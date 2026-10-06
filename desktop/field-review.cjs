'use strict';

// This optional experiment reuses Laya's trained label-matching task. It does
// not ask the form model to fact-check OCR or a person's answers. No profile or
// document VALUES enter a model request, and a model result can only add a
// warning to the independent deterministic review.
const { PROFILE_FIELDS, MAX_MEMBERS } = require('../shared/schema.cjs');
const { reviewProfile, reviewDocumentFields } = require('../shared/field-review.cjs');
const { QUESTIONS, CHOICE, MATCH_CANDIDATES, matchState, offeredFields, matchableBox, unsafeQuestion } = require('../shared/laya-prompts.cjs');

const LIMITS = Object.freeze({ documents: 150, modelLabels: 12, budgetMs: 3000, profileValue: 500, documentValue: 500, label: 150, id: 80 });
const REQUEST_KEYS = ['profile', 'documentFields', 'useLaya'];
const MEMBER_FIELDS = ['id', 'firstName', 'lastName', 'birthDate', 'relationship', 'student', 'grade'];
const DOCUMENT_KEYS = ['id', 'label', 'value', 'profileKey', 'page', 'confidence', 'sourceLabel', 'sourceRole'];
const MODEL_KEYS = new Set(MATCH_CANDIDATES.filter(key => PROFILE_FIELDS.includes(key)));
const ADDRESS_KEYS = new Set(['addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county']);
const SOURCE_ROLES = new Set(['applicant', 'spouse', 'document']);
const NO_MODEL = 'Not checked by Laya. Review the value and its source yourself.';
const LABEL_ONLY = 'Laya checked this source label only; the value and applicant identity still need your review.';
const UNCERTAIN = 'Laya could not map this source label reliably. Review the label and value in the original document.';
const MISMATCH = 'Experimental Laya label check suggests a different kind of saved field. Check the original document; no value was changed.';
const PROFILE_SCOPE = ' Profile values are not checked by Laya.';
const invalid = () => { throw new TypeError('The field review request is invalid or too large.'); };

// Treat even local renderer input as data. Never execute accessors or copy
// prototype keys into a prompt/result, and reject secrets supplied as new keys.
function plain(input, allowed) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value'))) invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function boundedString(value, max) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) invalid();
  return value;
}
function list(input, max) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > max) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || !Object.hasOwn(descriptors[key], 'value')))) invalid();
  // Sparse arrays are not a list of reviewable records.
  if (Object.keys(input).length !== input.length) invalid();
  return Array.from({ length: input.length }, (_, index) => descriptors[index].value);
}
function validateRequest(request) {
  const source = plain(request, REQUEST_KEYS);
  if (source.useLaya !== undefined && typeof source.useLaya !== 'boolean') invalid();
  const profile = plain(source.profile === undefined ? {} : source.profile, PROFILE_FIELDS);
  for (const key of Object.keys(profile)) {
    if (key === 'householdMembers') {
      profile[key] = list(profile[key], MAX_MEMBERS).map(member => {
        const row = plain(member, MEMBER_FIELDS);
        for (const name of Object.keys(row)) row[name] = boundedString(row[name], LIMITS.profileValue);
        return row;
      });
    } else profile[key] = boundedString(profile[key], LIMITS.profileValue);
  }
  const ids = new Set();
  const documentFields = list(source.documentFields === undefined ? [] : source.documentFields, LIMITS.documents).map((field, index) => {
    const row = plain(field, DOCUMENT_KEYS);
    for (const key of ['label', 'sourceLabel']) if (row[key] !== undefined) boundedString(row[key], LIMITS.label);
    if (row.value !== undefined) boundedString(row.value, LIMITS.documentValue);
    if (row.id !== undefined && (typeof row.id !== 'string' || row.id.length > LIMITS.id || !/^[A-Za-z0-9_.:-]+$/.test(row.id))) invalid();
    const id = row.id ?? `document-${index}`;
    if (ids.has(id)) invalid();
    ids.add(id);
    if (row.profileKey !== undefined && (!PROFILE_FIELDS.includes(row.profileKey) || row.profileKey === 'householdMembers')) invalid();
    if (row.page !== undefined && (!Number.isInteger(row.page) || row.page < 1 || row.page > 12)) invalid();
    if (row.confidence !== undefined && (typeof row.confidence !== 'number' || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 100)) invalid();
    if (row.sourceRole !== undefined && !SOURCE_ROLES.has(row.sourceRole)) invalid();
    return row;
  });
  return { profile, documentFields, useLaya: source.useLaya === true };
}

