'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const adapter = require('../extension/iowa-adapter.js');

function background({ url = `${adapter.PORTAL}/applyForBenefits/personalInformation`, nativeError, duringApproval } = {}) {
  const calls = { injections: [], content: [], native: [], disconnects: 0 };
  const tab = { id: 7, active: true, url };
  const popupUrl = 'chrome-extension://testextension/popup.html';
  let listener;
  const chrome = {
    tabs: {
      get: async () => tab,
      sendMessage: async (id, message) => {
        calls.content.push(message);
        if (message.type === 'secondhand:scan') return { token: 'preview-token', recognizedPage: true, supported: true, fields: [{ key: 'firstName', label: 'First name' }], ambiguous: [], skipped: 0 };
        return { ok: true, filledCount: 1, skippedCount: 0 };
      }
    },
    scripting: { executeScript: async request => { calls.injections.push(request); } },
    runtime: {
      id: 'testextension', getURL: name => `chrome-extension://testextension/${name}`,
      onMessage: { addListener: value => { listener = value; } },
      connectNative: host => {
        assert.equal(host, 'org.secondhand.bridge');
        let onMessage, onDisconnect;
        return {
          onMessage: { addListener: value => { onMessage = value; } },
          onDisconnect: { addListener: value => { onDisconnect = value; } },
          disconnect: () => { calls.disconnects++; onDisconnect?.(); },
          postMessage: request => {
            calls.native.push(request);
            queueMicrotask(() => {
              if (request.type === 'getFields') duringApproval?.(tab);
              onMessage(nativeError ? { id: request.id, ok: false, error: nativeError } : { id: request.id, ok: true, data: request.type === 'getFields' ? { values: { firstName: 'Private example' } } : { recorded: true } });
            });
          }
        };
      }
    }
  };
  const context = vm.createContext({ chrome, importScripts: () => {}, SecondHandIowa: adapter, crypto: webcrypto, setTimeout, clearTimeout, URL, Map, Set, console });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/background.js'), 'utf8'), context);
  const send = (message, sender = { id: 'testextension', url: popupUrl }) => new Promise(resolve => {
    const pending = listener(message, sender, resolve);
    if (!pending) resolve(undefined);
  });
  return { calls, tab, send };
}
const scan = worker => worker.send({ type: 'ui:scan', tabId: 7 });
const fill = worker => worker.send({ type: 'ui:fill', tabId: 7, token: 'preview-token', fields: ['firstName'], confirmed: true });

test('untrusted/content-script senders cannot reach the vault; wrong domains never inject', async () => {
  const worker = background({ url: 'https://example.com/' });
  assert.equal(await worker.send({ type: 'ui:scan', tabId: 7 }, { id: 'testextension', url: adapter.PORTAL, tab: { id: 7 } }), undefined);
  assert.equal((await scan(worker)).ok, false);
  assert.equal(worker.calls.injections.length, 0);
  assert.equal(worker.calls.native.length, 0);
});

test('scan is metadata-only; explicit fill requests only reviewed fields and records counts', async () => {
  const worker = background({ url: `${adapter.PORTAL}/applicant?session=secret#contact` });
  assert.equal((await scan(worker)).ok, true);
  assert.equal(worker.calls.native.length, 0);
  assert.equal(await worker.send({ type: 'ui:fill', tabId: 7, token: 'preview-token', fields: ['firstName'] }), undefined);
  assert.equal(worker.calls.native.length, 0);
  const result = await fill(worker);
  assert.equal(result.ok, true);
  assert.equal(worker.calls.native.length, 2);
  assert.equal(worker.calls.native[0].type, 'getFields');
  assert.equal(JSON.stringify(worker.calls.native[0].fields), '["firstName"]');
  assert.equal(worker.calls.native[0].url, `${adapter.PORTAL}/applicant`);
  assert.equal(worker.calls.native[1].type, 'recordProgress');
  assert.equal(worker.calls.native[1].filledCount, 1);
  assert.equal(worker.calls.content[1].values.firstName, 'Private example');
  const status = await worker.send({ type: 'ui:status' });
  assert.equal(status.data.busy, false);
  assert.doesNotMatch(JSON.stringify(status), /Private example|session=secret/);
  assert.equal((await fill(worker)).ok, false, 'preview cannot be replayed');
  assert.equal(worker.calls.native.length, 2);
  assert.equal(worker.calls.disconnects, 2);
});

test('changed tab during native approval does not receive values or record progress', async () => {
  const worker = background({ duringApproval: tab => { tab.url = 'https://example.com/'; } });
  await scan(worker);
  assert.equal((await fill(worker)).ok, false);
  assert.equal(worker.calls.content.length, 1);
  assert.equal(worker.calls.native.length, 1);
  assert.equal((await worker.send({ type: 'ui:status' })).data.busy, false);
});

test('declined/locked native requests fail once without automatic retry or content fill', async () => {
  const worker = background({ nativeError: 'Unlock your vault first.' });
  await scan(worker);
  const result = await fill(worker);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Unlock your vault first.');
  assert.equal(worker.calls.native.length, 1);
  assert.equal(worker.calls.content.length, 1);
  assert.equal((await worker.send({ type: 'ui:status' })).data.lastResult.error, true);
});

test('unpreviewed or duplicate fields never request native data', async () => {
  for (const fields of [['ssn'], ['firstName', 'firstName'], []]) {
    const worker = background();
    await scan(worker);
    const result = await worker.send({ type: 'ui:fill', tabId: 7, token: 'preview-token', fields, confirmed: true });
    assert.equal(result.ok, false);
    assert.equal(worker.calls.native.length, 0);
  }
});
