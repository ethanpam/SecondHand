'use strict';
// The answer rules a collected form question can be tagged with. A rule names the saved
// fact that decides the question; the dataset builder computes the correct answer from the
// facts sheet (shared/facts.cjs) with code, so training labels never come from a guess.
// `types` are the question types a rule fits; `params` describe its extra fields.
const { GENERIC_KEYS } = require('../extension/generic-adapter.js');

const CHOICE = ['radio', 'select'];
const YES_NO = ['radio', 'select', 'checkbox'];
const TEXT = ['text', 'textarea', 'number', 'date', 'email', 'tel', 'select'];
const ALL = ['radio', 'select', 'checkbox', 'text', 'textarea', 'number', 'date', 'email', 'tel'];
const PERIOD = { type: 'string', enum: ['month', 'year'], required: true };

const RULES = Object.freeze({
  // Questions SecondHand leaves to the applicant.
  none: { about: 'The saved profile cannot answer this: pets, pickup day or time, student ID, dietary needs, how you heard about the pantry.', types: ALL, params: {} },
  never: { about: 'SecondHand must never answer this: consent, signatures, attestations ("I certify"), terms, Social Security number.', types: ALL, params: {} },
  // Text boxes that hold one saved value (the #39 matching task).
  field: { about: 'A box for one saved value such as full name, phone, ZIP or household size. `key` is the SecondHand field it holds.', types: TEXT,
    params: { key: { type: 'string', enum: GENERIC_KEYS, required: true } } },
  // Yes/no questions decided by one household fact.
  anySenior65: { about: 'Is anyone in the household 65 or older?', types: YES_NO, params: {} },
  anySenior60: { about: 'Is anyone in the household 60 or older? Only known when the applicant is 60+ or someone is 65+.', types: YES_NO, params: {} },
  applicantAgeAtLeast: { about: 'Is the applicant at least `age` years old ("Are you 60 or older?").', types: YES_NO, params: { age: { type: 'number', required: true } } },
  anyChildren: { about: 'Are there children under 18 in the household?', types: YES_NO, params: {} },
  veteran: { about: 'Is anyone in the household a veteran or in the military?', types: YES_NO, params: {} },
  disability: { about: 'Does anyone in the household have a disability?', types: YES_NO, params: {} },
  pregnant: { about: 'Is anyone in the household pregnant?', types: YES_NO, params: {} },
  medicare: { about: 'Does anyone in the household get Medicare?', types: YES_NO, params: {} },
  allCitizens: { about: 'Is everyone in the household a US citizen?', types: YES_NO, params: {} },
  homeless: { about: 'Is the applicant without a home address or experiencing homelessness?', types: YES_NO, params: {} },
  // About the applicant alone, or a narrower group: only answered where the household facts make it certain.
  applicantVeteran: { about: 'Is the applicant (not the household) a veteran? Only "No" is certain, when nobody in the household is.', types: YES_NO, params: {} },
  applicantDisability: { about: 'Does the applicant (not the household) have a disability? Only "No" is certain, when nobody in the household does.', types: YES_NO, params: {} },
  applicantCitizen: { about: 'Is the applicant a US citizen? Only "Yes" is certain, when everyone in the household is.', types: YES_NO, params: {} },
  anyChildrenUnder: { about: 'Are there children under `age` (18 or younger) in the household? "No" is certain when there are no children.', types: YES_NO,
    params: { age: { type: 'number', required: true } } },
  noIncome: { about: 'Does the household have no income at all?', types: YES_NO, params: {} },
  livesInState: { about: 'Does the applicant live in `state` (full name, e.g. "Iowa")?', types: YES_NO, params: { state: { type: 'string', required: true } } },
  livesInCounty: { about: 'Does the applicant live in `county` (e.g. "Polk County")?', types: YES_NO, params: { county: { type: 'string', required: true } } },
  incomeBelow: { about: 'Is total household income below `amount` per `period`? Set `orEqual` when the question says "at or below".', types: YES_NO,
    params: { amount: { type: 'number', required: true }, period: PERIOD, orEqual: { type: 'boolean', required: false } } },
  applyingSnap: { about: 'Is the applicant applying for SNAP / food stamps? Not "do you currently receive SNAP" (that is none).', types: YES_NO, params: {} },
  applyingFip: { about: 'Is the applicant applying for FIP cash assistance?', types: YES_NO, params: {} },
  applyingMedicaid: { about: 'Is the applicant applying for Medicaid / health coverage?', types: YES_NO, params: {} },
  // Choice questions whose options are numbers, ranges or places.
  householdSize: { about: 'How many people are in the household (options like 1, 2, "5 or more", "One (Myself)")?', types: CHOICE, params: {} },
  adultsCount: { about: 'How many adults aged 18 to 64?', types: CHOICE, params: {} },
  childrenCount: { about: 'How many children under 18?', types: CHOICE, params: {} },
  seniorsCount: { about: 'How many people 65 or older?', types: CHOICE, params: {} },
  applicantAgeRange: { about: 'Which age range is the applicant in (options like "18-29", "30-64 yrs", "65+")?', types: CHOICE, params: {} },
  state: { about: 'Which state does the applicant live in?', types: CHOICE, params: {} },
  county: { about: 'Which county does the applicant live in?', types: CHOICE, params: {} },
  incomeBracket: { about: 'Which income range is the household in, per `period` (options like "$0-$999")?', types: CHOICE, params: { period: PERIOD } }
});

module.exports = { RULES };
