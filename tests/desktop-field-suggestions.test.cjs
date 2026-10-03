'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFieldSuggestions } = require('../desktop/field-suggestions.cjs');
const { ABSTAIN, QUESTIONS, MATCH_CANDIDATES, NEVER_SUGGESTED, CHOICE, KEY_ABOUT, matchState, offeredFields } = require('../shared/laya-prompts.cjs');
const { BARS } = require('../desktop/laya-decisions.cjs');

// A stand-in for desktop/laya.cjs (#38) running a noul-v1 model, with its exact decision interface.
// `scores(question, candidate)` plays the model; every batch it is asked is recorded.
function stubLaya(scores = () => 0.01) {
  const batches = [];
  return {
    batches,
    format: async () => 'noul-v1',
    status: async () => ({ state: 'ready', enabled: true, sizeBytes: 1 }),
    decide: async () => { throw new Error('field suggestions score in batches'); },
    decideBatch: async items => {
      batches.push(items);
      return items.map(({ state }) => { const noul = scores(state.question, state.candidate); return { answers: { correct: { type: 'noul', noul, confidence: Math.max(noul, 1 - noul) } } }; });
    }
  };
}
const saved = key => `Saved answer: ${{ email: 'email address', phone: 'phone number', householdSize: 'number of people in the household', zip: 'ZIP or postal code' }[key]}`;
const field = (id, label, type = 'text') => ({ id, label, type, options: [] });
// The time the extension's click has left for Laya, as the bridge carries it.
const BUDGET = { budgetMs: 3000 };

test('a text box the model matches above the bar gets that saved field; it sees the label and field descriptions only', async () => {
  const laya = stubLaya((question, candidate) => question === 'Where can we reach you by email?' && candidate === saved('email') ? 0.99 : 0.01);
  const suggestions = await createFieldSuggestions({ laya }).suggest([field('f0:sh-1-2', 'Where can we reach you by email?', 'email')], BUDGET);
  assert.deepEqual(suggestions, { 'f0:sh-1-2': 'email' });
  assert.equal(laya.batches.length, 1);
  assert.deepEqual(laya.batches[0], [...['email', 'phone'].map(key => matchState('Where can we reach you by email?', key)), matchState('Where can we reach you by email?', null)]
    .map(state => ({ state, questions: QUESTIONS })), 'the fields its label names plus abstain, in training order');
  assert.equal(laya.batches[0].at(-1).state.candidate, ABSTAIN);
});

test('each text box is asked about the saved fields its label names, every field when it names none, and a date box isn’t asked', async () => {
  const laya = stubLaya((question, candidate) => question === 'Zip Code:' && candidate === saved('zip') ? 0.99 : 0.01);
  const boxes = [field('a', 'Zip Code:'), field('b', 'Today’s Date', 'date'), field('c', 'Anything else?'), field('d', 'Total # of individuals living in your household:')];
  assert.deepEqual(await createFieldSuggestions({ laya }).suggest(boxes, BUDGET), { a: 'zip' });
  assert.deepEqual(laya.batches.map(batch => batch.map(item => item.state.question)[0]), ['Zip Code:', 'Anything else?', 'Total # of individuals living in your household:']);
  for (const [batch, box] of [[laya.batches[0], boxes[0]], [laya.batches[1], boxes[2]], [laya.batches[2], boxes[3]]]) {
    assert.deepEqual(batch.map(item => item.state), [...offeredFields(box).map(key => matchState(box.label, key)), matchState(box.label, null)], box.label);
  }
  assert.equal(laya.batches[1].length, MATCH_CANDIDATES.length + 1, 'a label that names no group is offered every field');
  assert.equal(laya.batches[0].length, 7, 'the six address fields and abstain');
});

test('the bar is 0.95: a lower score, an abstain that wins, or two likely fields leave the box to the applicant', async () => {
  const cases = [
    [() => 0.94, 'below the bar'],
    [(_, candidate) => candidate === ABSTAIN ? 0.99 : candidate === saved('phone') ? 0.97 : 0.01, 'abstain wins'],
    [(_, candidate) => [saved('zip'), saved('householdSize')].includes(candidate) ? 0.98 : 0.01, 'two likely fields']
  ];
  for (const [scores, why] of cases) {
    const suggestions = await createFieldSuggestions({ laya: stubLaya(scores) }).suggest([field('sh-1-0', 'Number')], BUDGET);
    assert.deepEqual(suggestions, {}, why);
  }
  const ok = await createFieldSuggestions({ laya: stubLaya((_, candidate) => candidate === saved('phone') ? 0.96 : 0.02) }).suggest([field('sh-1-0', 'Best number to reach you', 'tel')], BUDGET);
  assert.deepEqual(ok, { 'sh-1-0': 'phone' });
});

