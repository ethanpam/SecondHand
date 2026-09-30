'use strict';
// How long the desktop app takes to decide one form page with a real Laya export, on this computer's
// CPU (#65). It runs the desktop's own request code: desktop/field-answers.cjs for the page's choice
// questions, then desktop/field-suggestions.cjs for its text boxes with the time left, as one Autofill
// click does, through desktop/laya.cjs and onnxruntime-node in the model's own process. The page is
// one fictional household's first N questions on a real form, in form order, whether or not the
// rules would fill them (the worst case). Each run records the 1-minute load average taken before it
// and whether every question was decided within the click's 3-second budget.
//
//   node ML_model/eval/page_latency.cjs --model <export folder> --format <format> --form <form url> \
//     [--questions 20] [--runs 30] [--out <report.json>]
const fs = require('node:fs');
const os = require('node:os');
const { createLaya } = require('../../desktop/laya.cjs');
const { createFieldAnswers } = require('../../desktop/field-answers.cjs');
const { createFieldSuggestions } = require('../../desktop/field-suggestions.cjs');
const { BUDGET_MS } = require('../../desktop/laya-decisions.cjs');
const { ABSTAIN, CHOICE, TEXT_TYPES, CHOICE_TYPES, unsafeQuestion } = require('../../shared/laya-prompts.cjs');
const { buildFacts, factsText } = require('../../shared/facts.cjs');
const { loadQuestionBank } = require('../question-bank.cjs');
const { generateHouseholds } = require('../profiles/generate.cjs');

const TODAY = '2026-09-26';
const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : fallback; };
const percentile = (values, share) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(1, Math.ceil(share * sorted.length)) - 1]; };

// The page: the form's first `count` questions the bridge would carry (desktop/bridge.cjs limits),
// as the extension sends them.
function page(url, count, bank = loadQuestionBank()) {
  const form = bank.find(file => file.source.url === url);
  if (!form) throw new Error(`${url} isn’t in the question bank.`);
  const fits = question => question.label.length <= 200 && question.options.length <= 30 && question.options.every(option => option.length <= 100);
  const questions = form.questions.filter(fits).slice(0, count).map(({ id, label, type, options }) => ({ id: `f0:${id}`, label, type, options }));
  if (questions.length < count) throw new Error(`${url} has ${questions.length} questions the bridge carries; the page needs ${count}.`);
  return { choices: questions.filter(question => CHOICE_TYPES.includes(question.type)), boxes: questions.filter(question => TEXT_TYPES.includes(question.type)) };
}

// How many question passes a complete decision of the page takes, given what the first pass answered.
function passesNeeded(format, { choices, boxes }, profile, { answers, sensitive }) {
  const facts = buildFacts(profile, { today: TODAY });
  const everyday = factsText(facts.filter(fact => !fact.sensitive)), everything = factsText(facts);
  const open = choices.filter(question => !unsafeQuestion(question) && !question.options.includes(ABSTAIN));
  const firstPass = Object.keys(answers).length - sensitive.length;
  const matched = boxes.filter(box => !unsafeQuestion(box) && (format !== 'choice-v2' || CHOICE.MATCH_SETS[box.type].length));
  return (everyday ? open.length : 0) + (everything !== everyday ? open.length - (everyday ? firstPass : 0) : 0) + matched.length;
}

async function main() {
  const modelDir = arg('model'), format = arg('format'), url = arg('form');
  if (!modelDir || !format || !url) throw new Error('Usage: node ML_model/eval/page_latency.cjs --model <export folder> --format <format> --form <form url> [--questions 20] [--runs 30] [--out <report.json>]');
  const count = Number(arg('questions', '20')), runs = Number(arg('runs', '30'));
  const questions = page(url, count);
  const [profile] = generateHouseholds({ count: 400, seed: 11, today: TODAY });
  const laya = createLaya({ modelDir, modelFormat: format, manifest: { version: 1, model: null }, enabled: true, timeoutMs: BUDGET_MS });
  // Counts the question passes the model finished: a noul-v1 request is one question, a choice-v2 request one per item.
  let passes = 0;
  const counted = { ...laya, decideBatch: async (items, options) => {
    const results = await laya.decideBatch(items, options);
    passes += options?.format === 'choice-v2' ? items.length : 1;
    return results;
  } };
  const answerer = createFieldAnswers({ laya: counted, today: TODAY });
  const matcher = createFieldSuggestions({ laya: counted });
  const loadStarted = performance.now();
  await laya.warm();
  const loadMs = performance.now() - loadStarted;
  const click = async () => {
    passes = 0;
    const load1m = os.loadavg()[0];
    const started = performance.now();
    const answered = await answerer.answer({ questions: questions.choices, profile, budgetMs: BUDGET_MS });
    const left = Math.floor(BUDGET_MS - (performance.now() - started));
    const suggestions = left >= 1 ? await matcher.suggest(questions.boxes, { budgetMs: left }) : {};
    const ms = performance.now() - started;
    const needed = passesNeeded(format, questions, profile, answered);
    return { ms: Math.round(ms), load1m: Math.round(load1m * 100) / 100, passes, needed, complete: passes === needed && ms <= BUDGET_MS,
      filled: Object.keys(answered.answers).length + Object.keys(suggestions).length };
  };
  const first = await click();
  const timed = [];
  for (let run = 0; run < runs; run++) timed.push(await click());
  await laya.close();
  const times = timed.map(run => run.ms);
  const report = {
    machine: `${os.cpus()[0].model}, ${os.cpus().length} cores`, platform: `${os.platform()} ${os.release()}`, node: process.version,
    model: modelDir, format, form: url, household: 0, questions: count, choiceQuestions: questions.choices.length, textBoxes: questions.boxes.length,
    budgetMs: BUDGET_MS, loadMs: Math.round(loadMs), firstPage: first,
    p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), minMs: Math.min(...times), maxMs: Math.max(...times),
    load1mRange: [Math.min(...timed.map(run => run.load1m)), Math.max(...timed.map(run => run.load1m))],
    completeRuns: timed.filter(run => run.complete).length, runs: timed
  };
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (arg('out')) fs.writeFileSync(arg('out'), `${text}\n`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { page, passesNeeded };
