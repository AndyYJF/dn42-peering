import test from 'node:test';
import assert from 'node:assert/strict';

process.env.PEERING_DEMO = '1';
const { ifaceName, legacyIfaceName, legacyProtoName, protoName } = await import('../src/util.js');

test('full ASN names do not collide across DN42 ASN ranges', () => {
  assert.equal(ifaceName(4242422921), 'dn42-4242422921');
  assert.equal(ifaceName(4201272921), 'dn42-4201272921');
  assert.notEqual(ifaceName(4242422921), ifaceName(4201272921));
  assert.equal(ifaceName(4242422921).length, 15);
});

test('BIRD protocol names use the complete ASN', () => {
  assert.equal(protoName(4242422921), 'dn42_4242422921');
  assert.equal(protoName(4201272921), 'dn42_4201272921');
});

test('legacy helpers preserve existing four-digit session names', () => {
  assert.equal(legacyIfaceName(4242422921), 'dn42-2921');
  assert.equal(legacyProtoName(4242422921), 'dn42_2921');
});
