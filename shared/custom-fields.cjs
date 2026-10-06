'use strict';
// Applicant-authored reusable answers. Storage is independent of the model;
// release uses exact labels only, and never returns the saved catalog.
// An answer saved from a page with Remember for next time (#186) also keeps the question's type, its choices and the
// site it came from, and matches only the same words, the same kind of question and the same choices.
const { randomUUID } = require('node:crypto');
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
// Remember for next time (#186): the questions an answer may be saved from, a question's words, and its choices as a set.
// A checkbox group can hold several answers and a lone checkbox is often consent, so neither is remembered.
const REMEMBER_TYPES = Object.freeze(['text', 'textarea', 'number', 'date', 'email', 'tel', 'radio', 'select']);
const CHOICE_TYPES = Object.freeze(['radio', 'select']);
// Words in any script, lowercase, without accents or punctuation.
const words = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[‘’']/g, '').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
// A question number or letter the author added ("3.", "b)") and a trailing "required" or "optional" are not the question.
const QUESTION_NUMBER = /^\s*(\d{1,3}\s*[.)]|[a-z][.)](?=\s))\s*/i;
const questionWords = label => words(String(label).replace(QUESTION_NUMBER, '')).replace(/ (required|optional)$/, '');
// The choices' words in a fixed order; null when two can't be told apart or one has none.
function choiceSet(options) {
  const set = options.map(words);
  return set.some(option => !option) || new Set(set).size !== set.length ? null : set.sort();
}
const sameChoices = (a, b) => { const first = choiceSet(a), second = choiceSet(b); return Boolean(first && second) && first.join('\n') === second.join('\n'); };
// Subjects treated as sensitive on every site but Iowa's, as SENSITIVE_FIELDS in desktop/main.cjs treats saved fields: identity
// numbers, birth and age, income and money, health, disability and pregnancy, and citizenship and immigration, in English and Spanish.
const SENSITIVE_SUBJECT = /\b(social security|ssn|itin|seguro social|birth\w*|born|dob|nacimiento|ages?|edad(es)?|incomes?|ingresos?|earn\w*|wages?|salar\w*|paychecks?|money|dinero|cash|efectivo|savings?|ahorros?|banks?|banco|checking account|assets?|medic\w*|health\w*|salud|disab\w*|discapacidad\w*|blind\w*|ciegos?|ciegas?|pregnan\w*|embarazad\w*|citizen\w*|ciudadan\w*|immigra\w*|inmigra\w*|undocumented|green card|visas?|aliens?|refugees?|refugiad\w*|asylum|asilo|naturaliz\w*|legal status)\b/;
const sensitiveCustomQuestion = ({ label, options }) => [label, ...(options || [])].some(text => SENSITIVE_SUBJECT.test(words(text)));
// The site an answer was saved from: an https origin, nothing more.
function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.origin === value;
  } catch { return false; }
}
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
    if (Object.keys(row).some(key => !['id', 'label', 'value', 'aliases', 'type', 'options', 'site'].includes(key)) || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id.toLowerCase())) throw new Error('Each custom answer needs a unique identifier and supported fields.');
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
      }), ...savedFrom(row, value) };
    }
    throw new Error('A custom answer needs a question label.');
  });
}
// An answer saved from a page (#186): its question's type and choices, which go together, and the site it came from
// when known. An answer typed in My information has none of them.
function savedFrom(row, value) {
  const kept = {};
  if (row.type !== undefined || row.options !== undefined) {
    if (!REMEMBER_TYPES.includes(row.type)) throw new Error('A custom answer saved from a form has an unsupported kind of question.');
    list(row.options, 30);
    const options = row.options.map(option => string(option, MAX_CUSTOM_LABEL));
    if ((CHOICE_TYPES.includes(row.type) ? !options.length : options.length) || !choiceSet(options)) throw new Error('A custom answer saved from a form has invalid choices.');
    if (!validForType({ type: row.type, options }, value)) throw new Error('A custom answer saved from a form doesn’t fit its question.');
    Object.assign(kept, { type: row.type, options });
  }
  if (row.site !== undefined) {
    if (typeof row.site !== 'string' || !httpsOrigin(row.site)) throw new Error('A custom answer’s site is invalid.');
    kept.site = row.site;
  }
  return kept;
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
const namesOf = record => [record.label, ...record.aliases];
// Whether `record` answers the page's `field`: an answer saved from a page by the same words, the same kind of question and
// the same choices; one typed in My information by its whole label or an alias, as #209 matches it.
function answers(record, field) {
  if (record.type === undefined) return namesOf(record).some(name => normalizeLabel(name) === normalizeLabel(field.label));
  const asked = questionWords(field.label);
  return record.type === field.type && sameChoices(record.options, field.options || []) && Boolean(asked) && namesOf(record).some(name => questionWords(name) === asked);
}
function matchCustomFields(records, questions) {
  const saved = validateCustomFields(records);
  validateCustomQuestions(questions);
  // An innocuous alias cannot release an answer saved for a protected question.
  const usable = saved.filter(record => !namesOf(record).some(label => unsafeCustomQuestion({ label })));
  const duplicates = new Map();
  for (const field of questions) { const key = normalizeLabel(field.label); duplicates.set(key, (duplicates.get(key) || 0) + 1); }
  const candidates = questions.map(field => usable.filter(record => answers(record, field)));
  // An answer saved from a page goes to one question only: one it would answer twice answers neither.
  const uses = new Map();
  for (const found of candidates) for (const record of found) if (record.type !== undefined) uses.set(record, (uses.get(record) || 0) + 1);
  const matches = [], values = Object.create(null);
  for (const [index, field] of questions.entries()) {
    const found = candidates[index];
    if (duplicates.get(normalizeLabel(field.label)) !== 1 || found.length !== 1 || unsafeCustomQuestion(field) || (found[0].type !== undefined && uses.get(found[0]) !== 1)) continue;
    const record = found[0];
    // A choice saved from a page is the page's own option with the same words.
    const value = record.type !== undefined && CHOICE_TYPES.includes(record.type) ? field.options.find(option => words(option) === words(record.value)) : record.value;
    if (value === undefined || !validForType(field, value)) continue;
    const projected = { ...values, [field.id]: value };
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MAX_CUSTOM_RELEASE_BYTES) continue;
    values[field.id] = value;
    matches.push({ id: field.id, label: field.label, value, sensitive: sensitiveCustomQuestion(field) });
  }
  return { values, matches };
}

