'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { validateProfile, validateStoredApplication } = require('../shared/schema.cjs');

const scrypt = promisify(crypto.scrypt);
const MAX_VAULT_BYTES = 8 * 1024 * 1024;
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1 });
const AAD = Buffer.from('SecondHand encrypted vault v1');
const AAD_V2 = Buffer.from('SecondHand encrypted vault v2');
// Version 2 encrypts contents with a random data key. Each slot stores that key
// wrapped by one secret, so a recovery key can set a new password without
// re-encrypting or exposing the password.
const SLOT_NAMES = Object.freeze(['password', 'recovery']);
const slotAad = name => Buffer.from(`SecondHand vault key slot v2:${name}`);
// Crockford base32: no I, L, O, or U, so handwritten keys are hard to misread.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_BYTES = 20;

function passphraseBytes(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Use a password with at least 12 characters.');
  if (Buffer.byteLength(passphrase) > 1024) throw new Error('That password is too long. Use a shorter password.');
  return Buffer.from(passphrase, 'utf8');
}

function createRecoveryKey() {
  const bytes = crypto.randomBytes(RECOVERY_BYTES);
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  bytes.fill(0);
  return output.match(/.{4}/g).join('-');
}

function normalizeRecoveryKey(input) {
  const cleaned = typeof input === 'string' ? input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1') : '';
  if (!/^[0-9A-HJKMNP-TV-Z]{32}$/.test(cleaned)) throw new Error('Enter the recovery key exactly as it was shown, like ABCD-EFGH-1234.');
  return cleaned;
}

