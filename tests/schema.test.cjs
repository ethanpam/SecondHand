const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProfile, validateStoredProfile, validateApplication, validateStoredApplication, isPortalUrl, YES_NO_FIELDS, PROFILE_FIELDS, PROFILE_CHOICES, REQUEST_FIELDS, DERIVED_FIELDS, FIELD_LABELS,
  releasedValue, blockedByBirthDate, LIST_FIELDS, MEMBER_FIELDS } = require('../shared/schema.cjs');
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
  for (const [profile, reason] of [[{ unknown: 'value' }, /^Unknown profile field\.$/], [{ firstName: {} }, /^First name is invalid\.$/], [{ birthDate: '2020-02-30' }, /^Enter a valid date of birth\.$/],
    [{ monthlyRent: '-1' }, /^Monthly rent or mortgage must be a nonnegative dollar amount/], [{ monthlyRent: 'unknown' }, /^Monthly rent or mortgage must be a nonnegative dollar amount/],
    [{ householdSize: '0' }, /^Household size must be a whole number from 1 to 99\.$/], [JSON.parse('{"__proto__":"bad"}'), /^Unknown profile field\.$/]]) {
    assert.throws(() => validateProfile(profile), { message: reason }, JSON.stringify(profile));
  }
});
test('typed phone numbers stay distinct; legacy phone never implies home or mobile', () => {
  const profile = validateProfile({ phone: '515-555-0100', homePhone: '(515)555-0101', mobilePhone: '5155550102' });
  assert.equal(profile.homePhone, '(515)555-0101');
  assert.equal(profile.mobilePhone, '5155550102');
  assert.equal(validateProfile({ phone: '515-555-0100' }).homePhone, '');
  assert.throws(() => validateProfile({ mobilePhone: 'call me' }), /^Error: Enter a valid mobile phone number\.$/);
});
test('first-page yes/no choices preserve unknown separately and never infer programs or address answers', () => {
  const oldProfile = validateProfile({ firstName: 'Legacy', addressLine1: '123 Test Way', city: 'Demo City', state: 'IA', zip: '50309' });
  for (const field of YES_NO_FIELDS) assert.equal(oldProfile[field], '', field);
  assert.equal(oldProfile.mailingAddressLine1, '');
  assert.equal(oldProfile.mailingState, '');
  for (const field of YES_NO_FIELDS) {
    assert.equal(validateProfile({ [field]: 'yes' })[field], 'yes');
    assert.equal(validateProfile({ [field]: 'no' })[field], 'no');
    for (const value of [true, false, 0, 1]) assert.throws(() => validateProfile({ [field]: value }), / is invalid\.$/, `${field}: ${value}`);
    for (const value of ['Y', 'N', 'unknown', 'false']) assert.throws(() => validateProfile({ [field]: value }), / must be Yes, No, or left unanswered\.$/, `${field}: ${value}`);
  }
  const explicit = validateProfile({ programSnap: 'yes', programFip: 'no', hasHomeAddress: 'no', mailingSameAsHome: 'no' });
  assert.equal(explicit.programFip, 'no');
  assert.equal(explicit.programMedicaid, '');
  assert.equal(explicit.helpPayMedicalBills, '');
});
test('mailing contact fields stay separate, use validated formats, and the full fictional fixture is valid', () => {
  const complete = validateProfile(fictionalProfile);
  assert.ok(Object.keys(fictionalProfile).every(key => PROFILE_FIELDS.includes(key)), 'legacy fixture fields remain supported');
  assert.deepEqual(Object.keys(complete).sort(), [...PROFILE_FIELDS].sort(), 'new fields receive empty defaults');
  assert.equal(complete.mailingAddressLine1, 'PO Box 123');
  assert.equal(complete.addressLine1, fictionalProfile.addressLine1);
  assert.equal(validateProfile({ mailingState: 'ia' }).mailingState, 'IA');
  assert.throws(() => validateProfile({ mailingState: 'Iowa' }), /^Error: Mailing state must use a two-letter state abbreviation\.$/);
  assert.throws(() => validateProfile({ mailingZip: '123' }), /^Error: Mailing ZIP code must be a five- or nine-digit ZIP code\.$/);
  assert.throws(() => validateProfile({ bestContactTime: 'x'.repeat(31) }), /^Error: Best time to call must be 30 characters or fewer\.$/);
  assert.equal(validateProfile({ bestContactTime: 'x'.repeat(30) }).bestContactTime.length, 30);
  for (const suffix of ['', 'I', 'III', 'X', 'Jr.', 'Sr.']) assert.equal(validateProfile({ suffix }).suffix, suffix);
  for (const suffix of ['Jr', 'Doctor', 'XI']) assert.throws(() => validateProfile({ suffix }), /^Error: Choose a supported name suffix, or leave it blank\.$/, suffix);
});
test('submission is never inferred and requires a receipt', () => {
  assert.equal(validateApplication({}).status, 'draft');
  assert.throws(() => validateApplication({ status: 'submitted' }), /^Error: Add the portal confirmation number before marking an application submitted\.$/);
  const app = validateApplication({ status: 'submitted', confirmationNumber: 'TEST-RECEIPT' });
  assert.equal(app.confirmationNumber, 'TEST-RECEIPT');
  assert.equal(validateApplication({ ...app, status: 'needs_action' }, app).id, app.id);
  assert.throws(() => validateApplication({ dueDate: '2026-02-30' }), /^Error: Enter a valid due date\.$/);
});
test('stored application timestamps survive validation without being rewritten', () => {
  const original = { ...validateApplication({}), createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-02-01T12:00:00.000Z' };
  assert.deepEqual(validateStoredApplication(original), original);
  assert.throws(() => validateStoredApplication({ ...original, createdAt: 'yesterday' }), /^Error: Invalid application timestamp\.$/);
  assert.throws(() => validateStoredApplication({ ...original, id: '' }), /^Error: Incomplete stored application\.$/);
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

test('whether a Social Security number is saved is a field pages can ask for, never one the profile saves', () => {
  assert.equal(FIELD_LABELS.hasSsn, 'Whether you have a Social Security number');
  assert.equal(PROFILE_FIELDS.includes('hasSsn'), false);
  assert.ok(REQUEST_FIELDS.includes('hasSsn'));
  assert.throws(() => validateProfile({ hasSsn: 'yes' }), /Unknown profile field/);
  assert.equal(DERIVED_FIELDS.hasSsn(validateProfile({ ssn: '123-45-6789' })), 'yes');
  assert.equal(DERIVED_FIELDS.hasSsn(validateProfile({})), '');
  assert.equal(DERIVED_FIELDS.hasSsn({}), '', 'a profile saved before the SSN field existed has none');
});

test('the applicant’s own answers to Iowa’s Tell Us More questions are optional choices; blank means not saved', () => {
  assert.deepEqual(Object.fromEntries(['sex', 'maritalStatus', 'hasSsnAnswer', 'ssnCardNameMatches', 'usCitizen', 'militaryOrVeteran', 'disabled', 'blind', 'healthLimitation', 'medicare']
    .map(key => [key, FIELD_LABELS[key]])), {
    sex: 'Sex', maritalStatus: 'Marital status', hasSsnAnswer: 'You have a Social Security number',
    ssnCardNameMatches: 'Your first and last name match your Social Security card', usCitizen: 'You are a U.S. citizen or national',
    militaryOrVeteran: 'You are in the military, a veteran, or a spouse of a veteran', disabled: 'You are disabled', blind: 'You are blind',
    healthLimitation: 'A health condition limits your daily activities, or you live in a medical facility or nursing home', medicare: 'You have Medicare'
  });
  const empty = validateProfile({});
  for (const key of ['sex', 'maritalStatus', 'hasSsnAnswer', 'ssnCardNameMatches', 'usCitizen', 'militaryOrVeteran', 'disabled', 'blind', 'healthLimitation', 'medicare']) {
    assert.ok(PROFILE_FIELDS.includes(key), key);
    assert.equal(empty[key], '', key);
  }
  for (const key of ['hasSsnAnswer', 'ssnCardNameMatches', 'usCitizen', 'militaryOrVeteran', 'disabled', 'blind', 'healthLimitation', 'medicare']) {
    assert.ok(YES_NO_FIELDS.includes(key), key);
    for (const value of ['yes', 'no']) assert.equal(validateProfile({ [key]: value })[key], value, key);
    for (const value of ['Yes', 'true', 'maybe']) assert.throws(() => validateProfile({ [key]: value }), /Yes, No, or left unanswered/, key);
  }
  // Exactly Iowa's choices, written as Iowa writes them.
  assert.deepEqual(PROFILE_CHOICES.sex, ['', 'Male', 'Female']);
  assert.deepEqual(PROFILE_CHOICES.maritalStatus, ['', 'Divorced', 'Legally Separated', 'Married (includes common-law)', 'Never Married', 'Separated', 'Widowed']);
  for (const value of PROFILE_CHOICES.sex) assert.equal(validateProfile({ sex: value }).sex, value);
  for (const value of PROFILE_CHOICES.maritalStatus) assert.equal(validateProfile({ maritalStatus: value }).maritalStatus, value);
  for (const value of ['male', 'M', 'Other']) assert.throws(() => validateProfile({ sex: value }), /sex/, value);
  for (const value of ['Married', 'single', 'never married']) assert.throws(() => validateProfile({ maritalStatus: value }), /marital status/, value);
});

test('a saved Social Security number and a No to having one contradict each other', () => {
  assert.throws(() => validateProfile({ ssn: '123-45-6789', hasSsnAnswer: 'no' }), /Social Security number/);
  assert.equal(validateProfile({ ssn: '123-45-6789', hasSsnAnswer: 'yes' }).hasSsnAnswer, 'yes');
  assert.equal(validateProfile({ hasSsnAnswer: 'no' }).hasSsnAnswer, 'no');
});

test('whether you have a Social Security number comes from the saved number first, then your own answer, and never carries the number', () => {
  assert.equal(DERIVED_FIELDS.hasSsn(validateProfile({ ssn: '123-45-6789' })), 'yes');
  assert.equal(DERIVED_FIELDS.hasSsn(validateProfile({ ssn: '123-45-6789', hasSsnAnswer: 'yes' })), 'yes');
  assert.equal(DERIVED_FIELDS.hasSsn(validateProfile({ hasSsnAnswer: 'yes' })), 'yes');
  assert.equal(DERIVED_FIELDS.hasSsn(validateProfile({ hasSsnAnswer: 'no' })), 'no');
  assert.equal(DERIVED_FIELDS.hasSsn(validateProfile({})), '');
});

const MEMBER_SELF = '0f2c8d4e-1a3b-4c5d-8e6f-7a8b9c0d1e2f';
const MEMBER_CHILD = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const memberId = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const withMembers = (members, own = {}) => ({ firstName: 'Avery', lastName: 'Example', birthDate: '1985-04-12', ...own,
  householdMembers: [{ id: MEMBER_SELF, relationship: 'self' }, ...members] });
const child = (extra = {}) => ({ id: MEMBER_CHILD, firstName: ' Riley ', lastName: 'Example', birthDate: '2015-09-03', relationship: 'child', student: 'yes', grade: '5th', ...extra });
const completeMember = values => ({ ...Object.fromEntries(MEMBER_FIELDS.map(key => [key, ''])), ...values });

test('the household list is a profile field that defaults to empty and is never a field a page may ask for', () => {
  assert.equal(FIELD_LABELS.householdMembers, 'Household members');
  assert.ok(PROFILE_FIELDS.includes('householdMembers'));
  assert.equal(REQUEST_FIELDS.includes('householdMembers'), false);
  assert.deepEqual(validateProfile({}).householdMembers, []);
  assert.deepEqual(REQUEST_FIELDS, [...PROFILE_FIELDS.filter(field => !LIST_FIELDS.includes(field)), 'hasSsn', 'studentNameGrade']);
});

test('each household member is checked like the rest of the profile: trimmed, length-limited names and real past dates', () => {
  const saved = validateProfile(withMembers([child()]));
  assert.deepEqual(saved.householdMembers[1], completeMember({ id: MEMBER_CHILD, firstName: 'Riley', lastName: 'Example', birthDate: '2015-09-03', relationship: 'child', student: 'yes', grade: '5th' }));
  assert.deepEqual(validateProfile(withMembers([child({ birthDate: undefined, student: undefined, grade: undefined, lastName: undefined })])).householdMembers[1],
    completeMember({ id: MEMBER_CHILD, firstName: 'Riley', lastName: '', birthDate: '', relationship: 'child', student: '', grade: '' }), 'blank is unknown');
  // Each refused member, and the reason the applicant is given.
  const refused = {
    'an unknown member field': [child({ password: 'not-supported' }), /^Unknown household member field\.$/],
    'a future birth date': [child({ birthDate: '2999-01-01' }), /^Person 2’s date of birth can’t be after today /],
    'an impossible birth date': [child({ birthDate: '2015-02-30' }), /^Enter a valid date of birth for each person in your household\.$/],
    'a birth date in another format': [child({ birthDate: '09/03/2015' }), /^Enter a valid date of birth for each person in your household\.$/],
    'a control character': [child({ firstName: 'Ri\u0007ley' }), /^A household member’s first name is invalid\.$/],
    'a name over 100 characters': [child({ lastName: 'x'.repeat(101) }), /^A household member’s last name is invalid\.$/],
    'a relationship that isn’t listed': [child({ relationship: 'cousin' }), /^Choose how each household member is related to you\.$/],
    'a student answer that isn’t yes or no': [child({ student: 'true' }), /^Whether a household member is a student is invalid\.$/],
    'a grade over 20 characters': [child({ grade: 'x'.repeat(21) }), /^A household member’s grade is invalid\.$/],
    'a grade for someone who isn’t a student': [child({ student: 'no' }), /^Add a grade only for a household member who is a student\.$/],
    'a person with no first name': [child({ firstName: '  ' }), /^Enter a first name for each person in your household\.$/],
    'an id that isn’t one': [child({ id: 'child-1' }), /^A household member is invalid\.$/],
    'a member that isn’t an object': ['Riley Example', /^A household member is invalid\.$/],
    'a member with an inherited shape': [Object.create({ id: MEMBER_CHILD }), /^A household member is invalid\.$/]
  };
  for (const [name, [member, reason]] of Object.entries(refused)) assert.throws(() => validateProfile(withMembers([member])), { message: reason }, name);
  assert.throws(() => validateProfile(withMembers([child(), child()])), /once/, 'two members can’t share an id');
  assert.throws(() => validateProfile({ householdMembers: 'Riley' }), /household/i);
  assert.throws(() => validateProfile({ householdMembers: { 0: child() } }), /household/i);
  assert.equal(validateProfile(withMembers([child({ grade: 'x'.repeat(20) })])).householdMembers[1].grade.length, 20);
});

test('the household list holds up to 20 people', () => {
  const others = count => Array.from({ length: count }, (_, n) => ({ id: memberId(n + 1), firstName: `Person${n + 1}`, relationship: 'other' }));
  assert.equal(validateProfile(withMembers(others(19))).householdMembers.length, 20);
  assert.throws(() => validateProfile(withMembers(others(20))), /20 people/);
});

test('the applicant is the list’s one self row, kept in sync with their own name and birth date', () => {
  const saved = validateProfile(withMembers([child()], { firstName: ' Avery ', lastName: 'Example' }));
  assert.deepEqual(saved.householdMembers[0], completeMember({ id: MEMBER_SELF, firstName: 'Avery', lastName: 'Example', birthDate: '1985-04-12', relationship: 'self', student: '', grade: '' }));
  // A self row saved with other details takes the applicant's own.
  const stale = validateProfile({ ...withMembers([child()]), householdMembers: [{ id: MEMBER_SELF, firstName: 'Old', lastName: 'Name', birthDate: '1990-01-01', relationship: 'self' }, child()] });
  assert.deepEqual([stale.householdMembers[0].firstName, stale.householdMembers[0].lastName, stale.householdMembers[0].birthDate], ['Avery', 'Example', '1985-04-12']);
  assert.throws(() => validateProfile({ ...withMembers([]), householdMembers: [child()] }), /you/, 'a list without the applicant would undercount the household');
  assert.throws(() => validateProfile(withMembers([{ id: memberId(9), relationship: 'self' }])), /you/, 'the applicant appears once');
  assert.deepEqual(validateProfile(withMembers([])).householdMembers.map(member => member.relationship), ['self'], 'a household of one');
});

test('the fictional fixture has a fictional household: the applicant, two children, one a student, and a parent', () => {
  const saved = validateProfile(fictionalProfile);
  assert.deepEqual(saved.householdMembers.map(member => [member.firstName, member.relationship, member.student]),
    [['Avery', 'self', 'no'], ['Riley', 'child', 'yes'], ['Sam', 'child', 'no'], ['Morgan', 'parent', 'no']]);
});

// #135: a birth date is checked against today on this computer's calendar when it is saved, and never when it is read back.
function inZone(t, zone) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
}
// 8:30 pm on October 5 in Iowa is already October 6 in UTC.
const IOWA_EVENING = '2026-10-06T01:30:00Z';

test('on an Iowa evening, a birth date of tomorrow is refused, though it is already that date in UTC', t => {
  inZone(t, 'America/Chicago');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(IOWA_EVENING) });
  assert.throws(() => validateProfile({ birthDate: '2026-10-06' }), { message: 'Your date of birth can’t be after today (2026-10-05 on this computer).' });
  assert.throws(() => validateProfile(withMembers([child({ birthDate: '2026-10-06' })])), { message: 'Person 2’s date of birth can’t be after today (2026-10-05 on this computer).' });
  assert.equal(validateProfile({ birthDate: '2026-10-05' }).birthDate, '2026-10-05', 'born today');
  assert.equal(validateProfile(withMembers([child({ birthDate: '2026-10-05' })])).householdMembers[1].birthDate, '2026-10-05');
  // The same instant on a computer set to UTC: it is October 6 there.
  process.env.TZ = 'UTC';
  assert.equal(validateProfile({ birthDate: '2026-10-06' }).birthDate, '2026-10-06');
});

