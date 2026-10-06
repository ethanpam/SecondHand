'use strict';
// ML_model/eval/app_accuracy.cjs: how often the desktop app fills a question wrong with a real Laya model,
// checked here with a stand-in model (tests only). tests/laya-parity.test.cjs runs it on a real export.
const test = require('node:test');
const assert = require('node:assert/strict');
const { appAccuracy, overBudget, finalHoldout, WRONG_FILL_BUDGETS } = require('../ML_model/eval/app_accuracy.cjs');
const { choiceDecisions } = require('../ML_model/dataset/build.cjs');
const { MODEL_FORMATS } = require('../desktop/laya-model.cjs');

const TODAY = '2026-09-26';
// One final-holdout form: two yes/no questions the facts settle, one they never cover, two text boxes, and a date box.
const bank = [{ source: { url: 'https://final-pantry.example.org/intake', title: 'Synthetic final form', kind: 'web', retrieved: '2026-09-29', final: true }, questions: [
  { id: 'q1', label: 'Is anyone in your household 65 or older?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'anySenior65' } },
  { id: 'q2', label: 'Are there children under 18 in your household?', type: 'radio', options: ['No', 'Yes'], rule: { name: 'anyChildren' } },
  { id: 'q3', label: 'Do you have a pet?', type: 'radio', options: ['Yes', 'No'], rule: { name: 'none' } },
  { id: 'q4', label: 'Email address', type: 'email', options: [], rule: { name: 'field', key: 'email' } },
  { id: 'q5', label: 'Anything else we should know?', type: 'textarea', options: [], rule: { name: 'none' } },
  { id: 'q6', label: 'Date of birth', type: 'date', options: [], rule: { name: 'none' } }
] }];
// Two fictional households with no seniors and no children: "No" is right for both yes/no questions.
const household = { birthDate: '1985-04-12', householdSize: '2', householdAdults: '2', householdChildren: '0', householdSeniors: '0', state: 'IA', county: 'Polk' };
const households = [household, { ...household, birthDate: '1990-01-01' }];

// A stand-in noul-v1 model that is sure of the first candidate it is shown, and records what it was asked.
function firstCandidate() {
  const asked = [];
  return { asked, format: async () => 'noul-v1', decideBatch: async items => {
    asked.push(items[0].state.question);
    return items.map((_, index) => ({ answers: { correct: { type: 'noul', noul: index === 0 ? 0.99 : 0.001, confidence: 0.99 } } }));
  } };
}
// One that is sure the facts don't say, so it fills nothing.
const abstains = () => ({ format: async () => 'noul-v1', decideBatch: async items => items.map((_, index) => ({ answers: { correct: { type: 'noul', noul: index === items.length - 1 ? 0.99 : 0.001, confidence: 0.99 } } })) });
// noul-v1 and choice-v2 stand-ins that lean to the first candidate, under every bar, over "the facts don't say":
// never sure, so each question asked gets that candidate as Laya's best guess (#185).
const leansFirst = () => ({ format: async () => 'noul-v1', decideBatch: async items => items.map((_, index) => ({ answers: { correct: { type: 'noul', noul: index === 0 ? 0.6 : index === items.length - 1 ? 0.2 : 0.1, confidence: 0.6 } } })) });
const choiceLeansFirst = () => ({ format: async () => 'choice-v2', decideBatch: async items => items.map(({ questions }) => {
  const choices = questions.choice.criteria;
  return { answers: { choice: { type: 'choice', choice: choices[0], probabilities: Object.fromEntries(choices.map((label, index) => [label, index === 0 ? 0.6 : 0.4 / (choices.length - 1)])), confidence: 0.6 } } };
}) });

test('each fill the app makes is checked against the answer key: a fill the key doesn’t give is a wrong fill', async () => {
  const laya = firstCandidate();
  const result = await appAccuracy({ laya, bank, households, today: TODAY });
  // The yes/no questions are asked for each household; the pet question names nothing the facts cover, so it isn't.
  assert.deepEqual({ ...result.answering, wrong: result.answering.wrong.length }, { decisions: 6, filled: 4, right: 2, wrong: 2 });
  assert.deepEqual(result.answering.wrong.map(({ question, filled, key }) => ({ question, filled, key })), [
    { question: 'Is anyone in your household 65 or older?', filled: 'Yes', key: 'No' }, { question: 'Is anyone in your household 65 or older?', filled: 'Yes', key: 'No' }]);
  assert.equal(laya.asked.includes('Do you have a pet?'), false);
  // Each text box is asked once, and gets the first saved field on offer. The email box is offered email first, so
  // it is right; a box that names no field is offered every one, and the key fills nothing there. A date box is
  // never asked (date of birth is never offered), so it isn't a decision, as in the reports.
  assert.deepEqual(result.matching, { decisions: 2, filled: 2, right: 1, wrong: [
    { form: 'https://final-pantry.example.org/intake', question: 'Anything else we should know?', filled: 'firstName', key: null }] });
});

test('every question is decided however slow the model is: no request carries the click’s time limit', async () => {
  const limits = [];
  const laya = firstCandidate();
  const decideBatch = laya.decideBatch;
  laya.decideBatch = async (items, options = {}) => { limits.push(options.timeoutMs); return decideBatch(items, options); };
  const result = await appAccuracy({ laya, bank, households, today: TODAY });
  assert.ok(limits.length >= 6, 'every asked question and box reached the model');
  assert.deepEqual([...new Set(limits)], [undefined], 'a slow machine never drops a question as timed out');
  assert.equal(result.answering.filled, 4);
});

test('#189: Laya’s best guesses are asked for and counted apart from its sure answers, though Autofill doesn’t ask for them', async () => {
  const result = await appAccuracy({ laya: leansFirst(), bank, households, today: TODAY });
  // Never sure, so no sure answer: each yes/no question asked gets its first option as a guess, for each household.
  assert.deepEqual(result.answering, { decisions: 6, filled: 0, right: 0, wrong: [] });
  assert.deepEqual({ ...result.guessing, wrong: result.guessing.wrong.length }, { filled: 4, right: 2, wrongRate: 0.5, wrong: 2 });
  assert.deepEqual(result.guessing.wrong, [1, 2].map(() => ({ form: 'https://final-pantry.example.org/intake', question: 'Is anyone in your household 65 or older?', filled: 'Yes', key: 'No' })));
  // choice-v2 asks the pet question too: a guess where the key says the facts don't say is wrong.
  const choice = await appAccuracy({ laya: choiceLeansFirst(), bank, households, today: TODAY });
  assert.deepEqual({ ...choice.guessing, wrong: choice.guessing.wrong.map(({ question, filled, key }) => [question, filled, key]) }, { filled: 6, right: 2, wrongRate: 4 / 6, wrong: [
    ['Is anyone in your household 65 or older?', 'Yes', 'No'], ['Is anyone in your household 65 or older?', 'Yes', 'No'], ['Do you have a pet?', 'Yes', null], ['Do you have a pet?', 'Yes', null]] });
  // A sure answer is never also a guess, and a model that guesses nothing has no wrong rate.
  const sure = await appAccuracy({ laya: firstCandidate(), bank, households, today: TODAY });
  assert.deepEqual(sure.guessing, { filled: 0, right: 0, wrongRate: null, wrong: [] });
});

test('#189: wrong guesses are reported, never counted against the wrong-fill budgets', async () => {
  const result = await appAccuracy({ laya: leansFirst(), bank, households, today: TODAY });
  assert.equal(result.guessing.wrong.length, 2);
  assert.deepEqual(overBudget(result, { answering: 0, matching: 0 }), []);
});

test('a model that fills nothing makes no wrong fills', async () => {
  const result = await appAccuracy({ laya: abstains(), bank, households, today: TODAY });
  assert.deepEqual([result.answering.filled, result.answering.wrong, result.matching.filled, result.matching.wrong], [0, [], 0, []]);
});

test('wrong fills over a task’s budget, a share of its decisions, fail with the numbers', async () => {
  const result = await appAccuracy({ laya: firstCandidate(), bank, households, today: TODAY });
  assert.deepEqual(overBudget(result, { answering: 1 / 3, matching: 1 }), [], 'exactly at the budget passes');
  assert.deepEqual(overBudget(result, { answering: 0.3, matching: 1 }), ['answering: 2 wrong fills in 6 decisions (33.33%) is over its budget of 30%']);
  assert.deepEqual(overBudget({ answering: { decisions: 0, wrong: [] }, matching: { decisions: 0, wrong: [] } }, { answering: 0.1, matching: 0.1 }),
    ['answering: no decisions were asked', 'matching: no decisions were asked'], 'a run that asks nothing can’t pass');
  for (const format of MODEL_FORMATS) {
    for (const task of ['answering', 'matching']) assert.ok(WRONG_FILL_BUDGETS[format][task] > 0 && WRONG_FILL_BUDGETS[format][task] < 0.1, `${format} ${task}`);
  }
});

test('the final holdout is built as its reports were (docs/laya-model.md): 1,232 choice decisions and 222 text boxes that aren’t dates', () => {
  const { bank, households, today, perQuestion } = finalHoldout();
  assert.equal(choiceDecisions(bank, households, { today, perQuestion }).length, 1232);
  assert.equal(bank.flatMap(file => file.questions).filter(question => ['text', 'textarea', 'number', 'email', 'tel'].includes(question.type)).length, 222);
});
