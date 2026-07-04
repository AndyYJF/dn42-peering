#!/usr/bin/env python3
"""
dn42-peering node agent — provisions WireGuard + BIRD2 sessions on this node.

Pure Python 3 stdlib, single file, no pip dependencies. Runs as root on each
DN42 node (it writes /etc/wireguard and /etc/bird/peers and calls wg-quick /
birdc). Set DRY_RUN=1 to test the full API without touching the system.

API (Bearer token):
  GET    /health               -> agent + bird + wg sanity
  GET    /peers                -> list of provisioned peers
  GET    /discover             -> discover managed + manual BGP/WG peers
  PUT    /peers/<asn>          -> create/replace a peer (body: see PeerSpec)
  DELETE /peers/<asn>          -> tear down a peer
  GET    /peers/<asn>/status   -> live BGP + WireGuard state
"""

import ipaddress
import json
import hmac
import os
import re
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# --- configuration -----------------------------------------------------------

CONF_PATH = os.environ.get("AGENT_CONF", "/etc/dn42-peering-agent.json")

DEFAULTS = {
    "listen": "127.0.0.1",
    "port": 8643,
    "token": "",
    "our_asn": 4242420000,
    "allow_from": ["127.0.0.1/32", "::1/128"],
    "dry_run": False,
    "wg_dir": "/etc/wireguard",
    "wg_private_key_file": "/etc/wireguard/dn42-node.key",
    "bird_peer_dir": "/etc/bird/peers",
    "state_file": "/var/lib/dn42-peering/peers.json",
    "bird_template": "",          # path to a custom bird template, "" = built-in
    "wg_template": "",            # path to a custom wg template, "" = built-in
    "iface_prefix": "dn42-",
}

CONF = dict(DEFAULTS)
if os.path.exists(CONF_PATH):
    CONF.update(json.loads(Path(CONF_PATH).read_text()))
if os.environ.get("DRY_RUN") == "1":
    CONF["dry_run"] = True
if os.environ.get("AGENT_TOKEN"):
    CONF["token"] = os.environ["AGENT_TOKEN"]

if not CONF["token"]:
    print("agent: no token configured (set 'token' in %s or AGENT_TOKEN env)" % CONF_PATH, file=sys.stderr)
    sys.exit(1)

if CONF["dry_run"]:
    base = Path("./dryrun").resolve()
    CONF["wg_dir"] = str(base / "wireguard")
    CONF["bird_peer_dir"] = str(base / "bird-peers")
    CONF["state_file"] = str(base / "peers.json")
    print("agent: DRY RUN — writing configs under %s, not touching the system" % base)

STATE_FILE = Path(CONF["state_file"])

# --- templates ----------------------------------------------------------------

MANAGED_MARK = "managed by dn42-peering agent"

WG_TEMPLATE = """\
# managed by dn42-peering agent — do not edit
[Interface]
PrivateKey = {private_key}
ListenPort = {wg_port}
Address = {our_ll}/64
PostUp = sysctl -w net.ipv6.conf.%i.autoconf=0
Table = off

[Peer]
PublicKey = {peer_pubkey}
{endpoint_line}AllowedIPs = 10.0.0.0/8, 172.20.0.0/14, 172.31.0.0/16, fd00::/8, fe80::/64
PersistentKeepalive = 25
"""

# Per-peer protocols inherit channels + dn42 ROA filters from the bird.conf
# `template bgp dnpeers` already present on every node.
BIRD_TEMPLATE = """\
# managed by dn42-peering agent — do not edit
protocol bgp {proto} from dnpeers {{
    neighbor {peer_ll} % '{iface}' as {asn};
{v4_channel}{v6_channel}}}
"""

V4_CHANNEL = """\
    ipv4 {{
{enh_line}    }};
"""

V6_CHANNEL = ""

def load_template(path, fallback):
    return Path(path).read_text() if path else fallback

# --- helpers -------------------------------------------------------------------

