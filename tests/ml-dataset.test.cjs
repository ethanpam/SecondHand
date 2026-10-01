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
  assert.equal(pickFor({ name: 'householdMoreThanOne' }, yesNo), 'Yes');
  assert.equal(pickFor({ name: 'householdMoreThanOne' }, yesNo, { ...family, householdSize: '1' }), 'No');
  assert.equal(pickFor({ name: 'householdMoreThanOne' }, yesNo, { ...family, householdSize: '' }), ABSTAIN);
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
  assert.ok(rows.every(row => (row.split === 'test') === (splitFor('https://pantry.example.org/a') === 'test')));
});

test('test forms are held out whole; validation comes from decisions of the training forms', () => {
  const splits = Array.from({ length: 400 }, (_, i) => splitFor(`https://pantry.example.org/form-${i}`));
  const share = name => splits.filter(split => split === name).length / splits.length;
  assert.ok(share('test') > 0.12 && share('test') < 0.3, `test ${share('test')}`);
  assert.equal(share('train') + share('test'), 1, 'a form is either a test form or a training form');
  assert.equal(splitFor('https://pantry.example.org/form-1'), splitFor('https://pantry.example.org/form-1'));
  const trainForm = Array.from({ length: 50 }, (_, i) => `https://pantry.example.org/form-${i}`).find(url => splitFor(url) === 'train');
  const testForm = Array.from({ length: 50 }, (_, i) => `https://pantry.example.org/form-${i}`).find(url => splitFor(url) === 'test');
  const questions = Array.from({ length: 60 }, (_, i) => q({ name: 'anyChildren' }, yesNo, 'radio', `Question ${i}`)).map((item, i) => ({ ...item, id: `q${i}` }));
  const rows = buildRows([{ source: { url: trainForm, title: 'T' }, questions }, { source: { url: testForm, title: 'X' }, questions }], [family], { today: TODAY });
  const trainRows = rows.filter(row => row.group.startsWith(trainForm));
  const valShare = new Set(trainRows.filter(row => row.split === 'val').map(row => row.group)).size / new Set(trainRows.map(row => row.group)).size;
  assert.ok(valShare > 0.02 && valShare < 0.25, `val share ${valShare}`);
  assert.ok(rows.filter(row => row.group.startsWith(testForm)).every(row => row.split === 'test'), 'test forms never feed validation');
  for (const group of new Set(rows.map(row => row.group))) assert.equal(new Set(rows.filter(row => row.group === group).map(row => row.split)).size, 1, 'a decision stays in one split');
});

