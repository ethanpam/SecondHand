'use strict';
const { randomUUID } = require('node:crypto');
const household = require('./household.cjs');
const SNAP_INFORMATION = require('./snap-information.js');
const RECORD_FIELDS = Object.freeze(Object.fromEntries(SNAP_INFORMATION.records.map(record => [record.key, record.fields])));
const MAX_RECORDS = SNAP_INFORMATION.maxRecords;
const SNAP_IOWA_ONLY_FIELDS = Object.freeze(SNAP_INFORMATION.scalarFields.map(field => field.key));

const PORTAL_URL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
const FIELD_LABELS = Object.freeze({
  firstName: 'First name', middleName: 'Middle name', lastName: 'Last name',
  suffix: 'Name suffix', maidenName: 'Maiden name', isApplicant: 'Applying for benefits',
  birthDate: 'Date of birth', ssn: 'Social Security number', email: 'Email', phone: 'Phone (reference)',
  homePhone: 'Home phone number', mobilePhone: 'Mobile phone number', bestContactTime: 'Best time to call',
  hasHomeAddress: 'Has a home address', mailingSameAsHome: 'Mailing address is the same as home address',
  addressLine1: 'Street address', addressLine2: 'Apartment or unit', city: 'City',
  state: 'State', zip: 'ZIP code', county: 'County',
  mailingAddressLine1: 'Mailing street address', mailingAddressLine2: 'Mailing apartment or unit',
  mailingCity: 'Mailing city', mailingState: 'Mailing state', mailingZip: 'Mailing ZIP code',
  programSnap: 'Request SNAP', programFip: 'Request FIP or RCA', programMedicaid: 'Request Medicaid',
  helpPayMedicalBills: 'Request help paying medical bills from the last three calendar months', householdSize: 'Household size',
  monthlyEarnedIncome: 'Monthly earned income', monthlyOtherIncome: 'Monthly other income',
  monthlyRent: 'Monthly rent or mortgage', monthlyUtilities: 'Monthly utilities',
  householdAdults: 'Adults in household', householdChildren: 'Children in household', householdSeniors: 'Seniors (65+) in household',
  householdVeteran: 'Anyone in household a veteran', householdDisability: 'Anyone in household with a disability',
  assetsOnHand: 'Money on hand (cash, checking, savings)', monthlyMedicalExpenses: 'Monthly medical expenses',
  householdAllCitizens: 'Everyone in household a US citizen', householdLegalStatus: 'If not, legal documents to stay in the US',
  householdPregnant: 'Anyone in household pregnant', householdMedicare: 'Anyone in household on Medicare',
  // The applicant's own answers to Iowa's Tell Us More questions.
  sex: 'Sex', maritalStatus: 'Marital status', hasSsnAnswer: 'You have a Social Security number',
  ssnCardNameMatches: 'Your first and last name match your Social Security card', usCitizen: 'You are a U.S. citizen or national',
  militaryOrVeteran: 'You are in the military, a veteran, or a spouse of a veteran', disabled: 'You are disabled', blind: 'You are blind',
  healthLimitation: 'A health condition limits your daily activities, or you live in a medical facility or nursing home', medicare: 'You have Medicare',
  // Each person in the household: name, birth date, relationship to the applicant, and whether they are a student.
  householdMembers: 'Household members',
  hasSsn: 'Whether you have a Social Security number', studentNameGrade: 'Student name and grade',
  ...Object.fromEntries(SNAP_INFORMATION.scalarFields.map(field => [field.key, field.label])),
  ...Object.fromEntries(SNAP_INFORMATION.records.map(record => [record.key, record.label]))
});
// Answers the desktop works out from saved fields when a page asks for them. They are never saved,
// and never carry the saved value itself: hasSsn is Yes when a Social Security number is saved,
// otherwise the applicant's own saved Yes or No. studentNameGrade is the one student's "First Last, Grade".
const DERIVED_FIELDS = Object.freeze({
  hasSsn: profile => typeof profile.ssn === 'string' && profile.ssn.trim() ? 'yes' : ['yes', 'no'].includes(profile.hasSsnAnswer) ? profile.hasSsnAnswer : '',
  studentNameGrade: profile => household.studentNameGrade(profile)
});
const PROFILE_FIELDS = Object.freeze(Object.keys(FIELD_LABELS).filter(key => !Object.hasOwn(DERIVED_FIELDS, key)));
// The household list never leaves the app whole: a page gets only the answers worked out from it.
const LIST_FIELDS = Object.freeze(['householdMembers', ...Object.keys(RECORD_FIELDS)]);
// Every named field a page may ask the desktop for. Age-band counts ("householdCount:0-17") are asked for by key too.
const REQUEST_FIELDS = Object.freeze([...PROFILE_FIELDS.filter(key => !LIST_FIELDS.includes(key)), ...Object.keys(DERIVED_FIELDS)]);
// The fixed counts the household list works out when it has people; the manual counts answer otherwise.
const HOUSEHOLD_COUNT_FIELDS = Object.freeze({ householdSize: 'size', householdAdults: 'adults', householdChildren: 'children', householdSeniors: 'seniors' });
const RELATIONSHIPS = Object.freeze(['self', 'spouse-partner', 'child', 'parent', 'sibling', 'grandchild', 'other-relative', 'other']);
const MAX_MEMBERS = 20;
const MEMBER_FIELDS = Object.freeze(['id', ...SNAP_INFORMATION.memberFields.map(field => field.key)]);
const MAX_PROFILE_REVIEW_ROWS = PROFILE_FIELDS.length + MAX_MEMBERS * (MEMBER_FIELDS.length - 1) +
  MAX_RECORDS * Object.values(RECORD_FIELDS).reduce((count, fields) => count + fields.length, 0);
