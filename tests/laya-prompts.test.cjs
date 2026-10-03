'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../shared/laya-prompts.cjs');
const build = require('../ML_model/dataset/build.cjs');
const { KEY_ABOUT } = require('../extension/ai-mapper.js');
const generic = require('../extension/generic-adapter.js');
const { buildFacts, factsText } = require('../shared/facts.cjs');
const { loadQuestionBank, loadSyntheticBank } = require('../ML_model/question-bank.cjs');

const TODAY = '2026-09-26';

test('the desktop asks the trained model exactly the question, abstain candidate, and saved-field descriptions it was trained on', () => {
  assert.equal(prompts.ABSTAIN, build.ABSTAIN);
  assert.deepEqual(prompts.DECISION, build.DECISION);
  assert.deepEqual(prompts.QUESTIONS, { correct: build.DECISION });
  assert.deepEqual([...prompts.MATCH_KEYS], [...build.MATCH_KEYS]);
  assert.deepEqual(Object.keys(prompts.KEY_ABOUT), [...build.MATCH_KEYS]);
  for (const key of build.MATCH_KEYS) assert.equal(prompts.KEY_ABOUT[key], KEY_ABOUT[key], key);
});

test('a text-box decision is the training row’s state, byte for byte', () => {
  const file = { file: 'laya-prompts-check.json', source: { kind: 'synthetic' }, questions: [
    { id: 'reach', type: 'email', label: 'Where can we email you?', options: [], rule: { name: 'field', key: 'email' } }] };
  const rows = build.buildMatchRows([file]);
  const states = [...build.MATCH_KEYS.map(key => prompts.matchState('Where can we email you?', key)), prompts.matchState('Where can we email you?', null)];
  assert.deepEqual(states.map(state => JSON.stringify(state)), rows.map(row => JSON.stringify(row.state)));
});

test('a choice decision is the training row’s state, byte for byte, facts sheet included', () => {
  const question = { id: 'sixty', type: 'radio', label: 'Is anyone in your household 60 or older?', options: ['Yes', 'No'], rule: { name: 'anySenior60' } };
  const household = { birthDate: '1985-04-12', householdSize: '1', householdAdults: '1', householdChildren: '0', householdSeniors: '0', state: 'IA', county: 'Polk' };
  const rows = build.buildRows([{ file: 'laya-prompts-check.json', source: { kind: 'synthetic' }, questions: [question] }], [household], { today: TODAY });
  const facts = factsText(buildFacts(household, { today: TODAY }));
  const states = [...question.options, prompts.ABSTAIN].map(candidate => prompts.answerState(facts, question.label, candidate));
  assert.deepEqual(states.map(state => JSON.stringify(state)), rows.map(row => JSON.stringify(row.state)));
});

test('AI never matches a text box to a saved answer SecondHand keeps from guesses, SSN first among them', () => {
  assert.ok(prompts.NEVER_SUGGESTED.includes('ssn'));
  for (const key of prompts.NEVER_SUGGESTED) assert.equal(prompts.MATCH_CANDIDATES.includes(key), false, key);
  assert.deepEqual([...prompts.MATCH_CANDIDATES], build.MATCH_KEYS.filter(key => !prompts.NEVER_SUGGESTED.includes(key)));
  assert.ok(prompts.MATCH_CANDIDATES.length > 10);
  assert.ok(prompts.MATCH_CANDIDATES.every(key => generic.GENERIC_KEYS.includes(key)), 'every candidate is a key the engine can fill');
});

