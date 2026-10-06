'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFile } = require('./helpers/harness.cjs');

test('preload forwards only valid lock revisions and treats malformed or legacy events as uncorrelated locks', () => {
  let api;
  let listener;
  let removed;
  runFile('desktop/preload.cjs', {
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

test('preload exposes the Laya settings actions without an arbitrary model decision endpoint', () => {
  let api;
  const calls = [];
  runFile('desktop/preload.cjs', {
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
  assert.equal(Object.keys(api).some(name => /decide/i.test(name)), false, 'the renderer cannot ask arbitrary model questions');
});

test('preload exposes bounded field review and cancellation without saving', () => {
  let api;
  const calls = [];
  runFile('desktop/preload.cjs', {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } }
    })
  });
  const request = { profile: { firstName: 'Synthetic' }, useLaya: false };
  api.reviewFields(request);
  api.cancelFieldReview();
  assert.deepEqual(calls, [['secondhand:invoke', 'reviewFields', request], ['secondhand:invoke', 'cancelFieldReview']]);
});

test('preload lets the app turn all websites off, never on: Chrome’s prompt can only come from the extension', () => {
  let api;
  const calls = [];
  runFile('desktop/preload.cjs', {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); }, on() {}, removeListener() {} }
    })
  });
  api.turnOffAllSites();
  assert.deepEqual(calls, [['secondhand:invoke', 'turnOffAllSites']]);
  assert.deepEqual(Object.keys(api).filter(name => /allSites/i.test(name)), ['turnOffAllSites']);
});

test('preload lets the app remove Always allow on a site, never add it: only the sensitive prompt does (#175)', () => {
  let api;
  const calls = [];
  runFile('desktop/preload.cjs', {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); }, on() {}, removeListener() {} }
    })
  });
  api.removeAlwaysAllowedSite('https://pantry.example.org');
  assert.deepEqual(calls, [['secondhand:invoke', 'removeAlwaysAllowedSite', 'https://pantry.example.org']]);
  assert.deepEqual(Object.keys(api).filter(name => /alwaysAllow/i.test(name)), ['removeAlwaysAllowedSite']);
});

test('preload tells My information which fields a save from Chrome changed, never their values, and exposes the setup’s progress calls', () => {
  let api;
  let listener;
  let removed;
  const calls = [];
  runFile('desktop/preload.cjs', {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); },
        on(channel, callback) { if (channel === 'secondhand:profile-changed') listener = callback; },
        removeListener(channel, callback) { removed = { channel, callback }; } }
    })
  });
  const received = [];
  const unsubscribe = api.onProfileChanged(payload => received.push(payload));
  listener({ sender: 'private-electron-event' }, { fields: ['county', 'addressLine2'], values: { county: 'private' } });
  assert.deepEqual(JSON.parse(JSON.stringify(received.pop())), { fields: ['county', 'addressLine2'] });
  for (const payload of [undefined, null, {}, { fields: 'county' }, { fields: [] }, { fields: [42] }, { fields: ['county', 'county'] }, { fields: ['not a field!'] }, { fields: Array(41).fill('county').map((name, n) => `${name}${n}`) }]) {
    listener({ sender: 'private-electron-event' }, payload);
    assert.equal(received.length, 0, JSON.stringify(payload));
  }
  unsubscribe();
  assert.equal(removed.channel, 'secondhand:profile-changed');
  assert.equal(removed.callback, listener);
  assert.throws(() => api.onProfileChanged('not a function'), /callback/);
  api.setupProgress();
  api.startSetup();
  api.saveSetupProgress(2);
  assert.deepEqual(calls, [['secondhand:invoke', 'setupProgress'], ['secondhand:invoke', 'startSetup'], ['secondhand:invoke', 'saveSetupProgress', 2]]);
  assert.equal(Object.keys(api).some(name => /saveFields/i.test(name)), false, 'saving from a page is the extension’s request, never the renderer’s');
});

test('preload offers Touch ID as named calls, and an unlock notice with only a valid lock revision', () => {
  let api;
  const calls = [];
  const listeners = {};
  let removed;
  runFile('desktop/preload.cjs', {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); },
        on(channel, callback) { listeners[channel] = callback; }, removeListener(channel, callback) { removed = { channel, callback }; } }
    })
  });
  api.setTouchIdUnlock({ enabled: true, password: 'synthetic password' });
  api.unlockWithTouchId();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['secondhand:invoke', 'setTouchIdUnlock', { enabled: true, password: 'synthetic password' }], ['secondhand:invoke', 'unlockWithTouchId']]);
  const received = [];
  const unsubscribe = api.onUnlocked(payload => received.push(payload));
  listeners['secondhand:unlocked']({ sender: 'private-electron-event' }, { lockRevision: 0, ignored: 'private-extra-payload' });
  assert.deepEqual(JSON.parse(JSON.stringify(received.pop())), { lockRevision: 0 });
  for (const payload of [undefined, null, {}, { lockRevision: -1 }, { lockRevision: 2.5 }, { lockRevision: '3' }]) {
    listeners['secondhand:unlocked']({ sender: 'private-electron-event' }, payload);
    assert.equal(received.pop(), undefined);
  }
  unsubscribe();
  assert.equal(removed.channel, 'secondhand:unlocked');
  assert.throws(() => api.onUnlocked('not a function'), /callback is required/);
});

test('preload tells the window to open Your household with nothing from the event, and dismisses the Overview note (#180)', () => {
  let api, listener, removed;
  const calls = [];
  runFile('desktop/preload.cjs', {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); },
        on(channel, callback) { assert.equal(channel, 'secondhand:open-household'); listener = callback; },
        removeListener(channel, callback) { removed = { channel, callback }; } }
    })
  });
  const heard = [];
  const unsubscribe = api.onOpenHousehold((...args) => heard.push(args));
  listener({ sender: 'private-electron-event' }, { section: 'privacy', profile: { firstName: 'Private' } });
  assert.deepEqual(heard, [[]], 'the callback gets nothing');
  unsubscribe();
  assert.deepEqual(removed, { channel: 'secondhand:open-household', callback: listener });
  assert.throws(() => api.onOpenHousehold(), /callback/);
  api.dismissHouseholdNote();
  assert.deepEqual(calls, [['secondhand:invoke', 'dismissHouseholdNote']]);
});
