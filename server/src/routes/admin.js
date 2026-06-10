import { Router } from 'express';
import { config, nodes, nodeById, publicNode } from '../config.js';
import { q, logEvent } from '../db.js';
import { toApi, deploy } from './peerings.js';
import { agentHealth, safeRemove } from '../agents.js';

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
  if (!config.adminToken || config.adminToken.startsWith('CHANGE-ME')) {
    if (!config.demo) return res.status(503).json({ error: 'adminToken not configured' });
  }
  const token = req.headers['x-admin-token'];
  if (config.demo && token === 'demo') return next();
  if (token !== config.adminToken) return res.status(401).json({ error: 'bad admin token' });
  next();
});

adminRouter.get('/peerings', (req, res) => {
  res.json(q.allPeerings.all().map(toApi));
});

function adminAction(name, fn) {
  adminRouter.post(`/peerings/:id/${name}`, async (req, res) => {
    const p = q.peeringById.get(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'not found' });
    await fn(p);
    logEvent(p.asn, `admin.${name}`, p.node_id);
    res.json(toApi(q.peeringById.get(p.id)));
  });
}

adminAction('approve', async (p) => deploy(p));
adminAction('redeploy', async (p) => deploy(p));
adminAction('disable', async (p) => {
  await safeRemove(p.node_id, p.asn);
  q.setStatus.run('disabled', null, p.id);
});
adminAction('enable', async (p) => deploy(p));

adminRouter.delete('/peerings/:id', async (req, res) => {
  const p = q.peeringById.get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  await safeRemove(p.node_id, p.asn);
  q.deletePeering.run(p.id);
  logEvent(p.asn, 'admin.delete', p.node_id);
  res.json({ ok: true });
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
