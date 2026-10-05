'use strict';

// Unlock with Touch ID on macOS (#99). A random 32-byte key wraps the vault's data key in its
// `touchId` slot. This Mac's Keychain keeps that key through Electron's safeStorage, in
// `touch-unlock.bin`. The app releases the key only after systemPreferences.promptTouchID succeeds.
// Touch ID stays available until it's turned off, the information is erased or replaced, or its key
// can't be used: there is no password-first rule after a restart and no time limit (the owner's choice).
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { atomicWrite } = require('./vault.cjs');

const PROMPT_REASON = 'unlock SecondHand';
const MAX_SEALED_BYTES = 4096;
const publicError = message => Object.assign(new Error(message), { publicMessage: message });
// Why Touch ID can't go on: its message ends a sentence that starts "Touch ID was turned off because".
const reasonError = reason => Object.assign(new Error(reason), { touchIdReason: true });

// What main.cjs uses of macOS: Touch ID, and the Keychain through safeStorage.
// SECONDHAND_TEST_TOUCH_ID=approve, with SECONDHAND_TEST_MODE=1 (which also keeps the app's data
// in a temporary folder), stands in for both in the Electron UI smoke: the prompt always succeeds
// and sealing is a plain, reversible encoding. A packaged app refuses it and doesn't start.
function touchIdPlatform({ systemPreferences, safeStorage, platform, packaged, env }) {
  const hook = env.SECONDHAND_TEST_TOUCH_ID;
  if (hook !== undefined) {
    if (packaged) throw new Error('A packaged SecondHand refuses SECONDHAND_TEST_TOUCH_ID.');
    if (env.SECONDHAND_TEST_MODE !== '1') throw new Error('SECONDHAND_TEST_TOUCH_ID needs SECONDHAND_TEST_MODE=1.');
    if (hook !== 'approve') throw new Error('SECONDHAND_TEST_TOUCH_ID must be "approve".');
    const PREFIX = 'test-sealed:';
    return {
      supported: () => true,
      prompt: async () => {},
      sealingAvailable: () => true,
      seal: text => Buffer.from(`${PREFIX}${Buffer.from(text).toString('hex')}`),
      unseal: bytes => {
        const text = bytes.toString();
        if (!text.startsWith(PREFIX)) throw new Error('Not sealed by the Touch ID test hook.');
        return Buffer.from(text.slice(PREFIX.length), 'hex').toString();
      }
    };
  }
  return {
    supported: () => platform === 'darwin' && systemPreferences.canPromptTouchID(),
    prompt: reason => systemPreferences.promptTouchID(reason),
    sealingAvailable: () => safeStorage.isEncryptionAvailable(),
    seal: text => safeStorage.encryptString(text),
    unseal: bytes => safeStorage.decryptString(bytes)
  };
}