test('consent, signature, attestation, agreement, terms, and SSN questions are never asked about', () => {
  const unsafe = ['I certify that the information above is true and correct.', 'Signature', 'Applicant signature', 'I agree to the terms', 'Consent to share information',
    'Social Security Number', 'SSN', 'SS#', 'By entering your initials below you are signing this form', 'I attest that I live in the service area',
    'I acknowledge the rules of the pantry', 'Do you authorize us to contact your landlord?', 'I understand that food is limited', 'Password', 'Terms of service'];
  for (const label of unsafe) assert.equal(prompts.unsafeQuestion({ label, options: [] }), true, label);
  assert.equal(prompts.unsafeQuestion({ label: 'Please confirm', options: ['I agree', 'I do not agree'] }), true, 'an option can make a question unsafe');
  for (const label of ['Is anyone in your household 60 or older?', 'How many children under 18?', 'Where can we email you?', 'Do you live in Polk County?', 'Confirm email address']) {
    assert.equal(prompts.unsafeQuestion({ label, options: ['Yes', 'No'] }), false, label);
  }
});

test('the desktop’s unsafe-question check is the extension engine’s, on every question in the bank', () => {
  assert.equal(prompts.UNSAFE_QUESTION.source, generic.UNSAFE_QUESTION.source);
  assert.equal(prompts.UNSAFE_QUESTION.flags, generic.UNSAFE_QUESTION.flags);
  const bank = [...loadQuestionBank(), ...loadSyntheticBank()];
  let unsafe = 0;
  for (const file of bank) for (const question of file.questions) {
    const field = { label: question.label, options: question.options || [] };
    assert.equal(prompts.unsafeQuestion(field), generic.unsafeQuestion(field), question.label);
    unsafe += prompts.unsafeQuestion(field);
  }
  assert.ok(unsafe > 40, `found ${unsafe}`);
});

test('choice-v2: a box of a type the model wasn’t trained on is refused, not described', () => {
  assert.throws(() => prompts.CHOICE.matchState('Color', 'color'), /color/);
});

test('text boxes and choice questions are the question types the model was trained on', () => {
  assert.deepEqual([...prompts.TEXT_TYPES], ['text', 'textarea', 'number', 'date', 'email', 'tel']);
  assert.deepEqual([...prompts.CHOICE_TYPES], ['radio', 'select', 'checkbox']);
});

test('choice-v2: the desktop asks the trained model exactly the builder’s choices, instructions and abstain options', () => {
  const { CHOICE } = prompts;
  assert.equal(CHOICE.ANSWER_INSTRUCTIONS, build.CHOICE_ANSWER_INSTRUCTIONS);
  assert.equal(CHOICE.MATCH_INSTRUCTIONS, build.CHOICE_MATCH_INSTRUCTIONS);
  assert.equal(CHOICE.MATCH_ABSTAIN, build.MATCH_ABSTAIN);
  assert.deepEqual({ ...CHOICE.BOX_TYPES }, build.BOX_TYPES);
  assert.deepEqual(JSON.parse(JSON.stringify(CHOICE.MATCH_SETS)), JSON.parse(JSON.stringify(build.MATCH_SETS)));
  assert.deepEqual([...CHOICE.MATCH_SETS.text], [...prompts.MATCH_CANDIDATES], 'a text box is offered every field AI may suggest');
  for (const keys of Object.values(CHOICE.MATCH_SETS)) for (const key of keys) assert.equal(prompts.NEVER_SUGGESTED.includes(key), false, key);
  assert.deepEqual(new Set(Object.keys(CHOICE.MATCH_SETS)), new Set(prompts.TEXT_TYPES), 'every text-box type has its set');
});

test('choice-v2: an answering decision is the training row’s question and state, byte for byte, facts sheet included', () => {
  const question = { id: 'size', type: 'select', label: 'How many people live in your home?', options: ['1', '2', '3', '4 or more'], rule: { name: 'householdSize' } };
  const household = { birthDate: '1985-04-12', householdSize: '3', householdAdults: '2', householdChildren: '1', householdSeniors: '0', state: 'IA', county: 'Polk' };
  const { rows, questions } = build.buildChoiceRows([{ file: 'laya-prompts-check.json', source: { kind: 'synthetic' }, questions: [question] }], [household], { today: TODAY });
  const [row] = rows;
  const [id] = Object.keys(row.answers);
  const facts = factsText(buildFacts(household, { today: TODAY }));
  assert.equal(JSON.stringify(prompts.CHOICE.answerState(facts, question.label)), JSON.stringify(row.state));
  assert.equal(JSON.stringify(prompts.CHOICE.answerQuestion(question.options)), JSON.stringify(questions[id]));
});

