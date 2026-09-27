'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTokenizer } = require('../desktop/laya-tokenizer.cjs');
const { serializeState, toQuestion, encodeDecision, collate, readCalibration, probabilities, answerFor } = require('../desktop/laya-prompt.cjs');

// Python's laya_mlx build_sequence on the same small tokenizer (ML_model/eval/runtime_fixtures.py).
const cases = require('./fixtures/laya/small-tokenizer-cases.json');
const tokenizer = loadTokenizer(path.join(__dirname, 'fixtures/laya/small-tokenizer'));
const limits = { maxLen: 512, headMaxLen: 192 };

test('prompts match Python build_sequence id for id, with markers, truncation, and every criterion form', async () => {
  const tok = await tokenizer;
  assert.equal(cases.sequences.length, 20);
  for (const { state, question, ids, markers } of cases.sequences) {
    const encoded = encodeDecision(tok, state, toQuestion(cases.questions[question]), limits);
    assert.deepEqual(encoded.ids, ids, `${question} ${JSON.stringify(state).slice(0, 40)}`);
    assert.deepEqual(encoded.markers, markers);
  }
  assert.ok(cases.sequences.some(item => item.ids.length === 512), 'a long state is truncated to 512 tokens');
});

test('state objects serialize like Python json.dumps(ensure_ascii=False), which the model was trained on', () => {
  assert.equal(serializeState('plain text'), 'plain text');
  assert.equal(serializeState({ facts: 'Café “quoted”', question: 'Line\nbreak "and" \\ tab\t', n: 3, list: [true, false, null], nested: {} }),
    '{"facts": "Café “quoted”", "question": "Line\\nbreak \\"and\\" \\\\ tab\\t", "n": 3, "list": [true, false, null], "nested": {}}');
  assert.equal(serializeState([]), '[]');
  for (const [value, message] of [[{ amount: 1.5 }, /whole numbers/], [{ when: new Date(0) }, /plain/], [{ missing: undefined }, /undefined/],
    [{ lone: '\ud800' }, /well-formed/], [42, /text or a plain object/], [null, /text or a plain object/]]) {
    assert.throws(() => serializeState(value), message);
  }
});

test('questions are checked like the Python agent, and option order must be explicit', () => {
  assert.deepEqual(toQuestion({ type: 'noul', instructions: 'Is it?' }).labels, ['false', 'true']);
  assert.deepEqual(toQuestion({ type: 'choice', instructions: 'Which?', criteria: ['b', 'a'] }).labels, ['b', 'a']);
  assert.deepEqual(toQuestion({ type: 'choice', instructions: 'Which?', criteria: { b: 'second', a: null } }).options, ['b: second', 'a']);
  for (const [definition, message] of [
    [{ type: 'score', instructions: 'How much?', criteria: ['low', 'high'] }, /choice or noul/],
    [{ type: 'noul' }, /instructions/],
    [{ type: 'choice', instructions: 'Which?', criteria: [] }, /nonempty/],
    [{ type: 'choice', instructions: 'Which?', criteria: ['a', 'a'] }, /unique/],
    [{ type: 'choice', instructions: 'Which?', criteria: [1, 2] }, /strings/],
    [{ type: 'choice', instructions: 'Which?', criteria: { 2: 'two', 1: 'one' } }, /array/],
    [{ type: 'noul', instructions: 'Is it?', criteria: ['no', 'yes'] }, /false\/true/],
    ['noul', /question/]
  ]) assert.throws(() => toQuestion(definition), message, JSON.stringify(definition));
});

test('a question whose options cannot fit the token budget is refused, not silently shortened', async () => {
  const tok = await tokenizer;
  const criteria = Array.from({ length: 60 }, (_, index) => `option ${index} with a long description`);
  assert.throws(() => encodeDecision(tok, 'state', toQuestion({ type: 'choice', instructions: 'Which?', criteria }), { maxLen: 64, headMaxLen: 48 }), /too many options/);
});

test('batches are padded with the pad id and use the int64 and bool inputs the ONNX graph declares', () => {
  const batch = collate([{ ids: [1, 2, 3], markers: [1], qtype: 2 }, { ids: [4, 5], markers: [0, 1, 1], qtype: 0 }], 9);
  assert.deepEqual([batch.rows, batch.length, batch.count], [2, 3, 3]);
  assert.ok(batch.inputIds instanceof BigInt64Array && batch.markerMask instanceof Uint8Array);
  assert.deepEqual(Array.from(batch.inputIds, Number), [1, 2, 3, 4, 5, 9]);
  assert.deepEqual(Array.from(batch.attentionMask, Number), [1, 1, 1, 1, 1, 0]);
  assert.deepEqual(Array.from(batch.markerPos, Number), [1, 0, 0, 0, 1, 1]);
  assert.deepEqual(Array.from(batch.markerMask), [1, 0, 0, 1, 1, 1]);
  assert.deepEqual(Array.from(batch.qtype, Number), [2, 0]);
  assert.equal(collate([{ ids: [1], markers: [0], qtype: 2 }], 0).count, 2, 'at least two option slots, like collate_items');
});

test('calibration applies the per-bucket temperature, clamped to [0.5, 5] like laya_mlx', () => {
  const calibration = readCalibration({ temperature: [1.6, 1.25, 1.5465], temperature_by_options: { 'noul:2': 1.5465, 'choice:11+': 0.1006, 'choice:3-5': 9 } });
  const softmax = values => { const top = Math.max(...values); const e = values.map(v => Math.exp(v - top)); const sum = e.reduce((a, b) => a + b); return e.map(v => v / sum); };
  const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12, `${value} vs ${expected[index]}`));
  close(probabilities([0.2, 2.2], 2, 2, calibration), softmax([0.2 / 1.5465, 2.2 / 1.5465]));
  close(probabilities([3, 1, 0, -1], 4, 0, calibration), softmax([3 / 5, 1 / 5, 0, -1 / 5]));
  const twelve = Array.from({ length: 12 }, (_, index) => index / 4);
  close(probabilities([...twelve, 99], 12, 0, calibration), softmax(twelve.map(value => value / 0.5)));
  close(probabilities([1, 2], 2, 0, calibration), softmax([1 / 1.6, 2 / 1.6]));
  assert.throws(() => probabilities([Number.NaN, 1], 2, 2, calibration), /non-finite/);
  assert.throws(() => readCalibration({ temperature: [1, 1] }), /three/);
});

test('answers have the Python agent shape: noul probability, or choice with per-option probabilities, and confidence', () => {
  const noul = answerFor(toQuestion({ type: 'noul', instructions: 'Is it?' }), [0.2, 0.8]);
  assert.deepEqual(noul, { type: 'noul', noul: 0.8, confidence: 0.8 });
  const choice = answerFor(toQuestion({ type: 'choice', instructions: 'Which?', criteria: ['a', 'b', 'c', 'd'] }), [0.7, 0.1, 0.1, 0.1]);
  assert.equal(choice.type, 'choice');
  assert.equal(choice.choice, 'a');
  assert.deepEqual(choice.probabilities, { a: 0.7, b: 0.1, c: 0.1, d: 0.1 });
  const entropy = -(0.7 * Math.log(0.7) + 3 * 0.1 * Math.log(0.1));
  assert.ok(Math.abs(choice.confidence - (1 - entropy / Math.log(4))) < 1e-12);
});
