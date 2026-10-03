'use strict';
// What the desktop app asks Laya, its local decision model. The model was trained (#41, #65) on
// rows built by ML_model/dataset/build.cjs, so every constant and model input here must match that
// file byte for byte; tests/laya-prompts.test.cjs checks it. The packaged desktop app can only
// load desktop/, renderer/ and shared/, so the training constants are copied here. Each prompt
// format is a MODEL_FORMATS entry in desktop/laya-model.cjs: noul-v1 below, then CHOICE (choice-v2).

// noul-v1: the one question the model answers, about one candidate answer at a time.
const DECISION = Object.freeze({ type: 'noul', instructions: 'Given the facts about the household, is the candidate the correct answer to the form question?' });
const QUESTIONS = Object.freeze({ correct: DECISION });
// The extra candidate that is right when no other candidate is.
const ABSTAIN = 'None of these, or the facts don’t say';
// The question types the model was trained on: text boxes are matched to a saved field (#39),
// choice questions are answered from the saved profile's facts (#42).
const TEXT_TYPES = Object.freeze(['text', 'textarea', 'number', 'date', 'email', 'tel']);
const CHOICE_TYPES = Object.freeze(['radio', 'select', 'checkbox']);

// Saved values a text box can hold: the matching task's candidates, in training order.
const MATCH_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'fullName', 'suffix', 'birthDate', 'email', 'phone', 'addressLine1', 'addressLine2',
  'city', 'state', 'zip', 'county', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors', 'totalMonthlyIncome', 'annualIncome', 'monthlyRent',
  'monthlyUtilities', 'assetsOnHand', 'monthlyMedicalExpenses']);