function modelLabel(field) {
  if (!MODEL_KEYS.has(field.profileKey) || !field.value?.trim() ||
      !(field.sourceRole === 'applicant' || (field.sourceRole === 'document' && ADDRESS_KEYS.has(field.profileKey)))) return null;
  const label = field.sourceLabel?.trim();
  // Source labels are untrusted. Digits are unnecessary for the supported
  // identity/address labels and could be an SSN embedded in mislabeled text.
  // Reject role/control syntax as well as credential/signature questions. The
  // model never has an instruction-following or mutation capability here.
  if (!label || /[^\p{L}\p{M} \t.,:;?'’()\/-]/u.test(label) ||
      /\b(system|assistant|developer|instructions?|ignore|override|prompt|output|respond|password|passphrase|secret|token|recovery|credentials?|api key)\b/i.test(label) ||
      unsafeQuestion({ label }) || !matchableBox({ label })) return null;
  // A source cell split intentionally into multiple fields cannot be checked
  // as if it were a single form box (the IRS first-name/middle-initial cell).
  if (/\bfirst\b.*\b(middle|initial|last)\b|\b(given|forename)\b.*\b(surname|family name)\b|\bcity\b.*\b(state|zip|postal)\b/i.test(label)) return null;
  return label;
}
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
function scoresFor(results, items, format) {
  if (!Array.isArray(results) || results.length !== items.length) throw new Error('Invalid model output.');
  return results.map((result, index) => {
    if (format === 'noul-v1') {
      const answer = result?.answers?.correct;
      if (answer?.type !== 'noul' || !probability(answer.noul)) throw new Error('Invalid model output.');
      return answer.noul;
    }
    const answer = result?.answers?.choice, labels = items[index].questions.choice.criteria;
    if (answer?.type !== 'choice' || !answer.probabilities || Object.keys(answer.probabilities).length !== labels.length) throw new Error('Invalid model output.');
    const values = labels.map(label => answer.probabilities[label]);
    if (!values.every(probability)) throw new Error('Invalid model output.');
    return values;
  });
}

// These are intentionally only a conservative experimental warning trigger.
// They are NOT calibrated OCR-accuracy bars and never produce an approval or
// user-facing confidence number. Ambiguous/abstaining results add no assertion.
function suspiciousMatch(scores, keys, assigned) {
  const sorted = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
  const [best, runner] = sorted;
  if (best.score < 0.9 || best.score - (runner?.score ?? 0) < 0.5 || best.index === keys.length) return null;
  return keys[best.index] !== assigned;
}
const copyRows = rows => rows.map(row => ({ ...row, messages: [...row.messages] }));
function createFieldReview({ laya, now = Date.now, budgetMs = LIMITS.budgetMs } = {}) {
  if (typeof now !== 'function' || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > LIMITS.budgetMs) throw new TypeError('Invalid field review budget.');
  async function review(request, { today, isCurrent = () => true } = {}) {
    const input = validateRequest(request);
    const profileRules = reviewProfile(input.profile, { today });
    const documentRules = reviewDocumentFields(input.documentFields, input.profile, { today });
    const result = { profile: copyRows(profileRules), document: copyRows(documentRules), laya: { state: 'off', message: 'Laya was not requested. Rule checks only.' } };
    if (!input.useLaya) return result;
    let reviewed = 0;
    const checked = new Set();
    const finish = (state, detail) => {
      for (let index = 0; index < result.document.length; index++) {
        if (!checked.has(index)) result.document[index].messages.push(NO_MODEL);
      }
      result.laya = { state, message: `${detail} Laya checked ${reviewed} of ${input.documentFields.length} document field labels only; ${input.documentFields.length - reviewed} were not checked. Values and identity still need your review.${PROFILE_SCOPE}` };
      return result;
    };
    const current = () => typeof isCurrent === 'function' && isCurrent() === true;
    const cancelled = () => ({ profile: copyRows(profileRules), document: copyRows(documentRules), laya: { state: 'cancelled', message: 'Laya review was cancelled. No model results were retained.' } });
    if (!current()) return cancelled();
    const eligible = input.documentFields.map((field, index) => ({ index, label: modelLabel(field), key: field.profileKey })).filter(field => field.label);
    if (!eligible.length) return finish('unsupported', input.documentFields.length ? 'No supported applicant source labels were available for the experimental check.' : 'Laya has no document labels to check.');
    if (!laya || !['status', 'format', 'decideBatch'].every(key => typeof laya[key] === 'function')) return finish('unavailable', 'The local Laya model is unavailable. Rule checks are unchanged.');

    const deadline = now() + budgetMs;
    const left = () => Math.max(0, Math.min(budgetMs, Math.floor(deadline - now())));
    const timeout = () => Object.assign(new Error('Field label review timed out.'), { code: 'LAYA_TIMEOUT' });
    async function bounded(work) {
      if (!current()) throw Object.assign(new Error('Cancelled.'), { code: 'REVIEW_CANCELLED' });
      const remaining = left();
      if (remaining < 1) throw timeout();
      let timer;
      try {
        const value = await Promise.race([Promise.resolve().then(() => work(remaining)), new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), remaining); })]);
        if (!current()) throw Object.assign(new Error('Cancelled.'), { code: 'REVIEW_CANCELLED' });
        if (!left()) throw timeout();
        return value;
      } finally { clearTimeout(timer); }
    }
    const found = (field, scores, keys) => {
      const mismatch = suspiciousMatch(scores, keys, field.key);
      const row = result.document[field.index];
      if (mismatch === true) row.status = 'needs-review';
      row.messages.push(mismatch === true ? MISMATCH : mismatch === false ? LABEL_ONLY : UNCERTAIN);
      checked.add(field.index);
      reviewed++;
    };
    try {
      const status = await bounded(() => laya.status());
      if (status?.state !== 'ready' || status?.enabled !== true) return finish('unavailable', 'Laya is off, unavailable, or not downloaded. Rule checks are unchanged; this review does not download a model.');
      const format = await bounded(() => laya.format());
      if (!['noul-v1', 'choice-v2'].includes(format)) return finish('unsupported', 'This Laya model format is not supported for the experimental label check.');
      const selected = eligible.slice(0, LIMITS.modelLabels);
      if (format === 'noul-v1') {
        for (const field of selected) {
          const keys = offeredFields({ label: field.label, type: 'text' });
          const items = [...keys, null].map(key => ({ state: matchState(field.label, key), questions: QUESTIONS }));
          const output = await bounded(timeoutMs => laya.decideBatch(items, { format, timeoutMs }));
          found(field, scoresFor(output, items, format), keys);
        }
      } else {
        const keys = CHOICE.MATCH_SETS.text;
        for (let start = 0; start < selected.length; start += 8) {
          const chunk = selected.slice(start, start + 8);
          const items = chunk.map(field => ({ state: CHOICE.matchState(field.label, 'text'), questions: { choice: CHOICE.matchQuestion(keys) } }));
          const output = await bounded(timeoutMs => laya.decideBatch(items, { format, timeoutMs }));
          const scores = scoresFor(output, items, format);
          chunk.forEach((field, index) => found(field, scores[index], keys));
        }
      }
      return finish(reviewed === input.documentFields.length ? 'complete' : 'partial', 'Experimental label check finished.');
    } catch (error) {
      if (!current() || error?.code === 'REVIEW_CANCELLED') return cancelled();
      return finish(error?.code === 'LAYA_TIMEOUT' ? 'partial' : 'error', error?.code === 'LAYA_TIMEOUT'
        ? 'The short local-model time limit was reached. Rule checks and earlier label warnings remain.'
        : 'The local model could not finish the label check. Rule checks and earlier label warnings remain.');
    }
  }
  return Object.freeze({ review });
}

module.exports = { createFieldReview, LIMITS };
