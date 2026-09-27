'use strict';
// Builds LayaStudio training rows from the question bank and fictional households.
// Every label is computed here by code from the question's answer rule and the saved
// answers, never guessed. The model is always asked one fixed yes/no question about one
// candidate answer at a time; the abstain candidate is correct when the facts don't say.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildFacts, factsText, ageOf, STATE_NAMES } = require('../../shared/facts.cjs');
const { KEY_ABOUT } = require('../../extension/ai-mapper.js');

const ABSTAIN = 'None of these, or the facts don’t say';
const DECISION = Object.freeze({ type: 'noul', instructions: 'Given the facts about the household, is the candidate the correct answer to the form question?' });
const CHOICE_TYPES = ['radio', 'select', 'checkbox'];
const TEXT_TYPES = ['text', 'textarea', 'number', 'date', 'email', 'tel'];
// Saved values a text box can hold: the matching task's candidates. Yes/no and choice-only keys are left out.
const MATCH_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'fullName', 'suffix', 'birthDate', 'ssn', 'email', 'phone', 'addressLine1', 'addressLine2',
  'city', 'state', 'zip', 'county', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors', 'totalMonthlyIncome', 'annualIncome', 'monthlyRent',
  'monthlyUtilities', 'assetsOnHand', 'monthlyMedicalExpenses']);
