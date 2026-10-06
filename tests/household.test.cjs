'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const household = require('../shared/household.cjs');
const { validateProfile, releasedValue, fieldLabel, isRequestField } = require('../shared/schema.cjs');
const fixture = require('./fixtures/applicant-profile.json');

const TODAY = '2026-10-03';
const SELF = '0f2c8d4e-1a3b-4c5d-8e6f-7a8b9c0d1e2f';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A saved profile with a household list: the applicant's own row first.
function profile(members, own = {}) {
  return validateProfile({ firstName: 'Avery', lastName: 'Example', birthDate: '1985-04-12', ...own,
    householdMembers: [{ id: SELF, relationship: 'self' }, ...members.map((member, n) => ({ id: id(n + 1), firstName: `Person${n + 1}`, lastName: 'Example', relationship: 'child', ...member }))] });
}

test('ages count whole years as of today and change on the birthday itself', () => {
  assert.equal(household.ageOn('2008-10-03', TODAY), 18, 'an 18th birthday today makes an adult today');
  assert.equal(household.ageOn('2008-10-04', TODAY), 17, 'the day before an 18th birthday is still 17');
  assert.equal(household.ageOn('2008-02-29', '2026-02-28'), 17, 'a February 29 birthday comes on March 1 in other years');
  assert.equal(household.ageOn('2008-02-29', '2026-03-01'), 18);
  assert.equal(household.ageOn('', TODAY), null);
});

test('the household list gives the size and the age counts the profile used to store, ages as of today', () => {
  const saved = profile([{ birthDate: '2008-10-03' }, { birthDate: '2008-10-04' }, { birthDate: '1966-10-03' }, { birthDate: '1961-10-04' }, { birthDate: '1961-10-03' }]);
  // 18 today: adult. 17: child. 60 today: adult. 64: adult. 65 today: senior. The applicant: 41.
  assert.deepEqual(household.householdCounts(saved, { today: TODAY }), { size: '6', adults: '4', children: '1', seniors: '1' });
  assert.equal(household.householdCounts(validateProfile({ firstName: 'Avery' }), { today: TODAY }), null, 'no list, no derived counts');
});

test('a missing birth date leaves the age counts unknown, never guessed; the size still counts everyone', () => {
  const saved = profile([{ birthDate: '2015-09-03' }, { birthDate: '' }]);
  assert.deepEqual(household.householdCounts(saved, { today: TODAY }), { size: '3', adults: '', children: '', seniors: '' });
  const applicantUnknown = profile([{ birthDate: '2015-09-03' }], { birthDate: '' });
  assert.deepEqual(household.householdCounts(applicantUnknown, { today: TODAY }), { size: '2', adults: '', children: '', seniors: '' });
});

test('age bands are parsed strictly: whole numbers 0 to 120, low no higher than high, or N and older', () => {
  assert.deepEqual(household.parseBand('householdCount:0-17'), { low: 0, high: 17 });
  assert.deepEqual(household.parseBand('householdCount:18-59'), { low: 18, high: 59 });
  assert.deepEqual(household.parseBand('householdCount:60+'), { low: 60, high: null });
  assert.deepEqual(household.parseBand('householdCount:0-5'), { low: 0, high: 5 });
  assert.deepEqual(household.parseBand('householdCount:5-5'), { low: 5, high: 5 });
  assert.deepEqual(household.parseBand('householdCount:120+'), { low: 120, high: null });
  for (const key of ['householdCount:05-10', 'householdCount:10-5', 'householdCount:0-121', 'householdCount:121+', 'householdCount:-1-5', 'householdCount:1.5-3',
    'householdCount:abc', 'householdCount:', 'householdCount:5', 'householdcount:0-5', 'householdCount:0-5 ', 'householdCount:0–5', 'householdCount:0+5',
    'householdCount:0-5-9', 'householdCount:+60', 'householdCount:1000+', 'householdCount:0-17\n', 'householdSize', '', null, 5, ['householdCount:0-5']]) {
    assert.equal(household.parseBand(key), null, JSON.stringify(key));
    assert.equal(household.isBandKey(key), false, JSON.stringify(key));
  }
});

