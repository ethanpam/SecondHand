'use strict';
const { randomUUID } = require('node:crypto');

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
  hasSsn: 'Whether you have a Social Security number'
});
// Answers the desktop works out from saved fields when a page asks for them. They are never saved,
// and never carry the saved value itself: hasSsn says only that a Social Security number is saved.
const DERIVED_FIELDS = Object.freeze({
  hasSsn: profile => typeof profile.ssn === 'string' && profile.ssn.trim() ? 'yes' : ''
});
const PROFILE_FIELDS = Object.freeze(Object.keys(FIELD_LABELS).filter(key => !Object.hasOwn(DERIVED_FIELDS, key)));
// Every field a page may ask the desktop for.
const REQUEST_FIELDS = Object.freeze(Object.keys(FIELD_LABELS));
const YES_NO_FIELDS = Object.freeze(['hasHomeAddress', 'mailingSameAsHome', 'isApplicant',
  'programSnap', 'programFip', 'programMedicaid', 'helpPayMedicalBills', 'householdVeteran', 'householdDisability',
  'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare']);
const PROFILE_CHOICES = Object.freeze({
  ...Object.fromEntries(YES_NO_FIELDS.map(field => [field, Object.freeze(['', 'yes', 'no'])])),
  suffix: Object.freeze(['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'Jr.', 'Sr.'])
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
}
function text(value, name, max = 200) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(`${name} is invalid.`);
  return value.trim();
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validateProfile(input) {
  object(input);
  if (Object.keys(input).some(key => !PROFILE_FIELDS.includes(key))) throw new Error('Unknown profile field.');
  const result = Object.fromEntries(PROFILE_FIELDS.map(key => [key, text(input[key], FIELD_LABELS[key])]));
  for (const [field, choices] of Object.entries(PROFILE_CHOICES)) {
    if (!choices.includes(result[field])) throw new Error(YES_NO_FIELDS.includes(field) ?
      `${FIELD_LABELS[field]} must be Yes, No, or left unanswered.` : `Choose a supported ${FIELD_LABELS[field].toLowerCase()}, or leave it blank.`);
  }
  if (result.bestContactTime.length > 30) throw new Error('Best time to call must be 30 characters or fewer.');
  if (result.birthDate && (!validDate(result.birthDate) || result.birthDate > new Date().toISOString().slice(0, 10))) throw new Error('Enter a valid date of birth.');
  if (result.ssn && !/^\d{3}-?\d{2}-?\d{4}$/.test(result.ssn)) throw new Error('Enter a nine-digit Social Security number or leave it blank.');
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
  return result;
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

module.exports = { PORTAL_URL, FIELD_LABELS, PROFILE_FIELDS, REQUEST_FIELDS, DERIVED_FIELDS, PROFILE_CHOICES, YES_NO_FIELDS, APPLICATION_STATUSES, isPortalUrl, isHttpsSiteUrl, siteOrigin, validateProfile, validateApplication, validateStoredApplication };
