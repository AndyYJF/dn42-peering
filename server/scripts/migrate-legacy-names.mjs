#!/usr/bin/env node
import { config } from '../src/config.js';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const nodeId = argument('--node');
const baseUrl = argument('--base-url') || `http://127.0.0.1:${config.port}`;

if (!nodeId) {
  console.error('usage: node scripts/migrate-legacy-names.mjs --node <node-id> [--base-url URL]');
  process.exit(2);
}

async function admin(path, options = {}) {
  const response = await fetch(`${baseUrl}/api/admin${path}`, {
    ...options,
    headers: { 'x-admin-token': config.adminToken, ...(options.headers || {}) },
    signal: AbortSignal.timeout(100000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

const fullIface = (asn) => `dn42-${asn}`;
const fullProto = (asn) => `dn42_${asn}`;
const all = await admin('/peerings');
const candidates = all.filter((p) => (
  p.nodeId === nodeId
  && p.source === 'auto'
  && p.status === 'active'
  && (p.iface !== fullIface(p.asn) || p.bgpProto !== fullProto(p.asn))
));
const expectedUp = new Set(candidates.filter((p) => p.operationalState === 'up').map((p) => p.id));

console.log(JSON.stringify({ nodeId, candidates: candidates.length, expectedUp: expectedUp.size }));
for (const peering of candidates) {
  const result = await admin(`/peerings/${peering.id}/migrate-names`, { method: 'POST' });
  console.log(JSON.stringify({ id: peering.id, asn: peering.asn, changed: result.changed }));
}

let pending = [...expectedUp];
// A remote BIRD may keep the previous TCP/GR state for a 240-second hold time.
// Allow that full window plus retry slack before declaring the batch failed.
const deadline = Date.now() + 300000;
while (pending.length && Date.now() < deadline) {
  const live = await admin(`/peerings/live?node=${encodeURIComponent(nodeId)}`);
  pending = pending.filter((id) => live.find((item) => item.id === id)?.live?.operationalState !== 'up');
  if (pending.length) await new Promise((resolve) => setTimeout(resolve, 5000));
}

if (pending.length) {
  throw new Error(`previously-up sessions did not recover within 300s: ${pending.join(', ')}`);
}
console.log(JSON.stringify({ nodeId, migrated: candidates.length, verification: 'ok' }));
