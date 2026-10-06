'use strict';
// Applicant-authored reusable answers. Storage is independent of the model;
// release uses exact labels only, and never returns the saved catalog.
const MAX_CUSTOM_FIELDS = 50;
const MAX_CUSTOM_LABEL = 120;
const MAX_CUSTOM_VALUE = 1000;
const MAX_CUSTOM_ALIASES = 5;
const MAX_CUSTOM_QUESTIONS = 40;
const MAX_CUSTOM_RELEASE_BYTES = 48 * 1024;
const CUSTOM_TYPES = Object.freeze(['text', 'textarea', 'email', 'tel', 'number', 'date', 'select', 'radio', 'checkbox']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUESTION_ID = /^(f\d{1,6}:)?[A-Za-z][A-Za-z0-9_-]{0,59}$/;
const UNSEEN = /[[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]--[\u200C\u200D]]/v;
const UNSEEN_VALUE = /[[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]--[\u200C\u200D\n\r\t]]/v;
const normalizeLabel = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[\s:*]+$/u, '');
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new Error('Custom answers must contain plain data.');
}
function list(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))) throw new Error('Custom answer list is invalid or too large.');
}
function string(value, max, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? UNSEEN_VALUE : UNSEEN).test(value)) throw new Error('A custom answer has missing, invalid, or overly long text.');
  return value.trim();
}
function validateCustomFields(input) {
  if (input === undefined) return [];
  list(input, MAX_CUSTOM_FIELDS);
  const ids = new Set();
  return input.map(row => {
    plain(row);
    if (Object.keys(row).some(key => !['id', 'label', 'value', 'aliases'].includes(key)) || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id.toLowerCase())) throw new Error('Each custom answer needs a unique identifier and supported fields.');
    ids.add(row.id.toLowerCase());
    const label = string(row.label, MAX_CUSTOM_LABEL), value = string(row.value, MAX_CUSTOM_VALUE, true);
    const aliases = row.aliases === undefined ? [] : row.aliases;
    list(aliases, MAX_CUSTOM_ALIASES);
    const labels = new Set([normalizeLabel(label)]);
    if (!labels.has('')) {
      return { id: row.id.toLowerCase(), label, value, aliases: aliases.map(alias => {
        const text = string(alias, MAX_CUSTOM_LABEL), normalized = normalizeLabel(text);
        if (!normalized || labels.has(normalized)) throw new Error('Custom answer aliases must be distinct, nonempty labels.');
        labels.add(normalized); return text;
      }) };
    }
    throw new Error('A custom answer needs a question label.');
  });
}
function validateCustomQuestions(input) {
  list(input, MAX_CUSTOM_QUESTIONS);
  if (!input.length) throw new Error('Custom answer requests need at least one question.');
  const ids = new Set();
  for (const field of input) {
    plain(field);
    if (Object.keys(field).some(key => !['id', 'label', 'type', 'options'].includes(key)) || typeof field.id !== 'string' || !QUESTION_ID.test(field.id) || ids.has(field.id) || !CUSTOM_TYPES.includes(field.type)) throw new Error('Custom answer question is invalid.');
    ids.add(field.id); string(field.label, MAX_CUSTOM_LABEL);
    if (!normalizeLabel(field.label)) throw new Error('Custom answer question is invalid.');
    const options = field.options === undefined ? [] : field.options;
    list(options, 30);
    for (const option of options) string(option, MAX_CUSTOM_LABEL);
    if (new Set(options).size !== options.length || (['select', 'radio', 'checkbox'].includes(field.type) ? !options.length : options.length > 0)) throw new Error('Custom answer options are invalid.');
  }
  return input;
}
function unsafeCustomQuestion(field) {
  // Lazy import keeps the schema/iOS storage path independent of model helpers.
  const { unsafeQuestion, OTHER_PERSON_ROLE, MEMBER_DETAIL, CHILD_ROLE, PERSON_DETAIL } = require('./laya-prompts.cjs');
  const words = [field.label, ...(field.options || [])].map(value => normalizeLabel(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' '));
  return unsafeQuestion(field) || words.some(value => OTHER_PERSON_ROLE.test(value) || MEMBER_DETAIL.test(value) || (CHILD_ROLE.test(value) && PERSON_DETAIL.test(value)) ||
    /\b(payment|billing|routing|iban|swift|bank account|bank details|account (number|no|num)|credit|debit|cardholder|card holder|card expiry|card expiration|cvc|cvv|pin|passphrase|security answer|recovery key|recovery phrase|seed phrase|secret key|api key|authentication|verification|captcha)\b/.test(value));
}
function validForType(field, value) {
  if (['select', 'radio', 'checkbox'].includes(field.type)) return field.options.includes(value);
  if (field.type !== 'textarea' && /[\n\r\t]/.test(value)) return false;
  if (field.type === 'number') return /^-?\d+(?:\.\d+)?$/.test(value);
  if (field.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (field.type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (field.type === 'tel') return /^\+?[\d\s().-]{7,30}$/.test(value) && value.replace(/\D/g, '').length >= 7 && value.replace(/\D/g, '').length <= 15;
  return true;
}
function matchCustomFields(records, questions) {
  const saved = validateCustomFields(records);
  validateCustomQuestions(questions);
  const labels = new Map();
  for (const record of saved) {
    const names = [record.label, ...record.aliases];
    // An innocuous alias cannot release an answer saved for a protected question.
    if (names.some(label => unsafeCustomQuestion({ label }))) continue;
    for (const name of names) {
      const key = normalizeLabel(name), candidates = labels.get(key) || new Set();
      candidates.add(record); labels.set(key, candidates);
    }
  }
  const duplicates = new Map();
  for (const field of questions) { const key = normalizeLabel(field.label); duplicates.set(key, (duplicates.get(key) || 0) + 1); }
  const matches = [], values = Object.create(null);
  for (const field of questions) {
    const key = normalizeLabel(field.label), candidates = labels.get(key);
    if (duplicates.get(key) !== 1 || candidates?.size !== 1 || unsafeCustomQuestion(field)) continue;
    const record = [...candidates][0];
    if (!validForType(field, record.value)) continue;
    const projected = { ...values, [field.id]: record.value };
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MAX_CUSTOM_RELEASE_BYTES) continue;
    values[field.id] = record.value;
    matches.push({ id: field.id, label: field.label, value: record.value });
  }
  return { values, matches };
}
module.exports = { MAX_CUSTOM_FIELDS, MAX_CUSTOM_LABEL, MAX_CUSTOM_VALUE, MAX_CUSTOM_ALIASES, MAX_CUSTOM_QUESTIONS, MAX_CUSTOM_RELEASE_BYTES,
  CUSTOM_TYPES, normalizeLabel, validateCustomFields, validateCustomQuestions, unsafeCustomQuestion, matchCustomFields };