test('sensitive saved fields are never candidates, and consent, signature, and SSN questions never reach the model', async () => {
  const laya = stubLaya(() => 0.99);
  await createFieldSuggestions({ laya }).suggest([field('sh-1-0', 'Anything else?')], BUDGET);
  const offered = laya.batches.flat().map(item => item.state.candidate);
  for (const key of NEVER_SUGGESTED) assert.equal(offered.some(candidate => /Social Security|date of birth|income|on hand|medical/i.test(candidate)), false, key);
  const unsafe = stubLaya(() => 0.99);
  const suggestions = await createFieldSuggestions({ laya: unsafe }).suggest([field('a', 'Social Security Number'), field('b', 'Signature'), field('c', 'I certify this is true'), field('d', 'Type your initials to agree')], BUDGET);
  assert.deepEqual(suggestions, {});
  assert.deepEqual(unsafe.batches, [], 'nothing unsafe is scored');
});

test('Laya not ready fails the whole request with its code; a timeout or the three-second budget leaves the rest to the applicant', async () => {
  const notReady = Object.assign(new Error('Laya is off.'), { code: 'LAYA_NOT_READY' });
  const off = { format: async () => { throw notReady; }, status: async () => ({ state: 'off', enabled: false }), decide: async () => { throw notReady; }, decideBatch: async () => { throw notReady; } };
  await assert.rejects(createFieldSuggestions({ laya: off }).suggest([field('a', 'Email')], BUDGET), error => error.code === 'LAYA_NOT_READY');

  let calls = 0;
  const slow = stubLaya((question, candidate) => candidate === saved('email') ? 0.99 : 0.01);
  const decideBatch = slow.decideBatch;
  slow.decideBatch = async items => { if (++calls === 2) throw Object.assign(new Error('Laya took too long.'), { code: 'LAYA_TIMEOUT' }); return decideBatch(items); };
  assert.deepEqual(await createFieldSuggestions({ laya: slow }).suggest([field('a', 'Email'), field('b', 'Email again'), field('c', 'Third email')], BUDGET), { a: 'email' });
  assert.equal(calls, 3, 'every box was asked at once; a timeout keeps what came before it');

  // A decision that finishes after the deadline is dropped. Laya finishes one box every `step` ms, in the order asked.
  const timed = (step, budgetMs) => {
    let clock = 0;
    let previous = Promise.resolve();
    const laya = stubLaya((question, candidate) => candidate === saved('email') ? 0.99 : 0.01);
    const answer = laya.decideBatch;
    const options = [];
    laya.decideBatch = (items, option) => {
      options.push(option);
      previous = previous.then(() => new Promise(resolve => setImmediate(resolve))).then(() => { clock += step; return answer(items); });
      return previous;
    };
    return { laya, options, run: () => createFieldSuggestions({ laya, now: () => clock }).suggest([field('a', 'Email'), field('b', 'Email'), field('c', 'Email')], { budgetMs }) };
  };
  const full = timed(1600, 3000);
  assert.deepEqual(await full.run(), { a: 'email' }, 'the second field’s decision came at 3.2 seconds');
  assert.deepEqual(full.options, Array(3).fill({ format: 'noul-v1', timeoutMs: 3000 }), 'every box is asked at once, each ending when the click’s time does');
  const short = timed(400, 1000);
  assert.deepEqual(await short.run(), { a: 'email', b: 'email' }, 'the click had only one second left');
  assert.deepEqual(short.options.map(option => option.timeoutMs), [1000, 1000, 1000]);
  const capped = timed(1400, 9000);
  assert.deepEqual(await capped.run(), { a: 'email', b: 'email' }, 'never more than three seconds');
  for (const budgetMs of [0, -1, 1.5, '3000', undefined]) {
    await assert.rejects(createFieldSuggestions({ laya: stubLaya() }).suggest([field('a', 'Email')], { budgetMs }), /budget/, String(budgetMs));
  }

  const broken = stubLaya();
  broken.decideBatch = async () => { throw new Error('model crashed'); };
  await assert.rejects(createFieldSuggestions({ laya: broken }).suggest([field('a', 'Email')], BUDGET), /model crashed/, 'other failures are loud');
  assert.throws(() => createFieldSuggestions({}), /Laya/);
});

// A stand-in for desktop/laya.cjs running a choice-v2 model. `choose(label, choices)` plays the model: one probability per choice.
function choiceLaya(choose = (_, choices) => choices.map((_, index) => index === choices.length - 1 ? 0.99 : 0.01 / (choices.length - 1))) {
  const batches = [];
  return {
    batches,
    format: async () => 'choice-v2',
    status: async () => ({ state: 'ready', enabled: true, sizeBytes: 1 }),
    decide: async () => { throw new Error('field suggestions score in batches'); },
    decideBatch: async (items, options) => {
      batches.push({ items, options });
      return items.map(({ state, questions }) => {
        const choices = questions.choice.criteria;
        const values = choose(state.question, choices);
        return { answers: { choice: { type: 'choice', choice: choices[values.indexOf(Math.max(...values))], probabilities: Object.fromEntries(choices.map((label, index) => [label, values[index]])), confidence: 0.5 } } };
      });
    }
  };
}
// Probabilities that put `p` on the choice describing `key` (null: "None of these") and spread the rest.
const sure = (choices, key, p) => choices.map(label => label === (key ? KEY_ABOUT[key] : CHOICE.MATCH_ABSTAIN) ? p : (1 - p) / (choices.length - 1));
// A match the model is sure of: halfway between choice-v2's bar and certainty.
const SURE = (1 + BARS['choice-v2'].match) / 2;
const MEANS = { 'Where can we reach you by email?': 'email', 'Best number': 'phone', 'Your full name': 'fullName', 'People in your home': 'householdSize', 'Date of birth': null };

