'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const policy = require('../extension/address-policy.js');
const profile = require('./fixtures/applicant-profile.json');

// These addresses are fictional QA data. No test contacts the Iowa portal.
const home = () => ({ line1: profile.addressLine1, line2: profile.addressLine2, city: profile.city, state: profile.state, zip: profile.zip });
const mailing = () => ({ line1: profile.mailingAddressLine1, line2: profile.mailingAddressLine2, city: profile.mailingCity, state: profile.mailingState, zip: profile.mailingZip });
function request(overrides = {}) {
  return { scope: 'home', submitted: home(), candidates: [{ id: 'suggestion_1', address: home() }], hasWarnings: false, hasErrors: false, ...overrides };
}
const compare = (candidate, submitted = home()) => policy.decide(request({ submitted, candidates: [{ id: 'suggestion_1', address: candidate }] }));
function assertManual(result, reason) {
  assert.equal(result.eligible, false);
  assert.equal(result.candidateIndex, null);
  if (reason) assert.equal(result.reason, reason);
  assert.ok(Object.values(policy.REASONS).includes(result.reason));
  assert.ok(result.differingComponents.every(component => policy.COMPONENTS.includes(component)));
}

test('one equivalent candidate is eligible separately for home and mailing scopes', () => {
  for (const [scope, submitted] of [['home', home()], ['mailing', mailing()]]) {
    const result = policy.decide(request({ scope, submitted, candidates: [{ id: 'candidate_1', address: { ...submitted } }] }));
    assert.deepEqual(result, { eligible: true, reason: 'SINGLE_EQUIVALENT_CANDIDATE', candidateIndex: 0, differingComponents: [] });
  }
  assertManual(policy.decide(request({ scope: 'home-and-mailing' })), 'INVALID_SCOPE');
  assertManual(compare(mailing()), 'ADDRESS_DIFFERENT');
});

test('only ASCII case and whitespace formatting may differ', () => {
  const candidate = { line1: '  123   TEST\tWAY ', line2: '\n UNIT  4\r\n', city: ' DEMO\u00a0CITY ', state: ' ia ', zip: ' 50309\n' };
  assert.equal(compare(candidate).eligible, true);
  const submitted = { ...home(), line2: 'Apt 4' };
  assert.equal(compare({ ...submitted, line2: 'APT 4' }, submitted).eligible, true);
  assertManual(compare({ ...home(), line2: 'Unit4' }), 'ADDRESS_DIFFERENT');
  assertManual(compare({ ...home(), line1: '123 Test Wy' }), 'ADDRESS_DIFFERENT');
  assertManual(compare({ ...home(), line2: 'Apartment 4' }), 'ADDRESS_DIFFERENT');
  // No Unicode case folding/transliteration can merge distinct street names.
  assertManual(compare({ ...home(), line1: '123 STRASSE' }, { ...home(), line1: '123 Straße' }), 'ADDRESS_DIFFERENT');
});

test('house, street, direction, unit, city, state, and ZIP changes all pause', () => {
  for (const [component, value] of [
    ['line1', '124 Test Way'], ['line1', '123 Other Way'], ['line1', '123 East Test Way'],
    ['line1', '123 Test Way North'], ['line2', 'Unit 5'], ['line2', ''],
    ['city', 'Other City'], ['state', 'MN'], ['zip', '50310'], ['zip', '50309-1234']
  ]) {
    const result = compare({ ...home(), [component]: value });
    assertManual(result, 'ADDRESS_DIFFERENT');
    assert.deepEqual(result.differingComponents, [component]);
  }
  const noUnit = { ...home(), line2: '' };
  assertManual(compare(home(), noUnit), 'ADDRESS_DIFFERENT');
  assert.deepEqual(compare(mailing()).differingComponents, ['line1', 'line2']);
});

