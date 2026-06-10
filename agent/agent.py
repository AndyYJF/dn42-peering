#!/usr/bin/env python3
"""
dn42-peering node agent — provisions WireGuard + BIRD2 sessions on this node.

Pure Python 3 stdlib, single file, no pip dependencies. Runs as root on each
DN42 node (it writes /etc/wireguard and /etc/bird/peers and calls wg-quick /
birdc). Set DRY_RUN=1 to test the full API without touching the system.

API (Bearer token):
  GET    /health               -> agent + bird + wg sanity
  GET    /peers                -> list of provisioned peers
  PUT    /peers/<asn>          -> create/replace a peer (body: see PeerSpec)
  DELETE /peers/<asn>          -> tear down a peer
  GET    /peers/<asn>/status   -> live BGP + WireGuard state
"""

import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# --- configuration -----------------------------------------------------------

CONF_PATH = os.environ.get("AGENT_CONF", "/etc/dn42-peering-agent.json")

DEFAULTS = {
    "listen": "0.0.0.0",
    "port": 8643,
    "token": "",
    "our_asn": 4242420000,
    "allow_from": [],             # source-IP allowlist (CIDRs); [] = allow all
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
    iface = spec["iface"] = spec.get("iface") or iface_name(spec["asn"])
    wg_conf = Path(CONF["wg_dir"]) / ("%s.conf" % iface)
    bird_conf = Path(CONF["bird_peer_dir"]) / ("%s.conf" % proto_name(spec["asn"]))
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

# --- status ---------------------------------------------------------------------

def bgp_status(asn):
    if CONF["dry_run"]:
        return {"state": "Established", "since": "dry-run", "routes": {"ipv4_import": 0, "ipv4_export": 0, "ipv6_import": 0, "ipv6_export": 0}}
    out = run(["birdc", "show", "protocols", "all", proto_name(asn)], check=False).stdout
    state, since = "Unknown", ""
    for line in out.splitlines():
        if line.startswith(proto_name(asn)):
            f = line.split()
            # name BGP table state since [info]; info = BGP FSM state (Established/Active/...)
            if len(f) >= 5:
                since = f[4]
                state = f[5] if len(f) >= 6 else f[3]
            break
    routes = {"ipv4_import": 0, "ipv4_export": 0, "ipv6_import": 0, "ipv6_export": 0}
    for chan, imp, exp in re.findall(r"Channel (ipv[46]).*?Routes:\s+(\d+) imported.*?(\d+) exported", out, re.S):
        routes["%s_import" % chan] = int(imp)
        routes["%s_export" % chan] = int(exp)
    return {"state": state, "since": since, "routes": routes}

def wg_status(asn):
    if CONF["dry_run"]:
        return {"latest_handshake_age": 0, "rx_bytes": 0, "tx_bytes": 0, "endpoint": None}
    out = run(["wg", "show", iface_name(asn), "dump"], check=False).stdout.strip().splitlines()
    if len(out) < 2:
        return {"error": "interface not found"}
    f = out[1].split("\t")  # pubkey psk endpoint allowed-ips handshake rx tx keepalive
    import time
    hs = int(f[4]) if len(f) > 4 and f[4].isdigit() else 0
    return {
        "endpoint": f[2] if len(f) > 2 and f[2] != "(none)" else None,
        "latest_handshake_age": int(time.time()) - hs if hs else None,
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
        return auth == "Bearer %s" % CONF["token"]

    def _route(self):
        if not self._authed():
            return self._send(401, {"error": "bad token"})
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        try:
            if self.command == "GET" and parts == ["health"]:
                bird = run(["birdc", "show", "status"], check=False).stdout if not CONF["dry_run"] else "BIRD dry-run"
                return self._send(200, {
                    "ok": True,
                    "hostname": os.uname().nodename if hasattr(os, "uname") else "unknown",
                    "bird": (re.search(r"BIRD [\d.]+", bird) or re.search(r".*", bird)).group(0)[:60],
                    "wireguard": bool(shutil.which("wg")) or CONF["dry_run"],
                    "dry_run": CONF["dry_run"],
                    "peers": len(load_state()),
                })
            if self.command == "GET" and parts == ["peers"]:
                return self._send(200, load_state())
            if len(parts) >= 2 and parts[0] == "peers" and parts[1].isdigit():
                asn = int(parts[1])
                if self.command == "GET" and len(parts) == 3 and parts[2] == "status":
                    return self._send(200, {"bgp": bgp_status(asn), "wireguard": wg_status(asn)})
                if self.command == "PUT" and len(parts) == 2:
                    length = int(self.headers.get("Content-Length", 0))
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