test('around midnight, the day a birth date is checked against follows the computer’s timezone', t => {
  inZone(t, 'Pacific/Kiritimati');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-05T10:00:00Z') });
  assert.equal(validateProfile({ birthDate: '2026-10-06' }).birthDate, '2026-10-06', 'just after midnight in UTC+14, while UTC is still October 5');
  process.env.TZ = 'UTC';
  assert.throws(() => validateProfile({ birthDate: '2026-10-06' }), /after today \(2026-10-05 on this computer\)/);
});

test('a birth date more than 130 years ago is refused when saved; exactly 130 years ago is not', () => {
  const today = '2026-10-05';
  assert.throws(() => validateProfile({ birthDate: '1896-10-04' }, { today }), { message: 'Your date of birth can’t be more than 130 years ago.' });
  assert.throws(() => validateProfile({ birthDate: '1825-06-01' }, { today }), /more than 130 years ago/);
  assert.equal(validateProfile({ birthDate: '1896-10-05' }, { today }).birthDate, '1896-10-05');
  assert.throws(() => validateProfile(withMembers([{ id: memberId(1), firstName: 'Morgan', birthDate: '1825-06-01', relationship: 'parent' }]), { today }),
    { message: 'Person 2’s date of birth can’t be more than 130 years ago.' });
  assert.throws(() => validateProfile(withMembers([child(), { id: memberId(1), firstName: 'Sam', birthDate: '2026-10-06', relationship: 'child' }]), { today }),
    { message: 'Person 3’s date of birth can’t be after today (2026-10-05 on this computer).' }, 'named by the row it is on in My information');
  assert.throws(() => validateProfile({ birthDate: '2020-02-30' }, { today }), { message: 'Enter a valid date of birth.' });
});

