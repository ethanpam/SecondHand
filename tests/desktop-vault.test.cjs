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

// Writes a historical version 1 file: contents encrypted directly with the
// password-derived key and no key slots.
async function writeLegacyVault(file, passphrase, contents) {
  const salt = crypto.randomBytes(32);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('SecondHand encrypted vault v1'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(contents)), cipher.final()]);
  const bytes = Buffer.from(JSON.stringify({ version: 1, cipher: 'aes-256-gcm', kdf: { name: 'scrypt', N: 32768, r: 8, p: 1 },
    salt: salt.toString('base64'), iv: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
  await fs.writeFile(file, bytes);
  return bytes;
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
  // Build an authenticated historical payload that predates the added profile
  // fields. Unlocking it must neither infer answers nor rewrite the user's file.
  const legacy = { version: 1, profile: { firstName: 'Legacy Synthetic', addressLine1: '123 Test Way', state: 'IA' }, applications: [] };
  const legacyBytes = await writeLegacyVault(file, PASSPHRASE, legacy);
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

test('erasing while locked deletes the vault and its restore copies, keeps other files, and allows a new password', async t => {
  const { directory, file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  await vault.update(data => { data.profile.firstName = 'Forgotten'; });
  await assert.rejects(vault.erase(), /Lock/);
  assert.equal(await vault.exists(), true, 'An unlocked vault is never erased');
  await vault.lock();
  // A copy kept by an earlier restore, an interrupted write, and files that are not the vault's.
  await fs.writeFile(`${file}.before-import-1-abcd1234`, 'encrypted copy');
  await fs.writeFile(`${file}.0123456789abcdef01234567.tmp`, 'partial write');
  await fs.writeFile(path.join(directory, 'settings.json'), '{}');
  await fs.writeFile(path.join(directory, 'other.secondhand'), 'unrelated');
  await vault.erase();
  assert.equal(await vault.exists(), false);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['other.secondhand', 'settings.json']);
  await assert.rejects(vault.unlock(PASSPHRASE));
  await vault.create('a brand new password');
  assert.deepEqual(vault.getData().profile, {});
  await vault.lock();
  await vault.unlock('a brand new password');
  await vault.lock();
  await new Vault(path.join(directory, 'missing', 'vault.secondhand')).erase();
});

test('untrusted vault KDF parameters and malformed base64 are rejected before key derivation', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  const envelope = JSON.parse(await vault.readEncrypted());
  assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, N: 1073741824 } }))), /Unsupported/);
  assert.throws(() => parseEnvelope(Buffer.from(JSON.stringify({ ...envelope, slots: { ...envelope.slots, password: { ...envelope.slots.password, salt: 'invalid!!' } } }))), /Invalid/);
  await vault.lock();
});

