'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Vault, parseEnvelope } = require('../desktop/vault.cjs');
const { validateApplication } = require('../shared/schema.cjs');

const PASSPHRASE = 'test only long local phrase';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-vault-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'vault.secondhand') };
}

test('encrypted vault persists confirmed fields and records without plaintext; locked access fails', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  assert.equal(await vault.exists(), false);
  await vault.create(PASSPHRASE);
  const record = validateApplication({ status: 'draft', notes: 'Synthetic notes only' });
  await vault.update(data => { data.profile = { firstName: 'SYNTHETIC-PRIVATE-NAME' }; data.applications.push(record); });
  const saved = await fs.readFile(file, 'utf8');
  assert.equal(saved.includes('SYNTHETIC-PRIVATE-NAME'), false);
  assert.equal(saved.includes('Synthetic notes'), false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const key = vault.key;
  await vault.lock();
  assert.equal(key.every(byte => byte === 0), true);
  assert.throws(() => vault.getData(), /Unlock/);
  await assert.rejects(vault.update(data => { data.profile = {}; }), /Unlock/);
  const reopened = new Vault(file);
  await reopened.unlock(PASSPHRASE);
  assert.equal(reopened.getData().profile.firstName, 'SYNTHETIC-PRIVATE-NAME');
  assert.deepEqual(reopened.getData().applications[0], record);
  await reopened.lock();
});

test('existing encrypted v1 profiles open with new answers unknown and preserve explicit choices on later saves', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  // Build an authenticated historical payload that predates the added profile
  // fields. Unlocking it must neither infer answers nor rewrite the user's file.
  const originalEnvelope = JSON.parse(await fs.readFile(file, 'utf8'));
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vault.key, nonce);
  cipher.setAAD(Buffer.from('SecondHand encrypted vault v1'));
  const legacy = { version: 1, profile: { firstName: 'Legacy Synthetic', addressLine1: '123 Test Way', state: 'IA' }, applications: [] };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(legacy)), cipher.final()]);
  const legacyBytes = Buffer.from(JSON.stringify({ ...originalEnvelope, iv: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
  await fs.writeFile(file, legacyBytes);
  await vault.lock();
  await vault.unlock(PASSPHRASE);
  const profile = vault.getData().profile;
  assert.equal(profile.firstName, 'Legacy Synthetic');
  assert.equal(profile.addressLine1, '123 Test Way');
  for (const field of ['suffix', 'hasHomeAddress', 'mailingSameAsHome', 'isApplicant', 'programSnap', 'programFip', 'programMedicaid', 'helpPayMedicalBills', 'mailingAddressLine1']) assert.equal(profile[field], '', field);
  assert.deepEqual(await fs.readFile(file), legacyBytes);
  await vault.update(data => { data.profile.programSnap = 'yes'; data.profile.programFip = 'no'; data.profile.mailingSameAsHome = 'no'; data.profile.mailingAddressLine1 = 'PO Box 123'; });
  await vault.lock();
  await vault.unlock(PASSPHRASE);
  assert.equal(vault.getData().profile.programFip, 'no');
  assert.equal(vault.getData().profile.programMedicaid, '');
  assert.equal(vault.getData().profile.mailingAddressLine1, 'PO Box 123');
  assert.equal(vault.getData().profile.addressLine1, '123 Test Way');
  assert.equal((await fs.readFile(file, 'utf8')).includes('Legacy Synthetic'), false);
  await vault.lock();
});

test('wrong passphrase and authenticated ciphertext tampering do not unlock or change persisted bytes', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  await vault.lock();
  const original = await fs.readFile(file);
  await assert.rejects(vault.unlock('a completely different phrase'), /Unable to unlock/);
  assert.equal(vault.unlocked, false);
  assert.deepEqual(await fs.readFile(file), original);
  const envelope = JSON.parse(original);
  const cipher = Buffer.from(envelope.ciphertext, 'base64');
  cipher[0] ^= 1; envelope.ciphertext = cipher.toString('base64');
  await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(vault.unlock(PASSPHRASE), /Unable to unlock/);
  assert.equal(vault.unlocked, false);
  assert.throws(() => vault.getData(), /Unlock/);
});

test('failed validation preserves vault and serial updates do not lose changes', async t => {
  const { directory, file } = await fixture(t);
  const vault = new Vault(file);
  await assert.rejects(vault.create('too short'), /password/);
  await vault.create(PASSPHRASE);
  const before = await fs.readFile(file);
  await assert.rejects(vault.update(data => { data.profile = { websitePassword: 'never store this' }; }), /Unknown profile/);
  assert.deepEqual(await fs.readFile(file), before);
  await Promise.all([
    vault.update(data => { data.profile.firstName = 'Synthetic'; }),
    vault.update(data => { data.profile.lastName = 'Person'; })
  ]);
  assert.equal(vault.getData().profile.firstName, 'Synthetic');
  assert.equal(vault.getData().profile.lastName, 'Person');
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
  await vault.lock();
});

test('import rejects malformed envelopes and preserves encrypted rollback before replacing a locked vault', async t => {
  const { directory, file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  const firstBytes = await fs.readFile(file);
  await assert.rejects(vault.importEncrypted(firstBytes), /Lock/);
  await vault.lock();
  await assert.rejects(vault.importEncrypted(Buffer.from('not a vault')), /Invalid/);
  assert.deepEqual(await fs.readFile(file), firstBytes);
  const other = new Vault(path.join(directory, 'other.secondhand'));
  await other.create('separate synthetic passphrase');
  await other.update(data => { data.profile.firstName = 'Imported'; });
  const importedBytes = await other.readEncrypted();
  await other.lock();
  await vault.importEncrypted(importedBytes);
  const rollback = (await fs.readdir(directory)).find(name => name.includes('.before-import-'));
  assert.ok(rollback);
  assert.deepEqual(await fs.readFile(path.join(directory, rollback)), firstBytes);
  await vault.unlock('separate synthetic passphrase');
  assert.equal(vault.getData().profile.firstName, 'Imported');
  await vault.lock();
});

test('untrusted vault KDF parameters and malformed base64 are rejected before key derivation', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  const envelope = JSON.parse(await vault.readEncrypted());
  assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, N: 1073741824 } }))), /Unsupported/);
  assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify({ ...envelope, salt: 'invalid!!' }))), /Invalid/);
  await vault.lock();
});
