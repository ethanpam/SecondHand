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

function passphraseBytes(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || Buffer.byteLength(passphrase) > 1024) {
    throw new Error('Use a passphrase of at least 12 characters and at most 1024 bytes.');
  }
  return Buffer.from(passphrase, 'utf8');
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

function parseEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > MAX_VAULT_BYTES) throw new Error('Invalid encrypted vault size.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Invalid encrypted vault file.'); }
  if (!value || value.version !== 1 || value.cipher !== 'aes-256-gcm' ||
      !value.kdf || value.kdf.name !== KDF.name || value.kdf.N !== KDF.N || value.kdf.r !== KDF.r || value.kdf.p !== KDF.p) {
    throw new Error('Unsupported encrypted vault format.');
  }
  return { salt: decodeBase64(value.salt, 32, 'salt'), iv: decodeBase64(value.iv, 12, 'nonce'),
    tag: decodeBase64(value.tag, 16, 'tag'), ciphertext: decodeBase64(value.ciphertext, 0, 'content') };
}

async function deriveKey(passphrase, salt) {
  const bytes = passphraseBytes(passphrase);
  try { return await scrypt(bytes, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 }); }
  finally { bytes.fill(0); }
}

function encode(data, key, salt) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const plaintext = Buffer.from(JSON.stringify(data));
  let ciphertext;
  try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
  finally { plaintext.fill(0); }
  const bytes = Buffer.from(JSON.stringify({ version: 1, cipher: 'aes-256-gcm', kdf: KDF,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64') }));
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
    this.data = null;
    this.pending = Promise.resolve();
  }
  get unlocked() { return this.key !== null; }
  async exists() {
    try { await fs.access(this.filePath); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  create(passphrase) {
    return this.enqueue(async () => {
      if (await this.exists()) throw new Error('A local vault already exists. Unlock it instead.');
      const salt = crypto.randomBytes(32);
      const key = await deriveKey(passphrase, salt);
      const data = { version: 1, profile: {}, applications: [] };
      try { await atomicWrite(this.filePath, encode(data, key, salt)); }
      catch (error) { key.fill(0); throw error; }
      this.key = key; this.salt = salt; this.data = data;
    });
  }
  unlock(passphrase) {
    return this.enqueue(async () => {
      if (this.unlocked) throw new Error('The vault is already unlocked.');
      const envelope = parseEnvelope(await this.readEncrypted());
      const key = await deriveKey(passphrase, envelope.salt);
      let plaintext;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.iv);
        decipher.setAAD(AAD); decipher.setAuthTag(envelope.tag);
        plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
        this.data = validateData(JSON.parse(plaintext.toString('utf8')));
        this.key = key; this.salt = envelope.salt;
      } catch {
        key.fill(0); this.data = null;
        throw new Error('Unable to unlock. Check the passphrase or restore an intact backup.');
      } finally { if (plaintext) plaintext.fill(0); }
    });
  }
  lock() {
    return this.enqueue(async () => {
      if (this.key) this.key.fill(0);
      this.key = null; this.salt = null; this.data = null;
    });
  }
  getData() {
    if (!this.unlocked) throw new Error('Unlock your local vault first.');
    return structuredClone(this.data);
  }
  update(mutator) {
    return this.enqueue(async () => {
      const data = this.getData();
      const result = mutator(data);
      const validated = validateData(data);
      await atomicWrite(this.filePath, encode(validated, this.key, this.salt));
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
      if (this.unlocked) throw new Error('Lock your vault before importing a backup.');
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

module.exports = { Vault, atomicWrite, parseEnvelope, MAX_VAULT_BYTES };
