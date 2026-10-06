'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const catalog = require('../shared/snap-information.js');
const { validateProfile, validateStoredProfile, validateRecords, PROFILE_FIELDS, REQUEST_FIELDS, LIST_FIELDS, SNAP_IOWA_ONLY_FIELDS,
  MEMBER_FIELDS, MAX_RECORDS, isRequestField, releasedValue } = require('../shared/schema.cjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const today = { today: '2026-10-05' };
const own = extra => ({ id: id(1), relationship: 'self', ...extra });

test('the immutable catalog is identical in browser and Node, with unique typed fields and no approval/credential fields', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../shared/snap-information.js'), 'utf8'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.SecondHandSnapInformation)), JSON.parse(JSON.stringify(catalog)));
  assert.ok(Object.isFrozen(catalog) && Object.isFrozen(catalog.sections[0].fields[0]));
  const keys = catalog.scalarFields.map(field => field.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, SNAP_IOWA_ONLY_FIELDS);
  for (const field of [...catalog.scalarFields, ...catalog.records.flatMap(record => record.fields), ...catalog.memberFields]) {
    assert.ok(['text', 'yesno', 'money', 'date', 'email', 'tel', 'state', 'zip', 'select'].includes(field.type));
    assert.doesNotMatch(field.key, /password|captcha|consent|signature|finalSubmit/i);
    if (field.options) assert.ok(field.options.every(option => Array.isArray(option) && option.length === 2 && option.every(value => typeof value === 'string')));
  }
});

test('legacy profiles open with unanswered SNAP answers and empty local records without inferring personal or household facts', () => {
  const profile = validateStoredProfile({ firstName: 'Fictional', state: 'IA', monthlyRent: '800', householdAllCitizens: 'yes', assetsOnHand: '0' });
  for (const field of catalog.scalarFields) assert.equal(profile[field.key], '', field.key);
  for (const key of LIST_FIELDS) assert.deepEqual(profile[key], []);
  assert.equal(profile.state, 'IA');
  assert.equal(profile.monthlyRent, '800');
  assert.equal(profile.iowaResident, ''); assert.equal(profile.bornInUs, ''); assert.equal(profile.hasLiquidAssets, '');
  assert.deepEqual(Object.keys(profile).sort(), [...PROFILE_FIELDS].sort());
});

test('every new yes/no answer preserves explicit No separately from unknown and rejects boolean or inferred choices', () => {
  for (const field of catalog.scalarFields.filter(field => field.type === 'yesno')) {
    for (const value of ['', 'yes', 'no']) assert.equal(validateProfile({ [field.key]: value })[field.key], value);
    for (const value of [true, false, 'maybe', 'Yes', '0']) assert.throws(() => validateProfile({ [field.key]: value }), field.key);
  }
  const profile = validateProfile({ fugitiveFelon: 'no', probationParoleViolation: 'yes', snapTradingDrugs: 'no', snapTradingWeapons: 'yes' });
  assert.equal(profile.fugitiveFelon, 'no'); assert.equal(profile.probationParoleViolation, 'yes');
  assert.equal(profile.snapTradingDrugs, 'no'); assert.equal(profile.snapTradingWeapons, 'yes');
});

test('new personal and helper details use bounded strings, actual dates and contact/postal formats', () => {
  const p = validateProfile({ ssnCardFirstName: ' 李 ', preferredLanguage: 'Unfamiliar language', birthState: 'ia', representativeState: 'mn',
    pregnancyDueDate: '2027-02-28', helperEmail: 'helper@example.test', helperPhone: '+1 202 555 0147', representativeZip: '55101-1234' });
  assert.equal(p.ssnCardFirstName, '李'); assert.equal(p.birthState, 'IA'); assert.equal(p.representativeState, 'MN');
  for (const value of [{ birthState: 'ZZ' }, { helperEmail: 'bad' }, { helperPhone: '().---(' }, { representativeZip: '1234' },
    { pregnancyDueDate: '2027-02-30' }, { ssnCardLastName: 'x'.repeat(101) }, { race: 'x'.repeat(201) }, { helperName: 'bad\0' }]) assert.throws(() => validateProfile(value));
});