test('choice-v2: each text box is one pass over the saved fields offered for its type, eight boxes to a request; a date box is never asked', async () => {
  const fields = [field('a', 'Where can we reach you by email?', 'email'), field('b', 'Best number', 'tel'), field('c', 'Your full name'), field('d', 'People in your home', 'number'),
    field('e', 'Date of birth', 'date'), ...Array.from({ length: 5 }, (_, index) => field(`x${index}`, `Favorite color ${index}`, 'textarea'))];
  const laya = choiceLaya((label, choices) => sure(choices, MEANS[label] ?? null, SURE));
  const suggestions = await createFieldSuggestions({ laya }).suggest(fields, BUDGET);
  assert.deepEqual(suggestions, { a: 'email', b: 'phone', c: 'fullName', d: 'householdSize' });
  assert.deepEqual(laya.batches.map(({ items }) => items.length), [8, 1]);
  assert.deepEqual(laya.batches[0].items.slice(0, 4), [['Where can we reach you by email?', 'email'], ['Best number', 'tel'], ['Your full name', 'text'], ['People in your home', 'number']]
    .map(([label, type]) => ({ state: CHOICE.matchState(label, type), questions: { choice: CHOICE.matchQuestion(CHOICE.MATCH_SETS[type]) } })));
  assert.deepEqual(laya.batches[0].items[1].state, { question: 'Best number', type: 'phone' }, 'the model is told what kind of box it is');
  assert.deepEqual(laya.batches[0].items[1].questions.choice.criteria, [KEY_ABOUT.phone, CHOICE.MATCH_ABSTAIN]);
  assert.ok(laya.batches.every(({ options }) => options.format === 'choice-v2'));
  const offered = laya.batches.flatMap(({ items }) => items.flatMap(item => item.questions.choice.criteria));
  for (const key of NEVER_SUGGESTED) assert.equal(offered.includes(KEY_ABOUT[key]), false, key);
});

test('choice-v2: the match bar, "None of these", and a close runner-up each leave the box to the applicant', async () => {
  const bar = BARS['choice-v2'].match;
  const box = [field('z', 'Postal code', 'text')];
  const cases = [
    [choices => sure(choices, 'zip', bar - 0.005), {}, 'below the bar'],
    [choices => sure(choices, 'zip', bar), { z: 'zip' }, 'at the bar'],
    [choices => sure(choices, null, 0.9), {}, 'none of these'],
    [choices => choices.map(label => label === KEY_ABOUT.zip ? 0.5 : label === KEY_ABOUT.city ? 0.49 : 0.01 / (choices.length - 2)), {}, 'two likely fields']
  ];
  for (const [choose, expected, why] of cases) assert.deepEqual(await createFieldSuggestions({ laya: choiceLaya((_, choices) => choose(choices)) }).suggest(box, BUDGET), expected, why);
  const unsafe = choiceLaya(() => { throw new Error('never asked'); });
  assert.deepEqual(await createFieldSuggestions({ laya: unsafe }).suggest([field('a', 'Social Security Number'), field('b', 'Signature')], BUDGET), {});
  assert.deepEqual(unsafe.batches, []);
});

test('choice-v2: a timeout keeps the requests already decided; a request past the deadline is dropped; an unknown format fails loudly', async () => {
  const fields = Array.from({ length: 12 }, (_, index) => field(`e${index}`, 'Where can we reach you by email?', 'email'));
  const email = (label, choices) => sure(choices, 'email', SURE);
  let calls = 0;
  const slow = choiceLaya(email);
  const batch = slow.decideBatch;
  slow.decideBatch = async (items, options) => { if (++calls === 2) throw Object.assign(new Error('Laya took too long.'), { code: 'LAYA_TIMEOUT' }); return batch(items, options); };
  assert.deepEqual(Object.keys(await createFieldSuggestions({ laya: slow }).suggest(fields, BUDGET)), fields.slice(0, 8).map(item => item.id));

  let clock = 0;
  const timed = choiceLaya(email);
  const answer = timed.decideBatch;
  timed.decideBatch = async (items, options) => { clock += 2000; return answer(items, options); };
  assert.deepEqual(Object.keys(await createFieldSuggestions({ laya: timed, now: () => clock }).suggest(fields, BUDGET)), fields.slice(0, 8).map(item => item.id));
  assert.equal(timed.batches.length, 2, 'the second request came back at 4 seconds and is dropped');
  await assert.rejects(createFieldSuggestions({ laya: { ...choiceLaya(email), format: async () => 'choice-v9' } }).suggest(fields, BUDGET), /choice-v9/);
});