test('punctuation, fractions, hyphens, token boundaries, and ZIP extensions are preserved', () => {
  for (const [original, candidate] of [
    ['12-14 Test Way', '1214 Test Way'], ['12 1/2 Test Way', '12 12 Test Way'],
    ['123 N. Test Way', '123 N Test Way'], ['123 Test-Way', '123 Test Way'],
    ['123 Test Way', '123 TestWay'], ['PO Box 12', 'PO Box 1 2']
  ]) assertManual(compare({ ...home(), line1: candidate }, { ...home(), line1: original }), 'ADDRESS_DIFFERENT');
  const extended = { ...home(), zip: '50309-1234' };
  assert.equal(compare(extended, extended).eligible, true);
  assertManual(compare({ ...extended, zip: '50309-1235' }, extended), 'ADDRESS_DIFFERENT');
  assertManual(compare({ ...extended, zip: '50309 1234' }, extended), 'INVALID_CANDIDATE');
});

test('warnings and errors are explicit booleans and always prevent automatic acceptance', () => {
  assertManual(policy.decide(request({ hasWarnings: true })), 'WARNINGS_PRESENT');
  assertManual(policy.decide(request({ hasErrors: true })), 'ERRORS_PRESENT');
  assertManual(policy.decide(request({ hasWarnings: true, hasErrors: true })), 'ERRORS_PRESENT');
  for (const name of ['hasWarnings', 'hasErrors']) {
    for (const value of [undefined, null, 0, 1, '', 'false', [], {}]) assertManual(policy.decide(request({ [name]: value })), 'INVALID_REQUEST');
    const input = request(); delete input[name];
    assertManual(policy.decide(input), 'INVALID_REQUEST');
  }
});

test('multiple candidates always pause even if exactly one or all addresses match', () => {
  assertManual(policy.decide(request({ candidates: [] })), 'NO_CANDIDATES');
  for (const second of [home(), { ...home(), line1: '999 Other Street' }]) {
    const candidates = [{ id: 'one', address: home() }, { id: 'two', address: second }];
    assertManual(policy.decide(request({ candidates })), 'MULTIPLE_CANDIDATES');
  }
  const duplicates = [{ id: 'same', address: home() }, { id: 'same', address: home() }];
  assertManual(policy.decide(request({ candidates: duplicates })), 'DUPLICATE_CANDIDATE_ID');
});

test('incomplete or malformed addresses fail closed; absent unit must be an explicit empty string', () => {
  const invalid = [null, [], 'address', {}, { ...home(), extra: 'unverified' }];
  for (const component of policy.COMPONENTS) {
    const missing = home(); delete missing[component]; invalid.push(missing);
    for (const value of [null, undefined, false, 123, [], {}]) invalid.push({ ...home(), [component]: value });
    if (component !== 'line2') invalid.push({ ...home(), [component]: ' \t\n' });
  }
  invalid.push({ ...home(), state: 'ZZ' }, { ...home(), state: 'Iowa' }, { ...home(), zip: '1234' }, { ...home(), zip: '123456789' });
  for (const submitted of invalid) assertManual(policy.decide(request({ submitted })), 'INVALID_SUBMITTED_ADDRESS');
  for (const address of invalid) assertManual(policy.decide(request({ candidates: [{ id: 'one', address }] })), 'INVALID_CANDIDATE');
  assert.equal(compare({ ...home(), line2: '' }, { ...home(), line2: '' }).eligible, true);
});

test('input sizes and candidate identifiers are bounded', () => {
  const maximums = { line1: 160, line2: 160, city: 80, state: 16, zip: 24 };
  for (const [component, size] of Object.entries(maximums)) {
    assertManual(policy.decide(request({ submitted: { ...home(), [component]: 'A'.repeat(size + 1) } })), 'INVALID_SUBMITTED_ADDRESS');
  }
  for (const id of ['', 'a'.repeat(81), '../selector', '#input', 'private address', 1, null]) {
    assertManual(policy.decide(request({ candidates: [{ id, address: home() }] })), 'INVALID_CANDIDATE');
  }
  assertManual(policy.decide(request({ candidates: Array.from({ length: 9 }, (_, index) => ({ id: String(index), address: home() })) })), 'INVALID_CANDIDATES');
  assertManual(policy.decide(request({ candidates: Array.from({ length: 8 }, (_, index) => ({ id: String(index), address: home() })) })), 'MULTIPLE_CANDIDATES');
});

