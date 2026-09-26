'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const adapter = require('../extension/iowa-adapter.js');

// Values created inside the worker's vm context have foreign prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const PANEL_URL = 'chrome-extension://testextension/panel.html';

// A small page model: answering "has home address" reveals a mailing field,
// the way Iowa's form reveals conditional sections.
function worker({ kind = 'fillable', desktop = {}, duringGetFields } = {}) {
  const model = { kind, filled: [], revealed: false, token: null };
  const vault = { reachable: true, unlocked: true, getFieldsError: null,
    values: { firstName: 'Synthetic private first', hasHomeAddress: 'yes', mailingCity: 'Synthetic private city' }, ...desktop };
  const calls = { native: [], content: [], pageTabs: [] };
  const tab = { id: 7, active: true, url: `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo` };
  const events = {};
  const event = key => ({ addListener: value => { events[key] = value; } });
  const visible = () => ['firstName', 'lastName', 'hasHomeAddress', ...(model.revealed ? ['mailingCity'] : [])];
  function pageState() {
    model.token = `preview-${model.filled.length}`;
    return {
      page: { kind: model.kind, pageKey: 'iowa-personal-information', checklist: visible().map(key => ({ key, label: key, required: true, status: model.filled.includes(key) ? 'complete' : 'missing' })) },
      scan: { token: model.token, recognizedPage: model.kind === 'fillable', fields: visible().filter(key => !model.filled.includes(key)).map(key => ({ key, label: key })) }
    };
  }
  let listener;
  const chrome = {
    tabs: {
      get: async () => ({ ...tab }),
      sendMessage: async (id, message) => {
        calls.pageTabs.push(id); calls.content.push(message);
        if (message.type === 'secondhand:pageState') return pageState();
        if (message.type === 'secondhand:fill') {
          if (message.token !== model.token) return { ok: false, error: 'The page changed or the preview expired. Scan again.' };
          let filledCount = 0;
          for (const key of message.fields) {
            if (!message.values[key]) continue;
            model.filled.push(key); filledCount++;
            if (key === 'hasHomeAddress') model.revealed = true;
          }
          return { ok: true, filledCount, skippedCount: message.fields.length - filledCount };
        }
        if (message.type === 'secondhand:focusField') return { focused: true };
        throw new Error(`Unexpected content message ${message.type}`);
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated')
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    scripting: { executeScript: async () => {} },
    runtime: {
      id: 'testextension', getURL: file => `chrome-extension://testextension/${file}`,
      onMessage: { addListener: callback => { listener = callback; } },
      connectNative: () => {
        let onMessage, onDisconnect;
        return {
          onMessage: { addListener: callback => { onMessage = callback; } },
          onDisconnect: { addListener: callback => { onDisconnect = callback; } },
          disconnect: () => {},
          postMessage: request => {
            calls.native.push(request);
            queueMicrotask(() => {
              if (!vault.reachable) return onDisconnect();
              const reply = data => onMessage({ id: request.id, ok: true, data });
              const fail = error => onMessage({ id: request.id, ok: false, error });
              if (request.type === 'status') return reply({ unlocked: vault.unlocked, applicationCount: 0 });
              if (request.type === 'showApp') return reply({ shown: true });
              if (request.type === 'recordProgress') return reply({ recorded: true });
              if (request.type === 'getFields') {
                duringGetFields?.(tab);
                if (vault.getFieldsError) return fail(vault.getFieldsError);
                return reply({ values: Object.fromEntries(request.fields.filter(key => vault.values[key]).map(key => [key, vault.values[key]])) });
              }
              fail('Unsupported bridge request.');
            });
          }
        };
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'), 'utf8'),
    { chrome, SecondHandIowa: adapter, importScripts: () => {}, crypto: webcrypto, setTimeout, clearTimeout, URL, Map, Set, console });
  const send = (message, sender) => new Promise(resolve => { if (!listener(message, sender, resolve)) resolve(undefined); });
  return {
    calls, tab, events, filled: () => [...model.filled],
    send,
    panel: message => send({ tabId: 7, ...message }, { id: 'testextension', url: PANEL_URL }),
    launcher: message => send(message, { id: 'testextension', url: `${PANEL_URL}?surface=launcher`, frameId: 3, tab: { id: 7, url: tab.url } })
  };
}
const autofill = w => w.panel({ type: 'ui:autofill', confirmed: true });

test('one click makes one status and one getFields request, fills revealed fields, and records progress', async () => {
  const w = worker();
  const response = await autofill(w);
  assert.equal(response.ok, true);
  assert.deepEqual(w.calls.native.map(call => call.type), ['status', 'getFields', 'recordProgress']);
  assert.deepEqual(plain(w.calls.native[1].fields), Object.keys(adapter.definitions));
  assert.equal(w.calls.native[1].url, `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo`);
  assert.equal(w.calls.native[2].filledCount, 3);
  assert.deepEqual(w.filled(), ['firstName', 'hasHomeAddress', 'mailingCity']);
  const result = plain(response.data);
  assert.equal(result.state, 'done');
  assert.equal(result.filled, 3);
  assert.deepEqual(result.needYou, ['lastName']);
  assert.match(result.message, /Filled 3 · 1 need you/);
  assert.doesNotMatch(JSON.stringify(response), /Synthetic private/);
});

test('locked and unreachable desktops map to widget states without filling', async () => {
  const locked = worker({ desktop: { unlocked: false } });
  assert.equal((await autofill(locked)).data.state, 'locked');
  assert.deepEqual(locked.calls.native.map(call => call.type), ['status']);
  assert.equal(locked.filled().length, 0);
  const offline = worker({ desktop: { reachable: false } });
  const result = (await autofill(offline)).data;
  assert.equal(result.state, 'offline');
  assert.match(result.message, /Open the SecondHand app/);
  assert.equal(offline.filled().length, 0);
});

test('a vault that locks during the request, a cancelled approval, or a page change fills nothing', async () => {
  const locking = worker({ desktop: { getFieldsError: 'Unlock your local vault first.' } });
  assert.equal((await autofill(locking)).data.state, 'locked');
  const cancelled = worker({ desktop: { getFieldsError: 'You cancelled this field request.' } });
  const result = (await autofill(cancelled)).data;
  assert.equal(result.state, 'error');
  assert.equal(result.message, 'Cancelled. Nothing was filled.');
  const moved = worker({ duringGetFields: tab => { tab.url = `${adapter.PORTAL}/applyForBenefits/other`; } });
  assert.match((await autofill(moved)).data.message, /page changed/);
  for (const w of [locking, cancelled, moved]) {
    assert.equal(w.filled().length, 0);
    assert.equal(w.calls.native.some(call => call.type === 'recordProgress'), false);
  }
});

test('non-fillable pages never contact the desktop', async () => {
  const w = worker({ kind: 'manual' });
  const response = await autofill(w);
  assert.equal(response.ok, false);
  assert.match(response.error, /Nothing to fill/);
  assert.equal(w.calls.native.length, 0);
});

test('launcher is bound to its own tab, needs confirmed clicks, and cannot use panel-only or unknown types', async () => {
  const w = worker();
  assert.equal(await w.launcher({ type: 'ui:autofill' }), undefined);
  assert.equal((await w.launcher({ type: 'ui:autofill', confirmed: true, tabId: 99 })).ok, true);
  assert.equal(w.calls.pageTabs.every(id => id === 7), true);
  assert.equal(await w.launcher({ type: 'ui:desktopStatus' }), undefined);
  const page = { id: 'testextension', url: `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo`, tab: { id: 7 } };
  assert.equal(await w.send({ type: 'ui:autofill', confirmed: true, tabId: 7 }, page), undefined);
  assert.equal(await w.send({ type: 'ui:autofill', confirmed: true, tabId: 7 }, { id: 'otherextension', url: PANEL_URL }), undefined);
  const elsewhere = { id: 'testextension', url: `${PANEL_URL}?surface=launcher`, frameId: 3, tab: { id: 7, url: 'https://example.com/' } };
  assert.equal(await w.send({ type: 'ui:autofill', confirmed: true }, elsewhere), undefined);
});

test('pageState returns the last result for the same page and forgets it after navigation', async () => {
  const w = worker();
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.result, null);
  await autofill(w);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.result.state, 'done');
  w.events.updated(7, { status: 'loading' });
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.result, null);
});

test('desktop status, showApp, and focusField pass through; guided and manual-fill messages are gone', async () => {
  const w = worker();
  assert.deepEqual(plain((await w.panel({ type: 'ui:desktopStatus' })).data), { connected: true, unlocked: true });
  assert.deepEqual(plain((await w.launcher({ type: 'ui:showApp', confirmed: true })).data), { shown: true });
  assert.deepEqual(plain((await w.launcher({ type: 'ui:focusField', key: 'lastName', confirmed: true })).data), { focused: true });
  assert.equal(await w.launcher({ type: 'ui:focusField', key: 'input[type=password]', confirmed: true }), undefined);
  for (const type of ['ui:auto', 'ui:fill', 'ui:fillAndNext', 'ui:scan', 'ui:status']) {
    assert.equal(await w.panel({ type, confirmed: true, enabled: true }), undefined, type);
  }
  const offline = worker({ desktop: { reachable: false } });
  assert.deepEqual(plain((await offline.panel({ type: 'ui:desktopStatus' })).data), { connected: false, unlocked: false });
  // The side panel shows desktop state and can bring the app forward on any tab.
  const noTab = { id: 'testextension', url: PANEL_URL };
  assert.deepEqual(plain((await w.send({ type: 'ui:desktopStatus' }, noTab)).data), { connected: true, unlocked: true });
  assert.deepEqual(plain((await w.send({ type: 'ui:showApp', confirmed: true }, noTab)).data), { shown: true });
  assert.equal(await w.send({ type: 'ui:pageState' }, noTab), undefined);
});
