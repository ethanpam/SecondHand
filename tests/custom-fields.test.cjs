'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const custom = require('../shared/custom-fields.cjs');
const schema = require('../shared/schema.cjs');
const { Vault } = require('../desktop/vault.cjs');
const record = (n = 1, changes = {}) => ({ id: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`, label: 'Preferred pickup location', value: 'North entrance', aliases: ['Pickup point'], ...changes });
const question = changes => ({ id: 'field1', label: 'Preferred pickup location', type: 'text', ...changes });

test('custom answers default to an empty local list, validate without mutation, and never become profile request/save fields', () => {
  assert.deepEqual(schema.validateProfile({}).customFields, []);
  const original = { customFields: [record(1, { label: ' Preferred pickup location ', value: ' North entrance ', aliases: [' Pickup point '] })] };
  const before = structuredClone(original), clean = schema.validateProfile(original);
  assert.deepEqual(original, before);
  assert.deepEqual(clean.customFields, [record()]);
  assert.deepEqual(schema.validateStoredProfile(clean).customFields, clean.customFields);
  assert.ok(schema.LIST_FIELDS.includes('customFields'));
  assert.ok(!schema.REQUEST_FIELDS.includes('customFields'));
  assert.ok(!schema.SAVE_FIELDS.includes('customFields'));
  assert.ok(!schema.isRequestField('customFields'));
});

test('custom storage rejects malformed lists, accessors, duplicate IDs, unknown fields and bounded text without reflecting values', () => {
  let reads = 0;
  const accessor = Object.defineProperty(record(), 'value', { get() { reads++; return 'SECRET'; } });
  const sparse = new Array(1), extra = [record()]; extra.extra = 'SECRET';
  for (const input of [null, {}, sparse, extra, [accessor], [record(), record()], [record(1, { id: 'SECRET' })], [record(1, { unknown: 'SECRET' })],
    [record(1, { label: '' })], [record(1, { label: '*:' })], [record(1, { value: '' })], [record(1, { value: 'x'.repeat(1001) })],
    [record(1, { label: 'x'.repeat(121) })], [record(1, { label: 'Hidden\u202Elabel' })], [record(1, { value: 'Invisible\u200Bvalue' })],
    [record(1, { aliases: ['Pickup point', 'pickup POINT:'] })], [record(1, { aliases: ['Preferred pickup location*'] })],
    [record(1, { aliases: new Array(6).fill('alias') })], Array.from({ length: 51 }, (_, n) => record(n))]) {
    assert.throws(() => custom.validateCustomFields(input), error => error instanceof Error && !error.message.includes('SECRET'));
  }
  assert.equal(reads, 0);
  assert.equal(custom.validateCustomFields([record(1, { value: 'First line\nSecond line', aliases: undefined })])[0].value, 'First line\nSecond line');
});

test('whole normalized label or explicit alias matches once; no substring, fuzzy, duplicate-row or repeated-question guesses', () => {
  const records = [record()];
  assert.deepEqual({ ...custom.matchCustomFields(records, [question({ label: ' PREFERRED  PICKUP LOCATION:* ' })]).values }, { field1: 'North entrance' });
  assert.deepEqual({ ...custom.matchCustomFields(records, [question({ label: 'pickup point' })]).values }, { field1: 'North entrance' });
  for (const label of ['Pickup', 'Preferred delivery location', 'Your preferred pickup location']) assert.deepEqual({ ...custom.matchCustomFields(records, [question({ label })]).values }, {});
  assert.deepEqual({ ...custom.matchCustomFields([record(), record(2)], [question()]).values }, {});
  assert.deepEqual({ ...custom.matchCustomFields([record(), record(2, { label: 'Different question', aliases: ['Pickup point'] })], [question({ label: 'Pickup point' })]).values }, {});
  assert.deepEqual({ ...custom.matchCustomFields(records, [question(), question({ id: 'field2', label: 'preferred pickup location:' })]).values }, {});
});

test('protected request labels/options and protected saved aliases never release answers', () => {
  for (const label of ['Password', 'Payment account', 'Routing number', 'Cardholder name', 'Bank details', 'CAPTCHA', 'Verification code', 'I agree', 'Signature', 'SSN', 'Spouse name', 'Child date of birth', 'Emergency contact phone', 'Recovery key', 'Mother’s maiden name']) {
    const saved = [record(1, { label, aliases: [] })];
    assert.deepEqual({ ...custom.matchCustomFields(saved, [question({ label })]).values }, {}, label);
    assert.deepEqual({ ...custom.matchCustomFields([record(1, { aliases: [label] })], [question()]).values }, {}, `unsafe alias: ${label}`);
  }
  assert.deepEqual({ ...custom.matchCustomFields([record(1, { value: 'I agree' })], [question({ type: 'checkbox', options: ['I agree'] })]).values }, {});
});

test('choice answers must equal a shown option and typed controls do not coerce values', () => {
  const match = (value, type, options) => ({ ...custom.matchCustomFields([record(1, { value })], [question({ type, ...(options ? { options } : {}) })]).values });
  assert.deepEqual(match('Yes', 'radio', ['Yes', 'No']), { field1: 'Yes' });
  assert.deepEqual(match('yes', 'radio', ['Yes', 'No']), {});
  assert.deepEqual(match('North entrance', 'select', ['South entrance']), {});
  assert.deepEqual(match('2024-02-29', 'date'), { field1: '2024-02-29' });
  for (const [value, type] of [['2023-02-29', 'date'], ['several', 'number'], ['not an email', 'email'], ['call me', 'tel'], ['First\nSecond', 'text']]) assert.deepEqual(match(value, type), {});
  assert.deepEqual(match('First\nSecond', 'textarea'), { field1: 'First\nSecond' });
});

test('question protocol limits reject metadata carrying values, secrets, invalid IDs or ambiguous options', () => {
  for (const fields of [[], [question({ type: 'password' })], [question({ id: '__proto__' })], [question({ value: 'SECRET' })], [question(), question()],
    [question({ type: 'radio' })], [question({ type: 'text', options: ['option'] })], [question({ type: 'select', options: ['Yes', 'Yes'] })],
    [question({ label: 'x'.repeat(121) })], Array.from({ length: 41 }, (_, n) => question({ id: `field${n}` }))]) {
    assert.throws(() => custom.validateCustomQuestions(fields));
  }
});

test('large Unicode matches fit the native response budget without truncating any answer', () => {
  const records = Array.from({ length: 40 }, (_, n) => record(n, { label: `Question ${n}`, aliases: [], value: '界'.repeat(1000) }));
  const fields = records.map((row, n) => question({ id: `field${n}`, label: row.label }));
  const matched = custom.matchCustomFields(records, fields);
  assert.ok(Object.keys(matched.values).length > 0 && Object.keys(matched.values).length < 40);
  assert.ok(Buffer.byteLength(JSON.stringify(matched.values)) <= custom.MAX_CUSTOM_RELEASE_BYTES);
  for (const value of Object.values(matched.values)) assert.equal(value, '界'.repeat(1000));
});

test('custom answers survive encrypted vault save, reopen and encrypted backup import', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-custom-vault-'));
  try {
    const vault = new Vault(path.join(dir, 'source'));
    await vault.create('synthetic custom passphrase');
    await vault.update(data => { data.profile = schema.validateProfile({ customFields: [record()] }); });
    const encrypted = await fs.readFile(path.join(dir, 'source'));
    assert.ok(!encrypted.toString().includes('North entrance'));
    await vault.lock();
    await vault.unlock('synthetic custom passphrase');
    assert.deepEqual(vault.getData().profile.customFields, [record()]);
    const imported = new Vault(path.join(dir, 'destination'));
    await imported.importEncrypted(encrypted);
    await imported.unlock('synthetic custom passphrase');
    assert.deepEqual(imported.getData().profile.customFields, [record()]);
    await imported.lock(); await vault.lock();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// Remember for next time (#186): an answer the applicant gave on a page becomes a custom answer that also keeps the question's
// type, its choices and the site it was saved from. It matches only the same words, the same kind of question and the same choices.
const PANTRY = 'https://pantry.example.org';
const heard = (changes = {}) => ({ label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer'], answer: 'Church', ...changes });
const fromPage = (n = 1, changes = {}) => record(n, { label: 'How did you hear about us?', value: 'Church', aliases: [], type: 'radio', options: ['Friend', 'Church', 'Flyer'], site: PANTRY, ...changes });
const emplid = (n = 2, changes = {}) => record(n, { label: 'EMPLID', value: 'SYN-4471', aliases: [], type: 'text', options: [], site: PANTRY, ...changes });
const values = (records, fields) => ({ ...custom.matchCustomFields(records, fields).values });

test('an answer saved from a page keeps its type, choices and site; answers without them load exactly as before', () => {
  assert.deepEqual(custom.validateCustomFields([fromPage(), emplid()]), [fromPage(), emplid()]);
  assert.deepEqual(Object.keys(custom.validateCustomFields([record()])[0]).sort(), ['aliases', 'id', 'label', 'value'], 'nothing is added to an answer typed in My information');
  assert.deepEqual(custom.validateCustomFields([fromPage(1, { site: undefined })])[0].site, undefined, 'the site is kept when known');
  for (const changes of [{ options: undefined }, { type: undefined }, { type: 'checkbox' }, { type: 'password' }, { options: [] }, { type: 'text' },
    { options: ['Friend', 'friend!'] }, { value: 'Neighbor' }, { site: 'http://pantry.example.org' }, { site: `${PANTRY}/intake` }, { site: 'https://user@pantry.example.org' },
    { type: 'number', options: [], value: 'twelve' }, { type: 'date', options: [], value: '2026-02-30' }, { type: 'email', options: [], value: 'not an email' }]) {
    assert.throws(() => custom.validateCustomFields([fromPage(1, changes)]), Error, JSON.stringify(changes));
  }
});

test('an answer saved from a page matches only the same words, the same kind of question and the same choices', () => {
  const records = [fromPage(), emplid()];
  assert.deepEqual(values(records, [{ id: 'f1', label: '2. HOW DID YOU HEAR ABOUT US *', type: 'radio', options: ['flyer', 'FRIEND', 'Church!'] }, { id: 'f2', label: 'Emplid:', type: 'text' }]),
    { f1: 'Church!', f2: 'SYN-4471' }, 'case, accents, punctuation, a question number and the order of the choices don’t matter; a choice is the page’s own');
  for (const field of [{ label: 'How did you hear about us?', type: 'select', options: ['Friend', 'Church', 'Flyer'] }, { label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer', 'Other'] },
    { label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church'] }, { label: 'Where did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer'] },
    { label: 'EMPLID', type: 'textarea' }, { label: 'EMPLID number', type: 'text' }]) {
    assert.deepEqual(values(records, [{ id: 'f1', ...field }]), {}, JSON.stringify(field));
  }
  assert.deepEqual(values(records, [{ id: 'f1', label: 'EMPLID', type: 'text' }, { id: 'f2', label: '3. Emplid', type: 'text' }]), {}, 'a question asked twice gets neither');
  assert.deepEqual(values([emplid(), record(3, { label: 'Emplid', aliases: [], value: 'Typed in My information' })], [{ id: 'f1', label: 'EMPLID', type: 'text' }]), {},
    'two answers for one question: neither is a guess worth making');
  assert.deepEqual(values([fromPage(1, { aliases: ['Referral source'] })], [{ id: 'f1', label: 'Referral source', type: 'radio', options: ['Friend', 'Church', 'Flyer'] }]), { f1: 'Church' }, 'an alias works as the question’s words');
  assert.deepEqual(values([record()], [{ id: 'f1', label: 'Pickup point', type: 'textarea' }]), { f1: 'North entrance' }, 'an answer typed in My information matches any kind of box, as before');
});

test('only a question about a sensitive subject is sensitive: identity numbers, birth and age, income and money, health and disability, citizenship, pregnancy', () => {
  for (const label of ['What is your monthly income?', 'Total household earnings', 'How much cash do you have?', 'Do you have health insurance?', 'Are you disabled?',
    'Is anyone in your household blind?', 'Are you a U.S. citizen?', 'Immigration status', 'Your age', 'Year you were born', 'Fecha de nacimiento', 'Ingresos mensuales',
    '¿Tiene seguro médico?', 'Is anyone pregnant?', 'Medicare number', 'Savings']) assert.equal(custom.sensitiveCustomQuestion({ label, options: [] }), true, label);
  for (const label of ['How did you hear about us?', 'EMPLID', 'Pickup location', 'Favorite foods', 'Do you have a pet?', 'Agency name', 'Which page are you on?']) {
    assert.equal(custom.sensitiveCustomQuestion({ label, options: [] }), false, label);
  }
  assert.equal(custom.sensitiveCustomQuestion({ label: 'Which applies to you?', options: ['Veteran', 'Disabled', 'Neither'] }), true, 'a choice can name the subject');
  const matched = custom.matchCustomFields([record(1, { label: 'Monthly income', aliases: [], value: '1200' }), record(2)],
    [{ id: 'f1', label: 'Monthly income', type: 'number' }, { id: 'f2', label: 'Pickup point', type: 'text' }]);
  assert.deepEqual(matched.matches.map(({ id, sensitive }) => ({ id, sensitive })), [{ id: 'f1', sensitive: true }, { id: 'f2', sensitive: false }]);
});

test('an answer to remember from a page is checked, and never one only the applicant answers', () => {
  assert.deepEqual(custom.rememberedAnswer(heard({ label: ' How did you hear about us? ', answer: ' Church ' })),
    { label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer'], value: 'Church' });
  assert.equal(custom.rememberedAnswer(heard({ type: 'textarea', options: [], answer: 'First line\nSecond line' })).value, 'First line\nSecond line');
  for (const [changes, message] of [[{ type: 'checkbox' }, /kind of question/], [{ options: [] }, /choices/], [{ type: 'text' }, /choices/], [{ options: ['Friend', 'friend'] }, /told apart/],
    [{ answer: 'Neighbor' }, /one of its choices/], [{ answer: ' ' }, /answer/], [{ type: 'text', options: [], answer: 'x'.repeat(1001) }, /answer/],
    [{ type: 'text', options: [], answer: 'First\nSecond' }, /answer/], [{ label: 'x'.repeat(121) }, /question/], [{ label: '?!' }, /question/],
    [{ type: 'email', options: [], answer: 'not an email' }, /fit/], [{ label: 'Signature' }, /never remembers/], [{ label: 'Enter the code we texted you' }, /never remembers/],
    [{ label: 'Password' }, /never remembers/], [{ label: 'Bank account number', type: 'text', options: [], answer: '123' }, /never remembers/],
    [{ label: 'Spouse name', type: 'text', options: [], answer: 'Sam' }, /never remembers/]]) {
    assert.throws(() => custom.rememberedAnswer(heard(changes)), message, JSON.stringify(changes));
  }
});

test('remembering adds a custom answer for each question, or changes the one already saved from a page; at most 50 are kept', () => {
  const entries = answers => answers.map(custom.rememberedAnswer);
  const [added] = custom.rememberAnswers([record()], entries([heard()]), PANTRY).slice(1);
  assert.match(added.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual({ ...added, id: undefined }, { id: undefined, label: 'How did you hear about us?', value: 'Church', aliases: [], type: 'radio', options: ['Friend', 'Church', 'Flyer'], site: PANTRY });
  const again = custom.rememberAnswers([record(), added], entries([heard({ label: '1. how did you hear about us', options: ['Flyer', 'Friend', 'Church'], answer: 'Flyer' })]), 'https://wic.example.org');
  assert.deepEqual(again, [record(), { ...added, label: '1. how did you hear about us', options: ['Flyer', 'Friend', 'Church'], value: 'Flyer' }], 'the site it was first saved from stays');
  assert.throws(() => custom.rememberAnswers([record(1, { label: 'How did you hear about us?', aliases: [] })], entries([heard()]), PANTRY), /already have a custom answer/,
    'an answer typed in My information is never replaced from a page');
  assert.throws(() => custom.rememberAnswers([], entries([heard(), heard({ label: 'how did you hear about us' })]), PANTRY), /more than once/);
  assert.throws(() => custom.rememberAnswers([], entries([heard()]), 'http://pantry.example.org'), /site/);
  const full = Array.from({ length: 50 }, (_, n) => record(n, { label: `Question ${n}`, aliases: [] }));
  assert.throws(() => custom.rememberAnswers(full, entries([heard()]), PANTRY), /50 custom answers/);
  assert.equal(custom.rememberAnswers([...full.slice(1), { ...added }], entries([heard({ answer: 'Friend' })]), PANTRY).at(-1).value, 'Friend', 'a full list still changes an answer it has');
});
