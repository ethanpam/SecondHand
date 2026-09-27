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
  return files;
}

// Training-only rewordings.
function loadSyntheticBank(directory = SYNTHETIC_DIR) {
  if (!fs.existsSync(directory)) return [];
  const files = readFiles(directory);
  const real = files.find(file => file.source.kind !== 'synthetic');
  if (real) throw new Error(`${real.file}: only synthetic rewordings belong in questions/synthetic/.`);
  return files;
}

module.exports = { validateQuestionFile, loadQuestionBank, loadSyntheticBank, QUESTION_TYPES, KINDS };