// Remember for next time (#186): an answer the applicant gave on a page, { label, type, options, answer } in, checked, and
// { label, type, options, value } out. Never for a question only the applicant answers, or one no custom answer may fill.
function rememberedAnswer({ label, type, options, answer }) {
  if (!REMEMBER_TYPES.includes(type)) throw new Error('SecondHand can’t remember an answer to this kind of question.');
  if (typeof label !== 'string' || !label.trim() || label.trim().length > MAX_CUSTOM_LABEL || UNSEEN.test(label) || !questionWords(label)) throw new Error('This question is too long to remember, or has no words SecondHand can match.');
  if (!Array.isArray(options) || options.length > 30 || options.some(option => typeof option !== 'string' || !option.trim() || option.length > MAX_CUSTOM_LABEL || UNSEEN.test(option)) ||
    (CHOICE_TYPES.includes(type) ? !options.length : options.length)) throw new Error('This question’s choices don’t fit it.');
  const choices = options.map(option => option.trim());
  if (!choiceSet(choices)) throw new Error('This question’s choices can’t be told apart.');
  const asked = { label: label.trim(), type, options: choices };
  if (unsafeCustomQuestion(asked)) throw new Error('SecondHand never remembers answers to signatures, passwords, codes, consent, payment details, or another person’s details.');
  if (typeof answer !== 'string' || !answer.trim() || answer.length > MAX_CUSTOM_VALUE || (type === 'textarea' ? UNSEEN_VALUE : UNSEEN).test(answer)) throw new Error('Enter an answer of up to 1,000 characters.');
  const value = answer.trim();
  if (CHOICE_TYPES.includes(type) && !choices.includes(value)) throw new Error('The answer must be one of its choices.');
  if (!validForType(asked, value)) throw new Error('This answer doesn’t fit its question.');
  return { ...asked, value };
}
// `entries` (from rememberedAnswer) added to the custom answers `records`, from `site`'s page. One already saved from a page
// for the same question takes the new answer and keeps the site it was first saved from. One typed in My information is
// never replaced from a page. A new list; `records` are unchanged.
function rememberAnswers(records, entries, site) {
  if (typeof site !== 'string' || !httpsOrigin(site)) throw new Error('Remembered answers come only from an https site.');
  const keys = entries.map(entry => JSON.stringify([entry.type, questionWords(entry.label), choiceSet(entry.options)]));
  if (new Set(keys).size !== keys.length) throw new Error('A question is asked more than once here. Remember one answer for it.');
  const result = validateCustomFields(records).map(record => ({ ...record }));
  for (const entry of entries) {
    const found = result.filter(record => answers(record, entry));
    if (found.some(record => record.type === undefined)) throw new Error(`You already have a custom answer for “${entry.label}”. Change it in My information.`);
    if (found.length > 1) throw new Error(`More than one custom answer is for “${entry.label}”. Remove the extra ones in My information.`);
    if (found.length) { Object.assign(found[0], { label: entry.label, options: [...entry.options], value: entry.value }); continue; }
    if (result.length >= MAX_CUSTOM_FIELDS) throw new Error(`You have ${MAX_CUSTOM_FIELDS} custom answers, the most SecondHand keeps. Remove one in My information, then remember this answer again.`);
    result.push({ id: randomUUID(), label: entry.label, value: entry.value, aliases: [], type: entry.type, options: [...entry.options], site });
  }
  return validateCustomFields(result);
}
module.exports = { MAX_CUSTOM_FIELDS, MAX_CUSTOM_LABEL, MAX_CUSTOM_VALUE, MAX_CUSTOM_ALIASES, MAX_CUSTOM_QUESTIONS, MAX_CUSTOM_RELEASE_BYTES,
  CUSTOM_TYPES, REMEMBER_TYPES, CHOICE_TYPES, normalizeLabel, questionWords, validateCustomFields, validateCustomQuestions, unsafeCustomQuestion, sensitiveCustomQuestion,
  matchCustomFields, rememberedAnswer, rememberAnswers };