test('a band count comes from every member’s birth date, and from nothing else', () => {
  // The applicant (41), two children (11 and 5), and a grandparent (67).
  const saved = profile([{ birthDate: '2015-09-03' }, { birthDate: '2021-02-14' }, { birthDate: '1958-11-20', relationship: 'parent' }]);
  const count = key => household.bandCount(saved, key, { today: TODAY });
  assert.equal(count('householdCount:0-17'), '2');
  assert.equal(count('householdCount:18-59'), '1');
  assert.equal(count('householdCount:60+'), '1');
  assert.equal(count('householdCount:0-5'), '1');
  assert.equal(count('householdCount:6-18'), '1');
  assert.equal(count('householdCount:0-4'), '0', 'a count of nobody is a real answer');
  // 59 and 60 on the 60th birthday.
  const sixty = profile([{ birthDate: '1966-10-03', relationship: 'parent' }, { birthDate: '1966-10-04', relationship: 'parent' }]);
  assert.equal(household.bandCount(sixty, 'householdCount:60+', { today: TODAY }), '1');
  assert.equal(household.bandCount(sixty, 'householdCount:18-59', { today: TODAY }), '2');
  assert.equal(household.bandCount(profile([{ birthDate: '' }]), 'householdCount:0-17', { today: TODAY }), '', 'a missing birth date leaves the band unknown');
  assert.equal(household.bandCount(validateProfile({ householdChildren: '2' }), 'householdCount:0-17', { today: TODAY }), '', 'manual counts never answer a band');
  assert.equal(household.bandCount(saved, 'householdCount:10-5', { today: TODAY }), '', 'a malformed band counts nothing');
});

test('a student box is filled only from the one member who is a student, as "First Last, Grade"', () => {
  const one = profile([{ firstName: 'Riley', birthDate: '2015-09-03', student: 'yes', grade: '5th' }, { birthDate: '2021-02-14', student: 'no' }], {});
  // The applicant's own row has no student answer: only an explicit "no" settles that someone isn't a student.
  assert.equal(household.studentNameGrade(one), '', 'the applicant’s student status is unknown');
  const settled = validateProfile({ ...one, householdMembers: one.householdMembers.map(member => member.relationship === 'self' ? { ...member, student: 'no' } : member) });
  assert.equal(household.studentNameGrade(settled), 'Riley Example, 5th');
  const two = validateProfile({ ...settled, householdMembers: settled.householdMembers.map(member => member.id === id(2) ? { ...member, student: 'yes', grade: 'K' } : member) });
  assert.equal(household.studentNameGrade(two), '', 'two students: the applicant answers');
  const none = validateProfile({ ...settled, householdMembers: settled.householdMembers.map(member => ({ ...member, student: 'no', grade: '' })) });
  assert.equal(household.studentNameGrade(none), '', 'no students: the applicant answers');
  const noGrade = validateProfile({ ...settled, householdMembers: settled.householdMembers.map(member => member.id === id(1) ? { ...member, grade: '' } : member) });
  assert.equal(household.studentNameGrade(noGrade), '', 'a student with no saved grade leaves the question to the applicant');
  assert.equal(household.studentNameGrade(validateProfile({})), '');
});

