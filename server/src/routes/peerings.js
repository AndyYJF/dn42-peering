import { Router } from 'express';
import { config, nodeById, publicNode } from '../config.js';
import { db, q, logEvent, recordOperationalState } from '../db.js';
import { requireAuth } from './auth.js';
import { deployPeer, peerStatus, safeRemove } from '../agents.js';
import { isWgKey, isLinkLocal, isDn42V4, isDn42V6, isEndpoint, ifaceName, assignPort } from '../util.js';
import { operationalFailure, operationalSnapshot } from '../operational.js';
import { deletePeeringTransaction } from '../lifecycle.js';

export const peeringsRouter = Router();
peeringsRouter.use(requireAuth);

/** What the peer needs to configure their side. */
export function ourSide(p) {
  const node = nodeById(p.node_id);
  if (!node) return null;
  return {
    asn: config.ourAsn,
    endpoint: `${node.endpoint}:${p.wg_port}`,
    wgPubkey: node.wgPubkey,
    linkLocal: node.linkLocal,
    tunnelV4: node.tunnelV4 || null,
    dn42V6: node.dn42V6 || null,
    iface: p.iface || ifaceName(p.asn),
  };
}

const toApi = (p) => ({
  id: p.id, asn: p.asn, mntner: p.mntner, nodeId: p.node_id,
  status: p.status, provisionState: p.status,
  operationalState: p.operational_state || (p.status === 'active' ? 'unknown' : 'not-provisioned'),
  bgpState: p.bgp_state || 'unknown', wgState: p.wg_state || 'unknown',
  lastHandshakeAt: p.last_handshake_at, lastEstablishedAt: p.last_established_at,
  operationalError: p.operational_error, lastCheckedAt: p.last_checked_at,
  wgPubkey: p.wg_pubkey, wgEndpoint: p.wg_endpoint, peerLl: p.peer_ll,
  peerV4: p.peer_v4, peerV6: p.peer_v6, mpBgp: !!p.mp_bgp, enh: !!p.enh,
  wgPort: p.wg_port, source: p.source || 'auto', iface: p.iface || ifaceName(p.asn), bgpProto: p.bgp_proto || null,
  lastError: p.last_error, createdAt: p.created_at, updatedAt: p.updated_at,
  ourSide: ourSide(p), node: nodeById(p.node_id) ? publicNode(nodeById(p.node_id)) : null,
});

function validateTunnel(body) {
  const errors = [];
  if (!isWgKey(body.wgPubkey || '')) errors.push('invalid WireGuard public key');
  if (body.wgEndpoint && !isEndpoint(body.wgEndpoint)) errors.push('endpoint must be host:port');
  if (!isLinkLocal(body.peerLl || '')) errors.push('link-local must be inside fe80::/64');
  if (body.peerV4 && !isDn42V4(body.peerV4)) errors.push('IPv4 must be a DN42 address (172.20.0.0/14, 172.31.0.0/16, 10.0.0.0/8)');
  if (body.peerV6 && !isDn42V6(body.peerV6)) errors.push('IPv6 must be a ULA (fd00::/8) address');
  return errors;
}

async function deploy(peering) {
  if ((peering.source || 'auto') === 'manual') {
    throw new Error('manual sessions are read-only; use the node config to change them');
  }
  const node = nodeById(peering.node_id);
  // nodes may have manually-managed tunnels whose ports our DB doesn't know
  // about — on a port conflict the agent answers 409 and we retry with the
  // next free candidate.
  const tried = new Set();
  let attempt = peering;
  q.clearOperationalState.run(peering.id);
  try {
    for (let i = 0; ; i++) {
      try {
        await deployPeer(node, attempt);
        break;
      } catch (e) {
        if (!/port .* already used/i.test(e.message) || i >= 8) throw e;
        tried.add(attempt.wg_port);
        const taken = q.portsOnNode.all(peering.node_id).map((r) => r.wg_port).concat([...tried]);
        attempt = { ...peering, wg_port: assignPort(peering.asn, taken) };
        logEvent(peering.asn, 'deploy.port-retry', `${[...tried].join(',')} taken -> ${attempt.wg_port}`);
      }
    }
    if (attempt.wg_port !== peering.wg_port) {
      db.prepare("UPDATE peerings SET wg_port = ?, updated_at = datetime('now') WHERE id = ?").run(attempt.wg_port, peering.id);
    }
    q.setStatus.run('active', null, peering.id);
    return { status: 'active' };
  } catch (e) {
    q.setStatus.run('error', e.message, peering.id);
    logEvent(peering.asn, 'deploy.error', `${peering.node_id}: ${e.message}`);
    return { status: 'error', error: e.message };
  }
}

peeringsRouter.get('/', (req, res) => {
  res.json(q.peeringsByAsn.all(req.auth.asn).map(toApi));
});

