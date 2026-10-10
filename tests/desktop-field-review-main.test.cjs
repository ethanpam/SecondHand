'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deferred, startMain } = require('./helpers/harness.cjs');

// Exercise the real IPC authorization and lifecycle while the model review is deferred.
async function desktop() {
  let unlocked = true;
  const calls = [], writes = [];
  class Vault {
    async exists() { return true; } async inspect() { return {}; }
    get unlocked() { return unlocked; }
    async lock() { unlocked = false; } async unlock() { unlocked = true; }
    async update(callback) { const data = { profile: {} }; callback(data); writes.push(data); }
  }
  const laya = { status: async () => ({ state: 'off' }), setEnabled: async () => {}, startUpdates() {}, close: async () => {} };
  const main = await startMain({ userData: '/synthetic-field-review', platform: 'darwin', modules: {
    'node:fs/promises': { access: async () => { throw Object.assign(new Error('No file'), { code: 'ENOENT' }); }, mkdir: async () => {}, stat: async () => ({ size: 2 }), readFile: async () => '{}' },
    './vault.cjs': { Vault }, './laya.cjs': { createLaya: () => laya },
    './touch-id.cjs': { touchIdPlatform: () => ({}), createTouchIdUnlock: () => ({
      state: async () => 'off', supported: () => false, passwordUnlocked: async () => {} }) },
    './field-suggestions.cjs': { createFieldSuggestions: () => ({}) }, './field-answers.cjs': { createFieldAnswers: () => ({}) },
    './field-review.cjs': { createFieldReview: options => {
      assert.equal(options.laya, laya);
      return { review: (request, context) => { const done = deferred(); calls.push({ request, context, done }); return done.promise; } };
    } },
    './extension-setup.cjs': { getExtensionSetup: async () => ({}) },
    './ocr-service.cjs': { createDocumentReader: () => ({ cancel() {} }) }
  } });
  return { calls, writes, event: main.event, invoke: main.invoke, raw: main.raw, quit: main.quit };
}

test('field review requires the unlocked desktop frame and cannot save data', async () => {
  const app = await desktop(), event = app.event();
  const request = { profile: { firstName: 'Synthetic' }, useLaya: false };
  for (const fake of [{ ...event, sender: {} }, { ...event, senderFrame: { url: event.senderFrame.url } },
    { ...event, senderFrame: { url: 'https://example.invalid/' } }]) {
    await assert.rejects(app.raw(fake, 'reviewFields', request), /Request denied/);
  }
  await assert.rejects(app.invoke('reviewFields', request, 'unexpected argument'), /Request denied/);
  assert.equal(app.calls.length, 0);
  const pending = app.invoke('reviewFields', request);
  assert.deepEqual(app.calls[0].request, request);
  assert.equal(app.calls[0].context.isCurrent(), true);
  const result = { profile: [], document: [], laya: { state: 'off' } };
  app.calls[0].done.resolve(result);
  assert.equal(await pending, result);
  assert.deepEqual(app.writes, []);
  await app.invoke('lock');
  await assert.rejects(app.invoke('reviewFields', request), /Unlock/);
  assert.equal(app.calls.length, 1);
});

test('lock, lock then unlock, edits, cancellation, superseding review and quit discard late results', async t => {
  for (const action of ['lock', 'lock-unlock', 'save', 'cancel', 'supersede', 'quit']) await t.test(action, async () => {
    const app = await desktop();
    const pending = app.invoke('reviewFields', { profile: {}, useLaya: true });
    const rejected = assert.rejects(pending, /information changed during review/);
    if (action === 'lock' || action === 'lock-unlock') await app.invoke('lock');
    if (action === 'lock-unlock') await app.invoke('unlock', 'synthetic-test-only');
    if (action === 'save') await app.invoke('saveProfile', { firstName: 'Changed' });
    if (action === 'cancel') await app.invoke('cancelFieldReview');
    if (action === 'quit') app.quit();
    let second;
    if (action === 'supersede') second = app.invoke('reviewFields', { profile: {}, useLaya: false });
    assert.equal(app.calls[0].context.isCurrent(), false);
    app.calls[0].done.resolve({ profile: [{ key: 'firstName', messages: ['stale'] }] });
    await rejected;
    if (second) { app.calls[1].done.resolve({ profile: [], document: [] }); await second; }
    if (action !== 'save') assert.deepEqual(app.writes, []);
  });
});