test('a new password comes with a recovery key that can set a new password and keeps saved information', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  const { recoveryKey } = await vault.create(PASSPHRASE);
  assert.match(recoveryKey, /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
  await vault.update(data => { data.profile = { firstName: 'Recovered Synthetic' }; });
  await vault.lock();
  assert.equal((await fs.readFile(file, 'utf8')).includes(recoveryKey.replace(/-/g, '')), false);
  assert.deepEqual(await new Vault(file).inspect(), { recoveryKey: true, deviceReset: false });

  const before = await fs.readFile(file);
  await assert.rejects(vault.resetWithRecoveryKey('0000-0000-0000-0000-0000-0000-0000-0000', 'a brand new password'), /didn’t work/);
  await assert.rejects(vault.resetWithRecoveryKey('not a key', 'a brand new password'), /exactly as it was shown/);
  await assert.rejects(vault.resetWithRecoveryKey(recoveryKey, 'short'), /at least 12/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal(vault.unlocked, false);

  // Handwritten keys are accepted in lowercase, with spaces, and with O/I/L look-alikes.
  const typed = recoveryKey.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  await vault.resetWithRecoveryKey(typed, 'a brand new password');
  assert.equal(vault.getData().profile.firstName, 'Recovered Synthetic');
  await vault.lock();
  await assert.rejects(vault.unlock(PASSPHRASE), /Unable to unlock/);
  await vault.unlock('a brand new password');
  assert.equal(vault.getData().profile.firstName, 'Recovered Synthetic');
  await vault.lock();
  await vault.resetWithRecoveryKey(recoveryKey, 'the recovery key still works');
  await vault.lock();
});

test('a version 1 file gains a recovery key without changing its password, and replacing a key retires the old one', async t => {
  const { file } = await fixture(t);
  await writeLegacyVault(file, PASSPHRASE, { version: 1, profile: { firstName: 'Legacy Synthetic' }, applications: [] });
  const vault = new Vault(file);
  assert.deepEqual(await vault.inspect(), { recoveryKey: false, deviceReset: false });
  await assert.rejects(vault.resetWithRecoveryKey('0000-0000-0000-0000-0000-0000-0000-0000', 'a brand new password'), /no recovery key/);
  await vault.unlock(PASSPHRASE);
  const legacyKey = vault.key;
  const first = await vault.replaceRecoveryKey();
  assert.equal(legacyKey.every(byte => byte === 0), true);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
  assert.equal(vault.getData().profile.firstName, 'Legacy Synthetic');
  await vault.lock();
  await vault.unlock(PASSPHRASE);
  const second = await vault.replaceRecoveryKey();
  assert.notEqual(first, second);
  await vault.lock();
  await assert.rejects(vault.resetWithRecoveryKey(first, 'a brand new password'), /didn’t work/);
  await vault.resetWithRecoveryKey(second, 'a brand new password');
  assert.equal(vault.getData().profile.firstName, 'Legacy Synthetic');
  await vault.lock();
  await assert.rejects(vault.replaceRecoveryKey(), /Unlock/);
});

test('version 2 envelopes require a password slot and reject unknown or malformed slots', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  await vault.lock();
  const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
  const variant = slots => Buffer.from(JSON.stringify({ ...envelope, slots }));
  assert.throws(() => parseEnvelope(variant({ recovery: envelope.slots.recovery })), /Unsupported/);
  assert.throws(() => parseEnvelope(variant({ ...envelope.slots, extra: envelope.slots.recovery })), /Unsupported/);
  assert.throws(() => parseEnvelope(variant({ ...envelope.slots, recovery: { ...envelope.slots.recovery, key: 'AAAA' } })), /Invalid/);
  const swapped = variant({ password: envelope.slots.recovery, recovery: envelope.slots.password });
  await fs.writeFile(file, swapped);
  await assert.rejects(vault.unlock(PASSPHRASE), /Unable to unlock/);
});

test('this computer’s secret can reset the password only while its slot is enabled and matching', async t => {
  const { file } = await fixture(t);
  const deviceSecret = crypto.randomBytes(32);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE, { deviceSecret });
  await vault.update(data => { data.profile = { firstName: 'Device Synthetic' }; });
  await vault.lock();
  assert.deepEqual(await vault.inspect(), { recoveryKey: true, deviceReset: true });
  assert.equal((await fs.readFile(file, 'utf8')).includes(deviceSecret.toString('base64')), false);

  const before = await fs.readFile(file);
  await assert.rejects(vault.resetWithDeviceSecret(crypto.randomBytes(32), 'a brand new password'), /can’t reset/);
  await assert.rejects(vault.resetWithDeviceSecret(Buffer.alloc(8), 'a brand new password'), /can’t reset/);
  await assert.rejects(vault.resetWithDeviceSecret(deviceSecret, 'short'), /at least 12/);
  assert.deepEqual(await fs.readFile(file), before);

  await vault.resetWithDeviceSecret(deviceSecret, 'a brand new password');
  assert.equal(vault.getData().profile.firstName, 'Device Synthetic');
  await vault.setDeviceSecret(null);
  await vault.lock();
  assert.deepEqual(await vault.inspect(), { recoveryKey: true, deviceReset: false });
  await assert.rejects(vault.resetWithDeviceSecret(deviceSecret, 'another new password'), /isn’t set up/);
  await vault.unlock('a brand new password');
  await vault.lock();
});

