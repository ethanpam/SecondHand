const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProfile, validateApplication, validateStoredApplication, isPortalUrl, YES_NO_FIELDS, PROFILE_FIELDS, FIELD_LABELS } = require('../shared/schema.cjs');
const fictionalProfile = require('./fixtures/applicant-profile.json');

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
test('typed phone numbers stay distinct; legacy phone never implies home or mobile', () => {
  const profile = validateProfile({ phone: '515-555-0100', homePhone: '(515)555-0101', mobilePhone: '5155550102' });
  assert.equal(profile.homePhone, '(515)555-0101');
  assert.equal(profile.mobilePhone, '5155550102');
  assert.equal(validateProfile({ phone: '515-555-0100' }).homePhone, '');
  assert.throws(() => validateProfile({ mobilePhone: 'call me' }));
});
test('first-page yes/no choices preserve unknown separately and never infer programs or address answers', () => {
  const oldProfile = validateProfile({ firstName: 'Legacy', addressLine1: '123 Test Way', city: 'Demo City', state: 'IA', zip: '50309' });
  for (const field of YES_NO_FIELDS) assert.equal(oldProfile[field], '', field);
  assert.equal(oldProfile.mailingAddressLine1, '');
  assert.equal(oldProfile.mailingState, '');
  for (const field of YES_NO_FIELDS) {
    assert.equal(validateProfile({ [field]: 'yes' })[field], 'yes');
    assert.equal(validateProfile({ [field]: 'no' })[field], 'no');
    for (const value of [true, false, 0, 1, 'Y', 'N', 'unknown', 'false']) assert.throws(() => validateProfile({ [field]: value }), field);
  }
  const explicit = validateProfile({ programSnap: 'yes', programFip: 'no', hasHomeAddress: 'no', mailingSameAsHome: 'no' });
  assert.equal(explicit.programFip, 'no');
  assert.equal(explicit.programMedicaid, '');
  assert.equal(explicit.helpPayMedicalBills, '');
});
test('mailing contact fields stay separate, use validated formats, and the full fictional fixture is valid', () => {
  const complete = validateProfile(fictionalProfile);
  assert.deepEqual(Object.keys(fictionalProfile).sort(), [...PROFILE_FIELDS].sort());
  assert.equal(complete.mailingAddressLine1, 'PO Box 123');
  assert.equal(complete.addressLine1, '123 Test Way');
  assert.equal(validateProfile({ mailingState: 'ia' }).mailingState, 'IA');
  assert.throws(() => validateProfile({ mailingState: 'Iowa' }));
  assert.throws(() => validateProfile({ mailingZip: '123' }));
  assert.throws(() => validateProfile({ bestContactTime: 'x'.repeat(31) }));
  assert.equal(validateProfile({ bestContactTime: 'x'.repeat(30) }).bestContactTime.length, 30);
  for (const suffix of ['', 'I', 'III', 'X', 'Jr.', 'Sr.']) assert.equal(validateProfile({ suffix }).suffix, suffix);
  for (const suffix of ['Jr', 'Doctor', 'XI']) assert.throws(() => validateProfile({ suffix }));
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

test('household counts accept whole numbers from 0 to 30 and household flags accept only yes or no', () => {
  for (const key of ['householdAdults', 'householdChildren', 'householdSeniors', 'householdVeteran', 'householdDisability']) assert.ok(PROFILE_FIELDS.includes(key), key);
  for (const value of ['', '0', '7', '30']) assert.equal(validateProfile({ householdChildren: value }).householdChildren, value);
  for (const value of ['31', '-1', '2.5', 'abc', '007']) assert.throws(() => validateProfile({ householdSeniors: value }), /whole number from 0 to 30/, value);
  assert.equal(validateProfile({ householdVeteran: 'yes', householdDisability: 'no' }).householdVeteran, 'yes');
  assert.throws(() => validateProfile({ householdVeteran: 'maybe' }), /Yes, No, or left unanswered/);
});

test('Iowa financial answers: money on hand and medical costs are dollar amounts; household status questions are yes or no', () => {
  assert.deepEqual(Object.fromEntries(['assetsOnHand', 'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare'].map(key => [key, FIELD_LABELS[key]])), {
    assetsOnHand: 'Money on hand (cash, checking, savings)', monthlyMedicalExpenses: 'Monthly medical expenses',
    householdAllCitizens: 'Everyone in household a US citizen', householdLegalStatus: 'If not, legal documents to stay in the US',
    householdPregnant: 'Anyone in household pregnant', householdMedicare: 'Anyone in household on Medicare'
  });
  for (const key of ['assetsOnHand', 'monthlyMedicalExpenses']) {
    assert.ok(PROFILE_FIELDS.includes(key), key);
    for (const value of ['', '0', '1250', '1250.5', '99.99']) assert.equal(validateProfile({ [key]: value })[key], value);
    for (const value of ['-1', 'abc', '1.234', '$20']) assert.throws(() => validateProfile({ [key]: value }), /nonnegative dollar amount/, value);
  }
  for (const key of ['householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare']) {
    assert.ok(PROFILE_FIELDS.includes(key) && YES_NO_FIELDS.includes(key), key);
    assert.equal(validateProfile({})[key], '', key);
    assert.throws(() => validateProfile({ [key]: 'maybe' }), /Yes, No, or left unanswered/, key);
  }
});
