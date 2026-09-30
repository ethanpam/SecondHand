'use strict';
// Loads and checks the question bank: one JSON file per real public form, with each
// question copied exactly and tagged with an answer rule. A bad file fails loudly.
const fs = require('node:fs');
const path = require('node:path');
const { RULES } = require('./answer-rules.cjs');

const QUESTION_TYPES = ['radio', 'select', 'checkbox', 'text', 'textarea', 'number', 'date', 'email', 'tel'];
const KINDS = ['google-form', 'jotform', 'pdf', 'web', 'iowa-portal', 'synthetic'];
const QUESTIONS_DIR = path.join(__dirname, 'questions');
const SYNTHETIC_DIR = path.join(QUESTIONS_DIR, 'synthetic');
// The final holdout (#65): real forms collected after round 3, scored once after the bars are frozen.
const FINAL_DIR = path.join(__dirname, 'questions-final');
const text = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max;

function checkRule(where, question) {
  const rule = question.rule;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${where}: ${question.id}: rule must be an object with a name.`);
  const spec = RULES[rule.name];
  if (!spec) throw new Error(`${where}: ${question.id}: unknown rule "${rule.name}".`);
  if (!spec.types.includes(question.type)) throw new Error(`${where}: ${question.id}: rule ${rule.name} doesn't fit a ${question.type} question.`);
  for (const param of Object.keys(rule)) {
    if (param !== 'name' && !spec.params[param]) throw new Error(`${where}: ${question.id}: rule ${rule.name} has an unknown parameter ${param}.`);
  }
  for (const [param, want] of Object.entries(spec.params)) {
    const value = rule[param];
    if (value === undefined) {
      if (want.required) throw new Error(`${where}: ${question.id}: rule ${rule.name} needs ${param}.`);
      continue;
    }
    if (want.type === 'list') {
      if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length) {
        throw new Error(`${where}: ${question.id}: rule ${rule.name} ${param} must be a list of different values.`);
      }
      const unknown = value.find(item => !want.enum.includes(item));
      if (unknown !== undefined) throw new Error(`${where}: ${question.id}: ${rule.name} ${param} ${unknown} isn't one of ${want.enum.join(', ')}.`);
      continue;
    }
    if (typeof value !== want.type || (want.type === 'number' && !(Number.isFinite(value) && value >= 0)) || (want.type === 'string' && !value.trim())) {
      throw new Error(`${where}: ${question.id}: rule ${rule.name} ${param} must be a ${want.type}.`);
    }
    if (want.enum && !want.enum.includes(value)) {
      throw new Error(`${where}: ${question.id}: ${rule.name} ${param} ${value} isn't ${param === 'key' ? 'a SecondHand field' : `one of ${want.enum.join(', ')}`}.`);
    }
  }
}

function validateQuestionFile(file, where = 'form') {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`${where}: must be an object with source and questions.`);
  const { source, questions } = file;
  if (!source || typeof source !== 'object') throw new Error(`${where}: source is required.`);
  if (!KINDS.includes(source.kind)) throw new Error(`${where}: source.kind must be one of ${KINDS.join(', ')}.`);
  if (source.kind === 'synthetic') {
    // Rewordings written for training only: they have no page of their own and never reach the test set.
    if (source.url !== undefined) throw new Error(`${where}: synthetic rewordings have no url.`);
  } else {
    let url;
    try { url = new URL(source.url); } catch { throw new Error(`${where}: source.url must be an https URL.`); }
    if (url.protocol !== 'https:') throw new Error(`${where}: source.url must be an https URL.`);
  }
  if (!text(source.title, 200)) throw new Error(`${where}: source.title is required.`);
  // Held-out forms are always test forms: a clean check on forms nothing was tuned against.
  if (source.holdout !== undefined && (source.holdout !== true || source.kind === 'synthetic')) {
    throw new Error(`${where}: source.holdout can only be true, and only on a real form.`);
  }
  if (source.final !== undefined && (source.final !== true || source.kind === 'synthetic' || source.holdout !== undefined)) {
    throw new Error(`${where}: source.final can only be true, and only on a real form that isn't marked holdout.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.retrieved || '')) throw new Error(`${where}: source.retrieved must be a YYYY-MM-DD date.`);
  if (!Array.isArray(questions) || !questions.length) throw new Error(`${where}: needs at least one question.`);
  const seen = new Set();
  for (const question of questions) {
    if (!question || !text(question.id, 40)) throw new Error(`${where}: every question needs an id.`);
    if (seen.has(question.id)) throw new Error(`${where}: duplicate question id ${question.id}.`);
    seen.add(question.id);
    if (!text(question.label, 300)) throw new Error(`${where}: ${question.id}: label must be the question's text (1-300 characters).`);
    if (!QUESTION_TYPES.includes(question.type)) throw new Error(`${where}: ${question.id}: type must be one of ${QUESTION_TYPES.join(', ')}.`);
    const choice = ['radio', 'select', 'checkbox'].includes(question.type);
    const minimum = question.type === 'checkbox' ? 1 : 2;
    if (!Array.isArray(question.options) || !question.options.every(option => text(option, 200)) ||
      (choice ? question.options.length < minimum : question.options.length !== 0)) {
      throw new Error(`${where}: ${question.id}: options must list the choices exactly (${choice ? `at least ${minimum}` : 'empty for a text box'}).`);
    }
    checkRule(where, question);
    if (question.note !== undefined && !text(question.note, 300)) throw new Error(`${where}: ${question.id}: note must be short text.`);
  }
  return file;
}

