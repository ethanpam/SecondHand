'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { correctOption, buildRows, splitFor, writeDataset, ABSTAIN, DECISION } = require('../ML_model/dataset/build.cjs');

const TODAY = '2026-09-26';
const q = (rule, options, type = 'radio', label = 'A question') => ({ id: 'q1', label, type, options, rule });
const yesNo = ['Yes', 'No'];
const family = { birthDate: '1985-04-12', householdSize: '3', householdAdults: '2', householdChildren: '1', householdSeniors: '0', householdVeteran: 'no',
  state: 'IA', county: 'Polk', hasHomeAddress: 'yes', monthlyEarnedIncome: '900', monthlyOtherIncome: '100', programSnap: 'yes' };
const pickFor = (rule, options, profile = family, type) => correctOption(q(rule, options, type), profile, { today: TODAY });

test('yes/no rules pick the form\'s own Yes or No, or abstain when the facts don\'t say', () => {
  assert.equal(pickFor({ name: 'anyChildren' }, yesNo), 'Yes');
  assert.equal(pickFor({ name: 'anySenior65' }, ['YES', 'NO']), 'NO');
  assert.equal(pickFor({ name: 'veteran' }, yesNo), 'No');
  assert.equal(pickFor({ name: 'veteran' }, yesNo, {}), ABSTAIN, 'no saved answer, no guess');
  assert.equal(pickFor({ name: 'livesInState', state: 'Iowa' }, yesNo), 'Yes');
  assert.equal(pickFor({ name: 'livesInState', state: 'Rhode Island' }, yesNo), 'No');
  assert.equal(pickFor({ name: 'livesInCounty', county: 'Polk County' }, yesNo), 'Yes');
  assert.equal(pickFor({ name: 'homeless' }, yesNo), 'No');
  assert.equal(pickFor({ name: 'applyingSnap' }, yesNo), 'Yes');
  assert.equal(pickFor({ name: 'applicantAgeAtLeast', age: 60 }, yesNo), 'No');
  assert.equal(pickFor({ name: 'applicantAgeAtLeast', age: 18 }, yesNo), 'Yes');
});

test('60+ is only known when the saved answers prove it', () => {
  assert.equal(pickFor({ name: 'anySenior60' }, yesNo), ABSTAIN, 'a 41-year-old with other adults: their ages are unknown');
  assert.equal(pickFor({ name: 'anySenior60' }, yesNo, { ...family, householdSize: '1', householdAdults: '1', householdChildren: '0' }), 'No', 'a household of one');
  assert.equal(pickFor({ name: 'anySenior60' }, yesNo, { ...family, householdSeniors: '1' }), 'Yes');
  assert.equal(pickFor({ name: 'anySenior60' }, yesNo, { ...family, birthDate: '1962-01-01' }), 'Yes');
  assert.equal(pickFor({ name: 'anySenior65' }, yesNo, { ...family, birthDate: '1950-01-01', householdSeniors: '0' }), ABSTAIN, 'contradictory saved answers');
});

test('income thresholds compare the full household total and never a part of it', () => {
  assert.equal(pickFor({ name: 'incomeBelow', amount: 2430, period: 'month' }, yesNo), 'Yes');
  assert.equal(pickFor({ name: 'incomeBelow', amount: 1000, period: 'month' }, yesNo), 'No', '$1,000 is not below $1,000');
  assert.equal(pickFor({ name: 'incomeBelow', amount: 1000, period: 'month', orEqual: true }, yesNo), 'Yes');
  assert.equal(pickFor({ name: 'incomeBelow', amount: 11000, period: 'year' }, yesNo), 'No', '$12,000 a year');
  assert.equal(pickFor({ name: 'incomeBelow', amount: 2430, period: 'month' }, yesNo, { monthlyEarnedIncome: '900' }), ABSTAIN);
});