test('all local lists require unique IDs, fixed keys, bounded records and dense plain arrays', () => {
  for (const record of catalog.records) {
    const original = [{ id: id(2) }], copy = structuredClone(original);
    const saved = validateRecords(record.key, original);
    assert.equal(saved.length, 1); assert.deepEqual(original, copy);
    for (const field of record.fields) assert.equal(saved[0][field.key], '');
    for (const invalid of [[{}], [{ id: 'bad' }], [{ id: id(2) }, { id: id(2).toUpperCase() }], [{ id: id(2), password: 'secret' }],
      new Array(1), Array.from({ length: MAX_RECORDS + 1 }, (_, index) => ({ id: id(index + 1) }))]) assert.throws(() => validateRecords(record.key, invalid));
    const getter = [{ id: id(2) }]; Object.defineProperty(getter[0], record.fields[0].key, { get() { assert.fail('must not invoke'); } });
    assert.throws(() => validateRecords(record.key, getter), /plain data/);
  }
  assert.throws(() => validateRecords('unknown', []));
});

test('record money, frequency and dates are explicit and never generate scalar income or expense answers', () => {
  const input = { jobs: [{ id: id(3), person: 'Exact Fictional Person', employer: 'Demo Employer', amount: '1234.50', frequency: 'Every Other Week', startDate: '2026-01-01', endDate: '2026-09-30', hoursPerWeek: '37.5' }],
    housingExpenses: [{ id: id(4), person: 'Another Fictional Person', type: 'Rent', amount: '0', frequency: 'Monthly' }],
    assets: [{ id: id(5), person: '', type: 'Cash', currentValue: '50' }] };
  const p = validateProfile(input);
  assert.equal(p.jobs[0].frequency, 'Every Other Week'); assert.equal(p.assets[0].person, '');
  assert.equal(p.monthlyEarnedIncome, ''); assert.equal(p.householdWorking, ''); assert.equal(p.monthlyRent, ''); assert.equal(p.paysHousing, '');
  for (const extra of [{ amount: '-1' }, { amount: '1.234' }, { amount: '1e4' }, { amount: '100000000' }, { frequency: 'biweekly' }, { startDate: '2026-02-30' },
    { startDate: '2026-02-01', endDate: '2026-01-01' }, { hoursPerWeek: '168.01' }]) assert.throws(() => validateRecords('jobs', [{ id: id(3), ...extra }]));
});

test('historical statement records cannot set current earnings, jobs or citizenship and are never request fields', () => {
  const p = validateProfile({ taxStatements: [{ id: id(6), documentType: 'w2', taxYear: '2025', sourceName: 'Demo Employer', sourceRole: 'employer', recipientName: 'Fictional Person',
    annualIncome: '68450.00', annualIncomeLabel: 'Box 1 wages', annualWithholding: '8214.00', annualWithholdingLabel: 'Box 2 withholding' }] });
  assert.equal(p.monthlyEarnedIncome, ''); assert.deepEqual(p.jobs, []); assert.equal(p.usCitizen, '');
  for (const key of LIST_FIELDS) { assert.equal(REQUEST_FIELDS.includes(key), false); assert.equal(isRequestField(key), false); assert.throws(() => releasedValue(p, key)); }
  for (const extra of [{ taxYear: '2025.0' }, { documentType: 'paystub' }, { sourceRole: 'applicant' }, { annualIncome: '$2' }, { ssn: '123-45-6789' }]) assert.throws(() => validateRecords('taxStatements', [{ id: id(6), ...extra }]));
});

test('household details stay per person, preserve explicit answers, and retain the original self-row synchronization only', () => {
  const p = validateProfile({ firstName: 'Fictional', lastName: 'Applicant', birthDate: '1985-01-02', usCitizen: 'yes', pregnant: 'no',
    householdMembers: [own({ firstName: 'Stale' }), { id: id(7), firstName: 'Child', relationship: 'child', birthDate: '2015-03-04', usCitizen: 'no',
      hasSsnAnswer: 'yes', ssn: '123-45-6789', eatsWithHousehold: 'yes', isApplicant: 'no', birthState: 'mn', ssnCardLastName: 'Other Card Name' }] }, today);
  assert.equal(p.householdMembers[0].firstName, 'Fictional'); assert.equal(p.householdMembers[0].usCitizen, '', 'no inferred copying to the self row');
  assert.equal(p.householdMembers[1].usCitizen, 'no'); assert.equal(p.householdMembers[1].birthState, 'MN'); assert.equal(p.householdAllCitizens, '');
  for (const row of p.householdMembers) assert.deepEqual(Object.keys(row).sort(), [...MEMBER_FIELDS].sort());
  for (const extra of [{ ssn: '123', hasSsnAnswer: 'yes' }, { ssn: '123456789', hasSsnAnswer: 'no' }, { pregnant: true }, { pregnancyDueDate: '2026-02-30' }, { birthState: 'ZZ' }]) {
    assert.throws(() => validateProfile({ householdMembers: [own(), { id: id(8), firstName: 'Other', relationship: 'other', ...extra }] }, today));
  }
});
