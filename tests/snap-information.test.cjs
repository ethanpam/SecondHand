'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../shared/snap-information.js');
const { validateProfile, validateStoredProfile, validateRecords, PROFILE_FIELDS, REQUEST_FIELDS, LIST_FIELDS, SNAP_IOWA_ONLY_FIELDS,
  MEMBER_FIELDS, MAX_RECORDS, isRequestField, releasedValue } = require('../shared/schema.cjs');
const { runFile } = require('./helpers/harness.cjs');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const today = { today: '2026-10-05' };
const own = extra => ({ id: id(1), relationship: 'self', ...extra });

test('the immutable catalog is identical in browser and Node, with unique typed fields and no approval/credential fields', () => {
  const context = {};
  runFile('shared/snap-information.js', context);
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
    for (const value of [true, false]) assert.throws(() => validateProfile({ [field.key]: value }), { message: `${field.label} is invalid.` }, `${field.key}: ${value}`);
    for (const value of ['maybe', 'Yes', '0']) assert.throws(() => validateProfile({ [field.key]: value }), { message: `${field.label} must be Yes, No, or left unanswered.` }, `${field.key}: ${value}`);
  }
  const profile = validateProfile({ fugitiveFelon: 'no', probationParoleViolation: 'yes', snapTradingDrugs: 'no', snapTradingWeapons: 'yes' });
  assert.equal(profile.fugitiveFelon, 'no'); assert.equal(profile.probationParoleViolation, 'yes');
  assert.equal(profile.snapTradingDrugs, 'no'); assert.equal(profile.snapTradingWeapons, 'yes');
});

test('new personal and helper details use bounded strings, actual dates and contact/postal formats', () => {
  const p = validateProfile({ ssnCardFirstName: ' 李 ', preferredLanguage: 'Unfamiliar language', birthState: 'ia', representativeState: 'mn',
    pregnancyDueDate: '2027-02-28', helperEmail: 'helper@example.test', helperPhone: '+1 202 555 0147', representativeZip: '55101-1234' });
  assert.equal(p.ssnCardFirstName, '李'); assert.equal(p.birthState, 'IA'); assert.equal(p.representativeState, 'MN');
  for (const [value, message] of [[{ birthState: 'ZZ' }, 'U.S. state of birth must be a recognized two-letter state or postal-region abbreviation.'],
    [{ helperEmail: 'bad' }, 'Helper’s email must be a valid email address.'], [{ helperPhone: '().---(' }, 'Helper’s phone must be a valid phone number.'],
    [{ representativeZip: '1234' }, 'Representative’s ZIP code must be a five- or nine-digit ZIP code.'], [{ pregnancyDueDate: '2027-02-30' }, 'Expected due date must be a valid date.'],
    [{ ssnCardLastName: 'x'.repeat(101) }, 'Last name on Social Security card is invalid.'], [{ race: 'x'.repeat(201) }, 'Your race or races (your own description) is invalid.'],
    [{ helperName: 'bad\0' }, 'Application helper’s name is invalid.']]) assert.throws(() => validateProfile(value), { message }, Object.keys(value)[0]);
});

test('eating with the household is distinct from purchasing and preparing meals', () => {
  const legacy = validateStoredProfile({ eatsWithHousehold: 'yes' });
  assert.equal(legacy.eatsMealsWithHousehold, '', 'an existing meal-preparation answer cannot answer the eating question');
  const profile = validateProfile({ eatsWithHousehold: 'no', eatsMealsWithHousehold: 'yes' });
  assert.equal(profile.eatsWithHousehold, 'no');
  assert.equal(profile.eatsMealsWithHousehold, 'yes');
  assert.equal(SNAP_IOWA_ONLY_FIELDS.includes('eatsMealsWithHousehold'), true);
});

test('expected babies are an explicit bounded count, never inferred from pregnancy', () => {
  assert.equal(validateProfile({ pregnant: 'yes' }).pregnancyExpectedBabies, '');
  for (const value of ['', '1', '2', '20']) assert.equal(validateProfile({ pregnancyExpectedBabies: value }).pregnancyExpectedBabies, value);
  for (const value of ['0', '-1', '1.5', '21', '01', 'two']) assert.throws(() => validateProfile({ pregnancyExpectedBabies: value }));
});

