'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFacts, factsText, SENSITIVE_SOURCES } = require('../shared/facts.cjs');
const fixture = require('./fixtures/applicant-profile.json');

const TODAY = '2026-09-26';
const household = {
  birthDate: '1985-04-12', state: 'IA', county: 'Polk', city: 'Demo City', zip: '50309', hasHomeAddress: 'yes',
  householdSize: '3', householdAdults: '2', householdChildren: '1', householdSeniors: '0',
  householdVeteran: 'no', householdDisability: 'yes', householdPregnant: 'no', householdMedicare: 'no', householdAllCitizens: 'yes',
  monthlyEarnedIncome: '900', monthlyOtherIncome: '100', monthlyRent: '800', monthlyUtilities: '150', assetsOnHand: '250.75', monthlyMedicalExpenses: '40',
  programSnap: 'yes', programFip: 'no', programMedicaid: 'yes'
};
const byId = facts => Object.fromEntries(facts.map(fact => [fact.id, fact.text]));

test('a saved profile becomes short plain facts, with every calculation done in code', () => {
  assert.deepEqual(byId(buildFacts(household, { today: TODAY })), {
    'applicant.age': 'The applicant is 41 years old.',
    'applicant.ageBand': 'The applicant is 18 or older and younger than 55.',
    'household.size': 'The household has 3 people.',
    'household.adults': 'The household has 2 adults aged 18 to 64.',
    'household.children': 'The household has 1 child under 18.',
    'household.seniors': 'Nobody in the household is 65 or older.',
    'household.veteran': 'Nobody in the household is a veteran.',
    'household.disability': 'Someone in the household has a disability.',
    'household.pregnant': 'Nobody in the household is pregnant.',
    'household.medicare': 'Nobody in the household gets Medicare.',
    'household.citizens': 'Everyone in the household is a US citizen.',
    'address.home': 'The applicant has a home address.',
    'address.state': 'The applicant lives in Iowa.',
    'address.county': 'The applicant lives in Polk County.',
    'address.city': 'The applicant lives in Demo City.',
    'address.zip': 'The applicant’s ZIP code is 50309.',
    'income.earned': 'The household earns $900 a month from work.',
    'income.other': 'The household gets $100 a month from other income.',
    'income.total': 'The household’s total income is $1,000 a month ($12,000 a year).',
    'housing.rent': 'Rent or mortgage costs $800 a month.',
    'housing.utilities': 'Utilities cost $150 a month.',
    'money.assets': 'The household has $250.75 in cash, checking and savings.',
    'medical.costs': 'The household pays $40 a month in medical costs.',
    'program.snap': 'The applicant is applying for SNAP food assistance.',
    'program.fip': 'The applicant is not applying for FIP cash assistance.',
    'program.medicaid': 'The applicant is applying for Medicaid health coverage.'
  });
});

test('ages count whole years and change on the birthday, not before', () => {
  const age = today => byId(buildFacts({ birthDate: '1966-09-27' }, { today }))['applicant.age'];
  assert.equal(age('2026-09-26'), 'The applicant is 59 years old.');
  assert.equal(age('2026-09-27'), 'The applicant is 60 years old.');
  const band = birthDate => byId(buildFacts({ birthDate }, { today: TODAY }))['applicant.ageBand'];
  assert.equal(band('2010-01-01'), 'The applicant is younger than 18.');
  assert.equal(band('1968-01-01'), 'The applicant is 55 or older and younger than 60.');
  assert.equal(band('1965-01-01'), 'The applicant is 60 or older and younger than 62.');
  assert.equal(band('1963-01-01'), 'The applicant is 62 or older and younger than 65.');
  assert.equal(band('1950-01-01'), 'The applicant is 65 or older.');
});

test('missing answers leave their facts out instead of guessing', () => {
  assert.deepEqual(buildFacts({}, { today: TODAY }), []);
  const partial = byId(buildFacts({ monthlyEarnedIncome: '900', householdChildren: '0', county: 'Polk County' }, { today: TODAY }));
  assert.deepEqual(partial, {
    'household.children': 'The household has no children under 18.',
    'address.county': 'The applicant lives in Polk County.',
    'income.earned': 'The household earns $900 a month from work.'
  }, 'a total is never stated from only one part of the income');
  assert.equal(byId(buildFacts({ monthlyEarnedIncome: '0' }, { today: TODAY }))['income.earned'], 'The household has no income from work.');
});

