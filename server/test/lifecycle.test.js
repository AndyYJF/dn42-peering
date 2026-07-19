import test from 'node:test';
import assert from 'node:assert/strict';
import { deletePeeringTransaction } from '../src/lifecycle.js';

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