// Answers the side panel may offer to save from a page: the general engine's saved profile fields
// (extension/generic-adapter.js PROFILE_KEYS), except the Social Security number, which is never read from a page.
const SAVE_FIELDS = Object.freeze(['firstName', 'middleName', 'lastName', 'suffix', 'birthDate', 'email', 'mobilePhone', 'homePhone', 'phone',
  'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors',
  'householdVeteran', 'householdDisability', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'monthlyRent', 'monthlyUtilities', 'assetsOnHand',
  'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare', 'programMedicaid']);
// Labels for what a sensitive fact was read from, beyond the saved fields themselves.
const SOURCE_LABELS = Object.freeze({ 'householdMembers.birthDate': 'Household members’ birth dates' });
const YES_NO_FIELDS = Object.freeze(['hasHomeAddress', 'mailingSameAsHome', 'isApplicant',
  'programSnap', 'programFip', 'programMedicaid', 'helpPayMedicalBills', 'householdVeteran', 'householdDisability',
  'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare',
  'hasSsnAnswer', 'ssnCardNameMatches', 'usCitizen', 'militaryOrVeteran', 'disabled', 'blind', 'healthLimitation', 'medicare',
  ...SNAP_INFORMATION.scalarFields.filter(field => field.type === 'yesno').map(field => field.key)]);
const PROFILE_CHOICES = Object.freeze({
  ...Object.fromEntries(YES_NO_FIELDS.map(field => [field, Object.freeze(['', 'yes', 'no'])])),
  suffix: Object.freeze(['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'Jr.', 'Sr.']),
  // Iowa's own options, word for word.
  sex: Object.freeze(['', 'Male', 'Female']),
  maritalStatus: Object.freeze(['', 'Divorced', 'Legally Separated', 'Married (includes common-law)', 'Never Married', 'Separated', 'Widowed'])
});
const APPLICATION_STATUSES = Object.freeze(['draft', 'in_progress', 'submitted', 'needs_action', 'approved', 'denied']);

function isPortalUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://hhsservices.iowa.gov' && !url.username && !url.password &&
      (url.pathname === '/apspssp/ssp.portal' || url.pathname.startsWith('/apspssp/ssp.portal/'));
  } catch { return false; }
}