test('facts never claim more than the saved counts prove', () => {
  // The profile counts people 65 and older, so a senior applicant with a count of 0 is a contradiction: say nothing about the household.
  const senior = byId(buildFacts({ birthDate: '1950-01-01', householdSeniors: '0' }, { today: TODAY }));
  assert.equal(senior['household.seniors'], undefined);
  assert.equal(senior['applicant.ageBand'], 'The applicant is 65 or older.');
  assert.equal(byId(buildFacts({ householdSeniors: '2' }, { today: TODAY }))['household.seniors'], 'The household has 2 people aged 65 or older.');
  // Non-citizen legal status is only stated when not everyone is a citizen.
  assert.equal(byId(buildFacts({ householdAllCitizens: 'yes', householdLegalStatus: 'no' }, { today: TODAY }))['household.legalStatus'], undefined);
  assert.equal(byId(buildFacts({ householdAllCitizens: 'no', householdLegalStatus: 'yes' }, { today: TODAY }))['household.legalStatus'],
    'Household members who are not US citizens have legal documents to stay in the US.');
  assert.equal(byId(buildFacts({ hasHomeAddress: 'no' }, { today: TODAY }))['address.home'], 'The applicant does not have a home address.');
});

test('each fact names its saved fields and is marked sensitive when any of them is', () => {
  const facts = Object.fromEntries(buildFacts(household, { today: TODAY }).map(fact => [fact.id, fact]));
  assert.deepEqual(facts['income.total'].sources, ['monthlyEarnedIncome', 'monthlyOtherIncome']);
  assert.deepEqual(facts['applicant.age'].sources, ['birthDate']);
  for (const id of ['applicant.age', 'applicant.ageBand', 'income.earned', 'income.other', 'income.total', 'money.assets', 'medical.costs',
    'household.disability', 'household.pregnant', 'household.medicare', 'household.citizens', 'address.home']) assert.equal(facts[id].sensitive, true, id);
  for (const id of ['household.size', 'household.children', 'household.veteran', 'address.county', 'housing.rent', 'program.snap']) assert.equal(facts[id].sensitive, false, id);
  for (const fact of Object.values(facts)) assert.ok(fact.sources.length && fact.sources.every(source => typeof source === 'string'), fact.id);
  assert.ok(SENSITIVE_SOURCES.includes('ssn') && SENSITIVE_SOURCES.includes('birthDate'));
});

test('the facts sheet is short enough for the model and never contains identity details', () => {
  // The fixture's county ("Example County") shares a word with its last name, so use Ames's real county here.
  const profile = { ...fixture, county: 'Story' };
  const facts = buildFacts(profile, { today: TODAY });
  const sheet = factsText(facts);
  assert.equal(sheet, facts.map(fact => fact.text).join(' '));
  assert.ok(sheet.length <= 1400, `sheet is ${sheet.length} characters`);
  for (const secret of [fixture.firstName, fixture.lastName, fixture.email, fixture.mobilePhone, fixture.addressLine1, fixture.ssn].filter(Boolean)) {
    assert.equal(sheet.includes(secret), false, 'names, contact details, street address and SSN are never facts');
  }
  assert.deepEqual(buildFacts(profile, { today: TODAY }), facts, 'the same profile and date always give the same facts');
});

test('malformed saved values fail loudly', () => {
  assert.throws(() => buildFacts({ birthDate: '04/12/1985' }, { today: TODAY }), /birth date/i);
  assert.throws(() => buildFacts({ monthlyRent: 'eight hundred' }, { today: TODAY }), /monthlyRent/);
  assert.throws(() => buildFacts({ householdSize: '-1' }, { today: TODAY }), /householdSize/);
  assert.throws(() => buildFacts({}, { today: 'yesterday' }), /today/);
});

const SELF = '0f2c8d4e-1a3b-4c5d-8e6f-7a8b9c0d1e2f';
const memberId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// The applicant (41 on TODAY), two children (11 and 5, the older a student in 5th grade) and a parent (67).
const listed = (changes = {}) => ({ ...household, householdSize: '9', householdAdults: '9', householdChildren: '0', householdSeniors: '0',
  householdMembers: [
    { id: SELF, firstName: 'Avery', lastName: 'Example', birthDate: '1985-04-12', relationship: 'self', student: 'no', grade: '' },
    { id: memberId(1), firstName: 'Riley', lastName: 'Example', birthDate: '2015-09-03', relationship: 'child', student: 'yes', grade: '5th' },
    { id: memberId(2), firstName: 'Sam', lastName: 'Example', birthDate: '2021-02-14', relationship: 'child', student: 'no', grade: '' },
    { id: memberId(3), firstName: 'Morgan', lastName: 'Sample', birthDate: '1958-11-20', relationship: 'parent', student: 'no', grade: '' }
  ].map(member => ({ ...member, ...changes[member.firstName] })) });

test('with a household list, the household facts come from it: counts, each person’s age, children’s ages, and students', () => {
  const facts = byId(buildFacts(listed(), { today: TODAY }));
  assert.equal(facts['household.size'], 'The household has 4 people.');
  assert.equal(facts['household.adults'], 'The household has 1 adult aged 18 to 64.');
  assert.equal(facts['household.children'], 'The household has 2 children under 18.');
  assert.equal(facts['household.seniors'], 'The household has 1 person aged 65 or older.');
  assert.equal(facts['household.ages'], 'The household members are 67, 41, 11 and 5 years old.');
  assert.equal(facts['household.childAges'], 'The household has 2 children: ages 5 and 11.');
  assert.equal(facts['household.students'], 'One household member is a student in 5th grade.');
});

