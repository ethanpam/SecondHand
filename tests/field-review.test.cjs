'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewProfile, reviewDocumentFields } = require('../shared/field-review.cjs');
const { PROFILE_FIELDS, FIELD_LABELS, MEMBER_FIELDS } = require('../shared/schema.cjs');
const { buildFacts } = require('../shared/facts.cjs');
// Reviews include fixed record summaries, but applicant-authored custom answers
// have no deterministic field rules and never enter the review/model path.
const REVIEW_FIELDS = PROFILE_FIELDS.filter(key => key !== 'customFields');
const TODAY = { today: '2026-10-05' };
const rows = profile => Object.fromEntries(reviewProfile(profile, TODAY).map(row => [row.key, row]));
const self = (extra = {}) => ({ id: '00000000-0000-4000-8000-000000000001', firstName: 'Avery', lastName: 'Example', birthDate: '1985-04-12', relationship: 'self', student: 'no', grade: '', ...extra });
const child = (extra = {}) => ({ id: '00000000-0000-4000-8000-000000000002', firstName: 'Test', lastName: 'Example', birthDate: '2015-09-03', relationship: 'child', student: 'yes', grade: '5th', ...extra });
const profileWith = members => ({ firstName: 'Avery', lastName: 'Example', birthDate: '1985-04-12', householdMembers: members });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('every supported scalar and record summary has a fixed key/label and blank answers remain unknown', () => {
  const result = reviewProfile({}, TODAY);
  assert.deepEqual(result.map(row => row.key).sort(), [...REVIEW_FIELDS].sort());
  for (const row of result) {
    assert.deepEqual(Object.keys(row), ['key', 'label', 'status', 'messages']);
    assert.equal(row.label, FIELD_LABELS[row.key]);
    assert.equal(row.status, 'empty');
    assert.deepEqual(row.messages, []);
  }
  assert.equal(rows({ householdAdults: '0', monthlyRent: '0', disabled: 'no' }).householdAdults.status, 'format-passed');
  assert.equal(rows({ disabled: 'no' }).disabled.status, 'check-source');
});

test('custom answer labels, aliases and values stay out of review results and model facts', () => {
  const base = { firstName: 'Fictional', householdSize: '1' };
  const customFields = [{ id: self().id, label: 'Private custom question', value: 'Private custom answer', aliases: ['Private custom alias'] }];
  const profile = freeze({ ...base, customFields });
  const reviewed = reviewProfile(profile, TODAY), facts = buildFacts(profile);
  assert.deepEqual(reviewed, reviewProfile(base, TODAY));
  assert.deepEqual(facts, buildFacts(base));
  assert.ok(!reviewed.some(row => row.key === 'customFields' || row.key.startsWith('customFields.')));
  assert.doesNotMatch(JSON.stringify({ reviewed, facts }), /Private custom/);
});

test('names and source-dependent answers are never declared verified or corrected', () => {
  const unusual = ['李', 'O’Neill', 'Mary Anne', 'A', 'Jean-Luc', 'Nguyễn Thị', 'DʼAngelo', 'One name'];
  for (const firstName of unusual) assert.equal(rows({ firstName }).firstName.status, 'check-source', firstName);
  const result = rows({ addressLine1: 'PO Box 123', addressLine2: '#4', city: 'St. Louis', county: 'Example', sex: 'Female', programSnap: 'yes' });
  for (const key of ['addressLine1', 'addressLine2', 'city', 'county', 'sex', 'programSnap']) assert.equal(result[key].status, 'check-source');
  assert.ok(!JSON.stringify(result).includes('PO Box 123'));
});

test('SSN checks reject unassigned groups and only pass format, never identity', () => {
  for (const ssn of ['000-12-3456', '666-12-3456', '900-12-3456', '999-12-3456', '123-00-3456', '123-45-0000', '1234', '123 45 6789', '123-4O-6789']) {
    assert.equal(rows({ ssn }).ssn.status, 'needs-review', ssn);
  }
  for (const ssn of ['123-45-6789', '123456789', '899-12-3456']) {
    const result = rows({ ssn }).ssn;
    assert.equal(result.status, 'format-passed');
    assert.match(result.messages.join(' '), /does not verify/);
    assert.ok(!JSON.stringify(result).includes(ssn));
  }
});

