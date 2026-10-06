'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewProfile, reviewDocumentFields } = require('../shared/field-review.cjs');
const { createFieldReview, LIMITS } = require('../desktop/field-review.cjs');
const { SNAP_INFORMATION, PROFILE_FIELDS, MAX_PROFILE_REVIEW_ROWS } = require('../shared/schema.cjs');
const REVIEW_FIELDS = PROFILE_FIELDS.filter(key => key !== 'customFields');
const options = { today: '2026-10-05' };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const byKey = input => Object.fromEntries(reviewProfile(input, options).map(row => [row.key, row]));

test('SNAP source answers remain advisory, and malformed contacts, dates and choices need review', () => {
  const result = byKey({ ssnCardFirstName: 'Private Card Name', iowaResident: 'no', birthState: 'ia', race: 'Own description', preferredLanguage: 'Own language', helperPhone: '2025550147',
    representativeEmail: 'bad', pregnancyDueDate: '2026-02-30', paysUtilities: 'maybe' });
  for (const key of ['ssnCardFirstName', 'iowaResident', 'race', 'preferredLanguage']) assert.equal(result[key].status, 'check-source');
  for (const key of ['birthState', 'helperPhone']) assert.equal(result[key].status, 'format-passed');
  for (const key of ['representativeEmail', 'pregnancyDueDate', 'paysUtilities']) assert.equal(result[key].status, 'needs-review');
  assert.ok(!JSON.stringify(result).includes('Private Card Name'));
});

test('repeating records receive bounded fixed-key reviews without exposing their values or inferring household totals', () => {
  const input = { jobs: [{ id: id(1), person: 'Private Person', employer: 'Private Employer', amount: '100.00', frequency: 'Weekly', startDate: '2026-02-01', endDate: '2026-01-01' }],
    medicalExpenses: [{ id: id(2), type: 'Private treatment', amount: '-1', expenseDate: '2026-02-30' }],
    taxStatements: [{ id: id(3), documentType: 'w2', taxYear: '2025', annualIncome: '68450.00' }] };
  const before = structuredClone(input), result = byKey(input);
  assert.equal(result['jobs.0.person'].status, 'check-source');
  assert.equal(result['jobs.0.amount'].status, 'format-passed');
  assert.equal(result['jobs.0.startDate'].status, 'needs-review'); assert.equal(result['jobs.0.endDate'].status, 'needs-review');
  assert.equal(result['medicalExpenses.0.amount'].status, 'needs-review'); assert.equal(result['medicalExpenses.0.expenseDate'].status, 'needs-review');
  assert.equal(result['taxStatements.0.annualIncome'].status, 'check-source');
  assert.match(result['taxStatements.0.annualIncome'].messages.join(' '), /Historical statement/);
  assert.equal(result.monthlyEarnedIncome.status, 'empty'); assert.equal(result.householdWorking.status, 'empty');
  assert.doesNotMatch(JSON.stringify(result), /Private Person|Private Employer|Private treatment|68450/);
  assert.deepEqual(input, before);
});

test('all expanded household details are reviewed by stable index with SSN safety and no household-to-person guesses', () => {
  const result = byKey({ firstName: 'Fictional', usCitizen: 'yes', householdMembers: [{ id: id(1), firstName: 'Fictional', relationship: 'self' },
    { id: id(2), firstName: 'Child', relationship: 'child', hasSsnAnswer: 'no', ssn: '000-12-3456', usCitizen: 'no', pregnant: 'maybe', birthState: 'ZZ' }] });
  for (const field of SNAP_INFORMATION.memberFields) assert.ok(result[`householdMembers.1.${field.key}`], field.key);
  for (const key of ['ssn', 'hasSsnAnswer', 'pregnant', 'birthState']) assert.equal(result[`householdMembers.1.${key}`].status, 'needs-review');
  assert.equal(result['householdMembers.0.usCitizen'].status, 'empty');
  assert.equal(result['householdMembers.1.usCitizen'].status, 'check-source');
  assert.doesNotMatch(JSON.stringify(result), /000-12-3456/);
});