const readFiles = directory => fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()
  .map(name => ({ ...validateQuestionFile(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')), name), file: name }));

// Real public forms only.
function loadQuestionBank(directory = QUESTIONS_DIR) {
  const files = readFiles(directory);
  const mixed = files.find(file => file.source.kind === 'synthetic');
  if (mixed) throw new Error(`${mixed.file}: synthetic rewordings belong in questions/synthetic/.`);
  const final = files.find(file => file.source.final);
  if (final) throw new Error(`${final.file}: final holdout forms belong in questions-final/.`);
  return files;
}

// The final holdout: real forms, each marked final.
function loadFinalBank(directory = FINAL_DIR) {
  const files = readFiles(directory);
  const plain = files.find(file => file.source.final !== true);
  if (plain) throw new Error(`${plain.file}: every form in questions-final/ must say source.final: true.`);
  return files;
}

// Where a final form's content appears in `others` (training forms and synthetic rewordings), as
// readable lines. Real forms share standard wording (race and ethnicity categories, program names,
// "Prefer not to answer") and short labels ("Name", "Date of Birth") without copying, so the signals are:
// - a training form at a final form's URL, or on a final form's own site (form platforms aside);
// - a synthetic rewording that repeats a final label, of any length;
// - a training form repeating a whole final question, label and options, whose label has 7 or more words.
// `accepted` lists reviewed overlaps ("<file> <question id>"); each must still overlap.
const FORM_PLATFORMS = new Set(['docs.google.com', 'forms.gle', 'form.jotform.com', 'www.jotform.com', 'jotform.com', 'forms.office.com']);
const normalize = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = text => normalize(text).split(' ').filter(Boolean).length;
const whole = question => `${normalize(question.label)} || ${question.options.map(normalize).join(' | ')}`;
function finalLeaks(finalBank, others, accepted = []) {
  const labels = new Map(), questions = new Map(), urls = new Set(), sites = new Set();
  for (const file of finalBank) {
    urls.add(file.source.url);
    const host = new URL(file.source.url).host;
    if (!FORM_PLATFORMS.has(host)) sites.add(host);
    for (const question of file.questions) {
      labels.set(normalize(question.label), `${file.file} (${question.id})`);
      if (words(question.label) >= 7) questions.set(whole(question), `${file.file} (${question.id})`);
    }
  }
  const leaks = [], found = new Set();
  const report = (at, line) => { if (accepted.includes(at)) found.add(at); else leaks.push(line); };
  for (const file of others) {
    if (file.source.kind !== 'synthetic') {
      if (urls.has(file.source.url)) { leaks.push(`${file.file}: ${file.source.url} is a final form`); continue; }
      const host = new URL(file.source.url).host;
      if (sites.has(host)) { leaks.push(`${file.file}: ${host} is a final form’s site`); continue; }
    }
    for (const question of file.questions) {
      const at = `${file.file} ${question.id}`;
      if (file.source.kind === 'synthetic' && labels.has(normalize(question.label))) {
        report(at, `${at}: label "${question.label}" is on final form ${labels.get(normalize(question.label))}`);
      } else if (file.source.kind !== 'synthetic' && questions.has(whole(question))) {
        report(at, `${at}: the question "${question.label}" and its options are on final form ${questions.get(whole(question))}`);
      }
    }
  }
  const stale = accepted.filter(at => !found.has(at) && others.some(file => at.startsWith(`${file.file} `)));
  if (stale.length) throw new Error(`Accepted overlaps ${stale.join(', ')}: ${stale.length === 1 ? 'it no longer overlaps' : 'they no longer overlap'} a final form; take ${stale.length === 1 ? 'it' : 'them'} off the list.`);
  return leaks;
}
// Training-only rewordings.
function loadSyntheticBank(directory = SYNTHETIC_DIR) {
  const files = readFiles(directory);
  const real = files.find(file => file.source.kind !== 'synthetic');
  if (real) throw new Error(`${real.file}: only synthetic rewordings belong in questions/synthetic/.`);
  return files;
}

module.exports = { validateQuestionFile, loadQuestionBank, loadSyntheticBank, loadFinalBank, finalLeaks, QUESTION_TYPES, KINDS, FINAL_DIR };
