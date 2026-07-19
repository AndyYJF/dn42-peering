import test from 'node:test';
import assert from 'node:assert/strict';
import { operationalFailure, operationalSnapshot } from '../src/operational.js';

const checkedAt = '2026-07-19T00:00:00.000Z';

test('reports up only when BGP is established and WG is fresh', () => {
  const live = operationalSnapshot({
    bgp: { state: 'Established', since: '2026-07-18 12:00:00' },
    wireguard: { latest_handshake_at: 1_700_000_000, latest_handshake_age: 20, handshake_recent: true },
  }, checkedAt);
  assert.equal(live.operationalState, 'up');
  assert.equal(live.bgpState, 'Established');
  assert.equal(live.wgState, 'fresh');
  assert.equal(live.ok, true);
  assert.deepEqual(live.issues, []);
});

test('reports down for a stopped BGP session and stale WG tunnel', () => {
  const live = operationalSnapshot({
    bgp: { state: 'Connect', error: 'Received: Administrative shutdown' },
    wireguard: { latest_handshake_at: 1_700_000_000, latest_handshake_age: 86400 },
  }, checkedAt);
  assert.equal(live.operationalState, 'down');
  assert.equal(live.wgState, 'stale');
  assert.equal(live.ok, false);
  assert.ok(live.issues.some((issue) => issue.code === 'bgp.down'));
  assert.ok(live.issues.some((issue) => issue.code === 'wg.stale'));
});

test('reports degraded when only one layer is healthy', () => {
  const live = operationalSnapshot({
    bgp: { state: 'Established' },
    wireguard: { latest_handshake_at: 1_700_000_000, latest_handshake_age: 600 },
  }, checkedAt);
  assert.equal(live.operationalState, 'degraded');
  assert.equal(live.bgpUp, true);
  assert.equal(live.wgUp, false);
});

test('reports unknown when the agent returned no protocol data', () => {
  const live = operationalSnapshot({}, checkedAt);
  assert.equal(live.operationalState, 'unknown');
  assert.equal(live.severity, 'info');
  assert.equal(live.lastHandshakeAt, null);
});

test('keeps agent transport failures separate from provisioning state', () => {
  const live = operationalFailure('timeout', checkedAt);
  assert.equal(live.operationalState, 'unknown');
  assert.equal(live.error, 'timeout');
  assert.equal(live.issues[0].code, 'agent.unreachable');
});