test('contact, postal, choice, amount and count checks stay within supported formats', () => {
  const good = { email: 'fictional@example.invalid', phone: '+1 (202) 555-0147', homePhone: '2025550147', mobilePhone: '555-0147', state: 'ia', mailingState: 'DC', zip: '50011', mailingZip: '50011-2104', suffix: 'Jr.', monthlyRent: '1234.50', householdSize: '4', householdAdults: '1', householdChildren: '2', householdSeniors: '1' };
  const reviewed = rows(good);
  for (const key of Object.keys(good)) assert.notEqual(reviewed[key].status, 'needs-review', key);
  const bad = { email: 'a@@b.invalid', phone: '-------', homePhone: '(2025550147', mobilePhone: '1234567890123456', state: 'ZZ', mailingState: 'Iowa', zip: '50O11', mailingZip: '123456789', suffix: 'Esquire', isApplicant: 'maybe', monthlyRent: '-1', monthlyUtilities: '2.345', assetsOnHand: '100000000', householdSize: '0', householdAdults: '31', householdChildren: '1.5', householdSeniors: '007', bestContactTime: 'x'.repeat(31) };
  const rejected = rows(bad);
  for (const key of Object.keys(bad)) assert.equal(rejected[key].status, 'needs-review', key);
});

test('dates use the supplied local day, reject impossible or future dates and respect the 130-year boundary', () => {
  for (const birthDate of ['2026-10-05', '2024-02-29', '1896-10-05']) assert.equal(rows({ birthDate }).birthDate.status, 'format-passed', birthDate);
  for (const birthDate of ['2026-10-06', '2023-02-29', '2026-13-01', '1896-10-04', '10/05/1985']) assert.equal(rows({ birthDate }).birthDate.status, 'needs-review', birthDate);
  const invalidClock = reviewProfile({ birthDate: '1985-04-12' }, { today: 'not a date' }).find(row => row.key === 'birthDate');
  assert.equal(invalidClock.status, 'needs-review');
  assert.ok(!invalidClock.messages.join(' ').includes('1985'));
});

test('only definite self and household contradictions are flagged', () => {
  const contradictory = rows({ ssn: '123-45-6789', hasSsnAnswer: 'no', disabled: 'yes', householdDisability: 'no', medicare: 'yes', householdMedicare: 'no', usCitizen: 'no', householdAllCitizens: 'yes' });
  for (const key of ['ssn', 'hasSsnAnswer', 'disabled', 'householdDisability', 'medicare', 'householdMedicare', 'usCitizen', 'householdAllCitizens']) assert.equal(contradictory[key].status, 'needs-review', key);
  const compatible = rows({ disabled: 'no', householdDisability: 'yes', medicare: 'no', householdMedicare: 'yes', usCitizen: 'yes', householdAllCitizens: 'no', militaryOrVeteran: 'yes', householdVeteran: 'no', isApplicant: 'no', programSnap: 'yes' });
  for (const key of Object.keys(compatible)) assert.notEqual(compatible[key].status, 'needs-review', key);
});

test('home and mailing contradictions are flagged without choosing which answer to change', () => {
  const noHome = rows({ hasHomeAddress: 'no', addressLine1: '123 Fictional Road', city: 'Example' });
  for (const key of ['hasHomeAddress', 'addressLine1', 'city']) assert.equal(noHome[key].status, 'needs-review');
  const different = rows({ mailingSameAsHome: 'yes', addressLine1: '123 Fictional Road', mailingAddressLine1: 'PO Box 123' });
  for (const key of ['mailingSameAsHome', 'addressLine1', 'mailingAddressLine1']) assert.equal(different[key].status, 'needs-review');
  assert.equal(rows({ mailingSameAsHome: 'yes', addressLine1: '123 Fictional Road' }).mailingSameAsHome.status, 'check-source');
});

test('age bands count seniors once and incomplete counts do not invent missing numbers', () => {
  const profile = { householdSize: '4', householdAdults: '1', householdChildren: '2', householdSeniors: '1' };
  for (const key of Object.keys(profile)) assert.equal(rows(profile)[key].status, 'format-passed');
  const mismatch = rows({ ...profile, householdSize: '3' });
  for (const key of Object.keys(profile)) assert.equal(mismatch[key].status, 'needs-review');
  assert.equal(rows({ householdSize: '4', householdAdults: '1', householdChildren: '2' }).householdSize.status, 'format-passed');
  assert.equal(rows({ householdSize: '2', householdChildren: '3' }).householdSize.status, 'needs-review');
});

test('member subfields preserve stable indices and match the profile without exposing technical identifiers', () => {
  const profile = profileWith([self(), child()]);
  const reviewed = rows(profile);
  for (const index of [0, 1]) for (const field of ['firstName', 'lastName', 'birthDate', 'relationship', 'student', 'grade']) assert.ok(reviewed[`householdMembers.${index}.${field}`]);
  assert.equal(reviewed['householdMembers.0.id'], undefined);
  assert.equal(reviewed.householdMembers.status, 'check-source');
  const stale = rows(profileWith([self({ firstName: 'Previous' }), child()]));
  assert.equal(stale.firstName.status, 'needs-review');
  assert.equal(stale['householdMembers.0.firstName'].status, 'needs-review');
  assert.ok(!JSON.stringify(stale).includes('Previous'));
});

