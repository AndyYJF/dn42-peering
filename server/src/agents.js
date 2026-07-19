import { config, nodeById } from './config.js';
import { ifaceName } from './util.js';

/**
 * Client for the per-node provisioning agents (agent/agent.py).
 * In demo mode every call is simulated so the whole flow works without real nodes.
 */

async function call(node, method, p, body) {
  if (config.demo) return demoCall(method, p, body);
  const res = await fetch(`${node.agentUrl}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${node.agentToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(method === 'GET' ? 15000 : 90000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `agent ${res.status}`);
  return data;
}

/** Build the payload an agent needs to render wg + bird config for one peer. */
export function peerPayload(node, p) {
  return {
    asn: p.asn,
    iface: ifaceName(p.asn),
    wg_port: p.wg_port,
    peer_pubkey: p.wg_pubkey,
    peer_endpoint: p.wg_endpoint || null,
    peer_ll: p.peer_ll,
    peer_v4: p.peer_v4 || null,
    peer_v6: p.peer_v6 || null,
    mp_bgp: !!p.mp_bgp,
    enh: !!p.enh,
    our_ll: node.linkLocal,
    our_v4: node.tunnelV4 || null,
    our_v6: node.dn42V6 || null,
  };
}

export const deployPeer = (node, peering) => call(node, 'PUT', `/peers/${peering.asn}`, peerPayload(node, peering));
export const removePeer = (node, asn) => call(node, 'DELETE', `/peers/${asn}`);
export function peerStatus(node, peeringOrAsn) {
  const asn = typeof peeringOrAsn === 'object' ? peeringOrAsn.asn : peeringOrAsn;
  const params = new URLSearchParams();
  if (typeof peeringOrAsn === 'object') {
    if (peeringOrAsn.iface) params.set('iface', peeringOrAsn.iface);
    if (peeringOrAsn.bgp_proto) params.set('proto', peeringOrAsn.bgp_proto);
  }
  const qs = params.toString();
  return call(node, 'GET', `/peers/${asn}/status${qs ? `?${qs}` : ''}`);
}
export const agentHealth = (node) => call(node, 'GET', '/health');
export const discoverPeers = (node) => call(node, 'GET', '/discover');

export async function safeRemove(nodeId, asn) {
  const node = nodeById(nodeId);
  if (!node) throw new Error(`unknown node: ${nodeId}`);
  return removePeer(node, asn);
}

// --- demo simulation -------------------------------------------------------

function demoCall(method, p) {
  if (method === 'GET' && p === '/health') {
    return { ok: true, hostname: 'demo-node', bird: 'BIRD 2.15.1', bird_ok: true, wireguard: true, wg_quick: true, dry_run: true, peers: 3 };
  }
  if (method === 'GET' && p.includes('/status')) {
    const [pathOnly, query = ''] = p.split('?');
    const asn = Number(pathOnly.split('/')[2]);
    const params = new URLSearchParams(query);
    const seed = asn % 97;
    const handshakeAge = 12 + (seed % 240);
    const iface = params.get('iface') || `dn42-${String(asn).slice(-4)}`;
    const proto = params.get('proto') || `dn42_${String(asn).slice(-4)}`;
    return {
      bgp: {
        ok: seed % 11 !== 0,
        state: seed % 11 === 0 ? 'Connect' : 'Established',
        protocol: proto,
        protocol_state: seed % 11 === 0 ? 'start' : 'up',
        since: '2026-06-09 14:02:11',
        neighbor_address: 'fe80::1234%dn42-demo',
        neighbor_as: asn,
        local_as: config.ourAsn,
        routes: { ipv4_import: 480 + seed, ipv4_export: 512, ipv6_import: 290 + seed, ipv6_export: 301 },
        channels: {
          ipv4: { state: 'UP', imported: 480 + seed, exported: 512, preferred: 480 + seed },
          ipv6: { state: 'UP', imported: 290 + seed, exported: 301, preferred: 290 + seed },
        },
      },
      wireguard: {
        ok: handshakeAge <= 180,
        interface: iface,
        latest_handshake_at: Math.floor(Date.now() / 1000) - handshakeAge,
        latest_handshake_age: handshakeAge,
        handshake_recent: handshakeAge <= 180,
        rx_bytes: 10485760 + seed * 9973,
        tx_bytes: 8388608 + seed * 7919,
        endpoint: '203.0.113.7:51820',
      },
    };
  }
  if (method === 'GET' && p === '/discover') {
    return {
      peers: [
        {
          asn: 4242421235,
          iface: 'manual-1235',
          bgp_proto: 'manual_1235',
          wg_port: 21235,
          peer_pubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          peer_endpoint: '203.0.113.7:51820',
          peer_ll: 'fe80::1235',
          mp_bgp: true,
          enh: true,
          source: 'manual',
          managed: false,
        },
      ],
    };
  }
  return { ok: true, demo: true };
}
