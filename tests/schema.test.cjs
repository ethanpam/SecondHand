const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProfile, validateApplication, validateStoredApplication, isPortalUrl } = require('../shared/schema.cjs');

test('only the exact HTTPS Iowa application origin and path can receive fields', () => {
  assert.equal(isPortalUrl('https://hhsservices.iowa.gov/apspssp/ssp.portal/application/name'), true);
  for (const url of ['http://hhsservices.iowa.gov/apspssp/ssp.portal', 'https://hhsservices.iowa.gov.evil.example/apspssp/ssp.portal', 'https://evil.example/apspssp/ssp.portal', 'https://hhsservices.iowa.gov:8443/apspssp/ssp.portal', 'https://a:b@hhsservices.iowa.gov/apspssp/ssp.portal', 'https://hhsservices.iowa.gov/apspssp/ssp.portal.evil', 'https://hhsservices.iowa.gov/other', 'not a url']) assert.equal(isPortalUrl(url), false, url);
});
test('blank facts stay unknown; explicit zero remains zero', () => {
  const profile = validateProfile({ firstName: ' Test ', monthlyEarnedIncome: '0' });
  assert.equal(profile.firstName, 'Test');
  assert.equal(profile.monthlyEarnedIncome, '0');
  assert.equal(profile.monthlyRent, '');
  assert.equal(profile.state, '');
});
test('profile rejects unknown fields, invalid dates and invalid money', () => {
  for (const profile of [{ unknown: 'value' }, { firstName: {} }, { birthDate: '2020-02-30' }, { monthlyRent: '-1' }, { monthlyRent: 'unknown' }, { householdSize: '0' }, JSON.parse('{"__proto__":"bad"}')]) assert.throws(() => validateProfile(profile));
});
test('submission is never inferred and requires a receipt', () => {
  assert.equal(validateApplication({}).status, 'draft');
  assert.throws(() => validateApplication({ status: 'submitted' }));
  const app = validateApplication({ status: 'submitted', confirmationNumber: 'TEST-RECEIPT' });
  assert.equal(app.confirmationNumber, 'TEST-RECEIPT');
  assert.equal(validateApplication({ ...app, status: 'needs_action' }, app).id, app.id);
  assert.throws(() => validateApplication({ dueDate: '2026-02-30' }));
});
test('stored application timestamps survive validation without being rewritten', () => {
  const original = { ...validateApplication({}), createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-02-01T12:00:00.000Z' };
  assert.deepEqual(validateStoredApplication(original), original);
  assert.throws(() => validateStoredApplication({ ...original, createdAt: 'yesterday' }));
  assert.throws(() => validateStoredApplication({ ...original, id: '' }));
});