function decodeBase64(value, length, name) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid encrypted vault ${name}.`);
  }
  const result = Buffer.from(value, 'base64');
  if ((length && result.length !== length) || result.toString('base64') !== value) {
    throw new Error(`Invalid encrypted vault ${name}.`);
  }
  return result;
}

function parseSlot(value, name) {
  if (!value || typeof value !== 'object') throw new Error(`Invalid encrypted vault ${name} slot.`);
  return { salt: decodeBase64(value.salt, 32, `${name} salt`), iv: decodeBase64(value.iv, 12, `${name} nonce`),
    tag: decodeBase64(value.tag, 16, `${name} tag`), key: decodeBase64(value.key, 32, `${name} key`) };
}

function parseEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > MAX_VAULT_BYTES) throw new Error('Invalid encrypted vault size.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid encrypted vault file.'); }
  if (!value || ![1, 2].includes(value.version) || value.cipher !== 'aes-256-gcm' ||
      !value.kdf || value.kdf.name !== KDF.name || value.kdf.N !== KDF.N || value.kdf.r !== KDF.r || value.kdf.p !== KDF.p) {
    throw new Error('Unsupported encrypted vault format.');
  }
  const content = { iv: decodeBase64(value.iv, 12, 'nonce'), tag: decodeBase64(value.tag, 16, 'tag'),
    ciphertext: decodeBase64(value.ciphertext, 0, 'content') };
  if (value.version === 1) return { version: 1, salt: decodeBase64(value.salt, 32, 'salt'), ...content };
  if (!value.slots || typeof value.slots !== 'object' || Array.isArray(value.slots) || !value.slots.password ||
      Object.keys(value.slots).some(name => !SLOT_NAMES.includes(name))) {
    throw new Error('Unsupported encrypted vault format.');
  }
  const slots = {};
  for (const name of Object.keys(value.slots)) slots[name] = parseSlot(value.slots[name], name);
  return { version: 2, slots, ...content };
}

async function deriveSecretKey(bytes, salt) {
  try { return await scrypt(bytes, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 }); }
  finally { bytes.fill(0); }
}

const deriveKey = (passphrase, salt) => deriveSecretKey(passphraseBytes(passphrase), salt);
const deriveRecoveryKey = (recoveryKey, salt) => deriveSecretKey(Buffer.from(normalizeRecoveryKey(recoveryKey), 'utf8'), salt);

function wrapKey(dataKey, wrappingKey, name, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
  cipher.setAAD(slotAad(name));
  const key = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { salt, iv, tag: cipher.getAuthTag(), key };
}

function unwrapKey(slot, wrappingKey, name) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, slot.iv);
  decipher.setAAD(slotAad(name)); decipher.setAuthTag(slot.tag);
  return Buffer.concat([decipher.update(slot.key), decipher.final()]);
}

function decryptContents(envelope, key) {
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.iv);
    decipher.setAAD(envelope.version === 1 ? AAD : AAD_V2); decipher.setAuthTag(envelope.tag);
    plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    return validateData(JSON.parse(plaintext.toString('utf8')));
  } finally { if (plaintext) plaintext.fill(0); }
}

function encode(data, state) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', state.key, iv);
  cipher.setAAD(state.version === 1 ? AAD : AAD_V2);
  const plaintext = Buffer.from(JSON.stringify(data));
  let ciphertext;
  try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
  finally { plaintext.fill(0); }
  const content = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  const envelope = state.version === 1 ? { version: 1, cipher: 'aes-256-gcm', kdf: KDF, salt: state.salt.toString('base64'), ...content } :
    { version: 2, cipher: 'aes-256-gcm', kdf: KDF, ...content, slots: Object.fromEntries(Object.entries(state.slots).map(([name, slot]) =>
      [name, { salt: slot.salt.toString('base64'), iv: slot.iv.toString('base64'), tag: slot.tag.toString('base64'), key: slot.key.toString('base64') }])) };
  const bytes = Buffer.from(JSON.stringify(envelope));
  if (bytes.length > MAX_VAULT_BYTES) throw new Error('The local vault has reached its size limit.');
  return bytes;
}

function validateData(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.applications) || data.applications.length > 2000) {
    throw new Error('Invalid vault contents.');
  }
  const profile = validateProfile(data.profile);
  const applications = data.applications.map(item => validateStoredApplication(item));
  if (new Set(applications.map(item => item.id)).size !== applications.length) throw new Error('Duplicate application records.');
  return { version: 1, profile, applications };
}

async function atomicWrite(filePath, bytes) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

class Vault {
  constructor(filePath) {
    this.filePath = filePath;
    this.key = null;
    this.salt = null;
    this.slots = null;
    this.version = null;
    this.data = null;
    this.pending = Promise.resolve();
  }
  get unlocked() { return this.key !== null; }
  async exists() {
    try { await fs.access(this.filePath); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async inspect() {
    if (!await this.exists()) return null;
    try { return { recoveryKey: Boolean(parseEnvelope(await this.readEncrypted()).slots?.recovery) }; }
    catch { return { recoveryKey: false }; }
  }
  enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  // Keys change in memory only after the encrypted file is safely written.
  async commit(data, state) {
    await atomicWrite(this.filePath, encode(data, state));
    if (this.key && this.key !== state.key) this.key.fill(0);
    Object.assign(this, { key: state.key, salt: state.salt || null, slots: state.slots || null, version: state.version, data });
  }
  create(passphrase) {
    return this.enqueue(async () => {
      if (await this.exists()) throw new Error('SecondHand already has a password on this computer. Unlock it instead.');
      const recoveryKey = createRecoveryKey();
      const key = crypto.randomBytes(32);
      const passwordSalt = crypto.randomBytes(32);
      const recoverySalt = crypto.randomBytes(32);
      let passwordKey, recoveryWrappingKey;
      try {
        passwordKey = await deriveKey(passphrase, passwordSalt);
        recoveryWrappingKey = await deriveRecoveryKey(recoveryKey, recoverySalt);
        const slots = { password: wrapKey(key, passwordKey, 'password', passwordSalt), recovery: wrapKey(key, recoveryWrappingKey, 'recovery', recoverySalt) };
        await this.commit({ version: 1, profile: {}, applications: [] }, { version: 2, key, slots });
      } catch (error) { key.fill(0); throw error; }
      finally { passwordKey?.fill(0); recoveryWrappingKey?.fill(0); }
      return { recoveryKey };
    });
  }
  unlock(passphrase) {
    return this.enqueue(async () => {
      if (this.unlocked) throw new Error('SecondHand is already unlocked.');
      const envelope = parseEnvelope(await this.readEncrypted());
      const salt = envelope.version === 1 ? envelope.salt : envelope.slots.password.salt;
      const passwordKey = await deriveKey(passphrase, salt);
      let key;
      try {
        key = envelope.version === 1 ? passwordKey : unwrapKey(envelope.slots.password, passwordKey, 'password');
        const data = decryptContents(envelope, key);
        Object.assign(this, { key, salt: envelope.version === 1 ? salt : null, slots: envelope.slots || null, version: envelope.version, data });
      } catch {
        key?.fill(0); this.data = null;
        throw new Error('Unable to unlock. Check your password or restore an intact backup.');
      } finally { if (key !== passwordKey) passwordKey.fill(0); }
    });
  }
  resetWithRecoveryKey(recoveryKey, passphrase) {
    return this.enqueue(async () => {
      if (this.unlocked) throw new Error('SecondHand is already unlocked.');
      normalizeRecoveryKey(recoveryKey);
      passphraseBytes(passphrase).fill(0);
      const envelope = parseEnvelope(await this.readEncrypted());
      if (!envelope.slots?.recovery) throw new Error('This information was saved before recovery keys were added, so it has no recovery key.');
      const wrappingKey = await deriveRecoveryKey(recoveryKey, envelope.slots.recovery.salt);
      let key, data;
      try { key = unwrapKey(envelope.slots.recovery, wrappingKey, 'recovery'); data = decryptContents(envelope, key); }
      catch { key?.fill(0); throw new Error('That recovery key didn’t work. Check it and try again.'); }
      finally { wrappingKey.fill(0); }
      const salt = crypto.randomBytes(32);
      let passwordKey;
      try {
        passwordKey = await deriveKey(passphrase, salt);
        await this.commit(data, { version: 2, key, slots: { ...envelope.slots, password: wrapKey(key, passwordKey, 'password', salt) } });
      } catch (error) { key.fill(0); throw error; }
      finally { passwordKey?.fill(0); }
    });
  }
  // Also upgrades a version 1 file, reusing its password-derived key as the
  // password slot so the current password keeps working.
  replaceRecoveryKey() {
    return this.enqueue(async () => {
      const data = this.getData();
      const recoveryKey = createRecoveryKey();
      const salt = crypto.randomBytes(32);
      const wrappingKey = await deriveRecoveryKey(recoveryKey, salt);
      const upgrade = this.version === 1;
      const key = upgrade ? crypto.randomBytes(32) : this.key;
      try {
        const slots = upgrade ? { password: wrapKey(key, this.key, 'password', this.salt) } : { ...this.slots };
        slots.recovery = wrapKey(key, wrappingKey, 'recovery', salt);
        await this.commit(data, { version: 2, key, slots });
      } catch (error) { if (upgrade) key.fill(0); throw error; }
      finally { wrappingKey.fill(0); }
      return recoveryKey;
    });
  }
  lock() {
    return this.enqueue(async () => {
      if (this.key) this.key.fill(0);
      this.key = null; this.salt = null; this.slots = null; this.version = null; this.data = null;
    });
  }
  getData() {
    if (!this.unlocked) throw new Error('Unlock SecondHand first.');
    return structuredClone(this.data);
  }
  update(mutator) {
    return this.enqueue(async () => {
      const data = this.getData();
      const result = mutator(data);
      const validated = validateData(data);
      await atomicWrite(this.filePath, encode(validated, this));
      this.data = validated;
      return result === undefined ? undefined : structuredClone(result);
    });
  }
  async readEncrypted() {
    const stat = await fs.stat(this.filePath);
    if (stat.size > MAX_VAULT_BYTES) throw new Error('Invalid encrypted vault size.');
    const bytes = await fs.readFile(this.filePath);
    parseEnvelope(bytes);
    return bytes;
  }
  importEncrypted(bytes) {
    return this.enqueue(async () => {
      if (this.unlocked) throw new Error('Lock SecondHand before restoring a backup.');
      parseEnvelope(bytes);
      if (await this.exists()) {
        const stat = await fs.stat(this.filePath);
        if (stat.size > MAX_VAULT_BYTES) throw new Error('The existing vault is too large to preserve safely.');
        const rollbackPath = `${this.filePath}.before-import-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        await atomicWrite(rollbackPath, await fs.readFile(this.filePath));
      }
      await atomicWrite(this.filePath, bytes);
    });
  }
}

module.exports = { Vault, atomicWrite, parseEnvelope, normalizeRecoveryKey, MAX_VAULT_BYTES };