// Any other site SecondHand may fill must be plain HTTPS with no credentials or custom port.
function isHttpsSiteUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.port;
  } catch { return false; }
}
function siteOrigin(value) { return isHttpsSiteUrl(value) ? new URL(value).origin : null; }

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected an object.');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new Error('Expected plain data.');
}
function text(value, name, max = 200) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(`${name} is invalid.`);
  return value.trim();
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
// A birth date being saved must be today or earlier and no more than 130 years ago, on this computer's
// calendar (#135). Why one can't be, or null. `whose` names the person as My information does: "Your" or "Person 3’s".
function birthDateRefusal(birthDate, whose, today) {
  const problem = household.birthDateProblem(birthDate, today);
  if (problem === 'future') return `${whose} date of birth can’t be after today (${household.localDate(today)} on this computer).`;
  if (problem === 'tooOld') return `${whose} date of birth can’t be more than ${household.MAX_YEARS_BACK} years ago.`;
  return null;
}
function checkBirthDate(birthDate, whose, today) {
  const refusal = birthDateRefusal(birthDate, whose, today);
  if (refusal) throw new Error(refusal);
}
// Why a profile read back from the vault couldn't be saved again on `today` because of a birth date already
// in it: the first such date, named as My information names it. Null when every saved date can be used.
function savedBirthDateRefusal(profile, { today } = {}) {
  const others = (Array.isArray(profile?.householdMembers) ? profile.householdMembers : [])
    .map((member, index) => member.relationship === 'self' ? null : birthDateRefusal(member.birthDate, `Person ${index + 1}’s`, today));
  return [birthDateRefusal(profile?.birthDate, 'Your', today), ...others].find(Boolean) ?? null;
}
// A profile being saved: every field is checked, and each birth date against `today` (this computer's
// date unless a caller names one).
function validateProfile(input, { today } = {}) {
  return checkProfile(input, { today, saving: true });
}
// A profile read back from the vault. Its birth dates were checked when they were saved and are not
// checked against today again, so a clock set back, or a date saved before the 130-year limit,
// never keeps the information from opening (#135). Everything else is checked as when saved.
function validateStoredProfile(input) {
  return checkProfile(input, { saving: false });
}
function checkProfile(input, { today, saving }) {
  object(input);
  if (Object.keys(input).some(key => !PROFILE_FIELDS.includes(key))) throw new Error('Unknown profile field.');
  const result = Object.fromEntries(PROFILE_FIELDS.filter(key => !LIST_FIELDS.includes(key)).map(key => [key, text(input[key], FIELD_LABELS[key])]));
  for (const [field, choices] of Object.entries(PROFILE_CHOICES)) {
    if (!choices.includes(result[field])) throw new Error(YES_NO_FIELDS.includes(field) ?
      `${FIELD_LABELS[field]} must be Yes, No, or left unanswered.` : `Choose a supported ${FIELD_LABELS[field].toLowerCase()}, or leave it blank.`);
  }
  if (result.bestContactTime.length > 30) throw new Error('Best time to call must be 30 characters or fewer.');
  if (result.birthDate && !validDate(result.birthDate)) throw new Error('Enter a valid date of birth.');
  if (saving) checkBirthDate(result.birthDate, 'Your', today);
  if (result.ssn && !/^\d{3}-?\d{2}-?\d{4}$/.test(result.ssn)) throw new Error('Enter a nine-digit Social Security number or leave it blank.');
  if (result.ssn && result.hasSsnAnswer === 'no') throw new Error('You saved a Social Security number, so answer Yes to having one, or leave that question unanswered.');
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new Error('Enter a valid email address.');
  for (const field of ['phone', 'homePhone', 'mobilePhone']) {
    if (result[field] && !/^[+\d\s().-]{7,30}$/.test(result[field])) throw new Error(`Enter a valid ${FIELD_LABELS[field].toLowerCase()}.`);
  }
  for (const field of ['zip', 'mailingZip']) {
    if (result[field] && !/^\d{5}(-\d{4})?$/.test(result[field])) throw new Error(`${FIELD_LABELS[field]} must be a five- or nine-digit ZIP code.`);
  }
  for (const field of ['state', 'mailingState']) {
    if (result[field] && !/^[A-Za-z]{2}$/.test(result[field])) throw new Error(`${FIELD_LABELS[field]} must use a two-letter state abbreviation.`);
    result[field] = result[field].toUpperCase();
  }
  if (result.householdSize && !/^[1-9]\d?$/.test(result.householdSize)) throw new Error('Household size must be a whole number from 1 to 99.');
  for (const field of ['householdAdults', 'householdChildren', 'householdSeniors']) {
    if (result[field] && !/^(?:[0-9]|[12][0-9]|30)$/.test(result[field])) throw new Error(`${FIELD_LABELS[field]} must be a whole number from 0 to 30, or left blank.`);
  }
  for (const field of ['monthlyEarnedIncome', 'monthlyOtherIncome', 'monthlyRent', 'monthlyUtilities', 'assetsOnHand', 'monthlyMedicalExpenses']) {
    if (result[field] && !/^\d{1,8}(\.\d{1,2})?$/.test(result[field])) throw new Error(`${FIELD_LABELS[field]} must be a nonnegative dollar amount, or blank if unknown.`);
  }
  for (const definition of SNAP_INFORMATION.scalarFields) result[definition.key] = validateInformationValue(definition, input[definition.key]);
  result.householdMembers = validateMembers(input.householdMembers, result, { today, saving });
  for (const key of Object.keys(RECORD_FIELDS)) result[key] = validateRecords(key, input[key]);
  return result;
}

