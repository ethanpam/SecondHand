'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const policy = require('../extension/address-policy.js');
const request = (count = 1) => ({ scope: 'home', candidates: Array.from({ length: count }, (_, index) => ({ id: `homeAddressIndex${index}`, index, role: 'suggestion' })), hasWarnings: false, hasErrors: false, hasUnknownControls: false });

test('first verified home suggestion is the explicit policy, including multiple suggestions', () => {
  for (const count of [1, 2, 8]) assert.deepEqual(policy.decide(request(count)), { eligible: true, reason: 'FIRST_HOME_SUGGESTION', candidateIndex: 0 });
  assert.equal(policy.decide(request(0)).reason, 'NO_CANDIDATES');
});

test('entered-original fallback, missing/reordered/duplicate indexes and unbounded choices fail closed', () => {
  const cases = [request(9), { ...request(), candidates: [{ id: 'homeAddressIndex0', index: 0, role: 'original' }] },
    { ...request(), candidates: [{ id: 'homeAddressIndex1', index: 1, role: 'suggestion' }] },
    { ...request(), candidates: [request().candidates[0], request().candidates[0]] },
    { ...request(), candidates: [{ id: 'homeAddressIndex0', index: '0', role: 'suggestion' }] }];
  for (const item of cases) assert.equal(policy.decide(item).eligible, false);
});

test('mailing addresses and warnings/errors/unverified controls always pause', () => {
  assert.equal(policy.decide({ ...request(), scope: 'mailing' }).reason, 'INVALID_SCOPE');
  for (const [key, reason] of [['hasWarnings', 'WARNINGS_PRESENT'], ['hasErrors', 'ERRORS_PRESENT'], ['hasUnknownControls', 'UNKNOWN_CONTROLS']]) {
    assert.equal(policy.decide({ ...request(), [key]: true }).reason, reason);
    for (const value of [undefined, null, '', 0, 'false']) assert.equal(policy.decide({ ...request(), [key]: value }).reason, 'INVALID_REQUEST');
    const missing = request(); delete missing[key]; assert.equal(policy.decide(missing).reason, 'INVALID_REQUEST');
  }
});

test('addresses are neither accepted nor echoed; obsolete equivalence requests are invalid', () => {
  const privateAddress = '411 MORRILL RD';
  const result = policy.decide({ ...request(), submitted: privateAddress });
  assert.equal(result.eligible, false);
  assert.doesNotMatch(JSON.stringify(result), /MORRILL/);
  assert.equal(policy.decide({ ...request(), candidates: [{ ...request().candidates[0], address: privateAddress }] }).eligible, false);
  assert.deepEqual(Object.keys(policy.decide(request())), ['eligible', 'reason', 'candidateIndex']);
});

test('strict plain metadata rejects getters, prototype payloads, sparse arrays, and extra keys without reading getters', () => {
  let reads = 0;
  const accessor = request(); Object.defineProperty(accessor, 'scope', { enumerable: true, get() { reads++; return 'home'; } });
  const arrayGetter = request(); Object.defineProperty(arrayGetter.candidates, '0', { enumerable: true, get() { reads++; return request().candidates[0]; } });
  const sparse = request(); sparse.candidates = new Array(1);
  const extraArray = request(); extraArray.candidates.extra = true;
  const candidateGetter = request(); Object.defineProperty(candidateGetter.candidates[0], 'role', { enumerable: true, get() { reads++; return 'suggestion'; } });
  for (const input of [accessor, arrayGetter, sparse, extraArray, candidateGetter, Object.create(request()), null, [], { ...request(), extra: true }]) assert.equal(policy.decide(input).eligible, false);
  assert.equal(reads, 0);
});

test('policy has a browser export and immutable value-free results', () => {
  const sandbox = {}; vm.runInNewContext(fs.readFileSync(require.resolve('../extension/address-policy.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.SecondHandAddressPolicy.decide, 'function');
  const result = policy.decide(request()); assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(policy), true);
});
