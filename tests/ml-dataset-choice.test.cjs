'use strict';
// The choice-v2 dataset (#65): one `choice` question per form question, so Laya scores every
// option in one pass. Labels come from the same answer rules and splits as noul-v1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const build = require('../ML_model/dataset/build.cjs');
const { KEY_ABOUT } = require('../extension/ai-mapper.js');
const { buildFacts, factsText } = require('../shared/facts.cjs');

const { buildRows, buildChoiceRows, buildChoiceMatchRows, writeDataset, splitFor, ABSTAIN, CHOICE_ANSWER_INSTRUCTIONS, CHOICE_MATCH_INSTRUCTIONS, MATCH_ABSTAIN, BOX_TYPES,
  MATCH_SETS, MATCH_GROUPS } = build;
const TODAY = '2026-09-26';
const yesNo = ['Yes', 'No'];
const family = { birthDate: '1985-04-12', householdSize: '3', householdAdults: '2', householdChildren: '1', householdSeniors: '0', householdVeteran: 'no',
  state: 'IA', county: 'Polk', hasHomeAddress: 'yes', monthlyEarnedIncome: '900', monthlyOtherIncome: '100', programSnap: 'yes' };
const choice = (id, label, options, rule, type = 'radio') => ({ id, label, type, options, rule });
const box = (id, label, type, rule) => ({ id, label, type, options: [], rule });
const onlyAnswer = row => { const entries = Object.entries(row.answers); assert.equal(entries.length, 1); return entries[0]; };
const form = (url, questions, source = {}) => ({ file: `${url.split('/').pop()}.json`, source: { url, title: 'A pantry form', kind: 'web', ...source }, questions });
const synthetic = (file, questions) => ({ file, source: { title: 'Rewordings', kind: 'synthetic', retrieved: '2026-09-26' }, questions });

test('each choice question and household is one row: the facts and the question in the state, the form’s options plus abstain as the choices', () => {
  const bank = [form('https://pantry.example.org/a', [
    choice('q1', 'Any children under 18 in your home?', yesNo, { name: 'anyChildren' }),
    box('q2', 'Full name', 'text', { name: 'field', key: 'fullName' }),
    choice('q3', 'I certify this is true', ['I agree'], { name: 'never' }, 'checkbox')
  ])];
  const { rows, questions } = buildChoiceRows(bank, [family, {}], { today: TODAY });
  assert.equal(rows.length, 4, 'two choice questions for two households; text boxes belong to matching');
  const [first] = rows;
  assert.deepEqual(Object.keys(first.state), ['facts', 'question']);
  assert.equal(first.state.facts, factsText(buildFacts(family, { today: TODAY })));
  assert.equal(first.state.question, 'Any children under 18 in your home?');
  const [qid, answer] = onlyAnswer(first);
  assert.equal(answer, 'Yes');
  assert.deepEqual(questions[qid], { type: 'choice', instructions: CHOICE_ANSWER_INSTRUCTIONS, criteria: ['Yes', 'No', ABSTAIN] });
  assert.equal(onlyAnswer(rows.find(row => row.state.facts === '' && row.state.question === first.state.question))[1], ABSTAIN, 'an empty profile abstains');
  const certify = rows.find(row => row.state.question === 'I certify this is true');
  assert.deepEqual(questions[onlyAnswer(certify)[0]].criteria, ['I agree', ABSTAIN]);
  assert.equal(onlyAnswer(certify)[1], ABSTAIN);
  for (const row of rows) assert.ok(questions[onlyAnswer(row)[0]].criteria.includes(onlyAnswer(row)[1]), 'the answer is one of its choices');
});

test('choice rows are the same decisions, households and splits as the noul-v1 rows, so both formats are scored on the same questions', () => {
  const urls = Array.from({ length: 12 }, (_, i) => `https://pantry.example.org/form-${i}`);
  const questions = [choice('q1', 'Any children?', yesNo, { name: 'anyChildren' }), choice('q2', 'Household size', ['1', '2', '3', '4+'], { name: 'householdSize' }, 'select')];
  const bank = urls.map(url => form(url, questions));
  const households = [family, {}, { ...family, householdSize: '1', householdChildren: '0' }, { ...family, householdSize: '6' }];
  const noul = new Set(buildRows(bank, households, { today: TODAY, perQuestion: 3 }).map(row => `${row.group}|${row.split}`));
  const rows = buildChoiceRows(bank, households, { today: TODAY, perQuestion: 3 }).rows;
  assert.deepEqual(new Set(rows.map(row => `${row.group}|${row.split}`)), noul);
  assert.equal(rows.length, noul.size, 'one row per decision');
});