test('the dataset is written in LayaStudio\'s format', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-dataset-'));
  try {
    const bank = [{ source: { url: 'https://pantry.example.org/a', title: 'A' }, questions: [q({ name: 'anyChildren' }, yesNo)] }];
    const summary = writeDataset(out, bank, [family], { today: TODAY, format: 'noul-v1' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'questions.json'), 'utf8')), { correct: DECISION });
    assert.equal(DECISION.type, 'noul');
    const lines = fs.readFileSync(path.join(out, 'rows.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.deepEqual(Object.keys(lines[0]), ['state', 'answers', 'split', 'task', 'decision']);
    assert.equal(lines[0].task, 'answer');
    assert.equal(new Set(lines.map(line => line.decision)).size, 1, 'the three candidates of one decision share its id');
    assert.equal(summary.rows, 3);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('text boxes become matching rows: one per saved field that fits a box, plus abstain, exactly one correct', () => {
  const { buildMatchRows, MATCH_KEYS } = require('../ML_model/dataset/build.cjs');
  const { KEY_ABOUT } = require('../extension/ai-mapper.js');
  const bank = [{ source: { url: 'https://pantry.example.org/b', title: 'B' }, questions: [
    { id: 't1', label: 'Phone Number', type: 'tel', options: [], rule: { name: 'field', key: 'phone' } },
    { id: 't2', label: 'Student ID', type: 'text', options: [], rule: { name: 'none' } },
    { id: 'c1', label: 'Any children?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'anyChildren' } }
  ] }];
  const rows = buildMatchRows(bank);
  assert.equal(rows.length, 2 * (MATCH_KEYS.length + 1), 'choice questions belong to the answering task');
  assert.ok(MATCH_KEYS.includes('phone') && MATCH_KEYS.includes('fullName') && !MATCH_KEYS.includes('householdVeteran') && !MATCH_KEYS.includes('ageRange') && !MATCH_KEYS.includes('ssn'),
    'only saved values a text box can hold are candidates');
  for (const id of ['t1', 't2']) assert.equal(rows.filter(row => row.group.endsWith(`#${id}`) && row.answers.correct).length, 1, id);
  const phone = rows.find(row => row.state.question === 'Phone Number' && row.answers.correct);
  assert.equal(phone.state.candidate, `Saved answer: ${KEY_ABOUT.phone}`);
  assert.equal(rows.find(row => row.state.question === 'Student ID' && row.answers.correct).state.candidate, ABSTAIN);
  assert.deepEqual(Object.keys(phone.state), ['question', 'candidate'], 'matching needs no facts about the household');
});

test('the written dataset holds both tasks and reports them separately', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-dataset-'));
  try {
    const bank = [{ source: { url: 'https://pantry.example.org/c', title: 'C' }, questions: [
      q({ name: 'anyChildren' }, yesNo), { id: 't1', label: 'Email', type: 'email', options: [], rule: { name: 'field', key: 'email' } }] }];
    const summary = writeDataset(out, bank, [family], { today: TODAY, format: 'noul-v1' });
    assert.deepEqual(Object.keys(summary.tasks), ['answer', 'match']);
    assert.equal(summary.tasks.answer.rows, 3);
    assert.ok(summary.tasks.match.rows > 20);
    assert.equal(fs.readFileSync(path.join(out, 'rows.jsonl'), 'utf8').trim().split('\n').length, summary.rows);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('synthetic rewordings only ever train, never test', () => {
  const bank = [{ source: { title: 'Rewordings', kind: 'synthetic', retrieved: '2026-09-26' }, file: 'seniors.json',
    questions: Array.from({ length: 40 }, (_, i) => ({ ...q({ name: 'anyChildren' }, yesNo, 'radio', `Children? ${i}`), id: `s${i}` })) }];
  const rows = buildRows(bank, [family], { today: TODAY });
  assert.ok(rows.length > 0 && rows.every(row => row.split !== 'test'));
  assert.ok(rows.every(row => row.group.startsWith('synthetic:seniors.json#')));
});

test('applicant-only and narrower questions are answered only where the household facts make it certain', () => {
  assert.equal(pickFor({ name: 'applicantVeteran' }, yesNo), 'No', 'nobody in the household is a veteran');
  assert.equal(pickFor({ name: 'applicantVeteran' }, yesNo, { householdVeteran: 'yes' }), ABSTAIN, 'someone is, but maybe not the applicant');
  assert.equal(pickFor({ name: 'applicantDisability' }, yesNo, { householdDisability: 'no' }), 'No');
  assert.equal(pickFor({ name: 'applicantDisability' }, yesNo, { householdDisability: 'yes' }), ABSTAIN);
  assert.equal(pickFor({ name: 'applicantCitizen' }, yesNo, { householdAllCitizens: 'yes' }), 'Yes');
  assert.equal(pickFor({ name: 'applicantCitizen' }, yesNo, { householdAllCitizens: 'no' }), ABSTAIN);
  assert.equal(pickFor({ name: 'anyChildrenUnder', age: 8 }, yesNo, { householdChildren: '0' }), 'No');
  assert.equal(pickFor({ name: 'anyChildrenUnder', age: 8 }, yesNo), ABSTAIN, 'the child’s age is unknown');
  assert.equal(pickFor({ name: 'anyChildrenUnder', age: 18 }, yesNo), 'Yes');
  assert.equal(pickFor({ name: 'noIncome' }, yesNo, { monthlyEarnedIncome: '0', monthlyOtherIncome: '0' }), 'Yes');
  assert.equal(pickFor({ name: 'noIncome' }, yesNo), 'No');
  assert.equal(pickFor({ name: 'noIncome' }, yesNo, { monthlyEarnedIncome: '0' }), ABSTAIN);
});

test('forms marked holdout are always test forms, whatever their URL hashes to', () => {
  const urls = Array.from({ length: 30 }, (_, i) => `https://pantry.example.org/fresh-${i}`);
  const bank = urls.map(url => ({ source: { url, title: 'Fresh', holdout: true }, questions: [q({ name: 'anyChildren' }, yesNo)] }));
  const rows = buildRows(bank, [family], { today: TODAY });
  assert.ok(urls.some(url => splitFor(url) === 'train'), 'some of these would otherwise train');
  assert.ok(rows.every(row => row.split === 'test'));
});

test('labels read saved answers the way the facts sheet does, spaces and all', () => {
  const spaced = { ...family, householdVeteran: ' yes ', state: ' ia ', programSnap: 'yes ' };
  assert.equal(pickFor({ name: 'veteran' }, yesNo, spaced), 'Yes');
  assert.equal(pickFor({ name: 'livesInState', state: 'Iowa' }, yesNo, spaced), 'Yes');
  assert.equal(pickFor({ name: 'state' }, ['Iowa', 'Illinois'], spaced, 'select'), 'Iowa');
  assert.equal(pickFor({ name: 'applyingSnap' }, yesNo, spaced), 'Yes');
});

test('a per-question limit that isn\'t a positive whole number is refused, not read as zero', () => {
  const bank = [{ file: 'f.json', source: { url: 'https://pantry.example.org/a', kind: 'web' }, questions: [q({ name: 'anyChildren' }, yesNo)] }];
  for (const perQuestion of [Number('abc'), 0, -1, 2.5]) {
    assert.throws(() => buildRows(bank, [family], { today: TODAY, perQuestion }), /per-question/i, String(perQuestion));
  }
  assert.ok(buildRows(bank, [family], { today: TODAY, perQuestion: 1 }).length);
});

test('applyingFor answers a self row ("Applying?") from the programs it lists: Yes for any, No only when every one is known no', () => {
  const rule = programs => ({ name: 'applyingFor', programs });
  assert.equal(pickFor(rule(['snap', 'fip']), yesNo), 'Yes', 'applying for SNAP');
  assert.equal(pickFor(rule(['fip']), yesNo, { ...family, programFip: 'yes' }), 'Yes');
  assert.equal(pickFor(rule(['snap', 'fip']), yesNo, { ...family, programSnap: 'no', programFip: 'no' }), 'No');
  assert.equal(pickFor(rule(['snap', 'fip']), yesNo, { ...family, programSnap: 'no' }), ABSTAIN, 'FIP isn’t saved');
  assert.equal(pickFor(rule(['snap', 'fip']), yesNo, { ...family, programSnap: 'no', programFip: 'no', programMedicaid: 'yes' }), 'No', 'Medicaid isn’t on this form');
  assert.equal(pickFor(rule(['snap', 'fip', 'medicaid']), yesNo, { ...family, programSnap: 'no', programFip: 'no', programMedicaid: 'yes' }), 'Yes');
  assert.equal(pickFor(rule(['medicaid']), yesNo, {}), ABSTAIN);
});
