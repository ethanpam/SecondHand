'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('preload forwards only valid lock revisions and treats malformed or legacy events as uncorrelated locks', () => {
  let api;
  let listener;
  let removed;
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'), 'utf8'), {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        ipcRenderer: {
          on(channel, callback) { assert.equal(channel, 'secondhand:locked'); listener = callback; },
          removeListener(channel, callback) { removed = { channel, callback }; }
        }
      };
    }
  });
  const received = [];
  const unsubscribe = api.onLocked(payload => received.push(payload));
  listener({ sender: 'private-electron-event' }, { lockRevision: 3, ignored: 'private-extra-payload' });
  assert.deepEqual(JSON.parse(JSON.stringify(received.pop())), { lockRevision: 3 });
  for (const payload of [undefined, null, {}, { lockRevision: 0 }, { lockRevision: -1 }, { lockRevision: 2.5 }, { lockRevision: '3' }, { lockRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    listener({ sender: 'private-electron-event' }, payload);
    assert.equal(received.pop(), undefined);
  }
  unsubscribe();
  assert.equal(removed.channel, 'secondhand:locked');
  assert.equal(removed.callback, listener);
});

test('preload exposes the Laya settings actions as named desktop calls and nothing that runs the model', () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); }, on() {}, removeListener() {} }
    })
  });
  api.layaStatus();
  api.setLayaEnabled(true);
  api.downloadLaya();
  api.cancelLayaDownload();
  api.removeLaya();
  assert.deepEqual(calls, [['secondhand:invoke', 'layaStatus'], ['secondhand:invoke', 'setLayaEnabled', true], ['secondhand:invoke', 'downloadLaya'],
    ['secondhand:invoke', 'cancelLayaDownload'], ['secondhand:invoke', 'removeLaya']]);
  assert.equal(Object.keys(api).some(name => /decide/i.test(name)), false, 'the renderer cannot ask Laya for decisions');
});

test('preload lets the app turn all websites off, never on: Chrome’s prompt can only come from the extension', () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); }, on() {}, removeListener() {} }
    })
  });
  api.turnOffAllSites();
  assert.deepEqual(calls, [['secondhand:invoke', 'turnOffAllSites']]);
  assert.deepEqual(Object.keys(api).filter(name => /allSites/i.test(name)), ['turnOffAllSites']);
});
