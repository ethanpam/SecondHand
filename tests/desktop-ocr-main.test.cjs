'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tick, startMain } = require('./helpers/harness.cjs');
const ID = 'b1be3de2-8bcc-4f07-94a6-f534f0b34047';

async function desktop() {
  let picker = 0, readerOptions, unlocked = true;
  const canceled = [], reads = [];
  class Vault {
    async exists() { return true; } async inspect() { return {}; }
    get unlocked() { return unlocked; } async lock() { unlocked = false; }
  }
  const laya = { status: async () => ({ state: 'off' }), setEnabled: async () => {}, startUpdates() {}, close: async () => {} };
  const main = await startMain({ userData: '/synthetic-ocr-only', platform: 'darwin',
    dialog: { showOpenDialog: async () => { picker++; return { canceled: true, filePaths: [] }; } },
    modules: {
      'node:fs/promises': { mkdir: async () => {}, stat: async () => ({ size: 2 }), readFile: async () => '{}' },
      './vault.cjs': { Vault }, './laya.cjs': { createLaya: () => laya },
      './field-suggestions.cjs': { createFieldSuggestions: () => ({}) }, './field-answers.cjs': { createFieldAnswers: () => ({}) },
      './extension-setup.cjs': { getExtensionSetup: async () => ({}) },
      './ocr-service.cjs': { createDocumentReader: options => {
        readerOptions = options;
        return { read: async id => { reads.push(id); await options.chooseFile(); return { cancelled: true }; }, cancel: id => { canceled.push(id); return true; } };
      } }
    } });
  return { invoke: main.invoke, raw: main.raw, event: main.event, canceled, reads, get picker() { return picker; }, get unlocked() { return readerOptions.isUnlocked(); },
    async lock() { main.powerEvents.get('lock-screen')(); await tick(); }, quit: main.quit };
}

test('document IPC uses the exact desktop frame, a native picker, and rejects a locked vault', async () => {
  const app = await desktop();
  const event = app.event();
  await assert.rejects(app.raw({ ...event, senderFrame: { url: 'https://example.invalid' } }, 'readDocument', ID), /Request denied/);
  await assert.rejects(app.raw({ ...event, sender: {} }, 'readDocument', ID), /Request denied/);
  await assert.rejects(app.invoke('readDocument', ID, '/arbitrary/file.pdf'), /Request denied/);
  assert.equal(app.picker, 0);
  assert.equal((await app.invoke('readDocument', ID)).cancelled, true);
  assert.equal(app.picker, 1); assert.deepEqual(app.reads, [ID]);
  await app.lock();
  assert.equal(app.unlocked, false);
  await assert.rejects(app.invoke('readDocument', ID), /Unlock/);
  assert.equal(app.picker, 1);
});

test('vault lock/quit cancel the document reader and client cancellation requires a correlation ID', async () => {
  const app = await desktop();
  await assert.rejects(app.invoke('cancelDocumentRead'), /document request is invalid/);
  await assert.rejects(app.invoke('cancelDocumentRead', '/private/file'), /document request is invalid/);
  assert.equal(await app.invoke('cancelDocumentRead', ID), true);
  await app.lock(); app.quit();
  assert.deepEqual(app.canceled, [ID, undefined, undefined]);
});
