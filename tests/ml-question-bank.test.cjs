'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES } = require('../ML_model/answer-rules.cjs');
const { validateQuestionFile, loadQuestionBank } = require('../ML_model/question-bank.cjs');

const form = (questions, source = {}) => ({
  source: { url: 'https://pantry.example.org/intake', title: 'Example pantry intake', kind: 'web', retrieved: '2026-09-26', ...source },
  questions
});
const yesNo = { id: 'q1', label: 'Is anyone in your household 65 or older?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'anySenior65' } };

test('every answer rule says what it means, which question types it fits, and its parameters', () => {
  assert.ok(Object.keys(RULES).length >= 20);
  for (const [name, rule] of Object.entries(RULES)) {
    assert.equal(typeof rule.about, 'string', name);
    assert.ok(rule.about.length > 10, name);
    assert.ok(Array.isArray(rule.types) && rule.types.length, name);
    assert.equal(typeof rule.params, 'object', name);
  }
  for (const name of ['none', 'never', 'field', 'householdSize', 'anySenior60', 'incomeBelow', 'applicantAgeRange']) assert.ok(RULES[name], name);
});

test('every committed question file is valid', () => {
  const bank = loadQuestionBank();
  assert.ok(bank.length >= 1, 'the question bank has at least the example form');
  const urls = bank.map(file => file.source.url);
  assert.equal(new Set(urls).size, urls.length, 'each form is collected once');
});

test('a well-formed form passes, with text, choice, and unanswerable questions', () => {
  assert.doesNotThrow(() => validateQuestionFile(form([
    yesNo,
    { id: 'q2', label: 'Full name', type: 'text', options: [], rule: { name: 'field', key: 'fullName' } },
    { id: 'q3', label: 'Monthly household income below $2,430?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'incomeBelow', amount: 2430, period: 'month', orEqual: false } },
    { id: 'q4', label: 'Do you have pets?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'none' } },
    { id: 'q5', label: 'I certify that the information above is true.', type: 'checkbox', options: ['I agree'], rule: { name: 'never' } }
  ])));
});

test('mistakes that would poison training data are rejected with the question id', () => {
  const bad = (questions, source, pattern) => assert.throws(() => validateQuestionFile(form(questions, source)), pattern);
  bad([{ ...yesNo, rule: { name: 'guessFromVibes' } }], undefined, /q1.*unknown rule/i);
  bad([{ ...yesNo, options: [] }], undefined, /q1.*options/i);
  bad([{ ...yesNo, type: 'text', options: [] }], undefined, /q1.*anySenior65.*text/i);
  bad([yesNo, { ...yesNo }], undefined, /duplicate.*q1/i);
  bad([{ ...yesNo, label: '' }], undefined, /q1.*label/i);
  bad([{ ...yesNo, rule: { name: 'incomeBelow', period: 'month' } }], undefined, /q1.*amount/i);
  bad([{ ...yesNo, rule: { name: 'anySenior65', extra: 1 } }], undefined, /q1.*extra/i);
  bad([{ id: 'q2', label: 'Name', type: 'text', options: [], rule: { name: 'field', key: 'favoriteColor' } }], undefined, /q2.*favoriteColor/i);
  bad([yesNo], { url: 'http://pantry.example.org/intake' }, /https/i);
  bad([yesNo], { retrieved: 'yesterday' }, /retrieved/i);
  bad([yesNo], { kind: 'mystery' }, /kind/i);
  bad([], undefined, /at least one question/i);
});

test('synthetic rewordings are marked as such, need no URL, and live apart from real forms', () => {
  const { loadSyntheticBank } = require('../ML_model/question-bank.cjs');
  const synthetic = { source: { title: 'Rewordings: household seniors', kind: 'synthetic', retrieved: '2026-09-26' }, questions: [yesNo] };
  assert.doesNotThrow(() => validateQuestionFile(synthetic));
  assert.throws(() => validateQuestionFile({ ...synthetic, source: { ...synthetic.source, url: 'https://pantry.example.org/a' } }), /synthetic.*url/i);
  assert.throws(() => validateQuestionFile({ ...synthetic, source: { ...synthetic.source, kind: 'web' } }), /https/i, 'a real form still needs its URL');
  for (const file of loadSyntheticBank()) assert.equal(file.source.kind, 'synthetic');
  for (const file of loadQuestionBank()) assert.notEqual(file.source.kind, 'synthetic', 'real forms and rewordings are never mixed');
});

test('no synthetic label may leak the answer key by duplicating a held-out or test label', () => {
  const { loadQuestionBank, loadSyntheticBank } = require('../ML_model/question-bank.cjs');
  const { splitFor } = require('../ML_model/dataset/build.cjs');
  const normalize = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  const testLabels = new Set();
  for (const file of loadQuestionBank()) {
    if (file.source.holdout || splitFor(file.source.url) === 'test') {
      for (const q of file.questions) testLabels.add(normalize(q.label));
    }
  }

  const leaked = loadSyntheticBank().flatMap(file => file.questions.filter(q => testLabels.has(normalize(q.label))).map(q => `${file.file} ${q.id}: ${q.label}`));
  assert.deepEqual(leaked, [], 'synthetic questions must not repeat a test or held-out label');
});

test('holdout is a yes-or-nothing flag on real forms only', () => {
  assert.doesNotThrow(() => validateQuestionFile(form([yesNo], { holdout: true })));
  assert.throws(() => validateQuestionFile(form([yesNo], { holdout: 'yes' })), /holdout/i);
  assert.throws(() => validateQuestionFile({ source: { title: 'R', kind: 'synthetic', retrieved: '2026-09-26', holdout: true }, questions: [yesNo] }), /holdout/i);
});

test('a list parameter names known values, each once', () => {
  const selfRow = programs => ({ ...yesNo, label: 'Applying?', rule: { name: 'applyingFor', programs } });
  assert.doesNotThrow(() => validateQuestionFile(form([selfRow(['snap', 'fip'])])));
  const bad = (programs, pattern) => assert.throws(() => validateQuestionFile(form([selfRow(programs)])), pattern, JSON.stringify(programs));
  bad(undefined, /q1.*needs programs/);
  bad([], /q1.*programs must be a list/);
  bad('snap', /q1.*programs must be a list/);
  bad(['snap', 'snap'], /q1.*programs must be a list/);
  bad(['snap', 'wic'], /q1.*wic isn't one of snap, fip, medicaid/);
});

test('a field rule only fits text boxes: the matching task has no dropdowns', () => {
  const dropdown = { id: 'q1', label: 'State', type: 'select', options: ['Iowa', 'Illinois'], rule: { name: 'field', key: 'state' } };
  assert.throws(() => validateQuestionFile(form([dropdown])), /field doesn't fit a select/);
});

test('a missing synthetic folder is an error, not an empty bank', () => {
  const { loadSyntheticBank } = require('../ML_model/question-bank.cjs');
  assert.throws(() => loadSyntheticBank('/nonexistent/secondhand/synthetic'), /ENOENT/);
});
