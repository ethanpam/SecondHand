'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AssistedSession, ASSISTANCE_DURATION_MS } = require('../desktop/assistance.cjs');
const { PORTAL_URL } = require('../shared/schema.cjs');

const extensionId = 'a'.repeat(32);
const destination = { extensionId, url: PORTAL_URL };

function fixture() {
  let wall = Date.parse('2026-09-26T12:00:00.000Z');
  let monotonic = 1000;
  const manager = new AssistedSession({ wallNow: () => wall, monotonicNow: () => monotonic });
  return { manager, wall: value => { wall += value; }, monotonic: value => { monotonic += value; } };
}

test('assisted grants release only the approved field scope to the authenticated extension and Iowa portal', () => {
  const { manager } = fixture();
  const fields = ['firstName', 'homePhone'];
  const grant = manager.issue({ ...destination, fields });
  assert.match(grant.assistanceToken, /^[0-9a-f]{64}$/);
  assert.equal(grant.expiresAt, '2026-09-26T12:15:00.000Z');
  fields.push('ssn');
  grant.fields.push('ssn');
  const request = { ...destination, assistanceToken: grant.assistanceToken, fields: ['homePhone'] };
  manager.authorize(request);
  assert.deepEqual(manager.check(request), { active: true });
  manager.authorize({ ...request, url: `${PORTAL_URL}/step?screen=2` });
  assert.throws(() => manager.authorize({ ...request, fields: ['ssn'] }), /not approved/);
  assert.throws(() => manager.authorize({ ...request, fields: ['homePhone', 'homePhone'] }), /profile fields/);
  assert.throws(() => manager.authorize({ ...request, extensionId: 'b'.repeat(32) }), /ended/);
  assert.throws(() => manager.authorize({ ...request, assistanceToken: '0'.repeat(64) }), /ended/);
  assert.throws(() => manager.authorize({ ...request, url: 'https://hhsservices.iowa.gov.evil.test/apspssp/ssp.portal' }), /Iowa portal/);
  assert.throws(() => manager.issue({ ...destination, fields: ['password'] }), /profile fields/);
});

test('absolute assisted expiry cannot be extended by activity or a backward system clock', () => {
  const { manager, wall, monotonic } = fixture();
  const grant = manager.issue({ ...destination, fields: ['firstName'] });
  const request = { ...destination, assistanceToken: grant.assistanceToken, fields: ['firstName'] };
  monotonic(ASSISTANCE_DURATION_MS - 1);
  manager.authorize(request);
  wall(-24 * 60 * 60 * 1000);
  monotonic(1);
  assert.throws(() => manager.authorize(request), /ended/);
  assert.throws(() => manager.check(request), /ended/);
});

test('wall-clock expiry also revokes a grant when the monotonic clock did not advance during sleep', () => {
  const { manager, wall } = fixture();
  const grant = manager.issue({ ...destination, fields: ['firstName'] });
  wall(ASSISTANCE_DURATION_MS);
  assert.throws(() => manager.authorize({ ...destination, assistanceToken: grant.assistanceToken, fields: ['firstName'] }), /ended/);
});

test('revocation and replacement reject previous tokens; a stale stop cannot end the replacement', () => {
  const { manager } = fixture();
  const first = manager.issue({ ...destination, fields: ['firstName'] });
  const generation = manager.generation;
  manager.revoke();
  assert.ok(manager.generation > generation);
  assert.throws(() => manager.authorize({ ...destination, assistanceToken: first.assistanceToken, fields: ['firstName'] }), /ended/);
  const second = manager.issue({ ...destination, fields: ['firstName'] });
  assert.notEqual(second.assistanceToken, first.assistanceToken);
  assert.deepEqual(manager.end({ extensionId, assistanceToken: first.assistanceToken }), { ended: true });
  manager.authorize({ ...destination, assistanceToken: second.assistanceToken, fields: ['firstName'] });
  manager.end({ extensionId: 'b'.repeat(32), assistanceToken: second.assistanceToken });
  manager.authorize({ ...destination, assistanceToken: second.assistanceToken, fields: ['firstName'] });
  manager.end({ extensionId, assistanceToken: second.assistanceToken });
  assert.throws(() => manager.authorize({ ...destination, assistanceToken: second.assistanceToken, fields: ['firstName'] }), /ended/);
  assert.deepEqual(manager.end({ extensionId, assistanceToken: second.assistanceToken }), { ended: true });
});