test('all local lists require unique IDs, fixed keys, bounded records and dense plain arrays', () => {
  for (const record of catalog.records) {
    const original = [{ id: id(2) }], copy = structuredClone(original);
    const saved = validateRecords(record.key, original);
    assert.equal(saved.length, 1); assert.deepEqual(original, copy);
    for (const field of record.fields) assert.equal(saved[0][field.key], '');
    const unique = 'Each information-list entry needs a unique identifier.';
    for (const [invalid, message] of [[[{}], unique], [[{ id: 'bad' }], unique], [[{ id: id(2) }, { id: id(2).toUpperCase() }], unique], [[{ id: id(2), password: 'secret' }], 'Unknown information-list field.'],
      [new Array(1), `${record.label} must contain plain entries.`],
      [Array.from({ length: MAX_RECORDS + 1 }, (_, index) => ({ id: id(index + 1) })), `${record.label} must be a list with up to ${MAX_RECORDS} entries.`]]) {
      assert.throws(() => validateRecords(record.key, invalid), { message }, `${record.key}: ${message}`);
    }
    const getter = [{ id: id(2) }]; Object.defineProperty(getter[0], record.fields[0].key, { get() { assert.fail('must not invoke'); } });
    assert.throws(() => validateRecords(record.key, getter), /plain data/);
  }
  assert.throws(() => validateRecords('unknown', []), { message: 'Unknown information list.' });
});

test('record money, frequency and dates are explicit and never generate scalar income or expense answers', () => {
  const input = { jobs: [{ id: id(3), person: 'Exact Fictional Person', employer: 'Demo Employer', amount: '1234.50', frequency: 'Every Other Week', startDate: '2026-01-01', endDate: '2026-09-30', hoursPerWeek: '37.5' }],
    housingExpenses: [{ id: id(4), person: 'Another Fictional Person', type: 'Rent', amount: '0', frequency: 'Monthly' }],
    assets: [{ id: id(5), person: '', type: 'Cash', currentValue: '50' }] };
  const p = validateProfile(input);
  assert.equal(p.jobs[0].frequency, 'Every Other Week'); assert.equal(p.assets[0].person, '');
  assert.equal(p.monthlyEarnedIncome, ''); assert.equal(p.householdWorking, ''); assert.equal(p.monthlyRent, ''); assert.equal(p.paysHousing, '');
  const money = 'Gross income per pay period must be a nonnegative dollar amount, or blank if unknown.';
  for (const [extra, message] of [[{ amount: '-1' }, money], [{ amount: '1.234' }, money], [{ amount: '1e4' }, money], [{ amount: '100000000' }, money],
    [{ frequency: 'biweekly' }, 'Choose a supported answer for How often.'], [{ startDate: '2026-02-30' }, 'Start date must be a valid date.'],
    [{ startDate: '2026-02-01', endDate: '2026-01-01' }, 'An end date cannot be before its start date.'], [{ hoursPerWeek: '168.01' }, 'Hours per week must be between 0 and 168.']]) {
    assert.throws(() => validateRecords('jobs', [{ id: id(3), ...extra }]), { message }, JSON.stringify(extra));
  }
});

test('historical statement records cannot set current earnings, jobs or citizenship and are never request fields', () => {
  const p = validateProfile({ taxStatements: [{ id: id(6), documentType: 'w2', taxYear: '2025', sourceName: 'Demo Employer', sourceRole: 'employer', recipientName: 'Fictional Person',
    annualIncome: '68450.00', annualIncomeLabel: 'Box 1 wages', annualWithholding: '8214.00', annualWithholdingLabel: 'Box 2 withholding' }] });
  assert.equal(p.monthlyEarnedIncome, ''); assert.deepEqual(p.jobs, []); assert.equal(p.usCitizen, '');
  for (const key of LIST_FIELDS) { assert.equal(REQUEST_FIELDS.includes(key), false); assert.equal(isRequestField(key), false); assert.throws(() => releasedValue(p, key), { message: 'This is not a field a page may ask for.' }, key); }
  for (const [extra, message] of [[{ taxYear: '2025.0' }, 'Tax year must contain four digits from 1900 to 2099.'], [{ documentType: 'paystub' }, 'Choose a supported answer for Document type.'],
    [{ sourceRole: 'applicant' }, 'Choose a supported answer for Source role.'], [{ annualIncome: '$2' }, 'Historical annual amount must be a nonnegative dollar amount, or blank if unknown.'],
    [{ ssn: '123-45-6789' }, 'Unknown information-list field.']]) assert.throws(() => validateRecords('taxStatements', [{ id: id(6), ...extra }]), { message }, JSON.stringify(extra));
});

