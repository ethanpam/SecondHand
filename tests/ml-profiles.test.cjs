'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateHouseholds } = require('../ML_model/profiles/generate.cjs');
const { validateProfile, PROFILE_FIELDS } = require('../shared/schema.cjs');
const { buildFacts } = require('../shared/facts.cjs');

const TODAY = '2026-09-26';
const households = generateHouseholds({ count: 2000, seed: 7, today: TODAY });
const ageOf = birthDate => {
  const [y, m, d] = birthDate.split('-').map(Number);
  return 2026 - y - (9 < m || (9 === m && 26 < d) ? 1 : 0);
};
const share = predicate => households.filter(predicate).length / households.length;

test('the same seed always gives the same households, and another seed gives others', () => {
  assert.deepEqual(generateHouseholds({ count: 50, seed: 7, today: TODAY }), households.slice(0, 50));
  assert.notDeepEqual(generateHouseholds({ count: 50, seed: 8, today: TODAY }), households.slice(0, 50));
  assert.throws(() => generateHouseholds({ count: 0, seed: 7, today: TODAY }), /count/);
  assert.throws(() => generateHouseholds({ count: 10, seed: 1.5, today: TODAY }), /seed/);
});

test('every household is a valid saved profile that the facts builder accepts', () => {
  for (const profile of households) {
    assert.ok(Object.keys(profile).every(key => PROFILE_FIELDS.includes(key)));
    assert.doesNotThrow(() => validateProfile(profile));
    assert.doesNotThrow(() => buildFacts(profile, { today: TODAY }));
  }
});

test('households are fictional: no names, contact details, street address or SSN', () => {
  for (const profile of households) {
    for (const field of ['firstName', 'middleName', 'lastName', 'maidenName', 'ssn', 'email', 'phone', 'homePhone', 'mobilePhone', 'addressLine1', 'addressLine2',
      'mailingAddressLine1', 'mailingAddressLine2']) assert.equal(profile[field] || '', '', field);
  }
});

test('household counts add up and agree with the applicant age', () => {
  for (const profile of households) {
    const counts = ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'].map(field => profile[field]);
    if (counts.every(Boolean)) assert.equal(Number(counts[0]), Number(counts[1]) + Number(counts[2]) + Number(counts[3]));
    if (!profile.birthDate) continue;
    const age = ageOf(profile.birthDate);
    assert.ok(age >= 18 && age <= 95, `applicant age ${age}`);
    if (age >= 65 && profile.householdSeniors) assert.ok(Number(profile.householdSeniors) >= 1, 'a senior applicant counts as a senior');
    if (age < 65 && profile.householdAdults) assert.ok(Number(profile.householdAdults) >= 1, 'an adult applicant counts as an adult');
  }
});

test('the households cover the situations the model must learn, including missing answers', () => {
  const between = (value, low, high, what) => assert.ok(value >= low && value <= high, `${what}: ${value}`);
  between(share(p => p.state === 'IA'), 0.4, 0.8, 'Iowa share');
  between(share(p => p.state && p.state !== 'IA'), 0.1, 0.6, 'other states');
  between(share(p => p.hasHomeAddress === 'no'), 0.02, 0.15, 'no home address');
  between(share(p => Number(p.householdSeniors) > 0), 0.1, 0.5, 'households with a senior');
  between(share(p => Number(p.householdChildren) > 0), 0.2, 0.7, 'households with children');
  between(share(p => p.householdVeteran === 'yes'), 0.03, 0.25, 'veterans');
  between(share(p => p.householdAllCitizens === 'no'), 0.03, 0.25, 'not all citizens');
  between(share(p => p.monthlyEarnedIncome === '0'), 0.1, 0.5, 'no earned income');
  between(share(p => Number(p.householdSize) >= 6), 0.02, 0.2, 'large households');
  for (const field of ['birthDate', 'householdSize', 'householdSeniors', 'monthlyEarnedIncome', 'county', 'householdVeteran']) {
    between(share(p => !p[field]), 0.03, 0.3, `${field} missing`);
  }
  const ages = households.filter(p => p.birthDate).map(p => ageOf(p.birthDate));
  for (const [low, high] of [[18, 24], [25, 54], [55, 64], [65, 95]]) assert.ok(ages.some(age => age >= low && age <= high), `ages ${low}-${high}`);
});