def run(cmd, check=True, timeout=60):
    if CONF["dry_run"]:
        print("dry-run: would exec:", " ".join(cmd))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
    return subprocess.run(cmd, capture_output=True, text=True, check=check, timeout=timeout)

def run_always(cmd, timeout=10):
    """Run even in dry-run mode (read-only commands like getent)."""
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

def proto_name(asn):
    return "dn42_%s" % str(asn)[-4:]

def iface_name(asn):
    return CONF["iface_prefix"] + str(asn)[-4:]

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}

def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))

def wg_private_key():
    if CONF["dry_run"]:
        return "DRY_RUN_PRIVATE_KEY_PLACEHOLDER="
    return Path(CONF["wg_private_key_file"]).read_text().strip()

def is_ours(path):
    """Only ever touch files this agent created (manual peers share the naming scheme)."""
    try:
        return MANAGED_MARK in Path(path).read_text()
    except OSError:
        return False

class Conflict(Exception):
    pass

class Invalid(Exception):
    pass

WG_KEY_RE = re.compile(r"^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$")
HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$", re.I)
IFACE_RE = re.compile(r"^[A-Za-z0-9_.=-]{1,15}$")
PROTO_RE = re.compile(r"^[A-Za-z0-9_.=-]{1,64}$")
DN42_V4_NETS = [ipaddress.ip_network("10.0.0.0/8"), ipaddress.ip_network("172.20.0.0/14"), ipaddress.ip_network("172.31.0.0/16")]
DN42_V6_NET = ipaddress.ip_network("fd00::/8")
LL_NET = ipaddress.ip_network("fe80::/64")

def reject_controls(name, value):
    if not isinstance(value, str):
        raise Invalid("%s must be a string" % name)
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise Invalid("%s contains control characters" % name)
    return value.strip()

def validate_asn(asn):
    if not isinstance(asn, int) or asn < 1 or asn > 4294967295:
        raise Invalid("invalid ASN")
    return asn

def validate_port(port):
    if isinstance(port, str) and port.isdigit():
        port = int(port)
    if not isinstance(port, int) or port < 1 or port > 65535:
        raise Invalid("wg_port must be 1-65535")
    return port

def validate_wg_key(key):
    key = reject_controls("peer_pubkey", key)
    if not WG_KEY_RE.match(key):
        raise Invalid("invalid WireGuard public key")
    return key

def validate_link_local(name, addr):
    addr = reject_controls(name, addr)
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        raise Invalid("%s must be an IPv6 link-local address in fe80::/64" % name)
    if ip.version != 6 or ip not in LL_NET:
        raise Invalid("%s must be an IPv6 link-local address in fe80::/64" % name)
    return addr

def validate_endpoint(endpoint):
    if endpoint in (None, ""):
        return None
    endpoint = reject_controls("peer_endpoint", endpoint)
    if endpoint.startswith("["):
        end = endpoint.find("]")
        if end == -1 or end + 1 >= len(endpoint) or endpoint[end + 1] != ":":
            raise Invalid("endpoint must be host:port")
        host, port_s = endpoint[1:end], endpoint[end + 2:]
        try:
            if ipaddress.ip_address(host).version != 6:
                raise ValueError
        except ValueError:
            raise Invalid("endpoint IPv6 literal is invalid")
    else:
        if endpoint.count(":") != 1:
            raise Invalid("endpoint must be host:port")
        host, port_s = endpoint.rsplit(":", 1)
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if not HOST_RE.match(host):
                raise Invalid("endpoint hostname is invalid")
    if not port_s.isdigit() or not (1 <= int(port_s) <= 65535):
        raise Invalid("endpoint port must be 1-65535")
    return endpoint

def validate_optional_dn42(name, addr):
    if addr in (None, ""):
        return None
    addr = reject_controls(name, addr)
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        raise Invalid("%s is not a valid IP address" % name)
    if ip.version == 4 and not any(ip in net for net in DN42_V4_NETS):
        raise Invalid("%s must be a DN42 IPv4 address" % name)
    if ip.version == 6 and ip not in DN42_V6_NET:
        raise Invalid("%s must be a ULA IPv6 address" % name)
    return addr

