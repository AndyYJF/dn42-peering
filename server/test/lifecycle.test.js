import test from 'node:test';
import assert from 'node:assert/strict';
import { deletePeeringTransaction, migratePeeringNames } from '../src/lifecycle.js';

const peering = { id: 7, asn: 4242421234, node_id: 'fra' };

function fakeDeps(remove) {
  const calls = [];
  return {
    calls,
    remove: async (...args) => { calls.push(['remove', ...args]); return remove?.(...args); },
    setStatus: (...args) => calls.push(['status', ...args]),
    deleteRecord: (...args) => calls.push(['delete', ...args]),
    logEvent: (...args) => calls.push(['event', ...args]),
  };
}

test('deletes the database record only after node cleanup succeeds', async () => {
  const deps = fakeDeps();
  await deletePeeringTransaction(peering, deps);
  assert.deepEqual(deps.calls.slice(0, 3), [
    ['status', 'deleting', null, 7],
    ['remove', 'fra', 4242421234],
    ['delete', 7],
  ]);
  assert.equal(deps.calls.at(-1)[2], 'peering.delete');
});

test('retains the database record and records delete_failed on node error', async () => {
  const deps = fakeDeps(() => { throw new Error('agent timeout'); });
  await assert.rejects(
    deletePeeringTransaction(peering, deps),
    /database record retained: agent timeout/,
  );
  assert.ok(deps.calls.some((call) => call[0] === 'status' && call[1] === 'delete_failed'));
  assert.ok(deps.calls.some((call) => call[0] === 'event' && call[2] === 'peering.delete.failed'));
  assert.equal(deps.calls.some((call) => call[0] === 'delete'), false);
});

test('uses a separate audit action for admin deletion', async () => {
  const deps = fakeDeps();
  await deletePeeringTransaction(peering, deps, 'admin.delete');
  assert.equal(deps.calls.at(-1)[2], 'admin.delete');
});

test('commits full ASN names only after the node migration succeeds', async () => {
  const calls = [];
  const old = { ...peering, iface: 'dn42-1234', bgp_proto: 'dn42_1234' };
  const target = { iface: 'dn42-4242421234', bgp_proto: 'dn42_4242421234' };
  const result = await migratePeeringNames(old, target, {
    deploy: async (candidate) => calls.push(['deploy', candidate.iface, candidate.bgp_proto]),
    setNames: (...args) => calls.push(['names', ...args]),
    clearOperationalState: (...args) => calls.push(['clear', ...args]),
    logEvent: (...args) => calls.push(['event', ...args]),
  });
  assert.equal(result.changed, true);
  assert.deepEqual(calls.slice(0, 3), [
    ['deploy', target.iface, target.bgp_proto],
    ['names', target.iface, target.bgp_proto, 7],
    ['clear', 7],
  ]);
});

test('restores legacy node names if the database name update fails', async () => {
  const calls = [];
  const old = { ...peering, iface: 'dn42-1234', bgp_proto: 'dn42_1234' };
  const target = { iface: 'dn42-4242421234', bgp_proto: 'dn42_4242421234' };
  await assert.rejects(migratePeeringNames(old, target, {
    deploy: async (candidate) => calls.push(['deploy', candidate.iface, candidate.bgp_proto]),
    setNames: () => { throw new Error('database locked'); },
    clearOperationalState: () => calls.push(['clear']),
    logEvent: () => calls.push(['event']),
  }), /node restored to legacy names/);
  assert.deepEqual(calls, [
    ['deploy', target.iface, target.bgp_proto],
    ['deploy', old.iface, old.bgp_proto],
  ]);
});

test('skips an already migrated peering', async () => {
  let called = false;
  const full = { ...peering, iface: 'dn42-4242421234', bgp_proto: 'dn42_4242421234' };
  const result = await migratePeeringNames(full, {
    iface: full.iface,
    bgp_proto: full.bgp_proto,
  }, { deploy: async () => { called = true; } });
  assert.equal(result.changed, false);
  assert.equal(called, false);
});