test('household details stay per person, preserve explicit answers, and retain the original self-row synchronization only', () => {
  const p = validateProfile({ firstName: 'Fictional', lastName: 'Applicant', birthDate: '1985-01-02', usCitizen: 'yes', pregnant: 'no',
    householdMembers: [own({ firstName: 'Stale' }), { id: id(7), firstName: 'Child', relationship: 'child', birthDate: '2015-03-04', usCitizen: 'no',
      hasSsnAnswer: 'yes', ssn: '123-45-6789', eatsWithHousehold: 'yes', isApplicant: 'no', birthState: 'mn', ssnCardLastName: 'Other Card Name' }] }, today);
  assert.equal(p.householdMembers[0].firstName, 'Fictional'); assert.equal(p.householdMembers[0].usCitizen, '', 'no inferred copying to the self row');
  assert.equal(p.householdMembers[1].usCitizen, 'no'); assert.equal(p.householdMembers[1].birthState, 'MN'); assert.equal(p.householdAllCitizens, '');
  for (const row of p.householdMembers) assert.deepEqual(Object.keys(row).sort(), [...MEMBER_FIELDS].sort());
  for (const [extra, message] of [[{ ssn: '123', hasSsnAnswer: 'yes' }, 'Enter a nine-digit Social Security number or leave it blank.'],
    [{ ssn: '123456789', hasSsnAnswer: 'no' }, 'A household member has a Social Security number entered but having one is answered No.'], [{ pregnant: true }, 'Pregnant is invalid.'],
    [{ pregnancyDueDate: '2026-02-30' }, 'Expected due date must be a valid date.'], [{ birthState: 'ZZ' }, 'U.S. state of birth must be a recognized two-letter state or postal-region abbreviation.']]) {
    assert.throws(() => validateProfile({ householdMembers: [own(), { id: id(8), firstName: 'Other', relationship: 'other', ...extra }] }, today), { message }, JSON.stringify(extra));
  }
});

test('job-period and self-employment answers are separate explicit records, never inferred from legacy pay or taxes', () => {
  const old = validateStoredProfile({ jobs: [{ id: id(15), person: 'Fictional Owner', amount: '1000', hoursPerWeek: '40', selfEmployed: 'yes' }],
    taxStatements: [{ id: id(16), documentType: '1099-nec', annualIncome: '48000' }] });
  for (const field of ['workOrTraining', 'monthlyHours', 'tipsOrCommissions', 'incomeExpectedSame', 'changedJobs30Days',
    'stoppedWorking30Days', 'fewerHours30Days', 'selfEmploymentMonthlyNet', 'hasBusinessExpenses']) assert.equal(old.jobs[0][field], '', field);
  assert.equal(old.jobs[0].amount, '1000'); assert.equal(old.jobs[0].hoursPerWeek, '40'); assert.equal(old.monthlyEarnedIncome, '');
  const saved = validateRecords('jobs', [{ id: id(15), workOrTraining: 'Work', monthlyHours: '744', tipsOrCommissions: '0',
    incomeExpectedSame: 'no', changedJobs30Days: 'yes', stoppedWorking30Days: 'no', fewerHours30Days: 'no',
    selfEmploymentMonthlyNet: '1250.50', hasBusinessExpenses: 'yes' }])[0];
  assert.equal(saved.monthlyHours, '744'); assert.equal(saved.selfEmploymentMonthlyNet, '1250.50');
  assert.equal(saved.amount, ''); assert.equal(saved.selfEmployed, '');
  for (const value of ['0', '0.25', '160.50', '744']) assert.equal(validateRecords('jobs', [{ id: id(1), monthlyHours: value }])[0].monthlyHours, value);
  for (const extra of [{ monthlyHours: '-1' }, { monthlyHours: '744.01' }, { monthlyHours: '1e2' }, { monthlyHours: '1.001' },
    { workOrTraining: 'work' }, { workOrTraining: 'Self-employed' }, { tipsOrCommissions: '-1' }, { selfEmploymentMonthlyNet: '100000000' },
    { incomeExpectedSame: true }, { hasBusinessExpenses: 'Yes' }, { payFrequency: 'Monthly' }, { grossPay: '1' }]) {
    assert.throws(() => validateRecords('jobs', [{ id: id(1), ...extra }]), JSON.stringify(extra));
  }
});