def validate_iface(iface):
    iface = reject_controls("iface", iface)
    if not IFACE_RE.match(iface) or "/" in iface or "\\" in iface or iface in (".", ".."):
        raise Invalid("invalid interface name")
    return iface

def validate_proto(proto):
    proto = reject_controls("proto", proto)
    if not PROTO_RE.match(proto) or "/" in proto or "\\" in proto or proto in (".", ".."):
        raise Invalid("invalid BIRD protocol name")
    return proto

def safe_conf_path(base_dir, filename):
    base = Path(base_dir).resolve()
    path = (base / filename).resolve()
    if path.parent != base:
        raise Invalid("configuration path escapes %s" % base)
    return path

def validate_spec(spec):
    spec["asn"] = validate_asn(spec.get("asn"))
    spec["iface"] = validate_iface(iface_name(spec["asn"]))
    spec["wg_port"] = validate_port(spec.get("wg_port"))
    spec["peer_pubkey"] = validate_wg_key(spec.get("peer_pubkey"))
    spec["peer_endpoint"] = validate_endpoint(spec.get("peer_endpoint"))
    spec["peer_ll"] = validate_link_local("peer_ll", spec.get("peer_ll"))
    spec["our_ll"] = validate_link_local("our_ll", spec.get("our_ll"))
    spec["peer_v4"] = validate_optional_dn42("peer_v4", spec.get("peer_v4"))
    spec["peer_v6"] = validate_optional_dn42("peer_v6", spec.get("peer_v6"))
    spec["enh"] = bool(spec.get("enh"))
    spec["mp_bgp"] = bool(spec.get("mp_bgp", True))
    return spec

def check_endpoint_resolves(endpoint):
    """Fail fast on unresolvable endpoint hostnames — wg-quick would retry DNS for ages."""
    if not endpoint:
        return
    host = endpoint.rsplit(":", 1)[0].strip("[]")
    try:
        ipaddress.ip_address(host)
        return  # literal IP, nothing to resolve
    except ValueError:
        pass
    try:
        res = run_always(["getent", "ahosts", host], timeout=10)
    except subprocess.TimeoutExpired:
        raise Invalid("endpoint hostname %r does not resolve (DNS timeout)" % host)
    if res.returncode != 0 or not res.stdout.strip():
        raise Invalid("endpoint hostname %r does not resolve" % host)

def check_conflicts(spec, wg_conf, bird_conf):
    if wg_conf.exists() and not is_ours(wg_conf):
        raise Conflict("interface %s is manually managed on this node" % spec["iface"])
    if bird_conf.exists() and not is_ours(bird_conf):
        raise Conflict("bird protocol %s is manually managed on this node" % proto_name(spec["asn"]))
    # a manually-managed file may declare the same protocol name under a different filename
    peer_dir = Path(CONF["bird_peer_dir"])
    if peer_dir.exists():
        pat = re.compile(r"protocol\s+bgp\s+%s\b" % re.escape(proto_name(spec["asn"])))
        for f in peer_dir.glob("*"):
            if f == bird_conf or not f.is_file():
                continue
            try:
                if pat.search(f.read_text()):
                    raise Conflict("protocol %s already defined in %s" % (proto_name(spec["asn"]), f.name))
            except UnicodeDecodeError:
                continue
    # WireGuard listen-port collision with any other config on the node
    for f in Path(CONF["wg_dir"]).glob("*.conf"):
        if f == wg_conf:
            continue
        try:
            m = re.search(r"^\s*ListenPort\s*=\s*(\d+)", f.read_text(), re.M)
        except (OSError, UnicodeDecodeError):
            continue
        if m and int(m.group(1)) == int(spec["wg_port"]):
            raise Conflict("port %s already used by %s" % (spec["wg_port"], f.name))

# --- provisioning ---------------------------------------------------------------