test('choice-v2: a matching decision is the training row’s question and state for every type of text box', () => {
  for (const type of prompts.TEXT_TYPES) {
    const file = { file: 'laya-prompts-check.json', source: { kind: 'synthetic' }, questions: [{ id: 'box', type, label: 'Where can we reach you?', options: [], rule: { name: 'none' } }] };
    const { rows, questions } = build.buildChoiceMatchRows([file]);
    const row = rows.find(item => item.group === 'synthetic:laya-prompts-check.json#box');
    if (!prompts.CHOICE.MATCH_SETS[type].length) { assert.equal(row, undefined, `${type}: nothing on offer, nothing asked`); continue; }
    const [id] = Object.keys(row.answers);
    assert.equal(JSON.stringify(prompts.CHOICE.matchState('Where can we reach you?', type)), JSON.stringify(row.state), type);
    assert.equal(JSON.stringify(prompts.CHOICE.matchQuestion(prompts.CHOICE.MATCH_SETS[type])), JSON.stringify(questions[id]), type);
  }
});

test('noul-v1: a text box is offered the groups of saved fields its label names, in training order, and every field when it names none', () => {
  const { offeredFields, MATCH_CANDIDATES, NEVER_SUGGESTED } = prompts;
  const box = (label, type = 'text') => offeredFields({ label, type });
  const names = ['firstName', 'middleName', 'lastName', 'fullName', 'suffix'];
  const address = ['addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county'];
  const counts = ['householdSize', 'householdAdults', 'householdChildren', 'householdSeniors'];
  assert.deepEqual(box('First Name:'), names);
  assert.deepEqual(box('Zip Code:'), address);
  assert.deepEqual(box('Phone:'), ['email', 'phone']);
  assert.deepEqual(box('Total # of individuals living in your household:'), counts);
  assert.deepEqual(box('Utility costs per month (gas, electric, water)'), ['monthlyRent', 'monthlyUtilities']);
  assert.deepEqual(box('Name of Head of Household'), [...names, ...counts], 'two groups, in MATCH_CANDIDATES order');
  assert.deepEqual(box('Dirección'), address, 'accents are folded');
  assert.deepEqual(box('Teléfono', 'tel'), ['email', 'phone']);
  assert.deepEqual(box('Anything else?'), [...MATCH_CANDIDATES]);
  assert.deepEqual(box('Today’s Date', 'date'), [], 'date of birth is never offered, so a date box is offered nothing');
  assert.deepEqual(box('Phone', 'date'), []);
  for (const label of ['First Name', 'Anything else?', 'Rent', 'Email', 'City']) {
    assert.equal(box(label).some(key => NEVER_SUGGESTED.includes(key)), false, label);
  }
  const grouped = new Set(['Name', 'Email', 'Address', 'Household size', 'Monthly rent'].flatMap(label => box(label)));
  assert.deepEqual(MATCH_CANDIDATES.filter(key => !grouped.has(key)), [], 'every field the app offers is in a group');
  assert.throws(() => offeredFields({ label: 'Name', type: 'radio' }), /text box/);
});

test('noul-v1: every answerable text box in the question bank is offered its saved field', () => {
  const { offeredFields, MATCH_CANDIDATES } = prompts;
  let boxes = 0;
  for (const form of [...loadQuestionBank(), ...loadSyntheticBank()]) {
    for (const question of form.questions) {
      const key = question.rule.name === 'field' ? question.rule.key : null;
      if (!prompts.TEXT_TYPES.includes(question.type) || !MATCH_CANDIDATES.includes(key)) continue;
      boxes++;
      assert.ok(offeredFields(question).includes(key), `${form.source.url}: ${question.label} -> ${key}`);
    }
  }
  assert.ok(boxes > 100, `${boxes} answerable boxes`);
});