peeringsRouter.post('/', async (req, res) => {
  const { asn } = req.auth;
  if (asn === config.ourAsn) return res.status(400).json({ error: 'that is our own ASN' });
  const node = nodeById(String(req.body.nodeId || ''));
  if (!node) return res.status(400).json({ error: 'unknown node' });
  if (q.peeringByAsnNode.get(asn, node.id)) return res.status(409).json({ error: `you already have a session on ${node.id}` });
  if (q.peeringsByAsn.all(asn).length >= config.maxPeeringsPerAsn) {
    return res.status(409).json({ error: `limit of ${config.maxPeeringsPerAsn} sessions per ASN reached` });
  }
  const errors = validateTunnel(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const port = assignPort(asn, q.portsOnNode.all(node.id).map((r) => r.wg_port));
  const initial = config.autoApprove ? 'deploying' : 'pending';
  const info = q.insertPeering.run(
    asn, req.auth.mntner, node.id, initial,
    req.body.wgPubkey.trim(), req.body.wgEndpoint?.trim() || null,
    req.body.peerLl.trim(), req.body.peerV4?.trim() || null, req.body.peerV6?.trim() || null,
    req.body.mpBgp === false ? 0 : 1, req.body.enh === false ? 0 : 1, port,
  );
  let peering = q.peeringById.get(info.lastInsertRowid);
  logEvent(asn, 'peering.create', `${node.id} port ${port}`);

  if (config.autoApprove) {
    await deploy(peering);
    peering = q.peeringById.get(peering.id);
  }
  res.status(201).json(toApi(peering));
});

function ownPeering(req, res) {
  const p = q.peeringById.get(Number(req.params.id));
  if (!p || p.asn !== req.auth.asn) {
    res.status(404).json({ error: 'peering not found' });
    return null;
  }
  return p;
}

peeringsRouter.patch('/:id', async (req, res) => {
  const p = ownPeering(req, res);
  if (!p) return;
  if ((p.source || 'auto') === 'manual') return res.status(409).json({ error: 'manual sessions are read-only; edit the node config and sync again' });
  const merged = {
    wgPubkey: req.body.wgPubkey ?? p.wg_pubkey,
    wgEndpoint: req.body.wgEndpoint !== undefined ? req.body.wgEndpoint : p.wg_endpoint,
    peerLl: req.body.peerLl ?? p.peer_ll,
    peerV4: req.body.peerV4 !== undefined ? req.body.peerV4 : p.peer_v4,
    peerV6: req.body.peerV6 !== undefined ? req.body.peerV6 : p.peer_v6,
  };
  const errors = validateTunnel(merged);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  q.updatePeering.run(
    merged.wgPubkey.trim(), merged.wgEndpoint?.trim() || null, merged.peerLl.trim(),
    merged.peerV4?.trim() || null, merged.peerV6?.trim() || null,
    req.body.mpBgp !== undefined ? (req.body.mpBgp ? 1 : 0) : p.mp_bgp,
    req.body.enh !== undefined ? (req.body.enh ? 1 : 0) : p.enh,
    p.id,
  );
  logEvent(p.asn, 'peering.update', p.node_id);
  let updated = q.peeringById.get(p.id);
  if (['active', 'error', 'delete_failed'].includes(p.status)) {
    await deploy(updated);
    updated = q.peeringById.get(p.id);
  }
  res.json(toApi(updated));
});

peeringsRouter.delete('/:id', async (req, res) => {
  const p = ownPeering(req, res);
  if (!p) return;
  if ((p.source || 'auto') === 'manual') return res.status(409).json({ error: 'manual sessions are read-only; ask an operator to forget or change them' });
  try {
    await deletePeeringTransaction(p, {
      remove: safeRemove,
      setStatus: (...args) => q.setStatus.run(...args),
      deleteRecord: (id) => q.deletePeering.run(id),
      logEvent,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message, status: 'delete_failed', retained: true });
  }
});

peeringsRouter.get('/:id/status', async (req, res) => {
  const p = ownPeering(req, res);
  if (!p) return;
  if (p.status !== 'active') {
    return res.json({
      status: p.status,
      provisionState: p.status,
      operationalState: 'not-provisioned',
      bgpState: 'not-provisioned',
      wgState: 'not-provisioned',
      lastError: p.last_error,
    });
  }
  try {
    const live = operationalSnapshot(await peerStatus(nodeById(p.node_id), p));
    recordOperationalState(p.id, live);
    res.json({ status: p.status, provisionState: p.status, ...live });
  } catch (e) {
    const live = operationalFailure(e.message);
    recordOperationalState(p.id, live);
    res.json({ status: p.status, provisionState: p.status, ...live });
  }
});

export { toApi, deploy };