const matchCandidate = key => `Saved answer: ${KEY_ABOUT[key]}`;
const NUMBER_WORDS = { none: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

const present = value => typeof value === 'string' && value.trim() !== '';
const count = (profile, field) => present(profile[field]) ? Number(profile[field]) : null;
const yes = (profile, field) => present(profile[field]) ? profile[field] === 'yes' : null;
const dollars = (profile, field) => present(profile[field]) ? Number(profile[field]) : null;
const place = value => String(value).toLowerCase().replace(/\bcounty\b/g, '').replace(/[^a-z]+/g, ' ').trim();
const stateMatches = (code, value) => {
  const wanted = String(value).trim();
  return wanted.toUpperCase() === code || place(STATE_NAMES[code] || '') === place(wanted);
};

// The numeric range an option describes, inclusive, or null when it isn't a number range.
// "3", "Three", "One (Myself)", "1-2 people", "5+", "Five or more", "65 and older", "Under 18",
// "$0 - $15,000", "Over $75,000", "Less than $10,000".
function range(option) {
  let text = String(option).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[$,]/g, '').replace(/\b(yrs?|years?( old)?|people|persons?|members?|per (month|year)|a (month|year)|\/\s*(mo|yr|month|year))\b/g, ' ')
    .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  text = text.replace(/\b(none|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, word => String(NUMBER_WORDS[word]));
  if (/^(just )?me$|^myself$/.test(text)) return [1, 1];
  let match;
  if ((match = /^(\d+(?:\.\d+)?) ?(?:-|to) ?(\d+(?:\.\d+)?)$/.exec(text))) return [Number(match[1]), Number(match[2])];
  if ((match = /^(\d+(?:\.\d+)?) ?(?:\+|or more|or older|or over|and older|and over|and up|or above)$/.exec(text))) return [Number(match[1]), Infinity];
  if ((match = /^(?:under|less than|below|fewer than) (\d+(?:\.\d+)?)$/.exec(text))) return [0, Number(match[1]) - 1];
  if ((match = /^(?:over|more than|above|greater than) (\d+(?:\.\d+)?)$/.exec(text))) return [Number(match[1]) + 1, Infinity];
  if ((match = /^(\d+(?:\.\d+)?)$/.exec(text))) return [Number(match[1]), Number(match[1])];
  return null;
}

function pickRange(question, value) {
  const ranges = question.options.map(range);
  if (!ranges.some(Boolean)) throw new Error(`${question.id}: rule ${question.rule.name} is on options that aren't numbers or ranges.`);
  if (value === null) return ABSTAIN;
  const hits = question.options.filter((_, index) => ranges[index] && value >= ranges[index][0] && value <= ranges[index][1]);
  return hits.length === 1 ? hits[0] : ABSTAIN;
}

function pickYesNo(question, answer) {
  if (answer === null) return ABSTAIN;
  if (question.options.length === 1) return answer ? question.options[0] : ABSTAIN; // a lone checkbox is only ever checked
  const option = question.options.find(item => (answer ? /^\s*yes\b/i : /^\s*no\b/i).test(item));
  if (!option) throw new Error(`${question.id}: yes/no rule ${question.rule.name} is on options without Yes and No.`);
  return option;
}

// The yes/no answer the saved profile proves for a rule, or null when it doesn't say.
function decide(rule, profile, age) {
  const seniors = count(profile, 'householdSeniors');
  const children = count(profile, 'householdChildren');
  switch (rule.name) {
    case 'anySenior65':
      if (age !== null && age >= 65) return seniors === 0 ? null : true;
      return seniors === null ? null : seniors > 0;
    case 'anySenior60':
      if ((age !== null && age >= 60) || (seniors !== null && seniors > 0)) return true;
      // Only a household of one whose applicant is under 60 proves nobody is 60 or older.
      return age !== null && count(profile, 'householdSize') === 1 ? false : null;
    case 'applicantAgeAtLeast': return age === null ? null : age >= rule.age;
    case 'anyChildren': return children === null ? null : children > 0;
    case 'veteran': return yes(profile, 'householdVeteran');
    case 'disability': return yes(profile, 'householdDisability');
    case 'pregnant': return yes(profile, 'householdPregnant');
    case 'medicare': return yes(profile, 'householdMedicare');
    case 'allCitizens': return yes(profile, 'householdAllCitizens');
    case 'homeless': { const home = yes(profile, 'hasHomeAddress'); return home === null ? null : !home; }
    case 'livesInState': return present(profile.state) ? stateMatches(profile.state.toUpperCase(), rule.state) : null;
    case 'livesInCounty': return present(profile.county) ? place(profile.county) === place(rule.county) : null;
    case 'incomeBelow': {
      const earned = dollars(profile, 'monthlyEarnedIncome'), other = dollars(profile, 'monthlyOtherIncome');
      if (earned === null || other === null) return null;
      const total = (earned + other) * (rule.period === 'year' ? 12 : 1);
      return rule.orEqual ? total <= rule.amount : total < rule.amount;
    }
    case 'applyingSnap': return yes(profile, 'programSnap');
    case 'applyingFip': return yes(profile, 'programFip');
    case 'applyingMedicaid': return yes(profile, 'programMedicaid');
    default: return undefined;
  }
}

// The option a question should get for this profile, or ABSTAIN.
function correctOption(question, profile, { today } = {}) {
  const rule = question.rule;
  if (rule.name === 'none' || rule.name === 'never') return ABSTAIN;
  if (rule.name === 'field') throw new Error(`${question.id}: field rules belong to the text-box matching task.`);
  const age = ageOf(profile, { today });
  const answer = decide(rule, profile, age);
  if (answer !== undefined) return pickYesNo(question, answer);
  switch (rule.name) {
    case 'householdSize': return pickRange(question, count(profile, 'householdSize'));
    case 'adultsCount': return pickRange(question, count(profile, 'householdAdults'));
    case 'childrenCount': return pickRange(question, count(profile, 'householdChildren'));
    case 'seniorsCount': return pickRange(question, count(profile, 'householdSeniors'));
    case 'applicantAgeRange': return pickRange(question, age);
    case 'incomeBracket': {
      const earned = dollars(profile, 'monthlyEarnedIncome'), other = dollars(profile, 'monthlyOtherIncome');
      return pickRange(question, earned === null || other === null ? null : (earned + other) * (rule.period === 'year' ? 12 : 1));
    }
    case 'state': {
      if (!present(profile.state)) return ABSTAIN;
      const hits = question.options.filter(option => stateMatches(profile.state.toUpperCase(), option));
      return hits.length === 1 ? hits[0] : ABSTAIN;
    }
    case 'county': {
      if (!present(profile.county)) return ABSTAIN;
      const hits = question.options.filter(option => place(option) === place(profile.county));
      return hits.length === 1 ? hits[0] : ABSTAIN;
    }
    default: throw new Error(`${question.id}: no answer oracle for rule ${rule.name}.`);
  }
}

// Forms land in one split for good: about 70% train, 10% validation, 20% test.
function splitFor(url) {
  const value = crypto.createHash('sha256').update(url).digest().readUInt32BE(0) / 2 ** 32;
  return value < 0.7 ? 'train' : value < 0.8 ? 'val' : 'test';
}

// One row per candidate answer for every choice question and household. With `perQuestion`,
// households are taken round-robin across the correct answers so every answer is represented.
function buildRows(bank, households, { today, perQuestion = Infinity } = {}) {
  const rows = [];
  const sheets = households.map(profile => factsText(buildFacts(profile, { today })));
  for (const file of bank) {
    const split = splitFor(file.source.url);
    for (const question of file.questions.filter(item => CHOICE_TYPES.includes(item.type))) {
      const answers = households.map(profile => correctOption(question, profile, { today }));
      const byAnswer = new Map();
      answers.forEach((answer, index) => byAnswer.set(answer, [...(byAnswer.get(answer) || []), index]));
      const chosen = [];
      for (let round = 0; chosen.length < Math.min(perQuestion, households.length); round++) {
        let added = false;
        for (const indexes of byAnswer.values()) {
          if (round < indexes.length && chosen.length < perQuestion) { chosen.push(indexes[round]); added = true; }
        }
        if (!added) break;
      }
      for (const index of chosen.sort((a, b) => a - b)) {
        for (const candidate of [...question.options, ABSTAIN]) {
          rows.push({ state: { facts: sheets[index], question: question.label, candidate }, answers: { correct: candidate === answers[index] }, split,
            group: `${file.source.url}#${question.id}#${index}` });
        }
      }
    }
  }
  return rows;
}

// Text boxes: which saved value, if any, belongs in the box. One row per candidate field plus abstain.
function buildMatchRows(bank) {
  const rows = [];
  for (const file of bank) {
    const split = splitFor(file.source.url);
    for (const question of file.questions.filter(item => TEXT_TYPES.includes(item.type))) {
      if (question.rule.name === 'field' && !MATCH_KEYS.includes(question.rule.key)) throw new Error(`${question.id}: field key ${question.rule.key} isn't a text-box candidate.`);
      const correct = question.rule.name === 'field' ? matchCandidate(question.rule.key) : ABSTAIN;
      for (const candidate of [...MATCH_KEYS.map(matchCandidate), ABSTAIN]) {
        rows.push({ state: { question: question.label, candidate }, answers: { correct: candidate === correct }, split, group: `${file.source.url}#${question.id}` });
      }
    }
  }
  return rows;
}

function summarize(rows) {
  const decisions = new Set(rows.map(row => row.group)).size;
  const abstained = new Set(rows.filter(row => row.answers.correct && row.state.candidate === ABSTAIN).map(row => row.group)).size;
  return { rows: rows.length, decisions, abstainShare: decisions ? abstained / decisions : 0,
    bySplit: Object.fromEntries(['train', 'val', 'test'].map(split => [split, rows.filter(row => row.split === split).length])) };
}

function writeDataset(outDir, bank, households, options = {}) {
  const answer = buildRows(bank, households, options).map(row => ({ ...row, task: 'answer' }));
  const match = buildMatchRows(bank).map(row => ({ ...row, task: 'match' }));
  const rows = [...answer, ...match];
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'questions.json'), `${JSON.stringify({ correct: DECISION }, null, 2)}\n`);
  // `task` and `decision` let our own evaluation regroup the candidates of one decision; the training driver strips them.
  fs.writeFileSync(path.join(outDir, 'rows.jsonl'), rows.map(({ state, answers, split, task, group }) => JSON.stringify({ state, answers, split, task, decision: group })).join('\n') + '\n');
  return { ...summarize(rows), tasks: { answer: summarize(answer), match: summarize(match) } };
}

if (require.main === module) {
  const { loadQuestionBank } = require('../question-bank.cjs');
  const { generateHouseholds } = require('../profiles/generate.cjs');
  const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
  const today = arg('today', new Date().toISOString().slice(0, 10));
  const households = generateHouseholds({ count: Number(arg('households', '2000')), seed: Number(arg('seed', '7')), today });
  const summary = writeDataset(path.resolve(arg('out', path.join(__dirname, 'out'))), loadQuestionBank(), households, { today, perQuestion: Number(arg('per-question', '24')) });
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = { correctOption, buildRows, buildMatchRows, splitFor, writeDataset, range, ABSTAIN, DECISION, MATCH_KEYS };
