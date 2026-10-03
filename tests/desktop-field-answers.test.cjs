'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFieldAnswers } = require('../desktop/field-answers.cjs');
const { ABSTAIN, QUESTIONS, CHOICE, answerState } = require('../shared/laya-prompts.cjs');
const { BARS } = require('../desktop/laya-decisions.cjs');
const { buildFacts, factsText } = require('../shared/facts.cjs');

const TODAY = '2026-09-26';
// A stand-in for desktop/laya.cjs (#38) running a noul-v1 model, with its exact decision interface. `scores(state)` plays the model.
function stubLaya(scores = () => 0.01) {
  const batches = [];
  return {
    batches,
    format: async () => 'noul-v1',
    status: async () => ({ state: 'ready', enabled: true, sizeBytes: 1 }),
    decide: async () => { throw new Error('field answers score in batches'); },
    decideBatch: async items => { batches.push(items); return items.map(({ state }) => { const noul = scores(state); return { answers: { correct: { type: 'noul', noul, confidence: Math.max(noul, 1 - noul) } } }; }); }
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
  assert.deepEqual(second, ['Is anyone in your household 60 or older?', 'Is your household income under $2,000 a month?'], 'only questions left open are asked again');
  assert.equal(laya.batches.some(batch => batch[0].state.question === 'Do you have a pet?'), false, 'a question on no topic the facts cover is never asked');
  assert.equal(JSON.stringify({ answers, sensitive, sensitiveFields }).includes('years old'), false, 'the facts sheet never leaves the answerer');
});

test('without sensitive facts there is no second pass; without any facts nothing is asked', async () => {
  const laya = stubLaya(state => state.candidate === ABSTAIN ? 0.99 : 0.01);
  assert.deepEqual(await everydayAnswers(answerer(laya).answer({ questions: [question('vet', 'Is anyone in your household a veteran?')], profile: { householdSize: '2', county: 'Polk' }, budgetMs })), {});
  assert.equal(laya.batches.length, 1);
  const empty = stubLaya(() => 0.99);
  assert.deepEqual(await everydayAnswers(answerer(empty).answer({ questions: [question('pet', 'Do you have a pet?')], profile: {}, budgetMs })), {});
  assert.deepEqual(empty.batches, [], 'with no facts the answer is always "the facts don’t say"');
});

