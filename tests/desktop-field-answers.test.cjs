'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFieldAnswers } = require('../desktop/field-answers.cjs');
const { ABSTAIN, QUESTIONS, answerState } = require('../shared/laya-prompts.cjs');
const { buildFacts, factsText } = require('../shared/facts.cjs');

const TODAY = '2026-09-26';
// A stand-in for the Laya runtime (#38) with its exact interface. `scores(state)` plays the model.
function stubLaya(scores = () => 0.01) {
  const batches = [];
  return {
    batches,
    status: () => ({ state: 'ready' }),
    decide: async () => { throw new Error('field answers score in batches'); },
    decideBatch: async items => { batches.push(items); return items.map(({ state }) => ({ answers: { correct: { noul: scores(state) } } })); }
  };
}
const answerer = (laya, options = {}) => createFieldAnswers({ laya, today: TODAY, ...options });
// The time the extension's click has left for Laya, as the bridge carries it.
const budgetMs = 3000;
// The answers alone, when none needed a sensitive fact.
const everydayAnswers = async decided => { const result = await decided; assert.deepEqual(result.sensitive, []); assert.deepEqual(result.sensitiveFields, []); return result.answers; };
const question = (id, label, options = ['Yes', 'No'], type = 'radio') => ({ id, label, type, options });
// A household of one in Polk County whose applicant is 41: age and income are sensitive facts.
const profile = { birthDate: '1985-04-12', householdSize: '1', householdAdults: '1', householdChildren: '0', householdSeniors: '0', state: 'IA', county: 'Polk',
  householdVeteran: 'no', monthlyEarnedIncome: '900', monthlyOtherIncome: '100', firstName: 'Synthetic private first', ssn: '123-45-6789' };
const everyday = factsText(buildFacts(profile, { today: TODAY }).filter(fact => !fact.sensitive));
const everything = factsText(buildFacts(profile, { today: TODAY }));

test('an answer the facts settle above the bar comes back as the option’s own text; the model sees facts, the question, and one option at a time', async () => {
  const laya = stubLaya(state => state.question === 'Do you live in Polk County?' && state.candidate === 'YES' && state.facts.includes('Polk County') ? 0.97 : 0.02);
  const answers = await everydayAnswers(answerer(laya).answer({ questions: [question('f0:sh-1-1', 'Do you live in Polk County?', ['YES', 'NO'])], profile, budgetMs }));
  assert.deepEqual(answers, { 'f0:sh-1-1': 'YES' });
  assert.deepEqual(laya.batches, [['YES', 'NO', ABSTAIN].map(candidate => ({ state: answerState(everyday, 'Do you live in Polk County?', candidate), questions: QUESTIONS }))],
    'the first pass uses only facts that need no permission');
  assert.doesNotMatch(everyday, /years old|\$/, 'age and income are not in the first pass');
});

test('the 0.9 bar, "the facts don’t say", and a close runner-up each leave the question to the applicant', async () => {
  const household = { householdSize: '1', householdVeteran: 'no' };
  const cases = [
    [state => state.candidate === 'No' ? 0.89 : 0.01, {}, 'below the bar'],
    [state => state.candidate === 'No' ? 0.9 : 0.01, { vet: 'No' }, 'at the bar'],
    [state => state.candidate === ABSTAIN ? 0.99 : state.candidate === 'No' ? 0.95 : 0.01, {}, 'the facts don’t say'],
    [state => ['Yes', 'No'].includes(state.candidate) ? 0.96 : 0.01, {}, 'two likely answers']
  ];
  for (const [scores, expected, why] of cases) {
    const answers = await everydayAnswers(answerer(stubLaya(scores)).answer({ questions: [question('vet', 'Is anyone in your household a veteran?')], profile: household, budgetMs }));
    assert.deepEqual(answers, expected, why);
  }
  const dropdown = await everydayAnswers(answerer(stubLaya(state => state.candidate === '1 person' ? 0.98 : 0.01))
    .answer({ questions: [question('size', 'Household size', ['1 person', '2 people', '3 or more'], 'select')], profile: household, budgetMs }));
  assert.deepEqual(dropdown, { size: '1 person' });
  const unsure = await everydayAnswers(answerer(stubLaya(state => state.candidate === 'Veteran' ? 0.03 : state.candidate === 'Senior' ? 0.01 : 0.97))
    .answer({ questions: [question('who', 'Check any that apply', ['Veteran', 'Senior'], 'checkbox')], profile: household, budgetMs }));
  assert.deepEqual(unsure, {}, 'a checkbox is only checked when that box clears the bar');
  const sure = await everydayAnswers(answerer(stubLaya(state => state.candidate === 'Just me' ? 0.95 : 0.02))
    .answer({ questions: [question('who', 'Who lives with you?', ['Just me', 'Family'], 'checkbox')], profile: household, budgetMs }));
  assert.deepEqual(sure, { who: 'Just me' });
});

test('consent, signature, agreement, and SSN questions are never scored, whatever their options', async () => {
  const laya = stubLaya(() => 0.99);
  const answers = await answerer(laya).answer({ questions: [question('a', 'I agree to the pantry rules'), question('b', 'Do you give consent to share your information?'),
    question('c', 'Please confirm', ['I certify this is true', 'No']), question('d', 'Do you have a Social Security number?')], profile, budgetMs });
  assert.deepEqual(answers, { answers: {}, sensitive: [], sensitiveFields: [] });
  assert.deepEqual(laya.batches, []);
});