test('the household list wins over the manual counts, which stay for applicants without a list', () => {
  const manual = validateProfile({ householdSize: '5', householdAdults: '3', householdChildren: '2', householdSeniors: '0' });
  for (const field of ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors']) assert.equal(releasedValue(manual, field, { today: TODAY }), manual[field], field);
  const listed = validateProfile({ ...profile([{ birthDate: '2015-09-03' }]), householdSize: '5', householdAdults: '3', householdChildren: '2', householdSeniors: '0' });
  assert.deepEqual(['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'].map(field => releasedValue(listed, field, { today: TODAY })), ['2', '1', '1', '0']);
  const unknownAge = validateProfile({ ...profile([{ birthDate: '' }]), householdChildren: '2' });
  assert.equal(releasedValue(unknownAge, 'householdChildren', { today: TODAY }), '', 'the list wins even when it can’t count: the stale manual count is not used');
  assert.equal(releasedValue(unknownAge, 'householdSize', { today: TODAY }), '2');
});

test('released values: saved fields as saved, derived answers worked out, band keys counted, the member list never', () => {
  const saved = validateProfile(fixture);
  assert.equal(releasedValue(saved, 'firstName', { today: TODAY }), 'Avery');
  assert.equal(releasedValue(saved, 'hasSsn', { today: TODAY }), 'yes');
  assert.equal(releasedValue(saved, 'householdCount:0-17', { today: TODAY }), '2');
  assert.equal(releasedValue(saved, 'householdCount:18-59', { today: TODAY }), '1');
  assert.equal(releasedValue(saved, 'householdCount:60+', { today: TODAY }), '1');
  assert.equal(releasedValue(saved, 'studentNameGrade', { today: TODAY }), 'Riley Example, 5th');
  assert.throws(() => releasedValue(saved, 'householdMembers', { today: TODAY }), /not a field a page may ask for/);
  assert.throws(() => releasedValue(saved, 'householdCount:10-5', { today: TODAY }), /not a field a page may ask for/);
  assert.equal(isRequestField('householdCount:0-5'), true);
  assert.equal(isRequestField('householdCount:05'), false);
  assert.equal(isRequestField('householdMembers'), false);
  assert.equal(isRequestField('studentNameGrade'), true);
  assert.equal(fieldLabel('householdCount:0-17'), 'People in the household aged 0 to 17');
  assert.equal(fieldLabel('householdCount:60+'), 'People in the household aged 60 or older');
  assert.equal(fieldLabel('householdCount:5-5'), 'People in the household aged 5');
  assert.equal(fieldLabel('studentNameGrade'), 'Student name and grade');
  assert.equal(fieldLabel('householdMembers.birthDate'), 'Household members’ birth dates');
  assert.equal(fieldLabel('firstName'), 'First name');
  assert.throws(() => fieldLabel('somethingElse'), /Unknown field/);
});

// #135: one "today" for checking birth dates and working out ages, on this computer's own calendar.
// Each test pins the clock and the timezone it runs in, and puts both back afterwards.
function inZone(t, zone) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
}
function atInstant(t, iso) { t.mock.timers.enable({ apis: ['Date'], now: Date.parse(iso) }); }
// 8:30 pm on October 5 in Iowa (Central daylight time) is already October 6 in UTC.
const IOWA_EVENING = '2026-10-06T01:30:00Z';

test('today is the date on this computer’s calendar, in its own timezone, never the UTC date', t => {
  inZone(t, 'America/Chicago');
  assert.equal(household.localDate(new Date(IOWA_EVENING)), '2026-10-05', 'evening in Iowa is still October 5');
  assert.equal(household.localDate(new Date('2026-10-06T04:59:59Z')), '2026-10-05', 'one second before midnight in Iowa');
  assert.equal(household.localDate(new Date('2026-10-06T05:00:00Z')), '2026-10-06', 'midnight in Iowa');
  atInstant(t, IOWA_EVENING);
  assert.equal(household.localDate(), '2026-10-05', 'the clock, read with no date given');
  assert.equal(household.localDate('2026-02-28'), '2026-02-28', 'a date a caller names is used as it is');
  assert.throws(() => household.localDate('2026-02-30'), /real date/);
});