test('Laya not ready fails loudly with its code; a timeout or the click’s budget stops scoring, and a decision past the deadline is dropped', async () => {
  const notReady = Object.assign(new Error('Laya is off.'), { code: 'LAYA_NOT_READY' });
  const off = { format: async () => { throw notReady; }, status: async () => ({ state: 'off', enabled: false }), decide: async () => { throw notReady; }, decideBatch: async () => { throw notReady; } };
  await assert.rejects(answerer(off).answer({ questions: [question('vet', 'Veteran?')], profile, budgetMs }), error => error.code === 'LAYA_NOT_READY');

  const vet = state => state.candidate === 'No' ? 0.98 : 0.01;
  let calls = 0;
  const slow = stubLaya(vet);
  const batch = slow.decideBatch;
  slow.decideBatch = async items => { if (++calls === 2) throw Object.assign(new Error('Laya took too long.'), { code: 'LAYA_TIMEOUT' }); return batch(items); };
  assert.deepEqual((await answerer(slow).answer({ questions: [question('a', 'Veteran?'), question('b', 'Veteran again?'), question('c', 'Veteran third?')], profile, budgetMs })).answers, { a: 'No' });
  assert.equal(calls, 3, 'the pass’s questions were all asked at once; nothing is asked after the timeout');

  // Both passes share the click's budget. Laya finishes one decision every 1.1 seconds, in the order asked.
  const timed = limit => {
    let clock = 0;
    let previous = Promise.resolve();
    const laya = stubLaya(vet);
    const answer = laya.decideBatch;
    const options = [];
    laya.decideBatch = (items, option) => {
      options.push(option);
      previous = previous.then(() => new Promise(resolve => setImmediate(resolve))).then(() => { clock += 1100; return answer(items); });
      return previous;
    };
    const questions = Array.from({ length: 5 }, (_, index) => question(`q${index}`, `Veteran ${index}?`));
    return { laya, options, run: () => createFieldAnswers({ laya, today: TODAY, now: () => clock }).answer({ questions, profile, budgetMs: limit }) };
  };
  const full = timed(3000);
  assert.deepEqual((await full.run()).answers, { q0: 'No', q1: 'No' }, 'the third decision came at 3.3 seconds and is dropped');
  assert.equal(full.laya.batches.length, 5, 'the first pass asked every question at once; the second pass, past the deadline, asked nothing');
  assert.deepEqual(full.options, Array(5).fill({ format: 'noul-v1', timeoutMs: 3000 }), 'each request ends when the click’s time does');
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

// #90: a question costs one model pass per option, plus abstaining, and the model runs eight passes to a batch.
const items = count => Array.from({ length: count }, (_, index) => `Item ${index + 1}`);
const checklist = question('foods', 'Which of these does your household need? Check all that apply.', items(23), 'checkbox');
const sized = question('size', 'How many people live in your household?', items(8), 'select');
// Plays the model: veteran settles from everyday facts, 60-or-older only with the applicant's age, and the rest abstain.
const settles = state => {
  if (state.question === 'Is anyone in your household a veteran?') return state.candidate === 'No' ? 0.98 : 0.01;
  if (state.question === 'Is anyone in your household 60 or older?') return state.facts.includes('41 years old') ? (state.candidate === 'No' ? 0.97 : 0.01) : (state.candidate === ABSTAIN ? 0.95 : 0.01);
  return state.candidate === ABSTAIN ? 0.99 : 0.01;
};

test('noul-v1: the questions with the fewest options go first, each group by batches through both passes, so long checklists come last', async () => {
  const laya = stubLaya(settles);
  const questions = [checklist, question('sixty', 'Is anyone in your household 60 or older?'), sized, question('vet', 'Is anyone in your household a veteran?')];
  const { answers, sensitive } = await answerer(laya).answer({ questions, profile, budgetMs });
  assert.deepEqual(answers, { vet: 'No', sixty: 'No' });
  assert.deepEqual(sensitive, ['sixty']);
  const asked = laya.batches.map(batch => [batch[0].state.question, batch[0].state.facts === everything ? 'every fact' : 'everyday', batch.length]);
  assert.deepEqual(asked, [
    ['Is anyone in your household 60 or older?', 'everyday', 3], ['Is anyone in your household a veteran?', 'everyday', 3], ['Is anyone in your household 60 or older?', 'every fact', 3],
    ['How many people live in your household?', 'everyday', 9], ['How many people live in your household?', 'every fact', 9],
    [checklist.label, 'everyday', 24], [checklist.label, 'every fact', 24]
  ], 'yes/no questions (one batch each), then 8 options (two batches), then 23 (three), each through both passes');
});

test('noul-v1: a long checklist first on the page doesn’t take the short questions’ time; it gets what they leave', async () => {
  // Laya runs one pass at a time, 100 ms each, in the order asked.
  let clock = 0;
  let previous = Promise.resolve();
  const laya = stubLaya(settles);
  const answer = laya.decideBatch;
  laya.decideBatch = items => {
    previous = previous.then(() => new Promise(resolve => setImmediate(resolve))).then(() => { clock += 100 * items.length; return answer(items); });
    return previous;
  };
  const questions = [checklist, question('sixty', 'Is anyone in your household 60 or older?'), question('vet', 'Is anyone in your household a veteran?')];
  const { answers, sensitive } = await createFieldAnswers({ laya, today: TODAY, now: () => clock }).answer({ questions, profile, budgetMs });
  assert.deepEqual(answers, { vet: 'No', sixty: 'No' }, 'both short questions are decided, the sensitive pass included, by 0.9 seconds');
  assert.deepEqual(sensitive, ['sixty']);
  assert.equal(laya.batches.filter(batch => batch[0].state.question === checklist.label).length, 1, 'the checklist starts with the 2.1 seconds left, and its 2.4 seconds run out');
});

test('noul-v1: answers come back in page order, the ones from everyday facts first, as when every question was one group', async () => {
  const laya = stubLaya(state => state.question === checklist.label ? (state.candidate === 'Item 3' ? 0.97 : 0.01) : settles(state));
  const questions = [question('sixty', 'Is anyone in your household 60 or older?'), checklist, question('vet', 'Is anyone in your household a veteran?')];
  const { answers, sensitive } = await answerer(laya).answer({ questions, profile, budgetMs });
  assert.deepEqual(Object.entries(answers), [['foods', 'Item 3'], ['vet', 'No'], ['sixty', 'No']]);
  assert.deepEqual(sensitive, ['sixty']);
});

// A stand-in for desktop/laya.cjs running a choice-v2 model. `choose(state, choices)` plays the model: one probability per choice.
function choiceLaya(choose = (_, choices) => choices.map((_, index) => index === choices.length - 1 ? 0.98 : 0.02 / (choices.length - 1))) {
  const batches = [];
  return {
    batches,
    format: async () => 'choice-v2',
    status: async () => ({ state: 'ready', enabled: true, sizeBytes: 1 }),
    decide: async () => { throw new Error('field answers score in batches'); },
    decideBatch: async (items, options) => {
      batches.push({ items, options });
      return items.map(({ state, questions }) => {
        const choices = questions.choice.criteria;
        const values = choose(state, choices);
        return { answers: { choice: { type: 'choice', choice: choices[values.indexOf(Math.max(...values))], probabilities: Object.fromEntries(choices.map((label, index) => [label, values[index]])), confidence: 0.5 } } };
      });
    }
  };
}
// Probabilities that put `p` on `option` and spread the rest over the other choices.
const sure = (choices, option, p) => choices.map(label => label === option ? p : (1 - p) / (choices.length - 1));

test('choice-v2: every option of a question is scored in one pass, eight questions to a request, with the facts and the question as the state', async () => {
  const questions = Array.from({ length: 10 }, (_, index) => question(`q${index}`, index === 3 ? 'Do you live in Polk County?' : `Do you have pet number ${index}?`, index === 3 ? ['YES', 'NO'] : ['Yes', 'No']));
  const laya = choiceLaya((state, choices) => state.question === 'Do you live in Polk County?' && state.facts.includes('Polk County') ? sure(choices, 'YES', 0.97) : sure(choices, ABSTAIN, 0.97));
  const { answers, sensitive } = await answerer(laya).answer({ questions, profile, budgetMs });
  assert.deepEqual(answers, { q3: 'YES' });
  assert.deepEqual(sensitive, []);
  assert.deepEqual(laya.batches.map(({ items }) => items.length), [8, 2, 8, 1], 'the first pass in two requests; the nine still open again with every fact');
  assert.deepEqual(laya.batches[0].items[3], { state: CHOICE.answerState(everyday, 'Do you live in Polk County?'), questions: { choice: CHOICE.answerQuestion(['YES', 'NO']) } });
  assert.deepEqual(laya.batches[0].items[3].questions.choice.criteria, ['YES', 'NO', ABSTAIN]);
  assert.ok(laya.batches.every(({ options }) => options.format === 'choice-v2'), 'the prompts are choice-v2’s, so only a choice-v2 model may answer them');
  assert.ok(laya.batches.slice(2).every(({ items }) => items.every(item => item.state.facts === everything)));
});

test('choice-v2: the bar, "the facts don’t say", and a close runner-up each leave the question to the applicant', async () => {
  const household = { householdSize: '1', householdVeteran: 'no' };
  const bar = BARS['choice-v2'].answer;
  const vet = question('vet', 'Is anyone in your household a veteran?');
  const cases = [
    [choices => sure(choices, 'No', bar - 0.01), {}, 'below the bar'],
    [choices => sure(choices, 'No', bar), { vet: 'No' }, 'at the bar'],
    [() => [0.3, 0.3, 0.4], {}, 'the facts don’t say'],
    [() => [0.5, 0.49, 0.01], {}, 'two likely answers']
  ];
  for (const [choose, expected, why] of cases) {
    assert.deepEqual(await everydayAnswers(answerer(choiceLaya((_, choices) => choose(choices))).answer({ questions: [vet], profile: household, budgetMs })), expected, why);
  }
  const dropdown = await everydayAnswers(answerer(choiceLaya((_, choices) => sure(choices, '1 person', 0.98)))
    .answer({ questions: [question('size', 'Household size', ['1 person', '2 people', '3 or more'], 'select')], profile: household, budgetMs }));
  assert.deepEqual(dropdown, { size: '1 person' });
});

test('choice-v2: answers needing a sensitive fact are marked; a question whose option is the abstain choice itself is never asked', async () => {
  const laya = choiceLaya((state, choices) => {
    if (state.question === 'Is anyone in your household 60 or older?') return sure(choices, state.facts.includes('41 years old') ? 'No' : ABSTAIN, 0.97);
    if (state.question === 'Is anyone in your household a veteran?') return sure(choices, 'No', 0.98);
    return sure(choices, ABSTAIN, 0.99);
  });
  const questions = [question('sixty', 'Is anyone in your household 60 or older?'), question('vet', 'Is anyone in your household a veteran?'),
    question('odd', 'Pick one', ['Yes', ABSTAIN])];
  const { answers, sensitive, sensitiveFields } = await answerer(laya).answer({ questions, profile, budgetMs });
  assert.deepEqual(answers, { vet: 'No', sixty: 'No' });
  assert.deepEqual(sensitive, ['sixty']);
  assert.deepEqual(sensitiveFields, ['birthDate', 'monthlyEarnedIncome', 'monthlyOtherIncome']);
  assert.equal(laya.batches.flatMap(({ items }) => items).some(item => item.state.question === 'Pick one'), false, 'its choices would be ambiguous');
});

test('choice-v2: a timeout keeps the requests already decided; a request past the deadline is dropped; a format without bars fails loudly', async () => {
  const questions = Array.from({ length: 20 }, (_, index) => question(`q${index}`, `Is anyone a veteran ${index}?`));
  const vet = (_, choices) => sure(choices, 'No', 0.98);
  let calls = 0;
  const slow = choiceLaya(vet);
  const batch = slow.decideBatch;
  slow.decideBatch = async (items, options) => { if (++calls === 2) throw Object.assign(new Error('Laya took too long.'), { code: 'LAYA_TIMEOUT' }); return batch(items, options); };
  assert.deepEqual(Object.keys((await answerer(slow).answer({ questions, profile, budgetMs })).answers), questions.slice(0, 8).map(item => item.id));

  let clock = 0;
  const timed = choiceLaya(vet);
  const answer = timed.decideBatch;
  timed.decideBatch = async (items, options) => { clock += 1600; return answer(items, options); };
  const result = await createFieldAnswers({ laya: timed, today: TODAY, now: () => clock }).answer({ questions, profile, budgetMs });
  assert.deepEqual(Object.keys(result.answers), questions.slice(0, 8).map(item => item.id), 'the second request came back at 3.2 seconds');
  assert.equal(timed.batches.length, 2);

  const pageOrder = choiceLaya(vet);
  await answerer(pageOrder).answer({ questions: [checklist, question('vet', 'Is anyone in your household a veteran?')], profile, budgetMs });
  assert.deepEqual(pageOrder.batches[0].items.map(item => item.state.question), [checklist.label, 'Is anyone in your household a veteran?'],
    'choice-v2 scores every option of a question in one pass, so its questions stay in page order');

  const unknown = { ...choiceLaya(vet), format: async () => 'choice-v9' };
  await assert.rejects(answerer(unknown).answer({ questions, profile, budgetMs }), /choice-v9/);
});