def render_wg(spec):
    endpoint_line = ""
    if spec.get("peer_endpoint"):
        endpoint_line = "Endpoint = %s\n" % spec["peer_endpoint"]
    tpl = load_template(CONF["wg_template"], WG_TEMPLATE)
    return tpl.format(
        private_key=wg_private_key(),
        wg_port=spec["wg_port"],
        our_ll=spec["our_ll"],
        peer_pubkey=spec["peer_pubkey"],
        endpoint_line=endpoint_line,
    )

def render_bird(spec):
    # v6 routes ride the same session (MP-BGP is implicit with a v6 neighbor +
    # the dnpeers template's ipv6 channel); we only need to emit an ipv4 block
    # when extended-next-hop is requested.
    v4 = V4_CHANNEL.format(enh_line="        extended next hop on;\n") if spec.get("enh") else ""
    tpl = load_template(CONF["bird_template"], BIRD_TEMPLATE)
    return tpl.format(
        proto=proto_name(spec["asn"]),
        our_asn=CONF.get("our_asn", 4242420000),
        peer_ll=spec["peer_ll"],
        iface=spec["iface"],
        asn=spec["asn"],
        v4_channel=v4,
        v6_channel=V6_CHANNEL,
    )

def bird_reconfigure(check=True):
    res = run(["birdc", "configure"], check=False)
    # birdc exits 0 even when the new config is rejected — parse the reply
    if check and not CONF["dry_run"] and "Reconfigured" not in res.stdout and "Reconfiguration in progress" not in res.stdout:
        raise RuntimeError("bird rejected config: %s" % res.stdout.strip()[:300])
    return res

def apply_peer(spec):
    spec = validate_spec(spec)
    iface = spec["iface"]
    wg_conf = safe_conf_path(CONF["wg_dir"], "%s.conf" % iface)
    bird_conf = safe_conf_path(CONF["bird_peer_dir"], "%s.conf" % proto_name(spec["asn"]))
    wg_conf.parent.mkdir(parents=True, exist_ok=True)
    bird_conf.parent.mkdir(parents=True, exist_ok=True)

    check_conflicts(spec, wg_conf, bird_conf)
    check_endpoint_resolves(spec.get("peer_endpoint"))

    # both files (if present) are ours per check_conflicts — snapshot for rollback
    old_wg = wg_conf.read_text() if wg_conf.exists() else None
    old_bird = bird_conf.read_text() if bird_conf.exists() else None

    if old_wg is not None:
        run(["wg-quick", "down", str(wg_conf)], check=False)
    wg_conf.write_text(render_wg(spec))
    os.chmod(wg_conf, 0o600)
    bird_conf.write_text(render_bird(spec))
    try:
        run(["wg-quick", "up", str(wg_conf)])
        bird_reconfigure()
    except Exception:
        run(["wg-quick", "down", str(wg_conf)], check=False)
        for path, old in ((wg_conf, old_wg), (bird_conf, old_bird)):
            if old is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(old)
        if old_wg is not None:
            run(["wg-quick", "up", str(wg_conf)], check=False)
        bird_reconfigure(check=False)
        raise

    state = load_state()
    state[str(spec["asn"])] = {k: v for k, v in spec.items() if k != "private_key"}
    save_state(state)

def remove_peer(asn):
    iface = iface_name(asn)
    wg_conf = Path(CONF["wg_dir"]) / ("%s.conf" % iface)
    bird_conf = Path(CONF["bird_peer_dir"]) / ("%s.conf" % proto_name(asn))
    if wg_conf.exists() and is_ours(wg_conf):
        run(["wg-quick", "down", str(wg_conf)], check=False)
        wg_conf.unlink()
    if bird_conf.exists() and is_ours(bird_conf):
        bird_conf.unlink()
    bird_reconfigure(check=False)
    state = load_state()
    state.pop(str(asn), None)
    save_state(state)

# --- discovery ------------------------------------------------------------------