test('strict data schemas reject unknown fields, accessors, prototypes, and exotic arrays without invoking getters', () => {
  for (const input of [null, [], 'request', request({ unknown: 'answer' }), Object.assign(new Date(), request())]) assertManual(policy.decide(input), 'INVALID_REQUEST');
  let getterCalls = 0;
  const candidate = { id: 'one', address: home() };
  Object.defineProperty(candidate, 'address', { enumerable: true, get() { getterCalls++; return home(); } });
  assertManual(policy.decide(request({ candidates: [candidate] })), 'INVALID_CANDIDATE');
  const submitted = home();
  Object.defineProperty(submitted, 'line1', { enumerable: true, get() { getterCalls++; return '123 Test Way'; } });
  assertManual(policy.decide(request({ submitted })), 'INVALID_SUBMITTED_ADDRESS');
  const array = [{ id: 'one', address: home() }];
  Object.defineProperty(array, '0', { enumerable: true, get() { getterCalls++; return candidate; } });
  assertManual(policy.decide(request({ candidates: array })), 'INVALID_CANDIDATES');
  assert.equal(getterCalls, 0);
  const sparse = new Array(1);
  assertManual(policy.decide(request({ candidates: sparse })), 'INVALID_CANDIDATES');
  const extraArray = []; extraArray.note = 'extra';
  assertManual(policy.decide(request({ candidates: extraArray })), 'INVALID_CANDIDATES');
  const symbolInput = request(); symbolInput[Symbol('unknown')] = 'private';
  assertManual(policy.decide(symbolInput), 'INVALID_REQUEST');
  const inheritedAddress = Object.create(home());
  assertManual(policy.decide(request({ submitted: inheritedAddress })), 'INVALID_SUBMITTED_ADDRESS');
  const nullPrototype = Object.assign(Object.create(null), home());
  assert.equal(compare(nullPrototype, nullPrototype).eligible, true);
});

test('invisible and bidi characters cannot be normalized into an automatic match', () => {
  for (const character of ['\0', '\u0007', '\u007f', '\u200b', '\u200e', '\u202e', '\u2066', '\ufeff', '\u1680', '\u2028', '\u3000']) {
    const changed = { ...home(), line1: `123${character} Test Way` };
    assertManual(compare(changed), 'INVALID_CANDIDATE');
    assertManual(compare(changed, changed), 'INVALID_SUBMITTED_ADDRESS');
  }
});

test('results are deterministic, immutable, and contain only static reasons, component names, and an index', () => {
  const input = request({ candidates: [{ id: 'private_candidate_id', address: { ...home(), city: 'Private Town', line2: 'Secret Unit' } }] });
  const before = JSON.stringify(input);
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  freeze(input);
  const first = policy.decide(input), second = policy.decide(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.differingComponents), true);
  assert.deepEqual(Object.keys(first).sort(), ['candidateIndex', 'differingComponents', 'eligible', 'reason']);
  assert.deepEqual(first.differingComponents, ['line2', 'city']);
  assert.doesNotMatch(JSON.stringify(first), /Private|Secret|private_candidate|Test Way|Demo City|50309/);
});

test('browser UMD export operates in an empty JavaScript context without DOM or network APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension/address-policy.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const input = JSON.stringify(request());
  const result = vm.runInContext(`SecondHandAddressPolicy.decide(${input})`, context);
  assert.equal(result.eligible, true);
  assert.equal(result.candidateIndex, 0);
  assert.equal(result.reason, 'SINGLE_EQUIVALENT_CANDIDATE');
});
