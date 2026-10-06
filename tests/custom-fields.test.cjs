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