def parse_wg_configs():
    peers = {}
    wg_dir = Path(CONF["wg_dir"])
    if not wg_dir.exists():
        return peers
    for conf in wg_dir.glob("*.conf"):
        try:
            text = conf.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        iface = conf.stem
        pub = re.search(r"^\s*PublicKey\s*=\s*(\S+)", text, re.M)
        port = re.search(r"^\s*ListenPort\s*=\s*(\d+)", text, re.M)
        endpoint = re.search(r"^\s*Endpoint\s*=\s*(\S+)", text, re.M)
        peers[iface] = {
            "iface": iface,
            "peer_pubkey": pub.group(1) if pub else None,
            "wg_port": int(port.group(1)) if port else 0,
            "peer_endpoint": endpoint.group(1) if endpoint else None,
            "managed": is_ours(conf),
        }
    return peers

def parse_bird_peer_configs():
    peers = []
    peer_dir = Path(CONF["bird_peer_dir"])
    if not peer_dir.exists():
        return peers
    for conf in peer_dir.glob("*"):
        if not conf.is_file():
            continue
        try:
            text = conf.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        proto = None
        for line in text.splitlines():
            m = re.match(r"\s*protocol\s+bgp\s+([A-Za-z0-9_.=-]+)\b", line)
            if m:
                proto = m.group(1)
                continue
            m = re.search(r"\bneighbor\s+([0-9A-Fa-f:.]+)(?:\s+%\s*['\"]?([A-Za-z0-9_.=-]+)['\"]?)?\s+as\s+(\d+)", line)
            if not m or not proto:
                continue
            peers.append({
                "asn": int(m.group(3)),
                "bgp_proto": proto,
                "peer_ll": m.group(1),
                "iface": m.group(2) or None,
                "managed": is_ours(conf),
            })
    return peers

def discover_peers():
    if CONF["dry_run"]:
        discovered = []
        for asn_s, spec in load_state().items():
            spec = dict(spec)
            spec["asn"] = int(asn_s)
            spec["bgp_proto"] = proto_name(spec["asn"])
            spec["managed"] = True
            spec["source"] = "auto"
            discovered.append(spec)
        return discovered

    wg_by_iface = parse_wg_configs()
    discovered = []
    seen = set()
    for bird in parse_bird_peer_configs():
        iface = bird.get("iface") or iface_name(bird["asn"])
        wg = wg_by_iface.get(iface, {})
        peer = {
            "asn": bird["asn"],
            "iface": iface,
            "bgp_proto": bird.get("bgp_proto"),
            "wg_port": wg.get("wg_port", 0),
            "peer_pubkey": wg.get("peer_pubkey"),
            "peer_endpoint": wg.get("peer_endpoint"),
            "peer_ll": bird.get("peer_ll"),
            "peer_v4": None,
            "peer_v6": None,
            "mp_bgp": True,
            "enh": True,
            "managed": bool(bird.get("managed") or wg.get("managed")),
            "source": "auto" if bool(bird.get("managed") or wg.get("managed")) else "manual",
        }
        discovered.append(peer)
        seen.add(iface)

    # Surface WireGuard-only configs as incomplete discoveries so the server
    # can count them as skipped instead of making them invisible to operators.
    for iface, wg in wg_by_iface.items():
        if iface in seen:
            continue
        m = re.search(r"(\d{4})$", iface)
        if not m:
            continue
        discovered.append({
            "asn": int("424242%s" % m.group(1)),
            "iface": iface,
            "bgp_proto": None,
            "wg_port": wg.get("wg_port", 0),
            "peer_pubkey": wg.get("peer_pubkey"),
            "peer_endpoint": wg.get("peer_endpoint"),
            "peer_ll": None,
            "managed": bool(wg.get("managed")),
            "source": "auto" if wg.get("managed") else "manual",
        })
    return discovered

# --- status ---------------------------------------------------------------------

