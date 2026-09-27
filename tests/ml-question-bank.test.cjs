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