// How each candidate is described to the model: extension/ai-mapper.js's words for the key.
const KEY_ABOUT = Object.freeze({
  firstName: 'first (given) name', middleName: 'middle name or initial', lastName: 'last (family) name', fullName: 'whole name in one box',
  suffix: 'name suffix such as Jr. or III', birthDate: 'date of birth', email: 'email address', phone: 'phone number',
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

// noul-v1: the saved fields a text box is asked about. Each one is a pass through the model, so a box
// is offered only the groups of fields its label names, and every field when its label names none of
// them. A date box is offered none: date of birth never is. The groups and their words were chosen on
// the training forms' labels. On the test and final forms they keep every box's saved field and change
// none of the model's decisions (docs/laya-model.md, Speed).
const OFFER_GROUPS = Object.freeze([
  { keys: ['firstName', 'middleName', 'lastName', 'fullName', 'suffix'], words: /\b(names?|nombres?|surnames?|apellidos?|given|first|last|middle|initial|mi|suffix|jr|sr|ii|iii|iv)\b/ },
  { keys: ['email', 'phone'], words: /\b(e ?mail|emails|correo|electronico|phones?|telephones?|tel|telefono|cell|cellphone|mobile|contact|reach|text|call)\b/ },
  { keys: ['addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county'],
    words: /\b(address(es)?|direccion|street|apt|apartment|suite|unit|po box|city|ciudad|town|village|state|province|region|estado|zip|zipcode|postal|codigo|county|condado|parish|mailing|physical)\b/ },
  { keys: ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'],
    words: /\b(households?|family|families|people|persons?|members?|individuals?|adults?|child|children|kids?|minors?|infants?|babies|seniors?|elderly|size|how many)\b/ },
  { keys: ['monthlyRent', 'monthlyUtilities'], words: /\b(rent|rental|mortgage|housing|utility|utilities|electric|electricity|gas|water|heat|heating|bills?|payments?|pay|costs?|expenses?|monthly|month|amount|dollars)\b/ }
].map(group => Object.freeze({ keys: Object.freeze(group.keys), words: group.words })));
// A label's words, lowercased and without accents or punctuation.
const topicText = label => String(label).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’']/g, '').replace(/#/g, ' number ')
  .replace(/[^a-z0-9+]+/g, ' ').trim();
function offeredFields({ label, type }) {
  if (!TEXT_TYPES.includes(type)) throw new TypeError(`A ${type} field isn’t a text box Laya matches.`);
  if (type === 'date') return [];
  const text = topicText(label);
  const named = new Set(OFFER_GROUPS.filter(group => group.words.test(text)).flatMap(group => group.keys));
  return named.size ? MATCH_CANDIDATES.filter(key => named.has(key)) : [...MATCH_CANDIDATES];
}
const answerState = (facts, question, candidate) => ({ facts, question, candidate });

// choice-v2 (#65): one `choice` question per form question, so every option is scored in one
// pass. Answering: the facts and the question are the state, the form's options plus ABSTAIN the
// choices. Matching: the box's label and type (BOX_TYPES) are the state, the saved fields offered
// for its type (never a NEVER_SUGGESTED one) plus MATCH_ABSTAIN the choices, described as KEY_ABOUT says.
const CHOICE_ANSWER_INSTRUCTIONS = 'Given the facts about the household, which option is the correct answer to the form question?';
const CHOICE_MATCH_INSTRUCTIONS = 'Which saved answer belongs in this form box, given its label and type?';
const MATCH_ABSTAIN = 'None of these';
// How each text-box type is described to the model.
const BOX_TYPES = Object.freeze({ text: 'text', textarea: 'long text', number: 'number', date: 'date', email: 'email', tel: 'phone' });
const boxType = type => {
  if (!Object.hasOwn(BOX_TYPES, type)) throw new TypeError(`A ${type} field isn’t a text box Laya matches.`);
  return BOX_TYPES[type];
};
const CHOICE = Object.freeze({
  ANSWER_INSTRUCTIONS: CHOICE_ANSWER_INSTRUCTIONS,
  MATCH_INSTRUCTIONS: CHOICE_MATCH_INSTRUCTIONS,
  MATCH_ABSTAIN,
  BOX_TYPES,
  // In MATCH_KEYS order. A date box has nothing on offer (date of birth never is), so it isn't asked about.
  MATCH_SETS: Object.freeze({
    text: MATCH_CANDIDATES, textarea: MATCH_CANDIDATES,
    number: Object.freeze(['phone', 'zip', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors', 'monthlyRent', 'monthlyUtilities']),
    date: Object.freeze([]), email: Object.freeze(['email']), tel: Object.freeze(['phone'])
  }),
  answerQuestion: options => ({ type: 'choice', instructions: CHOICE_ANSWER_INSTRUCTIONS, criteria: [...options, ABSTAIN] }),
  matchQuestion: keys => ({ type: 'choice', instructions: CHOICE_MATCH_INSTRUCTIONS, criteria: [...keys.map(key => KEY_ABOUT[key]), MATCH_ABSTAIN] }),
  answerState: (facts, question) => ({ facts, question }),
  matchState: (question, type) => ({ question, type: boxType(type) })
});

// Questions only the applicant answers: consent, signatures, attestations, agreements, terms,
// Social Security numbers, and secrets. Must stay identical to UNSAFE_QUESTION in
// extension/generic-adapter.js, and is matched against the same normalized text.
const UNSAFE_QUESTION = /^social security$|\b(consent\w*|sign|signs|signed|signing|signature\w*|initials|attest\w*|certif\w*|agree|agrees|agreed|agreement\w*|terms|acknowledg\w*|authoriz\w*|permission|perjury|i understand|i confirm|i have read|true and (correct|accurate|complete)|privacy|social security (number|no|num|card)|ss number|ssn|itin|password|passcode|pin|cvv|cvc|card number|credit card|debit card|security code|captcha|verification code|one time)\b/;
const normal = value => String(value || '').toLowerCase().replace(/[‘’']/g, '').replace(/#/g, ' number ').replace(/\*/g, ' ').replace(/[^a-z0-9+]+/g, ' ').trim();
const unsafeQuestion = field => [field?.label, ...(Array.isArray(field?.options) ? field.options : [])].some(text => UNSAFE_QUESTION.test(normal(text)));

module.exports = { DECISION, QUESTIONS, ABSTAIN, TEXT_TYPES, CHOICE_TYPES, MATCH_KEYS, KEY_ABOUT, NEVER_SUGGESTED, MATCH_CANDIDATES, matchState, offeredFields, answerState,
  CHOICE, UNSAFE_QUESTION, unsafeQuestion };