test('turning on reset for this computer upgrades a version 1 file and keeps its password', async t => {
  const { file } = await fixture(t);
  await writeLegacyVault(file, PASSPHRASE, { version: 1, profile: { firstName: 'Legacy Synthetic' }, applications: [] });
  const deviceSecret = crypto.randomBytes(32);
  const vault = new Vault(file);
  await vault.unlock(PASSPHRASE);
  await vault.setDeviceSecret(deviceSecret);
  await vault.lock();
  assert.deepEqual(await vault.inspect(), { recoveryKey: false, deviceReset: true });
  await vault.unlock(PASSPHRASE);
  await vault.lock();
  await vault.resetWithDeviceSecret(deviceSecret, 'a brand new password');
  assert.equal(vault.getData().profile.firstName, 'Legacy Synthetic');
  await vault.lock();
});

// The Touch ID slot (#99): the data key wrapped by a random key that main.cjs seals in the Keychain.
const slotsOf = async file => JSON.parse(await fs.readFile(file, 'utf8')).slots;

test('a Touch ID key opens the information through its own slot only, and removing the slot leaves the others unchanged', async t => {
  const { file } = await fixture(t);
  const deviceSecret = crypto.randomBytes(32);
  const touchIdKey = crypto.randomBytes(32);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE, { deviceSecret });
  await vault.update(data => { data.profile = { firstName: 'Touch Synthetic' }; });
  const before = await slotsOf(file);
  assert.equal(vault.hasTouchIdSlot, false);
  await vault.setTouchIdKey(touchIdKey);
  assert.equal(vault.hasTouchIdSlot, true);
  const withTouchId = await slotsOf(file);
  assert.deepEqual(Object.keys(withTouchId).sort(), ['device', 'password', 'recovery', 'touchId']);
  for (const name of ['password', 'recovery', 'device']) assert.deepEqual(withTouchId[name], before[name], `${name} slot unchanged`);
  assert.equal((await fs.readFile(file, 'utf8')).includes(touchIdKey.toString('base64')), false);
  await vault.lock();

  const locked = await fs.readFile(file);
  await assert.rejects(vault.unlockWithTouchIdKey(crypto.randomBytes(32)), error => error.code === 'TOUCH_ID_KEY' && /Touch ID key doesn’t open/.test(error.message));
  await assert.rejects(vault.unlockWithTouchIdKey(Buffer.alloc(8)), error => error.code === 'TOUCH_ID_KEY');
  await assert.rejects(vault.unlockWithTouchIdKey(null), error => error.code === 'TOUCH_ID_KEY');
  assert.equal(vault.unlocked, false);
  assert.deepEqual(await fs.readFile(file), locked, 'a failed Touch ID unlock changes nothing');
  // A Touch ID key can't stand in for this computer's reset secret: each slot is bound to its name.
  await assert.rejects(vault.resetWithDeviceSecret(touchIdKey, 'a brand new password'), /can’t reset/);

  await vault.unlockWithTouchIdKey(touchIdKey);
  assert.equal(vault.getData().profile.firstName, 'Touch Synthetic');
  await assert.rejects(vault.unlockWithTouchIdKey(touchIdKey), /already unlocked/);
  await vault.update(data => { data.profile.lastName = 'Saved After Touch ID'; });
  await vault.setTouchIdKey(null);
  assert.equal(vault.hasTouchIdSlot, false);
  assert.deepEqual(await slotsOf(file), before, 'turning it off removes only the Touch ID slot');
  await vault.lock();
  await assert.rejects(vault.unlockWithTouchIdKey(touchIdKey), error => error.code === 'TOUCH_ID_MISSING' && /no Touch ID key/.test(error.message));
  await vault.unlock(PASSPHRASE);
  assert.equal(vault.getData().profile.lastName, 'Saved After Touch ID');
});

