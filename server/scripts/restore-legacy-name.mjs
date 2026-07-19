#!/usr/bin/env node
import { nodeById } from '../src/config.js';
import { deployPeer } from '../src/agents.js';
import { logEvent, q } from '../src/db.js';
import { migratePeeringNames } from '../src/lifecycle.js';
import { legacyIfaceName, legacyProtoName } from '../src/util.js';

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id < 1) {
  console.error('usage: node scripts/restore-legacy-name.mjs <peering-id>');
  process.exit(2);
}

const peering = q.peeringById.get(id);
if (!peering) throw new Error(`peering ${id} not found`);
if ((peering.source || 'auto') !== 'auto') throw new Error('manual sessions are read-only');
const node = nodeById(peering.node_id);
if (!node) throw new Error(`unknown node: ${peering.node_id}`);

const result = await migratePeeringNames(peering, {
  iface: legacyIfaceName(peering.asn),
  bgp_proto: legacyProtoName(peering.asn),
}, {
  deploy: (candidate) => deployPeer(node, candidate),
  setNames: (...args) => q.setNames.run(...args),
  clearOperationalState: (peeringId) => q.clearOperationalState.run(peeringId),
  logEvent,
});
console.log(JSON.stringify({ id, asn: peering.asn, nodeId: peering.node_id, ...result }));
