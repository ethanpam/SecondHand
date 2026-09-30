'use strict';
// Builds LayaStudio training rows from the question bank and fictional households.
// Every label is computed here by code from the question's answer rule and the saved
// answers, never guessed. Two prompt formats (desktop/laya-model.cjs MODEL_FORMATS):
// - noul-v1: one fixed yes/no question about one candidate answer at a time;
// - choice-v2 (#65): one `choice` question per form question, scoring all its options in one pass;
//   a text box is described by its label and its type.
// Either way, the abstain candidate is correct when the facts don't say.
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
const MATCH_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'fullName', 'suffix', 'birthDate', 'email', 'phone', 'addressLine1', 'addressLine2',
  'city', 'state', 'zip', 'county', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors', 'totalMonthlyIncome', 'annualIncome', 'monthlyRent',
  'monthlyUtilities', 'assetsOnHand', 'monthlyMedicalExpenses']);
const matchCandidate = key => `Saved answer: ${KEY_ABOUT[key]}`;

// choice-v2. Answering: the facts and the form question are the state; the form's options plus
// ABSTAIN are the choices. Matching: the box's label and its type (as BOX_TYPES words) are the
// state; the saved fields offered for its type plus MATCH_ABSTAIN are the choices.
const CHOICE_ANSWER_INSTRUCTIONS = 'Given the facts about the household, which option is the correct answer to the form question?';
const CHOICE_MATCH_INSTRUCTIONS = 'Which saved answer belongs in this form box, given its label and type?';
const BOX_TYPES = Object.freeze({ text: 'text', textarea: 'long text', number: 'number', date: 'date', email: 'email', tel: 'phone' });
const MATCH_ABSTAIN = 'None of these';
// Saved fields only a confident rule may place are never offered, so a box asking for one is "None of these".
const OFFERED = MATCH_KEYS.filter(key => !['birthDate', 'totalMonthlyIncome', 'annualIncome', 'assetsOnHand', 'monthlyMedicalExpenses'].includes(key));
const MATCH_SETS = Object.freeze({
  text: OFFERED, textarea: OFFERED,
  number: ['phone', 'zip', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors', 'monthlyRent', 'monthlyUtilities'],
  date: [], email: ['email'], tel: ['phone']
});
// Training only: each training box is also asked with these groups of fields, so the model learns
// to answer "None of these" when its field isn't on offer.
const MATCH_GROUPS = Object.freeze({
  names: ['firstName', 'middleName', 'lastName', 'fullName', 'suffix'],
  address: ['addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county'],
  contact: ['email', 'phone'],
  household: ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'],
  costs: ['monthlyRent', 'monthlyUtilities'],
  numbers: MATCH_SETS.number
});
const FORMATS = ['noul-v1', 'choice-v2'];
const choiceAnswerQuestion = options => ({ type: 'choice', instructions: CHOICE_ANSWER_INSTRUCTIONS, criteria: [...options, ABSTAIN] });
const choiceMatchQuestion = keys => ({ type: 'choice', instructions: CHOICE_MATCH_INSTRUCTIONS, criteria: [...keys.map(key => KEY_ABOUT[key]), MATCH_ABSTAIN] });
// A LayaStudio question id for a set of choices: questions with the same choices share it.
const choiceQuestionId = (task, question) => `${task}-${crypto.createHash('sha256').update(JSON.stringify(question)).digest('hex').slice(0, 16)}`;
// The saved answers behind applyingFor's programs.
const PROGRAM_FIELDS = Object.freeze({ snap: 'programSnap', fip: 'programFip', medicaid: 'programMedicaid' });
const NUMBER_WORDS = { none: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

const present = value => typeof value === 'string' && value.trim() !== '';
const count = (profile, field) => present(profile[field]) ? Number(profile[field]) : null;
const yes = (profile, field) => present(profile[field]) ? profile[field].trim() === 'yes' : null;
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
    case 'householdMoreThanOne': { const size = count(profile, 'householdSize'); return size === null ? null : size > 1; }
    case 'veteran': return yes(profile, 'householdVeteran');
    case 'disability': return yes(profile, 'householdDisability');
    case 'pregnant': return yes(profile, 'householdPregnant');
    case 'medicare': return yes(profile, 'householdMedicare');
    case 'allCitizens': return yes(profile, 'householdAllCitizens');
    case 'homeless': { const home = yes(profile, 'hasHomeAddress'); return home === null ? null : !home; }
    // Household facts only settle one answer about the applicant alone.
    case 'applicantVeteran': return yes(profile, 'householdVeteran') === false ? false : null;
    case 'applicantDisability': return yes(profile, 'householdDisability') === false ? false : null;
    case 'applicantCitizen': return yes(profile, 'householdAllCitizens') === true ? true : null;
    case 'anyChildrenUnder':
      if (children === null) return null;
      if (children === 0) return false;
      return rule.age >= 18 ? true : null;
    case 'noIncome': {
      const earned = dollars(profile, 'monthlyEarnedIncome'), other = dollars(profile, 'monthlyOtherIncome');
      return earned === null || other === null ? null : earned + other === 0;
    }
    case 'livesInState': return present(profile.state) ? stateMatches(profile.state.trim().toUpperCase(), rule.state) : null;
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
    case 'applyingFor': {
      const answers = rule.programs.map(program => yes(profile, PROGRAM_FIELDS[program]));
      if (answers.includes(true)) return true;
      return answers.every(answer => answer === false) ? false : null;
    }
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
      const hits = question.options.filter(option => stateMatches(profile.state.trim().toUpperCase(), option));
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

const unit = text => crypto.createHash('sha256').update(text).digest().readUInt32BE(0) / 2 ** 32;
// Where a form's decisions come from: its URL, or its file for training-only rewordings.
const formKey = file => file.source.kind === 'synthetic' ? `synthetic:${file.file}` : file.source.url;
const formSplit = file => file.source.kind === 'synthetic' ? 'train' : file.source.holdout || file.source.final ? 'test' : splitFor(file.source.url);
// Test forms are held out whole (about 20%), so the model is judged on forms it never saw.
function splitFor(url) {
  return unit(url) < 0.8 ? 'train' : 'test';
}
// Validation (for early stopping and calibration) takes about 10% of the training forms' decisions.
const decisionSplit = (formSplit, group) => formSplit === 'test' ? 'test' : unit(`val:${group}`) < 0.1 ? 'val' : 'train';

// Every choice question's decisions: { question, index, answer, group, split } for each
// household it is asked for. With `perQuestion`, households are taken round-robin across the
// correct answers so every answer is represented.
function choiceDecisions(bank, households, { today, perQuestion = Infinity } = {}) {
  if (perQuestion !== Infinity && !(Number.isInteger(perQuestion) && perQuestion > 0)) throw new Error('per-question must be a positive whole number.');
  const decisions = [];
  for (const file of bank) {
    const split = formSplit(file);
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
        const group = `${formKey(file)}#${question.id}#${index}`;
        decisions.push({ question, index, answer: answers[index], group, split: decisionSplit(split, group) });
      }
    }
  }
  return decisions;
}

