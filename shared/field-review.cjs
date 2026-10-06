'use strict';

// Advisory checks only: no I/O, model calls, corrections, or profile writes.
// Messages and labels are fixed; source values never become review text.
const { PROFILE_FIELDS, FIELD_LABELS, PROFILE_CHOICES, RELATIONSHIPS, MAX_MEMBERS, validateProfile } = require('./schema.cjs');
const household = require('./household.cjs');
const SCALARS = PROFILE_FIELDS.filter(key => key !== 'householdMembers');
const SCALAR_SET = new Set(SCALARS);
const MEMBER_FIELDS = ['firstName', 'lastName', 'birthDate', 'relationship', 'student', 'grade'];
const MEMBER_LABELS = { firstName: 'First name', lastName: 'Last name', birthDate: 'Date of birth', relationship: 'Relationship', student: 'Student', grade: 'Grade' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC AS GU MP PR VI AA AE AP FM MH PW'.split(' '));
const PHONES = new Set(['phone', 'homePhone', 'mobilePhone']);
const AMOUNTS = new Set(['monthlyEarnedIncome', 'monthlyOtherIncome', 'monthlyRent', 'monthlyUtilities', 'assetsOnHand', 'monthlyMedicalExpenses']);
const COUNTS = ['householdAdults', 'householdChildren', 'householdSeniors'];
const SOURCE = new Set(['firstName', 'middleName', 'lastName', 'maidenName', 'addressLine1', 'addressLine2', 'city', 'county',
  'mailingAddressLine1', 'mailingAddressLine2', 'mailingCity', 'bestContactTime', ...Object.keys(PROFILE_CHOICES)]);
const INVALID = Symbol('invalid input');
const BAD_VALUE = 'This answer has an unsupported format. Check the original and enter it again.';
const CHECK_SOURCE = 'Compare this answer with the original source or your own records. Its accuracy has not been verified.';
const FORMAT_ONLY = 'The format passed these checks. This does not verify that the answer is correct.';

function record(value) {
  try { return Boolean(value) && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}
function list(value) {
  try { return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype; }
  catch { return false; }
}
// Do not execute accessors while reviewing a malformed request.
function read(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor ? Object.hasOwn(descriptor, 'value') ? descriptor.value : INVALID : undefined;
  } catch { return INVALID; }
}
const bounded = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const cleanText = value => typeof value === 'string' ? value.trim() : '';
const entry = (key, label, status, message) => ({ key, label, status, messages: message ? [message] : [] });
function flag(result, message) {
  if (!result) return;
  result.status = 'needs-review';
  if (!result.messages.includes(message)) result.messages.push(message);
}
function validToday(today) {
  try {
    const formatted = household.localDate(today);
    return /^\d{4}-\d{2}-\d{2}$/.test(formatted) && new Date(formatted).toISOString().slice(0, 10) === formatted;
  } catch { return false; }
}
function invalidMessage(key) {
  if (key === 'birthDate') return 'Use a real date of birth that is not after today and is no more than 130 years ago.';
  if (key === 'ssn') return 'Use nine digits, with optional hyphens in the usual three-two-four grouping. Check the original card.';
  if (key === 'email') return 'Check the email address, including the name, @ sign, and domain.';
  if (PHONES.has(key)) return 'Check the phone number and country code. Use digits and ordinary phone punctuation.';
  if (key === 'state' || key === 'mailingState') return 'Use a recognized two-letter U.S. state or postal-region abbreviation.';
  if (key === 'zip' || key === 'mailingZip') return 'Use five ZIP digits, or five digits followed by a hyphen and four more digits.';
  if (key === 'householdSize') return 'Use a whole household size from 1 to 99.';
  if (COUNTS.includes(key)) return 'Use a whole number from 0 to 30, or leave it unanswered.';
  if (AMOUNTS.has(key)) return 'Use a nonnegative amount with at most eight whole-number digits and two decimal places. Check the time period.';
  if (Object.hasOwn(PROFILE_CHOICES, key)) return 'Choose one of the available answers, or leave the question unanswered.';
  if (key === 'bestContactTime') return 'Keep the best time to call to 30 characters or fewer.';
  return BAD_VALUE;
}
function scalar(key, raw, options) {
  const result = entry(key, FIELD_LABELS[key], 'empty');
  if (raw === undefined || (typeof raw === 'string' && raw.length <= 200 && !raw.trim())) return result;
  if (!bounded(raw, 200)) { flag(result, BAD_VALUE); return result; }
  const value = raw.trim();
  if (key === 'birthDate' && !validToday(options.today)) { flag(result, 'The date used for this check is unavailable. Check the date of birth yourself.'); return result; }
  try { validateProfile({ [key]: value }, options); }
  catch { flag(result, invalidMessage(key)); return result; }
  if ((key === 'state' || key === 'mailingState') && !STATES.has(value.toUpperCase())) flag(result, invalidMessage(key));
  if (PHONES.has(key)) {
    const digits = value.replace(/\D/g, '');
    const parentheses = [...value].reduce((depth, character) => depth < 0 ? depth : character === '(' ? depth + 1 : character === ')' ? depth - 1 : depth, 0);
    if (digits.length < 7 || digits.length > 15 || !/^\+?[\d\s().-]+$/.test(value) || parentheses !== 0) flag(result, invalidMessage(key));
  }
  if (key === 'ssn') {
    const digits = value.replace(/-/g, '');
    // SSA randomization excludes 000, 666, 900–999; group 00 and serial 0000.
    // https://www.ssa.gov/employer/randomizationfaqs.html
    if (/^(?:000|666|9\d\d)/.test(digits) || digits.slice(3, 5) === '00' || digits.slice(5) === '0000') {
      flag(result, 'This number contains a group that Social Security does not assign. Check the original card; do not guess replacement digits.');
    }
  }
  if (result.status !== 'needs-review') {
    result.status = SOURCE.has(key) ? 'check-source' : 'format-passed';
    result.messages.push(result.status === 'check-source' ? CHECK_SOURCE : FORMAT_ONLY);
  }
  return result;
}

function reviewProfile(profile, options = {}) {
  const today = record(options) ? read(options, 'today') : undefined;
  const goodShape = record(profile);
  const values = Object.fromEntries(SCALARS.map(key => [key, goodShape ? read(profile, key) : INVALID]));
  const results = SCALARS.map(key => scalar(key, values[key], { today }));
  const byKey = new Map(results.map(result => [result.key, result]));
  const mark = (keys, message) => keys.forEach(key => flag(byKey.get(key), message));
  const value = key => cleanText(values[key]);
  const has = key => typeof values[key] === 'string' && values[key].length <= 200 && Boolean(value(key));
  const numeric = key => has(key) && byKey.get(key).status === 'format-passed' ? Number(value(key)) : null;
  if (has('ssn') && value('hasSsnAnswer') === 'no') mark(['ssn', 'hasSsnAnswer'], 'A number is entered, but having a Social Security number is answered No. Review both answers.');
  for (const [self, family, selfAnswer, familyAnswer] of [['disabled', 'householdDisability', 'yes', 'no'], ['medicare', 'householdMedicare', 'yes', 'no'], ['usCitizen', 'householdAllCitizens', 'no', 'yes']]) {
    if (value(self) === selfAnswer && value(family) === familyAnswer) mark([self, family], 'Your answer conflicts with the answer about everyone in your household. Review both answers.');
  }
  const homeKeys = ['addressLine1', 'addressLine2', 'city', 'state', 'zip'];
  if (value('hasHomeAddress') === 'no' && homeKeys.some(has)) mark(['hasHomeAddress', ...homeKeys.filter(has)], 'A home address is entered, but having a home address is answered No. Check whether these are current home details.');
  if (value('mailingSameAsHome') === 'yes') for (const [home, mailing] of homeKeys.map(key => [key, `mailing${key[0].toUpperCase()}${key.slice(1)}`])) {
    if (has(home) && has(mailing) && value(home).toLowerCase() !== value(mailing).toLowerCase()) mark(['mailingSameAsHome', home, mailing], 'The home and mailing details differ, but the addresses are marked the same. Check both addresses.');
  }
  const size = numeric('householdSize'), counts = COUNTS.map(numeric);
  const knownSum = counts.reduce((sum, count) => sum + (count ?? 0), 0);
  // The schema's adults are 18–64. Children and seniors are separate bands;
  // seniors are included once, never added to an already inclusive adult count.
  if (size !== null && (knownSum > size || (counts.every(count => count !== null) && knownSum !== size))) {
    mark(['householdSize', ...COUNTS.filter((key, index) => counts[index] !== null)], 'The separate child, adult (18–64), and senior (65+) counts do not match the household size. Review the counts.');
  }

  const rawMembers = goodShape ? read(profile, 'householdMembers') : INVALID;
  const summary = entry('householdMembers', FIELD_LABELS.householdMembers, 'empty');
  results.push(summary); byKey.set(summary.key, summary);
  if (rawMembers === undefined) return results;
  if (!list(rawMembers)) { flag(summary, 'The household list has an unsupported format. Review the people listed.'); return results; }
  const length = read(rawMembers, 'length');
  if (!Number.isSafeInteger(length) || length < 0) { flag(summary, 'The household list has an unsupported format. Review the people listed.'); return results; }
  if (length > MAX_MEMBERS) flag(summary, 'The household list exceeds the supported number of people. Review the list.');
  else if (length) { summary.status = 'check-source'; summary.messages.push(CHECK_SOURCE); }
  const members = [], ids = new Set();
  for (let index = 0; index < Math.min(length, MAX_MEMBERS); index++) {
    const raw = read(rawMembers, String(index)), shape = record(raw);
    const member = Object.fromEntries(['id', ...MEMBER_FIELDS].map(key => [key, shape ? read(raw, key) : INVALID]));
    members.push(member);
    if (!shape || !bounded(member.id, 36) || !UUID.test(member.id) || ids.has(member.id.toLowerCase())) flag(summary, 'A household entry has a missing or duplicate identifier. Review the list before saving.');
    if (bounded(member.id, 36)) ids.add(member.id.toLowerCase());
    for (const field of MEMBER_FIELDS) {
      const key = `householdMembers.${index}.${field}`, rawValue = member[field];
      const result = field === 'birthDate' ? { ...scalar(field, rawValue, { today }), key, label: MEMBER_LABELS[field] }
        : entry(key, MEMBER_LABELS[field], 'empty');
      if (field !== 'birthDate' && rawValue !== undefined && rawValue !== '') {
        const max = ['firstName', 'lastName'].includes(field) ? 100 : field === 'student' ? 3 : 20;
        if (!bounded(rawValue, max)) flag(result, BAD_VALUE);
        else if (rawValue.trim()) { result.status = 'check-source'; result.messages.push(CHECK_SOURCE); }
      }
      const text = cleanText(rawValue);
      if (field === 'relationship' && text && !RELATIONSHIPS.includes(text)) flag(result, 'Choose one of the available relationships.');
      if (field === 'student' && text && !['yes', 'no'].includes(text)) flag(result, 'Choose Yes, No, or leave student status unanswered.');
      if (field === 'grade' && text && member.student !== 'yes') flag(result, 'A grade is entered without a Yes answer for student status. Review both answers.');
      if (field === 'firstName' && !text && member.relationship !== 'self') flag(result, 'Add a first name for this household member, or review whether this person belongs on the list.');
      if (member.relationship === 'self' && ['firstName', 'lastName', 'birthDate'].includes(field) && typeof rawValue === 'string' && text !== value(field)) {
        flag(result, 'The household entry for you differs from your own profile details. Review both entries.');
        flag(byKey.get(field), 'Your profile details differ from your household entry. Review both entries.');
      }
      results.push(result); byKey.set(key, result);
    }
  }
  if (members.length && members.filter(member => member.relationship === 'self').length !== 1) flag(summary, 'The household list must include your own entry exactly once. Review the relationships.');
  if (length <= MAX_MEMBERS && members.length && summary.status !== 'needs-review') {
    if (size !== null && size !== members.length) mark(['householdMembers', 'householdSize'], 'The household size differs from the number of people listed. Review the list and count.');
    const ages = members.map((member, index) => {
      if (byKey.get(`householdMembers.${index}.birthDate`).status !== 'format-passed') return null;
      try { return household.ageOn(member.birthDate, today); } catch { return null; }
    });
    if (ages.every(age => age !== null)) COUNTS.forEach((key, index) => {
      const band = household.COUNT_BANDS[key];
      const expected = ages.filter(age => age >= band.low && (band.high === null || age <= band.high)).length;
      if (counts[index] !== null && counts[index] !== expected) mark(['householdMembers', key], 'An age-band count differs from the birth dates on the household list. Review the dates and count.');
    });
  }
  return results;
}

function reviewDocumentFields(fields, profile, options = {}) {
  const today = record(options) ? read(options, 'today') : undefined;
  const invalidFields = () => [{ ...entry('document', 'Document fields', 'needs-review', 'The document fields have an unsupported format.'), id: 'document' }];
  if (!list(fields)) return invalidFields();
  const length = read(fields, 'length'), results = [], seenIds = new Map();
  if (!Number.isSafeInteger(length) || length < 0) return invalidFields();
  const base = record(profile) ? Object.fromEntries(PROFILE_FIELDS.map(key => [key, read(profile, key)])) : {};
  for (let index = 0; index < Math.min(length, 150); index++) {
    const candidate = read(fields, String(index)), shape = record(candidate);
    const get = key => shape ? read(candidate, key) : INVALID;
    const rawKey = get('profileKey'), supported = SCALAR_SET.has(rawKey);
    const rawId = get('id'), validId = bounded(rawId, 80) && /^[A-Za-z0-9_.:-]+$/.test(rawId);
    const id = validId ? rawId : `document-${index}`;
    const rawValue = get('value'), label = get('label'), sourceLabel = get('sourceLabel'), sourceRole = get('sourceRole'), confidence = get('confidence'), page = get('page');
    const result = supported
      ? { ...reviewProfile({ ...base, [rawKey]: rawValue }, { today }).find(row => row.key === rawKey), id }
      : { ...entry(`document.${index}`, 'Document field', 'check-source', 'This document detail is for source review only. It is not verified as a current profile answer.'), id };
    if (!supported && (rawValue === undefined || rawValue === '')) { result.status = 'empty'; result.messages = []; }
    if (!shape || (rawValue !== undefined && !bounded(rawValue, 500)) || (label !== undefined && !bounded(label, 150)) ||
        (sourceLabel !== undefined && !bounded(sourceLabel, 150)) || (sourceRole !== undefined && !['applicant', 'spouse', 'document'].includes(sourceRole)) ||
        (rawId !== undefined && !validId) || (rawKey !== undefined && (!bounded(rawKey, 80) || !supported)) ||
        (page !== undefined && (!Number.isSafeInteger(page) || page < 1 || page > 12)) ||
        (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 100))) {
      flag(result, 'The document field has unsupported data or metadata. Check the original document.');
    }
    if (seenIds.has(id)) {
      const message = 'More than one document field uses this identifier. Review these entries separately.';
      flag(result, message); flag(seenIds.get(id), message);
    }
    seenIds.set(id, result);
    if (length > 150) flag(result, 'The document has more fields than this review can check. Review the remaining details yourself.');
    if (typeof confidence === 'number' && confidence >= 0 && confidence < 75) flag(result, 'Text recognition confidence is low. Compare every character with the original.');
    if (supported && bounded(rawValue, 500) && typeof base[rawKey] === 'string' && base[rawKey].trim() && base[rawKey].trim() !== rawValue.trim()) {
      flag(result, 'This document value differs from your current profile draft. Compare both before deciding whether to replace it.');
    }
    const context = [label, sourceLabel].filter(value => bounded(value, 150)).join(' ').toLowerCase();
    const taxLine = /^taxLine/i.test(id);
    const annual = /\b(?:annual|annually|yearly|tax return|tax-return|w-?2|tax year)\b/.test(context) || taxLine;
    const joint = /\bjoint\b/.test(context), otherPerson = /\b(?:spouse|dependent|child|employer)\b/.test(context) || /^spouse/i.test(id);
    const amountCandidate = AMOUNTS.has(rawKey) || taxLine || (!supported && /\b(?:amount|income|wages|salary|interest|dividends|pensions?|annuities|distributions|rent|expenses|costs|assets|balance|benefits)\b/.test(context));
    if (amountCandidate && (annual || joint)) {
      const message = 'Annual or joint document amounts are historical source details, not verified current monthly income. Do not convert or copy them automatically.';
      if (supported) flag(result, message);
      else if (result.status !== 'needs-review') { result.status = 'check-source'; result.messages.push(message); }
    }
    if (supported && (otherPerson || sourceRole === 'spouse')) flag(result, 'This field appears to describe someone other than the applicant. Check whose information it is before using it.');
    if (result.status === 'format-passed') result.messages.push('OCR can produce incorrect characters even with high confidence. Compare this value with the original.');
    results.push(result);
  }
  return results;
}

module.exports = { reviewProfile, reviewDocumentFields };