def bgp_status(asn, proto=None):
    if CONF["dry_run"]:
        return {
            "ok": True,
            "state": "Established",
            "protocol_state": "up",
            "since": "dry-run",
            "routes": {"ipv4_import": 0, "ipv4_export": 0, "ipv6_import": 0, "ipv6_export": 0},
            "channels": {
                "ipv4": {"state": "UP", "imported": 0, "exported": 0, "preferred": 0},
                "ipv6": {"state": "UP", "imported": 0, "exported": 0, "preferred": 0},
            },
        }
    name = validate_proto(proto) if proto else proto_name(asn)
    res = run(["birdc", "show", "protocols", "all", name], check=False)
    out = res.stdout
    state, proto_state, since = "Unknown", "unknown", ""
    neighbor_address, neighbor_as, local_as = None, None, None
    error = None
    if res.returncode != 0:
        error = (res.stderr or res.stdout or "birdc failed").strip()[:300]
    if re.search(r"\b(no such protocol|not found|unknown protocol)\b", out, re.I):
        error = "BIRD protocol %s not found" % name
    for line in out.splitlines():
        if line.startswith(name):
            f = line.split()
            # name BGP table state since [info]; info = BGP FSM state (Established/Active/...)
            if len(f) >= 5:
                proto_state = f[3]
                since = f[4]
                state = f[5] if len(f) >= 6 else f[3]
        m = re.match(r"\s*BGP state:\s+(\S+)", line)
        if m:
            state = m.group(1)
        m = re.match(r"\s*Neighbor address:\s+(.+)", line)
        if m:
            neighbor_address = m.group(1).strip()
        m = re.match(r"\s*Neighbor AS:\s+(\d+)", line)
        if m:
            neighbor_as = int(m.group(1))
        m = re.match(r"\s*Local AS:\s+(\d+)", line)
        if m:
            local_as = int(m.group(1))

    routes = {"ipv4_import": 0, "ipv4_export": 0, "ipv6_import": 0, "ipv6_export": 0}
    channels = {}
    current_channel = None
    for line in out.splitlines():
        m = re.match(r"\s*Channel\s+(ipv[46])", line)
        if m:
            current_channel = m.group(1)
            channels[current_channel] = {"state": "UNKNOWN", "imported": 0, "exported": 0, "preferred": 0}
            continue
        if not current_channel:
            continue
        m = re.match(r"\s*State:\s+(\S+)", line)
        if m:
            channels[current_channel]["state"] = m.group(1)
            continue
        m = re.match(r"\s*Routes:\s+(\d+) imported,\s+(\d+) exported(?:,\s+(\d+) preferred)?", line)
        if m:
            imported = int(m.group(1))
            exported = int(m.group(2))
            preferred = int(m.group(3) or 0)
            channels[current_channel].update({"imported": imported, "exported": exported, "preferred": preferred})
            routes["%s_import" % current_channel] = imported
            routes["%s_export" % current_channel] = exported

    return {
        "ok": state == "Established" and not error,
        "state": state,
        "protocol": name,
        "protocol_state": proto_state,
        "since": since,
        "neighbor_address": neighbor_address,
        "neighbor_as": neighbor_as,
        "local_as": local_as,
        "routes": routes,
        "channels": channels,
        "error": error,
    }

def wg_status(asn, iface=None):
    if CONF["dry_run"]:
        iface = validate_iface(iface) if iface else iface_name(asn)
        return {
            "ok": True,
            "interface": iface,
            "latest_handshake_at": int(time.time()),
            "latest_handshake_age": 0,
            "handshake_recent": True,
            "rx_bytes": 0,
            "tx_bytes": 0,
            "endpoint": None,
        }
    iface = validate_iface(iface) if iface else iface_name(asn)
    res = run(["wg", "show", iface, "dump"], check=False)
    out = res.stdout.strip().splitlines()
    if len(out) < 2:
        err = (res.stderr or res.stdout or "interface not found").strip()[:300]
        return {"ok": False, "interface": iface, "error": err, "handshake_recent": False}
    f = out[1].split("\t")  # pubkey psk endpoint allowed-ips handshake rx tx keepalive
    hs = int(f[4]) if len(f) > 4 and f[4].isdigit() else 0
    age = int(time.time()) - hs if hs else None
    return {
        "ok": age is not None and age <= 180,
        "interface": iface,
        "endpoint": f[2] if len(f) > 2 and f[2] != "(none)" else None,
        "latest_handshake_at": hs or None,
        "latest_handshake_age": age,
        "handshake_recent": age is not None and age <= 180,
        "rx_bytes": int(f[5]) if len(f) > 5 else 0,
        "tx_bytes": int(f[6]) if len(f) > 6 else 0,
    }