test('choice rules pick the option that contains the saved value', () => {
  assert.equal(pickFor({ name: 'householdSize' }, ['One (Myself)', 'Two', 'Three', 'Four', 'Five or more']), 'Three');
  assert.equal(pickFor({ name: 'householdSize' }, ['1', '2', '3+']), '3+');
  assert.equal(pickFor({ name: 'householdSize' }, ['1', '2'], { ...family, householdSize: '6' }), ABSTAIN, 'no option covers 6');
  assert.equal(pickFor({ name: 'childrenCount' }, ['0', '1', '2 or more']), '1');
  assert.equal(pickFor({ name: 'seniorsCount' }, ['None', 'One', 'Two or more']), 'None');
  assert.equal(pickFor({ name: 'applicantAgeRange' }, ['0-5 yrs', '18-29 yrs', '30-64 yrs', '65+ yrs', 'Unknown']), '30-64 yrs');
  assert.equal(pickFor({ name: 'applicantAgeRange' }, ['Under 18', '18 to 59', '60 and older']), '18 to 59');
  assert.equal(pickFor({ name: 'state' }, ['Illinois', 'Iowa', 'Minnesota'], family, 'select'), 'Iowa');
  assert.equal(pickFor({ name: 'state' }, ['IL', 'IA', 'MN'], family, 'select'), 'IA');
  assert.equal(pickFor({ name: 'county' }, ['Dallas', 'Polk', 'Story'], family, 'select'), 'Polk');
  assert.equal(pickFor({ name: 'incomeBracket', period: 'year' }, ['$0 - $15,000', '$15,000 - $25,000', 'Over $25,000']), '$0 - $15,000');
  assert.equal(pickFor({ name: 'incomeBracket', period: 'year' }, ['$0 - $12,000', '$12,000 - $25,000']), ABSTAIN, 'on a shared boundary the answer is ambiguous');
});

test('none, never, and a single checkbox that is false all mean: leave it for the applicant', () => {
  assert.equal(pickFor({ name: 'none' }, yesNo), ABSTAIN);
  assert.equal(pickFor({ name: 'never' }, ['I agree'], family, 'checkbox'), ABSTAIN);
  assert.equal(pickFor({ name: 'veteran' }, ['Someone in my household is a veteran'], family, 'checkbox'), ABSTAIN);
  assert.equal(pickFor({ name: 'veteran' }, ['Someone in my household is a veteran'], { householdVeteran: 'yes' }, 'checkbox'), 'Someone in my household is a veteran');
});

test('each choice question and household becomes one row per candidate, with exactly one correct', () => {
  const bank = [{ source: { url: 'https://pantry.example.org/a', title: 'A' }, questions: [
    q({ name: 'anyChildren' }, yesNo, 'radio', 'Any children under 18 in your home?'),
    { id: 'q2', label: 'Full name', type: 'text', options: [], rule: { name: 'field', key: 'fullName' } },
    { id: 'q3', label: 'I certify this is true', type: 'checkbox', options: ['I agree'], rule: { name: 'never' } }
  ] }];
  const rows = buildRows(bank, [family, {}], { today: TODAY });
  // q1: 2 households x (2 options + abstain); q3: 2 x (1 + abstain); text boxes are not part of this task.
  assert.equal(rows.length, 2 * 3 + 2 * 2);
  const groups = Object.groupBy(rows, row => `${row.group}`);
  for (const group of Object.values(groups)) assert.equal(group.filter(row => row.answers.correct === true).length, 1);
  const first = rows[0];
  assert.deepEqual(Object.keys(first.state), ['facts', 'question', 'candidate']);
  assert.equal(first.state.question, 'Any children under 18 in your home?');
  assert.ok(first.state.facts.includes('The household has 1 child under 18.'));
  assert.equal(rows.find(row => row.state.candidate === 'Yes' && row.state.facts.includes('1 child')).answers.correct, true);
  assert.equal(rows.find(row => row.state.facts === '' && row.state.candidate === ABSTAIN).answers.correct, true, 'an empty profile abstains');
  assert.ok(rows.every(row => row.split === splitFor('https://pantry.example.org/a')));
});

test('splits go by form, so test forms are never seen in training', () => {
  const splits = Array.from({ length: 400 }, (_, i) => splitFor(`https://pantry.example.org/form-${i}`));
  const share = name => splits.filter(split => split === name).length / splits.length;
  assert.ok(share('train') > 0.6 && share('train') < 0.8, `train ${share('train')}`);
  assert.ok(share('val') > 0.05 && share('val') < 0.2, `val ${share('val')}`);
  assert.ok(share('test') > 0.1 && share('test') < 0.3, `test ${share('test')}`);
  assert.equal(splitFor('https://pantry.example.org/form-1'), splitFor('https://pantry.example.org/form-1'));
});

test('the dataset is written in LayaStudio\'s format', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-dataset-'));
  try {
    const bank = [{ source: { url: 'https://pantry.example.org/a', title: 'A' }, questions: [q({ name: 'anyChildren' }, yesNo)] }];
    const summary = writeDataset(out, bank, [family], { today: TODAY });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'questions.json'), 'utf8')), { correct: DECISION });
    assert.equal(DECISION.type, 'noul');
    const lines = fs.readFileSync(path.join(out, 'rows.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.deepEqual(Object.keys(lines[0]), ['state', 'answers', 'split']);
    assert.equal(summary.rows, 3);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