test('resetting the password with the recovery key or this computer keeps the Touch ID slot, which still unlocks', async t => {
  for (const method of ['recovery', 'device']) {
    const { file } = await fixture(t);
    const deviceSecret = crypto.randomBytes(32);
    const touchIdKey = crypto.randomBytes(32);
    const vault = new Vault(file);
    const { recoveryKey } = await vault.create(PASSPHRASE, { deviceSecret });
    await vault.setTouchIdKey(touchIdKey);
    const before = await slotsOf(file);
    await vault.lock();
    if (method === 'recovery') await vault.resetWithRecoveryKey(recoveryKey, 'a brand new password');
    else await vault.resetWithDeviceSecret(deviceSecret, 'a brand new password');
    assert.equal(vault.hasTouchIdSlot, true, method);
    const after = await slotsOf(file);
    assert.deepEqual(Object.keys(after).sort(), ['device', 'password', 'recovery', 'touchId'], method);
    for (const name of ['recovery', 'device', 'touchId']) assert.deepEqual(after[name], before[name], `${method}: ${name} slot unchanged`);
    assert.notDeepEqual(after.password, before.password, `${method}: only the password slot is new`);
    await vault.lock();
    // A reset keeps the data key, so the Touch ID key still opens the information.
    await vault.unlockWithTouchIdKey(touchIdKey);
    await vault.lock();
    await vault.unlock('a brand new password');
    await vault.lock();
  }
});

test('the password can be checked while unlocked, for a version 1 or 2 file, without changing anything', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  const bytes = await fs.readFile(file);
  await vault.checkPassword(PASSPHRASE);
  await assert.rejects(vault.checkPassword('a wrong but long password'), /That password isn’t right/);
  await assert.rejects(vault.checkPassword('short'), /at least 12/);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(vault.unlocked, true);
  await vault.lock();
  await assert.rejects(vault.checkPassword(PASSPHRASE), /Unlock SecondHand first/);

  const legacy = await fixture(t);
  await writeLegacyVault(legacy.file, PASSPHRASE, { version: 1, profile: { firstName: 'Legacy Synthetic' }, applications: [] });
  const old = new Vault(legacy.file);
  await old.unlock(PASSPHRASE);
  await old.checkPassword(PASSPHRASE);
  await assert.rejects(old.checkPassword('a wrong but long password'), /That password isn’t right/);
  // Turning Touch ID on upgrades a version 1 file and keeps its password.
  const touchIdKey = crypto.randomBytes(32);
  await old.setTouchIdKey(touchIdKey);
  await old.lock();
  assert.deepEqual(Object.keys(await slotsOf(legacy.file)).sort(), ['password', 'touchId']);
  await old.unlockWithTouchIdKey(touchIdKey);
  assert.equal(old.getData().profile.firstName, 'Legacy Synthetic');
  await old.checkPassword(PASSPHRASE);
  await old.lock();
  await old.unlock(PASSPHRASE);
});

// #135: a saved birth date is checked when it is saved. Reading it back never checks it against today again.
test('a clock set back before a saved birth date never keeps the information from opening or saving', async t => {
  const { file } = await fixture(t);
  const vault = new Vault(file);
  await vault.create(PASSPHRASE);
  const child = { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', firstName: 'Synthetic', birthDate: '2026-10-01', relationship: 'child' };
  await vault.update(data => { data.profile = { firstName: 'Synthetic', birthDate: '2026-09-30', householdMembers: [{ id: '0f2c8d4e-1a3b-4c5d-8e6f-7a8b9c0d1e2f', relationship: 'self' }, child] }; });
  await vault.lock();
  // The computer's clock goes back to 2025: both dates are now after today.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2025-01-01T12:00:00Z') });
  await vault.unlock(PASSPHRASE);
  assert.equal(vault.getData().profile.birthDate, '2026-09-30');
  assert.equal(vault.getData().profile.householdMembers[1].birthDate, '2026-10-01');
  await vault.update(data => { data.applications.push(validateApplication({ status: 'draft' })); });
  assert.equal(vault.getData().applications.length, 1, 'other changes still save');
  await vault.lock();
});

test('information saved before the 130-year limit, with a birth date of 1825, still opens', async t => {
  const { file } = await fixture(t);
  await writeLegacyVault(file, PASSPHRASE, { version: 1, profile: { firstName: 'Synthetic', birthDate: '1825-06-01' }, applications: [] });
  const vault = new Vault(file);
  await vault.unlock(PASSPHRASE);
  assert.equal(vault.getData().profile.birthDate, '1825-06-01');
  await vault.lock();
});