test('questions still open are tried again with sensitive facts, and those answers are marked with the saved details behind them', async () => {
  // Only the applicant's age settles 60+ for a household of one; only income settles the income question.
  const laya = stubLaya(state => {
    if (state.question === 'Is anyone in your household 60 or older?') return state.facts.includes('41 years old') ? (state.candidate === 'No' ? 0.97 : 0.01) : (state.candidate === ABSTAIN ? 0.95 : 0.01);
    if (state.question === 'Is your household income under $2,000 a month?') return state.facts.includes('$1,000 a month') ? (state.candidate === 'Yes' ? 0.96 : 0.01) : (state.candidate === ABSTAIN ? 0.9 : 0.01);
    if (state.question === 'Is anyone in your household a veteran?') return state.candidate === 'No' ? 0.98 : 0.01;
    return 0.01;
  });
  const questions = [question('sixty', 'Is anyone in your household 60 or older?'), question('vet', 'Is anyone in your household a veteran?'),
    question('income', 'Is your household income under $2,000 a month?'), question('pet', 'Do you have a pet?')];
  const { answers, sensitive, sensitiveFields } = await answerer(laya).answer({ questions, profile, budgetMs });
  assert.deepEqual(answers, { vet: 'No', sixty: 'No', income: 'Yes' });
  assert.deepEqual(sensitive, ['sixty', 'income'], 'the answers that needed a sensitive fact');
  assert.deepEqual(sensitiveFields, ['birthDate', 'monthlyEarnedIncome', 'monthlyOtherIncome'], 'the saved details the approval prompt names');
  const second = laya.batches.filter(batch => batch[0].state.facts === everything).map(batch => batch[0].state.question);
  assert.deepEqual(second, ['Is anyone in your household 60 or older?', 'Is your household income under $2,000 a month?', 'Do you have a pet?'], 'only questions left open are asked again');
  assert.equal(JSON.stringify({ answers, sensitive, sensitiveFields }).includes('years old'), false, 'the facts sheet never leaves the answerer');
});

test('without sensitive facts there is no second pass; without any facts nothing is asked', async () => {
  const laya = stubLaya(state => state.candidate === ABSTAIN ? 0.99 : 0.01);
  assert.deepEqual(await everydayAnswers(answerer(laya).answer({ questions: [question('pet', 'Do you have a pet?')], profile: { householdSize: '2', county: 'Polk' }, budgetMs })), {});
  assert.equal(laya.batches.length, 1);
  const empty = stubLaya(() => 0.99);
  assert.deepEqual(await everydayAnswers(answerer(empty).answer({ questions: [question('pet', 'Do you have a pet?')], profile: {}, budgetMs })), {});
  assert.deepEqual(empty.batches, [], 'with no facts the answer is always "the facts don’t say"');
});

test('Laya not ready fails loudly with its code; a timeout or the click’s budget stops scoring, and a decision past the deadline is dropped', async () => {
  const notReady = Object.assign(new Error('Laya is off.'), { code: 'LAYA_NOT_READY' });
  const off = { status: () => ({ state: 'off' }), decide: async () => { throw notReady; }, decideBatch: async () => { throw notReady; } };
  await assert.rejects(answerer(off).answer({ questions: [question('vet', 'Veteran?')], profile, budgetMs }), error => error.code === 'LAYA_NOT_READY');

  const vet = state => state.candidate === 'No' ? 0.98 : 0.01;
  let calls = 0;
  const slow = stubLaya(vet);
  const batch = slow.decideBatch;
  slow.decideBatch = async items => { if (++calls === 2) throw Object.assign(new Error('Laya took too long.'), { code: 'LAYA_TIMEOUT' }); return batch(items); };
  assert.deepEqual((await answerer(slow).answer({ questions: [question('a', 'Veteran?'), question('b', 'Veteran again?'), question('c', 'Veteran third?')], profile, budgetMs })).answers, { a: 'No' });
  assert.equal(calls, 2);

  // Both passes share the click's budget: 1.1 seconds a decision.
  const timed = limit => {
    let clock = 0;
    const laya = stubLaya(vet);
    const answer = laya.decideBatch;
    laya.decideBatch = async items => { clock += 1100; return answer(items); };
    const questions = Array.from({ length: 5 }, (_, index) => question(`q${index}`, `Veteran ${index}?`));
    return { laya, run: () => createFieldAnswers({ laya, today: TODAY, now: () => clock }).answer({ questions, profile, budgetMs: limit }) };
  };
  const full = timed(3000);
  assert.deepEqual((await full.run()).answers, { q0: 'No', q1: 'No' }, 'the third decision came at 3.3 seconds and is dropped');
  assert.equal(full.laya.batches.length, 3, 'nothing is asked past the deadline');
  const short = timed(1500);
  assert.deepEqual((await short.run()).answers, { q0: 'No' }, 'the click had a second and a half left');
  assert.deepEqual((await timed(60000).run()).answers, { q0: 'No', q1: 'No' }, 'never more than three seconds');
  for (const limit of [0, 1.5, '3000', undefined]) {
    await assert.rejects(answerer(stubLaya(vet)).answer({ questions: [question('a', 'Veteran?')], profile, budgetMs: limit }), /budget/, String(limit));
  }

  const broken = stubLaya();
  broken.decideBatch = async () => { throw new Error('model crashed'); };
  await assert.rejects(answerer(broken).answer({ questions: [question('a', 'Veteran?')], profile, budgetMs }), /model crashed/);
  assert.throws(() => createFieldAnswers({}), /Laya/);
});