test('household structural problems and definite age-count mismatches remain reviewable', () => {
  const duplicates = rows(profileWith([self(), child({ id: self().id })]));
  assert.equal(duplicates.householdMembers.status, 'needs-review');
  assert.equal(rows(profileWith([child()])).householdMembers.status, 'needs-review');
  assert.equal(rows(profileWith([self(), child({ relationship: 'self' })])).householdMembers.status, 'needs-review');
  const invalid = rows(profileWith([self(), child({ firstName: '', student: 'no', grade: '5th', relationship: 'unsupported', birthDate: '2026-10-06' })]));
  for (const field of ['firstName', 'birthDate', 'relationship', 'grade']) assert.equal(invalid[`householdMembers.1.${field}`].status, 'needs-review', field);
  const counts = rows({ ...profileWith([self(), child()]), householdSize: '2', householdAdults: '2', householdChildren: '0', householdSeniors: '0' });
  assert.equal(counts.householdAdults.status, 'needs-review'); assert.equal(counts.householdChildren.status, 'needs-review');
  assert.equal(counts.householdSeniors.status, 'format-passed');
  assert.equal(rows({ ...profileWith([self(), child({ birthDate: '' })]), householdAdults: '2' }).householdAdults.status, 'format-passed', 'an unknown age is not guessed');
});