test('questions with the same options share one LayaStudio question id; different options never do', () => {
  const bank = [form('https://pantry.example.org/b', [
    choice('q1', 'Any children?', yesNo, { name: 'anyChildren' }),
    choice('q2', 'Anyone 65 or older?', yesNo, { name: 'anySenior65' }),
    choice('q3', 'A veteran?', ['YES', 'NO'], { name: 'veteran' }),
    choice('q4', 'A veteran again?', ['No', 'Yes'], { name: 'veteran' })
  ])];
  const { rows, questions } = buildChoiceRows(bank, [family], { today: TODAY });
  const ids = rows.map(row => onlyAnswer(row)[0]);
  assert.equal(ids[0], ids[1]);
  assert.equal(new Set(ids).size, 3, 'YES/NO and No/Yes are other questions');
  assert.equal(Object.keys(questions).length, 3);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_.-]{1,64}$/);
  assert.deepEqual(buildChoiceRows(bank, [family], { today: TODAY }).questions, questions, 'the ids are stable');
});

test('matching: one row per text box, choosing among the saved fields offered for its type plus "None of these"', () => {
  const url = 'https://pantry.example.org/held-out';
  const bank = [form(url, [
    box('t1', 'Best phone', 'tel', { name: 'field', key: 'phone' }),
    box('t2', 'Email', 'email', { name: 'field', key: 'email' }),
    box('t3', 'Your name', 'text', { name: 'field', key: 'fullName' }),
    box('t4', 'Date of birth', 'date', { name: 'field', key: 'birthDate' }),
    box('t5', 'Monthly income', 'text', { name: 'field', key: 'totalMonthlyIncome' }),
    box('t6', 'Student ID', 'text', { name: 'none' }),
    box('t7', 'People at home', 'number', { name: 'field', key: 'householdSize' }),
    choice('c1', 'Any children?', yesNo, { name: 'anyChildren' })
  ], { holdout: true })];
  const { rows, questions } = buildChoiceMatchRows(bank);
  const byLabel = Object.fromEntries(rows.map(row => [row.state.question, row]));
  assert.deepEqual(Object.keys(byLabel), ['Best phone', 'Email', 'Your name', 'Monthly income', 'Student ID', 'People at home'],
    'a date box has no field on offer (date of birth never is), so it is never asked about');
  const criteria = row => questions[onlyAnswer(row)[0]].criteria;
  assert.deepEqual(criteria(byLabel['Best phone']), [KEY_ABOUT.phone, MATCH_ABSTAIN]);
  assert.deepEqual(criteria(byLabel['Your name']), [...MATCH_SETS.text.map(key => KEY_ABOUT[key]), MATCH_ABSTAIN]);
  assert.deepEqual(questions[onlyAnswer(byLabel['Your name'])[0]], { type: 'choice', instructions: CHOICE_MATCH_INSTRUCTIONS, criteria: criteria(byLabel['Your name']) });
  assert.equal(onlyAnswer(byLabel['Best phone'])[1], KEY_ABOUT.phone);
  assert.equal(onlyAnswer(byLabel['Your name'])[1], KEY_ABOUT.fullName);
  assert.equal(onlyAnswer(byLabel['People at home'])[1], KEY_ABOUT.householdSize);
  assert.equal(onlyAnswer(byLabel['Monthly income'])[1], MATCH_ABSTAIN, 'income is never offered, so the right choice is none of these');
  assert.equal(onlyAnswer(byLabel['Student ID'])[1], MATCH_ABSTAIN);
  assert.deepEqual(byLabel['Email'].state, { question: 'Email', type: 'email' }, 'matching needs no facts about the household, and says what kind of box it is');
  assert.deepEqual(byLabel['Best phone'].state, { question: 'Best phone', type: 'phone' });
  assert.deepEqual(byLabel['People at home'].state, { question: 'People at home', type: 'number' });
  assert.equal(CHOICE_MATCH_INSTRUCTIONS, 'Which saved answer belongs in this form box, given its label and type?');
  assert.deepEqual(BOX_TYPES, { text: 'text', textarea: 'long text', number: 'number', date: 'date', email: 'email', tel: 'phone' });
  assert.ok(rows.every(row => row.split === 'test' && row.group.startsWith(`${url}#`)));
  assert.equal(new Set(rows.map(row => row.group)).size, rows.length);
});

test('the offered fields never include a sensitive one, and each type’s set is in training order', () => {
  const sensitive = ['birthDate', 'totalMonthlyIncome', 'annualIncome', 'assetsOnHand', 'monthlyMedicalExpenses', 'ssn'];
  for (const [type, keys] of Object.entries(MATCH_SETS)) {
    assert.ok(keys.every(key => build.MATCH_KEYS.includes(key) && !sensitive.includes(key)), type);
    assert.deepEqual(keys, build.MATCH_KEYS.filter(key => keys.includes(key)), `${type} keeps MATCH_KEYS order`);
  }
  assert.deepEqual(Object.keys(MATCH_SETS), ['text', 'textarea', 'number', 'date', 'email', 'tel'], 'every text-box type has a set');
  assert.deepEqual(MATCH_SETS.date, []);
});

