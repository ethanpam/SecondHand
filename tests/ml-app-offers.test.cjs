'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { appOffers } = require('../ML_model/eval/app_offers.cjs');
const { ABSTAIN, MATCH_CANDIDATES, offeredFields, matchState } = require('../shared/laya-prompts.cjs');

const URL = 'https://pantry.example.org/intake';
const bank = [{ source: { url: URL }, questions: [
  { id: 'q1', label: 'Zip Code:', type: 'text', options: [], rule: { name: 'field', key: 'zip' } },
  { id: 'q2', label: 'Date of birth', type: 'date', options: [], rule: { name: 'field', key: 'birthDate' } },
  { id: 'q3', label: 'Anything else?', type: 'textarea', options: [], rule: { name: 'none' } },
  { id: 'q4', label: 'Any pets?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'none' } }
] }];
const row = (id, task, state) => ({ state, answers: { correct: false }, split: 'test', task, decision: `${URL}#${id}` });

test('a noul-v1 dataset’s text boxes are offered the saved fields the desktop offers them; answering decisions and date boxes are left out', () => {
  const rows = [
    row('q1', 'match', matchState('Zip Code:', 'zip')), row('q1', 'match', matchState('Zip Code:', null)),
    row('q2', 'match', matchState('Date of birth', 'birthDate')),
    row('q3', 'match', matchState('Anything else?', 'email')),
    row('q4', 'answer', { facts: 'x', question: 'Any pets?', candidate: 'Yes' })
  ];
  const offers = appOffers(rows, bank);
  assert.deepEqual(Object.keys(offers), [`${URL}#q1`, `${URL}#q2`, `${URL}#q3`]);
  assert.deepEqual(offers[`${URL}#q1`], offeredFields({ label: 'Zip Code:', type: 'text' }).map(key => matchState('Zip Code:', key).candidate));
  assert.deepEqual(offers[`${URL}#q2`], [], 'a date box isn’t asked');
  assert.equal(offers[`${URL}#q3`].length, MATCH_CANDIDATES.length);
  assert.ok(Object.values(offers).every(candidates => !candidates.includes(ABSTAIN)), 'the abstain row is always kept, so it isn’t listed');
});

test('decisions are keyed by form as the dataset builder keys them, synthetic files included', () => {
  const synthetic = [{ file: 'rewordings.json', source: { kind: 'synthetic' }, questions: [{ id: 's1', label: 'Your email', type: 'email', options: [], rule: { name: 'field', key: 'email' } }] }];
  const rows = [{ state: matchState('Your email', 'email'), answers: { correct: true }, split: 'train', task: 'match', decision: 'synthetic:rewordings.json#s1' }];
  assert.deepEqual(appOffers(rows, synthetic), { 'synthetic:rewordings.json#s1': ['email', 'phone'].map(key => matchState('Your email', key).candidate) });
});

test('a decision the question bank doesn’t have, or whose label differs, is refused', () => {
  assert.throws(() => appOffers([{ ...row('q9', 'match', matchState('Zip', 'zip')) }], bank), /q9/);
  assert.throws(() => appOffers([row('q1', 'match', matchState('Postal code', 'zip'))], bank), /label/);
});