test('household facts from birth dates are sensitive, as the applicant’s own birth date is; the size and students are not', () => {
  const facts = Object.fromEntries(buildFacts(listed(), { today: TODAY }).map(fact => [fact.id, fact]));
  for (const id of ['household.adults', 'household.children', 'household.seniors', 'household.ages', 'household.childAges']) {
    assert.equal(facts[id].sensitive, true, id);
    assert.deepEqual(facts[id].sources, ['householdMembers.birthDate'], id);
  }
  for (const id of ['household.size', 'household.students']) {
    assert.equal(facts[id].sensitive, false, id);
    assert.deepEqual(facts[id].sources, ['householdMembers'], id);
  }
  assert.ok(SENSITIVE_SOURCES.includes('householdMembers.birthDate'));
  assert.equal(SENSITIVE_SOURCES.includes('householdMembers'), false);
});

test('a missing birth date leaves every age fact out; the size and students stay', () => {
  const facts = byId(buildFacts(listed({ Sam: { birthDate: '' } }), { today: TODAY }));
  assert.equal(facts['household.size'], 'The household has 4 people.');
  for (const id of ['household.adults', 'household.children', 'household.seniors', 'household.ages', 'household.childAges']) assert.equal(facts[id], undefined, id);
  assert.equal(facts['household.students'], 'One household member is a student in 5th grade.');
});

test('student facts say only what every member’s saved answer proves', () => {
  const students = changes => byId(buildFacts(listed(changes), { today: TODAY }))['household.students'];
  assert.equal(students({ Sam: { student: 'yes', grade: 'K' } }), '2 household members are students.');
  assert.equal(students({ Riley: { student: 'no', grade: '' } }), 'Nobody in the household is a student.');
  assert.equal(students({ Avery: { student: '' } }), undefined, 'an unanswered member leaves it unknown');
  assert.equal(students({ Riley: { grade: '' } }), 'One household member is a student.');
  assert.equal(students({ Riley: { grade: '3' } }), 'One household member is a student in grade 3.');
  assert.equal(students({ Riley: { grade: 'K' } }), 'One household member is a student in kindergarten.');
  assert.equal(students({ Riley: { grade: 'College' } }), 'One household member is a student (grade: College).');
});

test('a household with no children says so; a household list never puts a name in the facts', () => {
  const facts = byId(buildFacts(listed({ Riley: { birthDate: '1990-01-01', student: 'no', grade: '' }, Sam: { birthDate: '1992-01-01' } }), { today: TODAY }));
  assert.equal(facts['household.children'], 'The household has no children under 18.');
  assert.equal(facts['household.childAges'], undefined);
  const sheet = factsText(buildFacts({ ...listed(), county: 'Story' }, { today: TODAY }));
  for (const name of ['Avery', 'Riley', 'Sam', 'Morgan', 'Example', 'Sample']) assert.equal(sheet.includes(name), false, name);
  const fromFixture = factsText(buildFacts({ ...fixture, county: 'Story' }, { today: TODAY }));
  for (const member of fixture.householdMembers) assert.equal(fromFixture.includes(member.firstName), false, member.firstName);
});

test('a saved birth date in the future or more than 130 years ago never stops the facts: only the ages it gives are left out (#135)', () => {
  // The applicant's own date: no age facts, every other fact stays.
  const ahead = byId(buildFacts({ ...household, birthDate: '2026-09-27' }, { today: TODAY }));
  assert.equal(ahead['applicant.age'], undefined);
  assert.equal(ahead['applicant.ageBand'], undefined);
  assert.equal(ahead['household.size'], 'The household has 3 people.');
  assert.equal(ahead['income.total'], 'The household’s total income is $1,000 a month ($12,000 a year).');
  assert.equal(byId(buildFacts({ birthDate: '1825-06-01' }, { today: TODAY }))['applicant.age'], undefined);
  // A member's date: every count by age and every member's age are left out; the applicant's own age, the size and students stay.
  const listedFacts = byId(buildFacts(listed({ Sam: { birthDate: '2026-09-27' }, Morgan: { birthDate: '1825-06-01' } }), { today: TODAY }));
  assert.equal(listedFacts['applicant.age'], 'The applicant is 41 years old.');
  assert.equal(listedFacts['household.size'], 'The household has 4 people.');
  for (const id of ['household.adults', 'household.children', 'household.seniors', 'household.ages', 'household.childAges']) assert.equal(listedFacts[id], undefined, id);
  assert.equal(listedFacts['household.students'], 'One household member is a student in 5th grade.');
});