// noul-v1: one row per candidate answer for every choice question and household.
function buildRows(bank, households, options = {}) {
  const sheets = households.map(profile => factsText(buildFacts(profile, { today: options.today })));
  return choiceDecisions(bank, households, options).flatMap(({ question, index, answer, group, split }) => [...question.options, ABSTAIN].map(candidate =>
    ({ state: { facts: sheets[index], question: question.label, candidate }, answers: { correct: candidate === answer }, split, group })));
}

// choice-v2: one row per choice question and household, and the LayaStudio questions they use.
function buildChoiceRows(bank, households, options = {}) {
  const sheets = households.map(profile => factsText(buildFacts(profile, { today: options.today })));
  const questions = {};
  const rows = choiceDecisions(bank, households, options).map(({ question, index, answer, group, split }) => {
    const definition = choiceAnswerQuestion(question.options);
    const id = choiceQuestionId('answer', definition);
    questions[id] = definition;
    return { state: { facts: sheets[index], question: question.label }, answers: { [id]: answer }, split, group };
  });
  return { rows, questions };
}

// Text boxes: which saved value, if any, belongs in the box. One row per candidate field plus abstain.
function buildMatchRows(bank) {
  const rows = [];
  for (const file of bank) {
    const split = formSplit(file);
    for (const question of file.questions.filter(item => TEXT_TYPES.includes(item.type))) {
      if (question.rule.name === 'field' && !MATCH_KEYS.includes(question.rule.key)) throw new Error(`${question.id}: field key ${question.rule.key} isn't a text-box candidate.`);
      const correct = question.rule.name === 'field' ? matchCandidate(question.rule.key) : ABSTAIN;
      for (const candidate of [...MATCH_KEYS.map(matchCandidate), ABSTAIN]) {
        const group = `${formKey(file)}#${question.id}`;
        rows.push({ state: { question: question.label, candidate }, answers: { correct: candidate === correct }, split: decisionSplit(split, group), group });
      }
    }
  }
  return rows;
}

// choice-v2: one row per text box whose type has saved fields on offer. Training boxes are also asked
// with each of MATCH_GROUPS (decision `<box>~<group>`); validation and test boxes only as the app asks.
function buildChoiceMatchRows(bank) {
  const rows = [];
  const questions = {};
  const add = (keys, question, group, split) => {
    const definition = choiceMatchQuestion(keys);
    const id = choiceQuestionId('match', definition);
    questions[id] = definition;
    const answer = question.rule.name === 'field' && keys.includes(question.rule.key) ? KEY_ABOUT[question.rule.key] : MATCH_ABSTAIN;
    rows.push({ state: { question: question.label, type: BOX_TYPES[question.type] }, answers: { [id]: answer }, split, group });
  };
  for (const file of bank) {
    const split = formSplit(file);
    for (const question of file.questions.filter(item => TEXT_TYPES.includes(item.type))) {
      if (question.rule.name === 'field' && !MATCH_KEYS.includes(question.rule.key)) throw new Error(`${question.id}: field key ${question.rule.key} isn't a text-box candidate.`);
      const keys = MATCH_SETS[question.type];
      if (!keys.length) continue;
      const group = `${formKey(file)}#${question.id}`;
      const boxSplit = decisionSplit(split, group);
      add(keys, question, group, boxSplit);
      if (boxSplit === 'train') for (const [name, groupKeys] of Object.entries(MATCH_GROUPS)) add(groupKeys, question, `${group}~${name}`, boxSplit);
    }
  }
  return { rows, questions };
}