test('captured current-address energy assistance and uncovered aged/disabled medical questions never inherit broader answers', () => {
  for (const value of ['yes', 'no']) {
    const stored = validateStoredProfile({ receivedEnergyAssistance: value, paysMedical: value, paysMedicare: value });
    assert.equal(stored.receivedEnergyAssistanceCurrentAddress, '');
    assert.equal(stored.paysUncoveredAgedDisabledMedical, '');
    const explicit = validateProfile({ receivedEnergyAssistance: value, paysMedical: value,
      receivedEnergyAssistanceCurrentAddress: value === 'yes' ? 'no' : 'yes', paysUncoveredAgedDisabledMedical: value === 'yes' ? 'no' : 'yes' });
    assert.equal(explicit.receivedEnergyAssistance, value); assert.equal(explicit.paysMedical, value);
    assert.notEqual(explicit.receivedEnergyAssistanceCurrentAddress, value); assert.notEqual(explicit.paysUncoveredAgedDisabledMedical, value);
  }
  for (const key of ['receivedEnergyAssistanceCurrentAddress', 'paysUncoveredAgedDisabledMedical']) {
    assert.ok(SNAP_IOWA_ONLY_FIELDS.includes(key));
    assert.throws(() => validateProfile({ [key]: true }));
  }
});

test('person-owned utilities stay separate from household utility answers and never receive inferred owners', () => {
  const p = validateStoredProfile({ utilityGas: 'yes', utilityElectricity: 'no', monthlyUtilities: '300', firstName: 'Avery' });
  assert.deepEqual(p.utilityExpenses, []);
  const row = validateProfile({ utilityGas: 'yes', utilityElectricity: 'no', utilityExpenses: [{ id: id(18), person: 'Other Person', gas: 'no', electricity: 'yes' }] }).utilityExpenses[0];
  assert.equal(row.person, 'Other Person'); assert.equal(row.gas, 'no'); assert.equal(row.electricity, 'yes');
  for (const key of ['waterSewage', 'telephone', 'petFees', 'garageRent', 'landlordExtra', 'garbage', 'heatingCooling']) assert.equal(row[key], '');
  assert.equal(validateRecords('utilityExpenses', [{ id: id(18) }])[0].person, '');
  assert.equal(isRequestField('utilityExpenses'), false);
  for (const extra of [{ gas: true }, { gas: 'Yes' }, { utilityGas: 'yes' }, { amount: '300' }]) assert.throws(() => validateRecords('utilityExpenses', [{ id: id(18), ...extra }]));
});

test('own-or-buy property, conservatorship-or-trust, and registered vehicles remain separate explicit answers', () => {
  const pairs = [['hasRealProperty', 'ownsOrBuyingProperty'], ['hasTrust', 'hasConservatorshipOrTrust'], ['hasVehicle', 'ownsOrRegisteredVehicle']];
  for (const [oldKey, newKey] of pairs) for (const value of ['yes', 'no']) {
    const legacy = validateStoredProfile({ [oldKey]: value }); assert.equal(legacy[newKey], ''); assert.equal(legacy[oldKey], value);
    const explicit = validateProfile({ [oldKey]: value, [newKey]: value === 'yes' ? 'no' : 'yes' });
    assert.equal(explicit[oldKey], value); assert.notEqual(explicit[newKey], value); assert.ok(SNAP_IOWA_ONLY_FIELDS.includes(newKey));
    assert.throws(() => validateProfile({ [newKey]: true }));
  }
});