// `revision` comes from main.cjs: a number that moves on as soon as a lock starts (its access
// revision), so a lock while Touch ID asks is never undone by the unlock.
function createTouchIdUnlock({ vault, platform, filePath, revision }) {
  // Why Touch ID was turned off, shown until the password is used again or it is turned back on.
  let notice = null;
  // The Touch ID prompt under way: a second request waits for the same one.
  let pending = null;

  async function sealedExists() {
    try { await fs.access(filePath); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  // Version 2 seals only the key. Version 1, written by an earlier build of this branch, also carried
  // when the password was last used; that time is no longer needed, so it is read and ignored.
  const seal = key => platform.seal(JSON.stringify({ version: 2, key: key.toString('base64') }));
  async function readSealed() {
    let bytes;
    try {
      if ((await fs.stat(filePath)).size > MAX_SEALED_BYTES) throw reasonError('its key file on this Mac is damaged');
      bytes = await fs.readFile(filePath);
    } catch (error) {
      if (error.touchIdReason) throw error;
      throw reasonError(`its key file on this Mac couldn’t be read (${error.code || error.message})`);
    }
    let text;
    try { text = platform.unseal(bytes); } catch { throw reasonError('this Mac’s Keychain couldn’t open its key'); }
    let record;
    try { record = JSON.parse(text); } catch { throw reasonError('its key file on this Mac is damaged'); }
    const key = typeof record?.key === 'string' ? Buffer.from(record.key, 'base64') : null;
    if (![1, 2].includes(record?.version) || key?.length !== 32 || key.toString('base64') !== record.key) {
      key?.fill(0);
      throw reasonError('its key file on this Mac is damaged');
    }
    return { key };
  }
  const removeSealed = () => fs.rm(filePath, { force: true });
  // Turns Touch ID off because its key or slot can't be used. While locked, the slot stays until
  // the next password unlock removes it; without the key it opens nothing.
  async function turnOffBecause(reason) {
    notice = `Touch ID was turned off because ${reason}.`;
    try {
      await removeSealed();
      if (vault.unlocked && vault.hasTouchIdSlot) await vault.setTouchIdKey(null);
    } catch (error) { notice += ` Its key couldn’t be removed (${error.message}). Turn Touch ID off in Privacy & backups.`; }
  }

  // 'ready' or 'off'.
  async function state() {
    return platform.supported() && await sealedExists() ? 'ready' : 'off';
  }

  // While unlocked, after the password is checked again.
  async function turnOn(password) {
    if (!platform.supported()) throw publicError('Touch ID isn’t available on this Mac.');
    try { await vault.checkPassword(password); }
    catch (error) { throw publicError(/password/.test(error.message) ? error.message : 'Could not check your password. Please try again.'); }
    if (!platform.sealingAvailable()) throw publicError('This Mac’s Keychain isn’t available, so Touch ID can’t be turned on.');
    const key = crypto.randomBytes(32);
    try {
      const sealed = seal(key);
      await vault.setTouchIdKey(key);
      try { await atomicWrite(filePath, sealed); }
      catch (error) {
        try { await vault.setTouchIdKey(null); }
        catch (undo) { throw publicError(`Touch ID couldn’t be turned on (${error.message}), and its slot couldn’t be removed (${undo.message}). Turn Touch ID off and try again.`); }
        throw error;
      }
    } catch (error) {
      if (error.publicMessage) throw error;
      throw publicError(`Touch ID couldn’t be turned on (${error.message}). Your password still works.`);
    } finally { key.fill(0); }
    notice = null;
  }

  // While unlocked: the key first, so Touch ID can't unlock even if removing the slot fails.
  async function turnOff() {
    try {
      await removeSealed();
      await vault.setTouchIdKey(null);
    } catch (error) { throw publicError(`Could not turn off Touch ID (${error.message}). Please try again.`); }
    notice = null;
  }

  // After a password unlock: checks that the sealed key can still be read and has a slot, or finishes
  // turning Touch ID off. Problems turn it off and become the notice; they never undo the unlock.
  async function passwordUnlocked() {
    notice = null;
    let record;
    try {
      if (!await sealedExists()) {
        if (vault.hasTouchIdSlot) await vault.setTouchIdKey(null);
        return;
      }
      record = await readSealed();
      if (!vault.hasTouchIdSlot) throw reasonError('your saved information has no Touch ID key');
    } catch (error) {
      await turnOffBecause(error.touchIdReason ? error.message : `of an error (${error.message})`);
    } finally { record?.key.fill(0); }
  }

  // A restored backup or a new password: the information is a different one, so the key goes.
  async function forget() {
    try { await removeSealed(); }
    catch (error) { notice = `Touch ID’s key on this Mac couldn’t be removed (${error.message}). Turn Touch ID off in Privacy & backups.`; }
  }

  const refuse = (reason, message) => ({ unlocked: false, reason, message });
  async function attempt() {
    if (vault.unlocked) return { unlocked: true };
    if (!platform.supported() || !await sealedExists()) return refuse('off', 'Touch ID is off. Enter your password.');
    const asked = revision();
    try { await platform.prompt(PROMPT_REASON); }
    catch (error) { return refuse('cancelled', `Touch ID didn’t unlock SecondHand (${error.message}). Enter your password.`); }
    if (vault.unlocked) return { unlocked: true };
    let record;
    try {
      record = await readSealed();
      // Checked right before the unlock is queued: a lock that starts later is queued after it.
      if (revision() !== asked) return refuse('cancelled', 'SecondHand locked while Touch ID was asking. Try again, or enter your password.');
      await vault.unlockWithTouchIdKey(record.key);
    } catch (error) {
      // A password unlock finished first.
      if (vault.unlocked) return { unlocked: true };
      const reason = error.touchIdReason ? error.message : error.code === 'TOUCH_ID_MISSING' ? 'your saved information has no Touch ID key' :
        error.code === 'TOUCH_ID_KEY' ? 'its key doesn’t open your saved information' : null;
      if (!reason) throw error;
      await turnOffBecause(reason);
      return refuse('off', `${notice} Enter your password.`);
    } finally { record?.key.fill(0); }
    return { unlocked: true };
  }
  // { unlocked: true }, or { unlocked: false, reason: 'off' | 'cancelled', message }.
  function unlock() {
    pending ||= attempt().finally(() => { pending = null; });
    return pending;
  }

  return { state, turnOn, turnOff, passwordUnlocked, forget, removeSealed, unlock, supported: () => platform.supported(), get notice() { return notice; } };
}

module.exports = { touchIdPlatform, createTouchIdUnlock };