# --- HTTP server ------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "dn42-peering-agent/1.0"

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        if CONF["allow_from"]:
            src = ipaddress.ip_address(self.client_address[0])
            if not any(src in ipaddress.ip_network(c) for c in CONF["allow_from"]):
                return False
        auth = self.headers.get("Authorization", "")
        return hmac.compare_digest(auth, "Bearer %s" % CONF["token"])

    def _route(self):
        if not self._authed():
            return self._send(401, {"error": "bad token"})
        url = urlsplit(self.path)
        parts = [p for p in url.path.split("/") if p]
        query = parse_qs(url.query)
        try:
            if self.command == "GET" and parts == ["health"]:
                bird_res = run(["birdc", "show", "status"], check=False) if not CONF["dry_run"] else None
                bird = bird_res.stdout if bird_res else "BIRD dry-run"
                wg_ok = bool(shutil.which("wg")) or CONF["dry_run"]
                wg_quick_ok = bool(shutil.which("wg-quick")) or CONF["dry_run"]
                return self._send(200, {
                    "ok": (bird_res.returncode == 0 if bird_res else True) and wg_ok and wg_quick_ok,
                    "hostname": os.uname().nodename if hasattr(os, "uname") else "unknown",
                    "bird": (re.search(r"BIRD [\d.]+", bird) or re.search(r".*", bird)).group(0)[:60],
                    "bird_ok": bird_res.returncode == 0 if bird_res else True,
                    "wireguard": wg_ok,
                    "wg_quick": wg_quick_ok,
                    "dry_run": CONF["dry_run"],
                    "peers": len(load_state()),
                })
            if self.command == "GET" and parts == ["peers"]:
                return self._send(200, load_state())
            if self.command == "GET" and parts == ["discover"]:
                return self._send(200, {"peers": discover_peers()})
            if len(parts) >= 2 and parts[0] == "peers" and parts[1].isdigit():
                asn = int(parts[1])
                if self.command == "GET" and len(parts) == 3 and parts[2] == "status":
                    iface = query.get("iface", [None])[0]
                    proto = query.get("proto", [None])[0]
                    return self._send(200, {"bgp": bgp_status(asn, proto), "wireguard": wg_status(asn, iface)})
                if self.command == "PUT" and len(parts) == 2:
                    length = int(self.headers.get("Content-Length", 0))
                    if length > 65536:
                        return self._send(413, {"error": "request body too large"})
                    spec = json.loads(self.rfile.read(length))
                    spec["asn"] = asn
                    for field in ("wg_port", "peer_pubkey", "peer_ll", "our_ll"):
                        if not spec.get(field):
                            return self._send(400, {"error": "missing field: %s" % field})
                    apply_peer(spec)
                    return self._send(200, {"ok": True, "iface": spec["iface"], "proto": proto_name(asn)})
                if self.command == "DELETE" and len(parts) == 2:
                    remove_peer(asn)
                    return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except Conflict as e:
            return self._send(409, {"error": str(e)})
        except Invalid as e:
            return self._send(400, {"error": str(e)})
        except subprocess.CalledProcessError as e:
            return self._send(500, {"error": "command failed: %s: %s" % (" ".join(e.cmd), (e.stderr or "")[:300])})
        except Exception as e:  # noqa: BLE001 — surface everything to the control plane
            return self._send(500, {"error": "%s: %s" % (type(e).__name__, e)})

    do_GET = do_PUT = do_DELETE = _route

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    addr = (CONF["listen"], int(CONF["port"]))
    print("dn42-peering agent listening on %s:%s%s" % (addr[0], addr[1], " (dry run)" if CONF["dry_run"] else ""))
    ThreadingHTTPServer(addr, Handler).serve_forever()