const STATE_CODES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC AS GU MP PR VI AA AE AP FM MH PW'.split(' '));
// Catalog fields stay ordinary bounded strings. Validation never chooses a
// person, time period, citizenship answer, or current-income interpretation.
function validateInformationValue(definition, input) {
  const { key, label, type } = definition;
  const value = text(input, label, definition.maxLength || 200);
  if (!value) return '';
  if (type === 'yesno' || type === 'select') {
    if (!definition.options.some(option => option[0] === value)) throw new Error(`Choose a supported answer for ${label}.`);
  }
  if (type === 'money' && !/^\d{1,8}(\.\d{1,2})?$/.test(value)) throw new Error(`${label} must be a nonnegative dollar amount, or blank if unknown.`);
  if (type === 'date' && !validDate(value)) throw new Error(`${label} must be a valid date.`);
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`${label} must be a valid email address.`);
  if (type === 'tel' && (!/^\+?[\d\s().-]{7,30}$/.test(value) || value.replace(/\D/g, '').length < 7 || value.replace(/\D/g, '').length > 15)) throw new Error(`${label} must be a valid phone number.`);
  if (type === 'zip' && !/^\d{5}(-\d{4})?$/.test(value)) throw new Error(`${label} must be a five- or nine-digit ZIP code.`);
  if (type === 'state' && !STATE_CODES.has(value.toUpperCase())) throw new Error(`${label} must be a recognized two-letter state or postal-region abbreviation.`);
  if (key === 'ssn' && !/^\d{3}-?\d{2}-?\d{4}$/.test(value)) throw new Error('Enter a nine-digit Social Security number or leave it blank.');
  if (key === 'taxYear' && !/^(19|20)\d{2}$/.test(value)) throw new Error('Tax year must contain four digits from 1900 to 2099.');
  if (key === 'monthlyHours' && (!/^\d{1,3}(\.\d{1,2})?$/.test(value) || Number(value) > 744)) throw new Error('Hours per month must be between 0 and 744.');
  if (key === 'hoursPerWeek' && (!/^\d{1,3}(\.\d{1,2})?$/.test(value) || Number(value) > 168)) throw new Error('Hours per week must be between 0 and 168.');
  if (key === 'pregnancyExpectedBabies' && !/^(?:[1-9]|1\d|20)$/.test(value)) throw new Error('Number of expected babies must be a whole number from 1 to 20, or left blank.');
  return type === 'state' ? value.toUpperCase() : value;
}

