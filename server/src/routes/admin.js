import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config, nodes, nodeById, publicNode } from '../config.js';
import { q, logEvent, recordOperationalState } from '../db.js';
import { toApi, deploy } from './peerings.js';
import { agentHealth, discoverPeers, peerStatus, safeRemove } from '../agents.js';
import { isEndpoint, isLinkLocal, isValidAsn, isWgKey } from '../util.js';
import { operationalFailure, operationalSnapshot } from '../operational.js';
import { deletePeeringTransaction } from '../lifecycle.js';

export const adminRouter = Router();

/** Constant-time string compare; false (without leaking via timing) on length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

adminRouter.use((req, res, next) => {
  if (!config.adminToken || config.adminToken.startsWith('CHANGE-ME')) {
    if (!config.demo) return res.status(503).json({ error: 'adminToken not configured' });
  }
  const token = req.headers['x-admin-token'];
  if (config.demo && token === 'demo') return next();
  if (!safeEqual(token, config.adminToken)) return res.status(401).json({ error: 'bad admin token' });
  next();
});

adminRouter.get('/peerings', (req, res) => {
  res.json(q.allPeerings.all().map(toApi));
});

adminRouter.get('/peerings/live', async (req, res) => {
  const rows = q.allPeerings.all();
  const results = await Promise.all(rows.map(async (p) => {
    const base = { id: p.id, asn: p.asn, nodeId: p.node_id, status: p.status };
    if (p.status !== 'active') {
      return {
        ...base,
        live: {
          ok: false,
          severity: p.status === 'error' ? 'critical' : 'info',
          skipped: true,
          reason: p.status,
          summary: `session is ${p.status}`,
          issues: p.status === 'error' ? [{ code: 'session.error', message: p.last_error || 'session is in error state' }] : [],
          checkedAt: new Date().toISOString(),
        },
      };
    }
    try {
      const live = operationalSnapshot(await peerStatus(nodeById(p.node_id), p));
      recordOperationalState(p.id, live);
      return { ...base, live };
    } catch (e) {
      const live = operationalFailure(e.message);
      recordOperationalState(p.id, live);
      return { ...base, live };
    }
  }));
  res.json(results);
});

function adminAction(name, fn) {
  adminRouter.post(`/peerings/:id/${name}`, async (req, res) => {
    const p = q.peeringById.get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'not found' });
    if ((p.source || 'auto') === 'manual' && ['approve', 'redeploy', 'disable', 'enable'].includes(name)) {
      return res.status(409).json({ error: 'manual sessions are read-only; change the node config and sync again' });
    }
    try {
      await fn(p);
      logEvent(p.asn, `admin.${name}`, p.node_id);
      res.json(toApi(q.peeringById.get(p.id)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });
}

adminAction('approve', async (p) => deploy(p));
adminAction('redeploy', async (p) => deploy(p));
adminAction('disable', async (p) => {
  await safeRemove(p.node_id, p.asn);
  q.setStatus.run('disabled', null, p.id);
  q.markNotProvisioned.run(p.id);
});
adminAction('enable', async (p) => deploy(p));

adminRouter.delete('/peerings/:id', async (req, res) => {
  const p = q.peeringById.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  if ((p.source || 'auto') === 'manual') {
    q.deletePeering.run(p.id);
    logEvent(p.asn, 'admin.forget-manual', p.node_id);
    return res.json({ ok: true });
  }
  try {
    await deletePeeringTransaction(p, {
      remove: safeRemove,
      setStatus: (...args) => q.setStatus.run(...args),
      deleteRecord: (id) => q.deletePeering.run(id),
      logEvent,
    }, 'admin.delete');
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message, status: 'delete_failed', retained: true });
  }
});

function validDiscoveredPeer(peer) {
  if (!isValidAsn(peer.asn)) return false;
  if (!isWgKey(peer.peer_pubkey || '')) return false;
  if (!isLinkLocal(peer.peer_ll || '')) return false;
  if (peer.peer_endpoint && !isEndpoint(peer.peer_endpoint)) return false;
  return true;
}

adminRouter.post('/peerings/sync-discovered', async (req, res) => {
  const nodeFilter = req.query.node || req.body?.nodeId;
  const targetNodes = nodeFilter ? nodes.filter((n) => n.id === nodeFilter) : nodes;
  if (!targetNodes.length) return res.status(404).json({ error: 'node not found' });
  const results = [];
  for (const node of targetNodes) {
    try {
      const discovered = await discoverPeers(node);
      let imported = 0;
      let skipped = 0;
      for (const peer of discovered.peers || []) {
        if (!validDiscoveredPeer(peer) || peer.asn === config.ourAsn) {
          skipped += 1;
          continue;
        }
        const before = q.peeringByAsnNode.get(peer.asn, node.id);
        q.upsertDiscoveredPeering.run(
          peer.asn,
          peer.mntner || 'DISCOVERED-MANUAL',
          node.id,
          peer.peer_pubkey,
          peer.peer_endpoint || null,
          peer.peer_ll,
          peer.peer_v4 || null,
          peer.peer_v6 || null,
          peer.mp_bgp === false ? 0 : 1,
          peer.enh === false ? 0 : 1,
          Number(peer.wg_port || 0),
          peer.iface || null,
          peer.bgp_proto || null,
        );
        const after = q.peeringByAsnNode.get(peer.asn, node.id);
        if (!before || before.source === 'manual' || after?.source === 'manual') imported += 1;
        else skipped += 1;
      }
      logEvent(null, 'admin.sync-discovered', `${node.id}: imported ${imported}, skipped ${skipped}`);
      results.push({ nodeId: node.id, ok: true, discovered: (discovered.peers || []).length, imported, skipped });
    } catch (e) {
      results.push({ nodeId: node.id, ok: false, error: e.message });
    }
  }
  res.json({ ok: results.every((r) => r.ok), results });
});

adminRouter.get('/nodes/health', async (req, res) => {
  const results = await Promise.all(nodes.map(async (n) => {
    try {
      return { ...publicNode(n), health: await agentHealth(n), reachable: true };
    } catch (e) {
      return { ...publicNode(n), reachable: false, error: e.message };
    }
  }));
  res.json(results);
});

adminRouter.get('/events', (req, res) => {
  res.json(q.recentEvents.all(Math.min(Number(req.query.limit) || 100, 500)));
});