// Whether a row's correct answer is "leave it for the applicant", in either format.
const abstains = row => row.state.candidate !== undefined ? row.answers.correct && row.state.candidate === ABSTAIN : [ABSTAIN, MATCH_ABSTAIN].includes(Object.values(row.answers)[0]);

function summarize(rows) {
  const decisions = new Set(rows.map(row => row.group)).size;
  const abstained = new Set(rows.filter(abstains).map(row => row.group)).size;
  return { rows: rows.length, decisions, abstainShare: decisions ? abstained / decisions : 0,
    bySplit: Object.fromEntries(['train', 'val', 'test'].map(split => [split, rows.filter(row => row.split === split).length])) };
}

// The rows of `bank` in the dataset `format`: { answer, match, questions }.
function datasetRows(bank, households, options) {
  const { format } = options;
  if (!FORMATS.includes(format)) throw new Error(`The dataset format must be one of ${FORMATS.join(', ')}.`);
  if (format === 'noul-v1') return { answer: buildRows(bank, households, options), match: buildMatchRows(bank), questions: { correct: DECISION } };
  const answering = buildChoiceRows(bank, households, options), matching = buildChoiceMatchRows(bank);
  return { answer: answering.rows, match: matching.rows, questions: { ...answering.questions, ...matching.questions } };
}

function write(outDir, { answer, match, questions }, format) {
  answer = answer.map(row => ({ ...row, task: 'answer' }));
  match = match.map(row => ({ ...row, task: 'match' }));
  const rows = [...answer, ...match];
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'questions.json'), `${JSON.stringify(questions, null, 2)}\n`);
  // `task` and `decision` let our own evaluation regroup the candidates of one decision; the training driver strips them.
  fs.writeFileSync(path.join(outDir, 'rows.jsonl'), rows.map(({ state, answers, split, task, group }) => JSON.stringify({ state, answers, split, task, decision: group })).join('\n') + '\n');
  return { format, ...summarize(rows), tasks: { answer: summarize(answer), match: summarize(match) } };
}

// The training dataset: real forms and synthetic rewordings, never a final holdout form.
function writeDataset(outDir, bank, households, options = {}) {
  const final = bank.find(file => file.source.final);
  if (final) throw new Error(`${final.file || final.source.url}: final holdout forms never go in the training dataset.`);
  return write(outDir, datasetRows(bank, households, options), options.format);
}

// The final holdout's evaluation-only dataset: every row is a test row.
function writeFinalDataset(outDir, finalBank, households, options = {}) {
  const plain = finalBank.find(file => file.source.final !== true);
  if (plain) throw new Error(`${plain.file || plain.source.url}: the final dataset only takes final holdout forms.`);
  const rows = datasetRows(finalBank, households, options);
  if ([...rows.answer, ...rows.match].some(row => row.split !== 'test')) throw new Error('Every final holdout row must be a test row.');
  return write(outDir, rows, options.format);
}

if (require.main === module) {
  const { loadQuestionBank, loadSyntheticBank } = require('../question-bank.cjs');
  const { generateHouseholds } = require('../profiles/generate.cjs');
  const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
  const today = arg('today', new Date().toISOString().slice(0, 10));
  const households = generateHouseholds({ count: Number(arg('households', '2000')), seed: Number(arg('seed', '7')), today });
  const options = { today, perQuestion: Number(arg('per-question', '24')), format: arg('format') };
  // --final builds the final holdout's evaluation-only dataset; nothing else ever reads questions-final/.
  const summary = process.argv.includes('--final') ?
    writeFinalDataset(path.resolve(arg('out', path.join(__dirname, 'out-final'))), require('../question-bank.cjs').loadFinalBank(), households, options) :
    writeDataset(path.resolve(arg('out', path.join(__dirname, 'out'))), [...loadQuestionBank(), ...loadSyntheticBank()], households, options);
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = { correctOption, buildRows, buildMatchRows, buildChoiceRows, buildChoiceMatchRows, splitFor, writeDataset, writeFinalDataset, range, ABSTAIN, DECISION, MATCH_KEYS,
  CHOICE_ANSWER_INSTRUCTIONS, CHOICE_MATCH_INSTRUCTIONS, BOX_TYPES, MATCH_ABSTAIN, MATCH_SETS, MATCH_GROUPS, FORMATS };
