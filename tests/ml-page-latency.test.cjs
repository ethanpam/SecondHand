'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, passesNeeded } = require('../ML_model/eval/page_latency.cjs');
const { ABSTAIN } = require('../shared/laya-prompts.cjs');

const URL = 'https://pantry.example.org/intake';
const q = (id, label, type, options = []) => ({ id, label, type, options, rule: { name: 'none' } });
const bank = [{ source: { url: URL }, questions: [
  q('q1', 'Full name', 'text'), q('q2', 'Any children?', 'radio', ['Yes', 'No']), q('q3', 'x'.repeat(201), 'text'),
  q('q4', 'Date of birth', 'date'), q('q5', 'Signature', 'text'), q('q6', 'Household size', 'select', ['1', '2', '3']), q('q7', 'Odd', 'radio', ['Yes', ABSTAIN])
] }];

test('a page is the form’s first questions the bridge carries, split the way the extension asks them', () => {
  const { choices, boxes } = page(URL, 5, bank);
  assert.deepEqual(choices.map(item => item.id), ['f0:q2', 'f0:q6']);
  assert.deepEqual(boxes.map(item => item.id), ['f0:q1', 'f0:q4', 'f0:q5'], 'a label over 200 characters never reaches Laya');
  assert.deepEqual(Object.keys(boxes[0]), ['id', 'label', 'type', 'options'], 'no answer rule travels with a question');
  assert.throws(() => page(URL, 7, bank), /6 questions/);
  assert.throws(() => page('https://nowhere.example.org', 1, bank), /question bank/);
});

test('a complete decision of the page is two passes of the open choice questions, less the first pass’s answers, plus every text box asked', () => {
  const questions = page(URL, 6, bank);
  const profile = { householdSize: '2', birthDate: '1985-04-12' };
  // Two open choice questions (the odd one is never asked), one answered in the first pass and one with sensitive facts.
  assert.equal(passesNeeded('choice-v1', questions, profile, { answers: { a: 'Yes', b: '2' }, sensitive: ['b'] }), 2 + 1 + 1, 'a date box isn’t asked of choice-v1');
  assert.equal(passesNeeded('noul-v1', questions, profile, { answers: {}, sensitive: [] }), 2 + 2 + 2, 'noul-v1 asks the date box too');
  assert.equal(passesNeeded('choice-v1', questions, { householdSize: '2' }, { answers: {}, sensitive: [] }), 2 + 1, 'no sensitive facts, no second pass');
  assert.equal(passesNeeded('choice-v1', questions, { birthDate: '1985-04-12' }, { answers: {}, sensitive: [] }), 2 + 1, 'only sensitive facts: one pass, with all of them');
});