function denseList(value, max, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) throw new Error(`${label} must be a list with up to ${max} entries.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(descriptors[key], 'value'))) || Object.keys(value).length !== value.length) throw new Error(`${label} must contain plain entries.`);
  return value;
}

function validateRecords(key, input) {
  if (!Object.hasOwn(RECORD_FIELDS, key)) throw new Error('Unknown information list.');
  if (input === undefined) return [];
  denseList(input, MAX_RECORDS, FIELD_LABELS[key]);
  const definitions = RECORD_FIELDS[key], allowed = ['id', ...definitions.map(field => field.key)], ids = new Set();
  return input.map(row => {
    object(row);
    if (Object.keys(row).some(field => !allowed.includes(field))) throw new Error('Unknown information-list field.');
    if (typeof row.id !== 'string' || !MEMBER_ID.test(row.id) || ids.has(row.id.toLowerCase())) throw new Error('Each information-list entry needs a unique identifier.');
    ids.add(row.id.toLowerCase());
    const result = { id: row.id.toLowerCase(), ...Object.fromEntries(definitions.map(field => [field.key, validateInformationValue(field, row[field.key])])) };
    if (result.startDate && result.endDate && result.endDate < result.startDate) throw new Error('An end date cannot be before its start date.');
    return result;
  });
}

const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The household list: up to 20 people, each checked like the rest of the profile. The applicant is its one
// self row, which always carries their own name and birth date.
function validateMembers(input, applicant, { today, saving }) {
  if (input === undefined) return [];
  if (Array.isArray(input) && input.length > MAX_MEMBERS) throw new Error(`The household list holds up to ${MAX_MEMBERS} people.`);
  denseList(input, MAX_MEMBERS, 'The household list');
  const ids = new Set();
  const members = input.map((member, index) => {
    try { object(member); } catch { throw new Error('A household member is invalid.'); }
    if (Object.keys(member).some(key => !MEMBER_FIELDS.includes(key))) throw new Error('Unknown household member field.');
    if (typeof member.id !== 'string' || !MEMBER_ID.test(member.id)) throw new Error('A household member is invalid.');
    if (ids.has(member.id.toLowerCase())) throw new Error('Each household member can be listed only once.');
    ids.add(member.id.toLowerCase());
    const result = { id: member.id.toLowerCase(), firstName: text(member.firstName, 'A household member’s first name', 100), lastName: text(member.lastName, 'A household member’s last name', 100),
      birthDate: text(member.birthDate, 'A household member’s date of birth', 10), relationship: text(member.relationship, 'A household member’s relationship', 20),
      student: text(member.student, 'Whether a household member is a student', 3), grade: text(member.grade, 'A household member’s grade', 20) };
    for (const definition of SNAP_INFORMATION.memberFields) {
      if (!['firstName', 'lastName', 'birthDate', 'relationship', 'student', 'grade'].includes(definition.key)) result[definition.key] = validateInformationValue(definition, member[definition.key]);
    }
    if (!RELATIONSHIPS.includes(result.relationship) && result.relationship !== '') throw new Error('Choose how each household member is related to you.');
    if (!['', 'yes', 'no'].includes(result.student)) throw new Error('Whether a household member is a student must be Yes, No, or left unanswered.');
    if (result.grade && result.student !== 'yes') throw new Error('Add a grade only for a household member who is a student.');
    if (result.ssn && result.hasSsnAnswer === 'no') throw new Error('A household member has a Social Security number entered but having one is answered No.');
    if (result.relationship === 'self') Object.assign(result, { firstName: applicant.firstName, lastName: applicant.lastName, birthDate: applicant.birthDate });
    else if (!result.firstName) throw new Error('Enter a first name for each person in your household.');
    if (result.birthDate && !validDate(result.birthDate)) throw new Error('Enter a valid date of birth for each person in your household.');
    // The applicant's own date was checked as theirs.
    if (saving && result.relationship !== 'self') checkBirthDate(result.birthDate, `Person ${index + 1}’s`, today);
    return result;
  });
  if (members.length && members.filter(member => member.relationship === 'self').length !== 1) throw new Error('The household list must include you once.');
  return members;
}

// Whether a page may ask for this field: a named request field, or a valid age-band count.
const isRequestField = key => REQUEST_FIELDS.includes(key) || household.isBandKey(key);
function fieldLabel(key) {
  if (Object.hasOwn(FIELD_LABELS, key)) return FIELD_LABELS[key];
  if (Object.hasOwn(SOURCE_LABELS, key)) return SOURCE_LABELS[key];
  if (household.isBandKey(key)) return household.bandLabel(key);
  throw new Error('Unknown field.');
}
// What a page asking for `field` gets from a saved profile: '' when nothing is saved. Derived answers are
// worked out, age-band counts come from birth dates, and the household list's counts win over the manual ones.
// A birth date after today or more than 130 years ago is never filled, and no age is worked out from it.
function releasedValue(profile, field, { today } = {}) {
  if (!isRequestField(field)) throw new Error('This is not a field a page may ask for.');
  if (household.isBandKey(field)) return household.bandCount(profile, field, { today });
  if (Object.hasOwn(DERIVED_FIELDS, field)) return DERIVED_FIELDS[field](profile);
  if (Object.hasOwn(HOUSEHOLD_COUNT_FIELDS, field) && household.listed(profile)) return household.householdCounts(profile, { today })[HOUSEHOLD_COUNT_FIELDS[field]];
  if (field === 'birthDate' && household.birthDateProblem(profile.birthDate, today)) return '';
  return typeof profile[field] === 'string' ? profile[field] : '';
}
// Whether a page asking for `field` gets no answer because a saved birth date it needs can't be used:
// the applicant's own for their date of birth, everyone's on the household list for a count by age.
function blockedByBirthDate(profile, field, { today } = {}) {
  if (field === 'birthDate') return household.birthDateProblem(profile.birthDate, today) !== null;
  const byAge = household.isBandKey(field) || Object.hasOwn(household.COUNT_BANDS, field);
  return byAge && household.listed(profile) && profile.householdMembers.some(member => household.birthDateProblem(member.birthDate, today) !== null);
}

function validateApplication(input, existing) {
  object(input);
  const allowed = ['id', 'program', 'status', 'createdAt', 'updatedAt', 'confirmationNumber', 'notes', 'nextAction', 'dueDate'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Unknown application field.');
  if (input.id && (typeof input.id !== 'string' || !/^[a-f\d-]{36}$/i.test(input.id))) throw new Error('Invalid application ID.');
  if (input.program && input.program !== 'Iowa SNAP') throw new Error('Only Iowa SNAP is supported.');
  const status = input.status || 'draft';
  if (!APPLICATION_STATUSES.includes(status)) throw new Error('Invalid application status.');
  const confirmationNumber = text(input.confirmationNumber, 'Confirmation number', 150);
  if (status === 'submitted' && !confirmationNumber) throw new Error('Add the portal confirmation number before marking an application submitted.');
  const dueDate = text(input.dueDate, 'Due date', 10);
  if (dueDate && !validDate(dueDate)) throw new Error('Enter a valid due date.');
  const now = new Date().toISOString();
  return {
    id: existing?.id || input.id || randomUUID(), program: 'Iowa SNAP', status,
    createdAt: existing?.createdAt || now, updatedAt: now, confirmationNumber,
    notes: text(input.notes, 'Notes', 5000), nextAction: text(input.nextAction, 'Next action', 500), dueDate
  };
}

function validateStoredApplication(input) {
  object(input);
  if (!input.id || !input.createdAt || !input.updatedAt) throw new Error('Incomplete stored application.');
  for (const field of ['createdAt', 'updatedAt']) {
    const value = input[field];
    if (typeof value !== 'string' || value.length !== 24 || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Invalid application timestamp.');
  }
  if (input.updatedAt < input.createdAt) throw new Error('Invalid application chronology.');
  return { ...validateApplication(input), createdAt: input.createdAt, updatedAt: input.updatedAt };
}

module.exports = { PORTAL_URL, FIELD_LABELS, PROFILE_FIELDS, REQUEST_FIELDS, DERIVED_FIELDS, PROFILE_CHOICES, YES_NO_FIELDS, APPLICATION_STATUSES, HOUSEHOLD_COUNT_FIELDS,
  RELATIONSHIPS, MAX_MEMBERS, MEMBER_FIELDS, LIST_FIELDS, SNAP_INFORMATION, SNAP_IOWA_ONLY_FIELDS, RECORD_FIELDS, MAX_RECORDS, MAX_PROFILE_REVIEW_ROWS,
  SAVE_FIELDS, isPortalUrl, isHttpsSiteUrl, siteOrigin, isRequestField, fieldLabel, releasedValue, blockedByBirthDate, savedBirthDateRefusal,
  validateInformationValue, validateRecords, validateProfile, validateStoredProfile, validateApplication, validateStoredApplication };