test('malformed, oversized and accessor-backed profiles stay bounded without executing input code', () => {
  for (const value of [null, [], 'bad', 5, Object.create({ firstName: 'Inherited' })]) {
    const result = reviewProfile(value, TODAY);
    assert.equal(result.length, REVIEW_FIELDS.length);
    assert.ok(result.every(row => row.status === 'needs-review'));
  }
  const profile = { firstName: 'x'.repeat(201), email: { text: 'secret' }, state: '\u0000IA', householdMembers: Array.from({ length: 1000 }, () => null) };
  let accessed = false;
  Object.defineProperty(profile, 'ssn', { get() { accessed = true; throw new Error('secret'); } });
  const result = reviewProfile(profile, TODAY);
  assert.equal(accessed, false);
  assert.equal(result.length, REVIEW_FIELDS.length + 20 * (MEMBER_FIELDS.length - 1));
  for (const key of ['firstName', 'email', 'state', 'ssn', 'householdMembers']) assert.equal(result.find(row => row.key === key).status, 'needs-review');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('document review preserves bounded IDs, reports every candidate and does not echo labels or values', () => {
  const input = [{ id: 'applicantFirstName', label: 'Private source label', sourceLabel: 'Your first name', sourceRole: 'applicant', profileKey: 'firstName', value: 'UniquePrivateName', page: 1, confidence: 99 },
    { id: 'contact', profileKey: 'email', value: 'private@example.invalid', confidence: 99 }, { id: 'blank', profileKey: 'phone' }];
  const result = reviewDocumentFields(input, {}, TODAY);
  assert.deepEqual(result.map(row => row.id), input.map(row => row.id));
  assert.deepEqual(result.map(row => row.key), ['firstName', 'email', 'phone']);
  assert.deepEqual(result.map(row => row.status), ['check-source', 'format-passed', 'empty']);
  for (const source of ['UniquePrivateName', 'private@example.invalid', 'Private source label']) assert.ok(!JSON.stringify(result).includes(source));
  assert.ok(result.every(row => !Object.hasOwn(row, 'value') && !Object.hasOwn(row, 'confidence') && !Object.hasOwn(row, 'page')));
});

test('document confidence, draft conflicts and contradictory profile context require review without replacing anything', () => {
  const draft = { firstName: 'Current', ssn: '123-45-6789', hasSsnAnswer: 'no' };
  const candidates = [{ id: 'name', profileKey: 'firstName', value: 'Different', confidence: 99 },
    { id: 'zip', profileKey: 'zip', value: '50011', confidence: 74.9 },
    { id: 'ssn', profileKey: 'ssn', value: '123-45-6789', confidence: 99 }];
  const before = structuredClone({ draft, candidates });
  const result = reviewDocumentFields(freeze(candidates), freeze(draft), TODAY);
  assert.ok(result.every(row => row.status === 'needs-review'));
  assert.match(result[0].messages.join(' '), /current profile draft/);
  assert.match(result[1].messages.join(' '), /confidence is low/);
  assert.match(result[2].messages.join(' '), /answered No/);
  assert.deepEqual({ draft, candidates }, before);
});

test('annual, joint and spouse document provenance never grants a current applicant answer', () => {
  const result = reviewDocumentFields([
    { id: 'taxLine1a', label: 'W-2 wages', value: '68450', confidence: 99 },
    { id: 'income', label: 'Monthly earned income', sourceLabel: 'Annual wages on joint tax return', profileKey: 'monthlyEarnedIncome', value: '68450' },
    { id: 'spouseName', label: 'First name', sourceRole: 'spouse', profileKey: 'firstName', value: 'Other' },
    { id: 'otherSsn', label: 'Social Security number', sourceLabel: 'Spouse social security number', profileKey: 'ssn', value: '123-45-6789' },
    { id: 'readonlySpouse', sourceRole: 'spouse', label: 'Spouse first name', value: 'Other' }
  ], {}, TODAY);
  assert.equal(result[0].status, 'check-source');
  assert.match(result[0].messages.join(' '), /historical/);
  for (const index of [1, 2, 3]) assert.equal(result[index].status, 'needs-review');
  assert.match(result[1].messages.join(' '), /not verified current monthly income/);
  assert.equal(result[4].status, 'check-source');
});

test('tax-return addresses, joint-return names and explicit monthly pensions do not acquire annual-amount warnings', () => {
  const result = reviewDocumentFields([
    { id: 'addressLine1', label: 'Address on tax return', sourceLabel: 'Home address', profileKey: 'addressLine1', value: '123 Fictional Road' },
    { id: 'spouseFirstName', label: 'Spouse name on joint tax return', sourceRole: 'spouse', profileKey: 'firstName', value: 'Other' },
    { id: 'readonlyName', label: 'Spouse name on joint tax return', sourceRole: 'spouse', value: 'Other' },
    { id: 'pension', label: 'Monthly pension income', sourceLabel: 'Monthly pension amount', profileKey: 'monthlyOtherIncome', value: '500' }
  ], {}, TODAY);
  assert.deepEqual(result.map(row => row.status), ['check-source', 'needs-review', 'check-source', 'format-passed']);
  for (const row of result) assert.doesNotMatch(row.messages.join(' '), /Annual or joint document amounts|historical source details/);
});

test('document metadata corruption, unsupported keys, duplicates and oversized lists do not escape bounds', () => {
  const cases = [null, { value: { private: true } }, { id: '../bad', value: 'x' }, { profileKey: '__proto__', value: 'x' },
    { value: 'x'.repeat(501) }, { value: 'x', label: 'x'.repeat(151) }, { value: 'x', sourceLabel: 'x'.repeat(151) },
    { value: 'x', sourceRole: 'guardian' }, { value: 'x', confidence: NaN }, { value: 'x', confidence: 101 }, { value: 'x', page: 13 }];
  assert.ok(reviewDocumentFields(cases, {}, TODAY).every(row => row.status === 'needs-review'));
  assert.equal(reviewDocumentFields(null, {}, TODAY)[0].status, 'needs-review');
  const duplicate = reviewDocumentFields([{ id: 'same', value: 'x' }, { id: 'same', value: 'y' }], {}, TODAY);
  assert.ok(duplicate.every(row => row.status === 'needs-review'));
  const oversized = reviewDocumentFields(Array.from({ length: 1000 }, (_, index) => ({ id: `field-${index}`, value: 'x' })), {}, TODAY);
  assert.equal(oversized.length, 150);
  assert.ok(oversized.every(row => row.status === 'needs-review'));
});

test('optional review metadata and revoked or accessor-backed input cannot crash or execute getters', () => {
  assert.doesNotThrow(() => reviewProfile({}, null));
  assert.doesNotThrow(() => reviewDocumentFields([], {}, null));
  let accessed = false;
  const candidate = { id: 'source', profileKey: 'firstName' };
  Object.defineProperty(candidate, 'value', { get() { accessed = true; throw new Error('private'); } });
  assert.equal(reviewDocumentFields([candidate], {}, TODAY)[0].status, 'needs-review');
  const proxy = Proxy.revocable([], {}); proxy.revoke();
  assert.equal(reviewDocumentFields(proxy.proxy, {}, TODAY)[0].status, 'needs-review');
  assert.equal(rows({ householdMembers: proxy.proxy }).householdMembers.status, 'needs-review');
  assert.equal(accessed, false);
});

test('all source objects are immutable and deterministic review never returns their private values', () => {
  const profile = freeze({ ...profileWith([self(), child()]), ssn: '123-45-6789', email: 'private@example.invalid', monthlyRent: '987.65' });
  const before = JSON.stringify(profile);
  const first = reviewProfile(profile, TODAY), second = reviewProfile(profile, TODAY);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(profile), before);
  for (const value of ['Avery', 'Example', '1985-04-12', '123-45-6789', 'private@example.invalid', '987.65', self().id]) assert.ok(!JSON.stringify(first).includes(value));
});