test('corrupt record lists cannot execute accessors or make unbounded review results', () => {
  let accesses = 0;
  const job = { id: id(1) }; Object.defineProperty(job, 'amount', { get() { accesses++; throw new Error('private'); } });
  const result = byKey({ jobs: [job, { id: id(1) }], assets: Array.from({ length: 1000 }, () => null) });
  assert.equal(accesses, 0); assert.equal(result.jobs.status, 'needs-review'); assert.equal(result.assets.status, 'needs-review');
  assert.equal(result['jobs.0.amount'].status, 'needs-review');
  const maxRows = REVIEW_FIELDS.length + 2 * SNAP_INFORMATION.records.find(row => row.key === 'jobs').fields.length + 20 * SNAP_INFORMATION.records.find(row => row.key === 'assets').fields.length;
  assert.equal(Object.keys(result).length, maxRows);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('desktop review accepts bounded lists but never passes their sensitive values or new SNAP answers to Laya', async () => {
  const requests = [];
  const laya = { status: async () => ({ state: 'ready', enabled: true }), format: async () => 'noul-v1', decideBatch: async items => { requests.push(items); return items.map(() => ({ answers: { correct: { type: 'noul', noul: 0.1 } } })); } };
  const input = { profile: { iowaResident: 'yes', immigrationStatus: 'Private immigration detail', jobs: [{ id: id(1), employer: 'Secret Employer', person: 'Secret Person', amount: '4123.45' }],
    householdMembers: [{ id: id(2), firstName: 'Secret Person', relationship: 'self', ssn: '123-45-6789' }] }, useLaya: true,
    documentFields: [{ id: 'address', label: 'Address', sourceLabel: 'Home address', sourceRole: 'applicant', profileKey: 'addressLine1', value: '23 Private Street' }] };
  const before = structuredClone(input), result = await createFieldReview({ laya }).review(input, options);
  assert.ok(requests.length > 0);
  const sent = JSON.stringify(requests);
  assert.doesNotMatch(sent, /Secret|4123|123-45|immigration|23 Private|iowaResident/);
  assert.equal(result.profile.find(row => row.key === 'jobs.0.employer').status, 'check-source');
  assert.deepEqual(input, before);
  for (const profile of [{ jobs: [{ id: id(1), password: 'secret' }] }, { jobs: new Array(1) }, { jobs: Array.from({ length: 21 }, () => ({ id: id(1) })) }]) {
    await assert.rejects(createFieldReview().review({ profile }, options), /invalid or too large/);
  }
  await assert.rejects(createFieldReview().review({ documentFields: [{ profileKey: 'jobs', value: '[]' }] }), /invalid or too large/);
});

test('employer, payer and issuer provenance stays review-only and is never eligible for the local label model', async () => {
  for (const sourceRole of ['employer', 'payer', 'issuer']) {
    let calls = 0;
    const field = { id: sourceRole, sourceRole, sourceLabel: 'First name', label: 'Name', profileKey: 'firstName', value: 'Private Entity' };
    assert.equal(reviewDocumentFields([field], {}, options)[0].status, 'needs-review');
    const result = await createFieldReview({ laya: { status() { calls++; throw new Error('must not call'); } } }).review({ useLaya: true, documentFields: [field] }, options);
    assert.equal(calls, 0); assert.equal(result.document[0].status, 'needs-review'); assert.equal(result.laya.state, 'unsupported');
  }
});

test('desktop review rejects custom answer lists before any model call and does not reflect their contents', async () => {
  let calls = 0;
  const fail = () => { calls++; throw new Error('Model must not be called'); };
  const review = createFieldReview({ laya: { status: fail, format: fail, decideBatch: fail } });
  const customFields = [{ id: id(1), label: 'Private custom question', value: 'Private custom answer', aliases: ['Private custom alias'] }];
  await assert.rejects(review.review({ profile: { customFields }, useLaya: true,
    documentFields: [{ id: 'address', sourceLabel: 'Home address', sourceRole: 'applicant', profileKey: 'addressLine1', value: 'Fictional address' }] }),
  error => /invalid or too large/.test(error.message) && !/Private custom/.test(error.message));
  assert.equal(calls, 0);
});

test('the maximum-sized local review includes the last member and every last record without truncation', async () => {
  const profile = { householdMembers: Array.from({ length: 20 }, (_, index) => ({ id: id(index + 1), firstName: 'Fictional', relationship: index ? 'other' : 'self' })) };
  for (const record of SNAP_INFORMATION.records) profile[record.key] = Array.from({ length: 20 }, (_, index) => ({ id: id(index + 1),
    ...Object.fromEntries(record.fields.map(field => [field.key, ''])) }));
  const result = await createFieldReview().review({ profile }, options);
  assert.equal(result.profile.length, MAX_PROFILE_REVIEW_ROWS);
  assert.equal(result.profile.length, LIMITS.profileResults);
  assert.ok(result.profile.some(row => row.key === 'householdMembers.19.medicare'));
  for (const record of SNAP_INFORMATION.records) assert.ok(result.profile.some(row => row.key === `${record.key}.19.${record.fields.at(-1).key}`));
});