test('a profile read back from the vault keeps a birth date the clock now puts in the future, or one from before the 130-year limit', () => {
  const stored = withMembers([child({ birthDate: '2031-01-01' }), { id: memberId(1), firstName: 'Morgan', birthDate: '1825-06-01', relationship: 'parent' }], { birthDate: '2030-05-05' });
  const read = validateStoredProfile(stored);
  assert.equal(read.birthDate, '2030-05-05');
  assert.deepEqual(read.householdMembers.map(member => member.birthDate), ['2030-05-05', '2031-01-01', '1825-06-01']);
  // Everything else is still checked as it is when saved.
  for (const [profile, reason] of [[{ birthDate: '2020-02-30' }, /^Enter a valid date of birth\.$/], [{ birthDate: '04/12/1985' }, /^Enter a valid date of birth\.$/],
    [withMembers([child({ birthDate: '2015-02-30' })]), /^Enter a valid date of birth for each person in your household\.$/], [{ zip: 'ABCDE' }, /^ZIP code must be a five- or nine-digit ZIP code\.$/],
    [{ unknown: 'value' }, /^Unknown profile field\.$/]]) {
    assert.throws(() => validateStoredProfile(profile), { message: reason }, JSON.stringify(profile));
  }
});

test('a page gets no answer worked out from a birth date that can’t be used, and the reason is known', () => {
  const today = '2026-10-05';
  const stored = validateStoredProfile({ ...withMembers([], { householdChildren: '3', householdVeteran: 'no' }),
    householdMembers: [{ id: MEMBER_SELF, relationship: 'self', student: 'no' }, child({ birthDate: '2026-10-06' })] });
  for (const field of ['householdCount:0-17', 'householdChildren', 'householdAdults', 'householdSeniors']) {
    assert.equal(releasedValue(stored, field, { today }), '', field);
    assert.equal(blockedByBirthDate(stored, field, { today }), true, field);
  }
  assert.equal(releasedValue(stored, 'householdSize', { today }), '2', 'the size needs no birth date');
  assert.equal(releasedValue(stored, 'studentNameGrade', { today }), 'Riley Example, 5th');
  for (const field of ['householdSize', 'studentNameGrade', 'householdVeteran', 'firstName', 'birthDate']) assert.equal(blockedByBirthDate(stored, field, { today }), false, field);
  assert.equal(releasedValue(stored, 'birthDate', { today }), '1985-04-12', 'the applicant’s own date is fine');
  // The applicant's own date: it is never filled into a page, and the reason is known.
  const own = validateStoredProfile({ birthDate: '1825-06-01', householdChildren: '1' });
  assert.equal(releasedValue(own, 'birthDate', { today }), '');
  assert.equal(blockedByBirthDate(own, 'birthDate', { today }), true);
  assert.equal(releasedValue(own, 'householdChildren', { today }), '1', 'without a list, the manual count is the applicant’s own answer');
  assert.equal(blockedByBirthDate(own, 'householdChildren', { today }), false);
  assert.equal(blockedByBirthDate(validateStoredProfile({ birthDate: '' }), 'birthDate', { today }), false, 'nothing saved is not a reason');
});