test('training boxes also come with fixed groups of fields, answered "None of these" when their field isn’t offered; validation and test boxes don’t', () => {
  const file = synthetic('names.json', Array.from({ length: 40 }, (_, i) => box(`n${i}`, `First name ${i}`, 'text', { name: 'field', key: 'firstName' })));
  const { rows, questions } = buildChoiceMatchRows([file]);
  const trainBoxes = file.questions.filter(question => rows.some(row => row.group === `synthetic:names.json#${question.id}` && row.split === 'train'));
  const valBoxes = file.questions.filter(question => rows.some(row => row.group === `synthetic:names.json#${question.id}` && row.split === 'val'));
  assert.ok(trainBoxes.length && valBoxes.length, 'the 40 boxes land in both training and validation');
  const variants = rows.filter(row => row.group.includes('~'));
  assert.equal(variants.length, trainBoxes.length * Object.keys(MATCH_GROUPS).length);
  assert.ok(variants.every(row => row.split === 'train'));
  for (const question of valBoxes) assert.equal(rows.filter(row => row.group.startsWith(`synthetic:names.json#${question.id}`)).length, 1, 'no variants for validation');
  const [first] = trainBoxes;
  for (const [name, keys] of Object.entries(MATCH_GROUPS)) {
    const row = rows.find(item => item.group === `synthetic:names.json#${first.id}~${name}`);
    assert.deepEqual(questions[onlyAnswer(row)[0]].criteria, [...keys.map(key => KEY_ABOUT[key]), MATCH_ABSTAIN], name);
    assert.equal(onlyAnswer(row)[1], keys.includes('firstName') ? KEY_ABOUT.firstName : MATCH_ABSTAIN, name);
  }
});

test('the choice dataset is written in LayaStudio’s format, with every question it uses', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-choice-'));
  try {
    const bank = [form('https://pantry.example.org/c', [choice('q1', 'Any children?', yesNo, { name: 'anyChildren' }), box('t1', 'Email', 'email', { name: 'field', key: 'email' })], { holdout: true })];
    const summary = writeDataset(out, bank, [family], { today: TODAY, format: 'choice-v2' });
    const questions = JSON.parse(fs.readFileSync(path.join(out, 'questions.json'), 'utf8'));
    const lines = fs.readFileSync(path.join(out, 'rows.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, summary.rows);
    for (const line of lines) {
      assert.deepEqual(Object.keys(line), ['state', 'answers', 'split', 'task', 'decision']);
      const [qid, answer] = Object.entries(line.answers)[0];
      assert.ok(questions[qid].criteria.includes(answer));
    }
    assert.deepEqual(new Set(Object.keys(questions)), new Set(lines.map(line => Object.keys(line.answers)[0])), 'no unused questions');
    assert.deepEqual(lines.map(line => line.task), ['answer', 'match']);
    assert.equal(summary.format, 'choice-v2');
    assert.deepEqual(Object.keys(summary.tasks), ['answer', 'match']);
    assert.equal(summary.tasks.answer.abstainShare, 0);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  assert.throws(() => writeDataset(out, [], [family], { today: TODAY }), /format/);
  assert.throws(() => writeDataset(out, [], [family], { today: TODAY, format: 'choice-v1' }), /format/, 'choice-v1 was dropped: it was never published');
});

test('held-out and test forms never reach training or validation in the real choice dataset', () => {
  const { loadQuestionBank, loadSyntheticBank } = require('../ML_model/question-bank.cjs');
  const { generateHouseholds } = require('../ML_model/profiles/generate.cjs');
  const bank = [...loadQuestionBank(), ...loadSyntheticBank()];
  const kept = new Set(bank.filter(file => file.source.kind !== 'synthetic' && (file.source.holdout || splitFor(file.source.url) === 'test')).map(file => file.source.url));
  assert.ok(kept.size >= 7);
  const households = generateHouseholds({ count: 20, seed: 5, today: TODAY });
  const rows = [...buildChoiceRows(bank, households, { today: TODAY, perQuestion: 2 }).rows, ...buildChoiceMatchRows(bank).rows];
  const leaked = rows.filter(row => row.split !== 'test' && kept.has(row.group.split('#')[0])).map(row => row.group);
  assert.deepEqual(leaked, []);
  assert.ok(rows.filter(row => row.split === 'test').every(row => kept.has(row.group.split('#')[0])), 'only held-out and test forms are test');
  assert.ok(rows.some(row => row.split === 'test') && rows.some(row => row.split === 'val') && rows.some(row => row.split === 'train'));
});
