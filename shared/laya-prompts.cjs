'use strict';
// What the desktop app asks Laya, its local decision model. The model was trained (#41) on rows
// built by ML_model/dataset/build.cjs, so every constant and model input here must match that
// file byte for byte; tests/laya-prompts.test.cjs checks it. The packaged desktop app can only
// load desktop/, renderer/ and shared/, so the training constants are copied here.

// The one question the model answers, about one candidate answer at a time.
const DECISION = Object.freeze({ type: 'noul', instructions: 'Given the facts about the household, is the candidate the correct answer to the form question?' });
const QUESTIONS = Object.freeze({ correct: DECISION });
// The extra candidate that is right when no other candidate is.
const ABSTAIN = 'None of these, or the facts don’t say';
// The question types the model was trained on: text boxes are matched to a saved field (#39),
// choice questions are answered from the saved profile's facts (#42).
const TEXT_TYPES = Object.freeze(['text', 'textarea', 'number', 'date', 'email', 'tel']);
const CHOICE_TYPES = Object.freeze(['radio', 'select', 'checkbox']);

// Saved values a text box can hold: the matching task's candidates, in training order.
const MATCH_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'fullName', 'suffix', 'birthDate', 'ssn', 'email', 'phone', 'addressLine1', 'addressLine2',
  'city', 'state', 'zip', 'county', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors', 'totalMonthlyIncome', 'annualIncome', 'monthlyRent',
  'monthlyUtilities', 'assetsOnHand', 'monthlyMedicalExpenses']);
// How each candidate is described to the model: extension/ai-mapper.js's words for the key.
const KEY_ABOUT = Object.freeze({
  firstName: 'first (given) name', middleName: 'middle name or initial', lastName: 'last (family) name', fullName: 'whole name in one box',
  suffix: 'name suffix such as Jr. or III', birthDate: 'date of birth', ssn: 'Social Security number', email: 'email address', phone: 'phone number',
  addressLine1: 'street address', addressLine2: 'apartment, unit, or suite', city: 'city or town', state: 'state', zip: 'ZIP or postal code', county: 'county',
  householdSize: 'number of people in the household', householdAdults: 'number of adults in the household', householdChildren: 'number of children in the household',
  householdSeniors: 'number of seniors (65 or older) in the household', totalMonthlyIncome: 'total household income per month', annualIncome: 'total household income per year',
  monthlyRent: 'monthly rent or mortgage payment', monthlyUtilities: 'monthly utility costs', assetsOnHand: 'money the household has on hand: cash, checking, and savings',
  monthlyMedicalExpenses: 'medical expenses the household pays each month'
});
// Saved answers only a confident rule may place, never an AI guess (SENSITIVE_KEYS in
// extension/background.js). They are never offered to the model as a candidate.
const NEVER_SUGGESTED = Object.freeze(['ssn', 'birthDate', 'ageRange', 'totalMonthlyIncome', 'annualIncome', 'assetsOnHand', 'monthlyMedicalExpenses',
  'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare']);
const MATCH_CANDIDATES = Object.freeze(MATCH_KEYS.filter(key => !NEVER_SUGGESTED.includes(key)));

// One model input each, in the key order of the training rows. A null key is the abstain candidate.
const matchState = (question, key) => ({ question, candidate: key === null ? ABSTAIN : `Saved answer: ${KEY_ABOUT[key]}` });
const answerState = (facts, question, candidate) => ({ facts, question, candidate });

// Questions only the applicant answers: consent, signatures, attestations, agreements, terms,
// Social Security numbers, and secrets. Must stay identical to UNSAFE_QUESTION in
// extension/generic-adapter.js, and is matched against the same normalized text.
const UNSAFE_QUESTION = /^social security$|\b(consent\w*|sign|signs|signed|signing|signature\w*|initials|attest\w*|certif\w*|agree|agrees|agreed|agreement\w*|terms|acknowledg\w*|authoriz\w*|permission|perjury|i understand|i confirm|i have read|true and (correct|accurate|complete)|privacy|social security (number|no|num|card)|ss number|ssn|itin|password|passcode|pin|cvv|cvc|card number|credit card|debit card|security code|captcha|verification code|one time)\b/;
const normal = value => String(value || '').toLowerCase().replace(/[‘’']/g, '').replace(/#/g, ' number ').replace(/\*/g, ' ').replace(/[^a-z0-9+]+/g, ' ').trim();
const unsafeQuestion = field => [field?.label, ...(Array.isArray(field?.options) ? field.options : [])].some(text => UNSAFE_QUESTION.test(normal(text)));

module.exports = { DECISION, QUESTIONS, ABSTAIN, TEXT_TYPES, CHOICE_TYPES, MATCH_KEYS, KEY_ABOUT, NEVER_SUGGESTED, MATCH_CANDIDATES, matchState, answerState,
  UNSAFE_QUESTION, unsafeQuestion };
