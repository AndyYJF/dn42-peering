import { Router } from 'express';
import { config, nodes, publicNode } from '../config.js';
import { q } from '../db.js';

export const publicRouter = Router();

publicRouter.get('/info', (req, res) => {
  const byStatus = Object.fromEntries(q.countByStatus.all().map((r) => [r.status, r.n]));
  res.json({
    networkName: config.networkName,
    ourAsn: config.ourAsn,
    autoApprove: config.autoApprove,
    demo: config.demo,
    nodes: nodes.length,
    sessions: {
      active: byStatus.active || 0,
      pending: byStatus.pending || 0,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    },
  });
});

publicRouter.get('/nodes', (req, res) => {
  const counts = Object.fromEntries(q.countByNode.all().map((r) => [r.node_id, r.n]));
  res.json(nodes.map((n) => ({ ...publicNode(n), activeSessions: counts[n.id] || 0 })));
});