test('around midnight UTC, today follows the computer’s timezone on both sides of the date line', t => {
  inZone(t, 'UTC');
  assert.equal(household.localDate(new Date('2026-10-05T23:59:59Z')), '2026-10-05');
  assert.equal(household.localDate(new Date('2026-10-06T00:00:00Z')), '2026-10-06');
  process.env.TZ = 'Pacific/Kiritimati';
  assert.equal(household.localDate(new Date('2026-10-05T09:59:59Z')), '2026-10-05');
  assert.equal(household.localDate(new Date('2026-10-05T10:00:00Z')), '2026-10-06', 'UTC+14 is a day ahead of UTC');
  process.env.TZ = 'America/Chicago';
  assert.equal(household.localDate(new Date('2026-10-06T00:00:00Z')), '2026-10-05', 'UTC midnight is 7 pm in Iowa');
});

test('a birth date can be used when it is today or earlier and no more than 130 years ago', () => {
  const today = '2026-10-05';
  assert.equal(household.birthDateProblem('', today), null, 'no birth date saved');
  assert.equal(household.birthDateProblem('2026-10-05', today), null, 'born today');
  assert.equal(household.birthDateProblem('2026-10-06', today), 'future', 'born tomorrow');
  assert.equal(household.birthDateProblem('2999-01-01', today), 'future');
  assert.equal(household.birthDateProblem('1896-10-05', today), null, 'exactly 130 years ago');
  assert.equal(household.birthDateProblem('1896-10-04', today), 'tooOld', 'one day more than 130 years ago');
  assert.equal(household.birthDateProblem('1825-06-01', today), 'tooOld');
  // February 29: 130 years before 2028-02-29 is 1898-02-28 plus one day, so 1898-02-28 is too old and March 1 is not.
  assert.equal(household.birthDateProblem('1898-02-28', '2028-02-29'), 'tooOld');
  assert.equal(household.birthDateProblem('1898-03-01', '2028-02-29'), null);
  assert.throws(() => household.birthDateProblem('04/12/1985', today), /real date/, 'a date in another format is a programming error, not a saved date');
});

test('a birth date in the future or more than 130 years ago has no age, and never throws', () => {
  assert.equal(household.ageOn('2026-10-06', '2026-10-05'), null);
  assert.equal(household.ageOn('1825-06-01', '2026-10-05'), null);
  assert.equal(household.ageOn('1896-10-05', '2026-10-05'), 130);
  assert.throws(() => household.ageOn('1985-13-01', '2026-10-05'), /real date/);
});

test('a member born “tomorrow” (saved on an Iowa evening) or long ago leaves the counts by age unknown; the size still counts everyone', t => {
  inZone(t, 'America/Chicago');
  atInstant(t, IOWA_EVENING);
  // Saved while the clock was later, or before the oldest limit existed: stored as it is.
  const stored = { firstName: 'Avery', birthDate: '1985-04-12', householdMembers: [
    { id: SELF, firstName: 'Avery', birthDate: '1985-04-12', relationship: 'self' },
    { id: id(1), firstName: 'Person1', birthDate: '2026-10-06', relationship: 'child' },
    { id: id(2), firstName: 'Person2', birthDate: '1825-06-01', relationship: 'parent' }] };
  assert.deepEqual(household.householdCounts(stored), { size: '3', adults: '', children: '', seniors: '' });
  assert.equal(household.memberAges(stored), null);
  assert.equal(household.bandCount(stored, 'householdCount:0-17'), '');
  assert.equal(household.hasUnusableBirthDate(stored), true);
  assert.equal(household.hasUnusableBirthDate(stored, { today: '2026-10-06' }), true, 'still the 1825 date');
  const fine = { ...stored, householdMembers: stored.householdMembers.slice(0, 1) };
  assert.equal(household.hasUnusableBirthDate(fine), false);
  assert.equal(household.hasUnusableBirthDate({ birthDate: '2026-10-06', householdMembers: [] }), true, 'the applicant’s own date counts too');
  assert.equal(household.hasUnusableBirthDate({ birthDate: '2026-10-06', householdMembers: [] }, { today: '2026-10-06' }), false, 'in UTC it is already October 6');
});
