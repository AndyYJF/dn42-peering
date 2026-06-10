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
export const peerStatus = (node, asn) => call(node, 'GET', `/peers/${asn}/status`);
export const agentHealth = (node) => call(node, 'GET', '/health');

export async function safeRemove(nodeId, asn) {
  const node = nodeById(nodeId);
  if (!node) return;
  try { await removePeer(node, asn); } catch (e) { console.warn(`[agent] remove AS${asn}@${nodeId}: ${e.message}`); }
}

// --- demo simulation -------------------------------------------------------

function demoCall(method, p) {
  if (method === 'GET' && p === '/health') {
    return { ok: true, hostname: 'demo-node', bird: 'BIRD 2.15.1', wireguard: true, dry_run: true };
  }
  if (method === 'GET' && p.endsWith('/status')) {
    const asn = Number(p.split('/')[2]);
    const seed = asn % 97;
    return {
      bgp: {
        state: seed % 11 === 0 ? 'Connect' : 'Established',
        since: '2026-06-09 14:02:11',
        routes: { ipv4_import: 480 + seed, ipv4_export: 512, ipv6_import: 290 + seed, ipv6_export: 301 },
      },
      wireguard: { latest_handshake_age: 12 + (seed % 90), rx_bytes: 10485760 + seed * 9973, tx_bytes: 8388608 + seed * 7919, endpoint: '203.0.113.7:51820' },
    };
  }
  return { ok: true, demo: true };
}
