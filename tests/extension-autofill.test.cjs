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
// Verified Iowa pages never use the general engine; any call there is a bug.
const noSiteEngine = { requestKeys: () => { throw new Error('Iowa used the site engine.'); }, deriveValues: () => { throw new Error('Iowa used the site engine.'); } };
// Stand-in for generic-adapter.js's pure helpers on pages the Iowa adapter hasn't verified.
const generalEngine = {
  requestKeys: keys => [...new Set(keys.flatMap(key => key === 'totalMonthlyIncome' ? ['monthlyEarnedIncome', 'monthlyOtherIncome'] : [key]))],
  deriveValues: values => ({ ...values, ...(values.monthlyEarnedIncome && values.monthlyOtherIncome ? { totalMonthlyIncome: 'Synthetic private total' } : {}) })
};
const nothingPlanned = () => ({ token: 'plan-0', matched: [], unmatched: [] });
const financialPlan = () => ({ token: 'plan-1',
  matched: [{ id: 'sh-1-0', key: 'householdAdults', confidence: 'high' }, { id: 'sh-1-1', key: 'totalMonthlyIncome', confidence: 'high' }, { id: 'sh-1-2', key: 'householdSeniors', confidence: 'high' }],
  unmatched: [{ id: 'sh-1-3', label: 'Is anyone blind?', type: 'radio', options: ['Yes', 'No'], required: true }] });
const financialValues = { householdAdults: '2', monthlyEarnedIncome: 'Synthetic private 900', monthlyOtherIncome: '100' };
// The general engine's side of a page: plan, fill what has a value, focus the field that needs you.
function generalPage(message, plan) {
  if (message.type === 'secondhand:generic:plan') return structuredClone(plan);
  if (message.type === 'secondhand:generic:fill') {
    if (message.token !== plan.token) return { ok: false, filled: [], skipped: [] };
    const filled = message.assignments.filter(item => message.values[item.key]).map(item => item.id);
    return { ok: true, filled, skipped: message.assignments.map(item => item.id).filter(id => !filled.includes(id)) };
  }
  if (message.type === 'secondhand:generic:focus') return { focused: message.id === 'sh-1-3' };
  return undefined;
}

// A small page model: answering "has home address" reveals a mailing field,
// the way Iowa's form reveals conditional sections.
function worker({ kind = 'fillable', desktop = {}, duringGetFields, engine = noSiteEngine, general = nothingPlanned() } = {}) {
  const model = { kind, filled: [], revealed: false, token: null };
  const vault = { reachable: true, unlocked: true, getFieldsError: null,
    values: { firstName: 'Synthetic private first', hasHomeAddress: 'yes', mailingCity: 'Synthetic private city' }, ...desktop };
  const calls = { native: [], content: [], pageTabs: [], injected: [] };
  const tab = { id: 7, active: true, url: `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo` };
  const events = {};
  const event = key => ({ addListener: value => { events[key] = value; } });
  const visible = () => ['firstName', 'lastName', 'hasHomeAddress', ...(model.revealed ? ['mailingCity'] : [])];
  function pageState() {
    model.token = `preview-${model.filled.length}`;
    return {
      page: { kind: model.kind, pageKey: model.kind === 'manual' ? 'iowa-manual' : 'iowa-personal-information', checklist: visible().map(key => ({ key, label: key, required: true, status: model.filled.includes(key) ? 'complete' : 'missing' })) },
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
        const answer = generalPage(message, general);
        if (answer) return answer;
        throw new Error(`Unexpected content message ${message.type}`);
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated')
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    scripting: { executeScript: async details => { calls.injected.push(plain(details)); }, getRegisteredContentScripts: async () => [] },
    permissions: { contains: async () => false },
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
    { chrome, SecondHandIowa: adapter, SecondHandGeneric: engine, importScripts: () => {}, crypto: webcrypto, setTimeout, clearTimeout, URL, Map, Set, console });
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
  assert.equal(w.calls.content.some(message => message.type.startsWith('secondhand:generic:')), false, 'verified pages never use the general engine');
  assert.deepEqual(w.calls.injected[0], { target: { tabId: 7, frameIds: [0] }, files: ['iowa-adapter.js', 'generic-adapter.js', 'content.js'] });
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

test('an unknown page where the general engine matches nothing stops autofill without contacting the desktop', async () => {
  const w = worker({ kind: 'manual', general: { ...nothingPlanned(), unmatched: financialPlan().unmatched } });
  const response = await autofill(w);
  assert.equal(response.ok, true);
  assert.equal(response.data.state, 'stopped');
  assert.match(response.data.message, /doesn’t know this page yet/);
  assert.equal(w.calls.native.length, 0);
  assert.deepEqual(w.calls.content.map(message => message.type), ['secondhand:pageState', 'secondhand:generic:plan']);
  const state = (await w.panel({ type: 'ui:pageState' })).data;
  assert.equal(state.autopilot, false);
  assert.equal(state.page.todo, undefined);
});

test('an unknown Iowa page gets one general fill, then waits for the applicant to check it and continue', async () => {
  const w = worker({ kind: 'manual', engine: generalEngine, general: financialPlan(), desktop: { values: financialValues } });
  const response = await autofill(w);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { state: 'done', filled: 2, needYou: ['sh-1-3', 'sh-1-2'],
    message: 'Filled 2 · 2 need you. Check your answers, then click Continue.', todo: 'Check your answers, then click Continue.', pageKey: 'iowa-manual' });
  assert.deepEqual(w.calls.native.map(call => call.type), ['status', 'getFields']);
  assert.equal(w.calls.native[1].url, `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo`);
  assert.deepEqual(plain(w.calls.native[1].fields), ['householdAdults', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'householdSeniors']);
  assert.deepEqual(w.calls.content.map(message => message.type), ['secondhand:pageState', 'secondhand:generic:plan', 'secondhand:generic:fill']);
  const fill = plain(w.calls.content[2]);
  assert.equal(fill.token, 'plan-1');
  assert.deepEqual(fill.assignments, [{ id: 'sh-1-0', key: 'householdAdults', guessed: false }, { id: 'sh-1-1', key: 'totalMonthlyIncome', guessed: false }]);
  assert.deepEqual(Object.keys(fill.values), ['householdAdults', 'totalMonthlyIncome'], 'only the values being placed reach the page');
  assert.doesNotMatch(JSON.stringify(response), /Synthetic private/);

  const state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.equal(state.autopilot, true, 'autofill keeps going after the applicant continues');
  assert.equal(state.result.message, response.data.message);
  assert.equal(state.page.todo, 'Check your answers, then click Continue.');
  assert.doesNotMatch(JSON.stringify(state), /Synthetic private/);
  w.events.updated(7, { status: 'complete' });
  await new Promise(resolve => setImmediate(resolve));
  await w.panel({ type: 'ui:pageState' });
  assert.equal(w.calls.content.filter(message => message.type === 'secondhand:generic:fill').length, 1, 'one general fill per page');
  assert.equal(w.calls.content.some(message => ['secondhand:continue', 'secondhand:fill'].includes(message.type)), false, 'never continues or uses the Iowa fill');
  assert.equal(w.calls.native.some(call => call.type === 'recordProgress'), false);
});

test('need-you on a general-filled Iowa page focuses the general engine’s field; Iowa keys still go to the Iowa adapter', async () => {
  const w = worker({ kind: 'manual', engine: generalEngine, general: financialPlan(), desktop: { values: financialValues } });
  await autofill(w);
  assert.deepEqual(plain((await w.launcher({ type: 'ui:focusField', key: 'sh-1-3', confirmed: true })).data), { focused: true });
  assert.deepEqual(plain((await w.panel({ type: 'ui:focusField', key: 'sh-9-9' })).data), { focused: false });
  assert.deepEqual(plain((await w.launcher({ type: 'ui:focusField', key: 'lastName', confirmed: true })).data), { focused: true });
  assert.deepEqual(w.calls.content.filter(message => /focus/i.test(message.type)).map(({ type, id, key }) => ({ type, target: id || key })),
    [{ type: 'secondhand:generic:focus', target: 'sh-1-3' }, { type: 'secondhand:generic:focus', target: 'sh-9-9' }, { type: 'secondhand:focusField', target: 'lastName' }]);
  assert.equal(await w.launcher({ type: 'ui:focusField', key: 'input[type=password]', confirmed: true }), undefined);
});

test('a locked, cancelled, or unreadable general fill on an unknown Iowa page stops autofill and fills nothing', async () => {
  const locked = worker({ kind: 'manual', engine: generalEngine, general: financialPlan(), desktop: { unlocked: false } });
  const result = plain((await autofill(locked)).data);
  assert.equal(result.state, 'locked');
  assert.equal(result.pageKey, 'iowa-manual');
  const cancelled = worker({ kind: 'manual', engine: generalEngine, general: financialPlan(), desktop: { getFieldsError: 'You cancelled this field request.' } });
  assert.equal((await autofill(cancelled)).data.message, 'Cancelled. Nothing was filled.');
  const unreadable = worker({ kind: 'manual', engine: generalEngine, general: { matched: [] } });
  assert.match((await autofill(unreadable)).data.message, /couldn’t be checked safely/);
  for (const w of [locked, cancelled, unreadable]) {
    assert.equal(w.calls.content.some(message => message.type === 'secondhand:generic:fill'), false);
    assert.equal((await w.panel({ type: 'ui:pageState' })).data.autopilot, false);
  }
  // Once the engine found fields, the page offers Autofill again, for example after unlocking.
  assert.equal((await locked.panel({ type: 'ui:pageState' })).data.page.todo, 'Check your answers, then click Continue.');
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
  // A widget on a site the user has not turned on is refused before anything is read.
  const calls = w.calls.native.length + w.calls.content.length;
  const elsewhere = { id: 'testextension', url: `${PANEL_URL}?surface=launcher`, frameId: 3, tab: { id: 7, url: 'https://example.com/' } };
  assert.equal((await w.send({ type: 'ui:autofill', confirmed: true }, elsewhere)).ok, false);
  const plainPage = { ...elsewhere, tab: { id: 7, url: 'http://example.com/' } };
  assert.equal(await w.send({ type: 'ui:autofill', confirmed: true }, plainPage), undefined);
  assert.equal(w.calls.native.length + w.calls.content.length, calls);
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

// A multi-screen walk: each Continue moves the tab to the next screen and fires
// Chrome's loading/complete updates, the way a real navigation does.
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function journey({ screens, desktop = {}, continueStays = false, engine = noSiteEngine } = {}) {
  const vault = { unlocked: true, values: { programSnap: 'yes', firstName: 'Synthetic private first', lastName: 'Synthetic private last' }, ...desktop };
  const calls = { native: [], content: [] };
  let index = 0;
  const filled = new Set();
  const tab = { id: 7, active: true, url: `${adapter.PORTAL}${screens[0].path}` };
  const events = {};
  const event = key => ({ addListener: value => { events[key] = value; } });
  const current = () => screens[index];
  function state() {
    const screen = current();
    const page = typeof screen.page === 'function' ? screen.page(filled) : screen.page;
    const fields = (screen.fields || []).filter(key => !filled.has(key));
    return { page, scan: { token: `t-${index}-${filled.size}`, recognizedPage: page.kind === 'fillable', fields: fields.map(key => ({ key, label: key })) } };
  }
  function navigate() {
    index = Math.min(index + 1, screens.length - 1);
    tab.url = `${adapter.PORTAL}${current().path}`;
    events.updated?.(7, { status: 'loading', url: tab.url });
    setImmediate(() => events.updated?.(7, { status: 'complete' }));
  }
  let listener;
  const chrome = {
    tabs: {
      get: async () => ({ ...tab }),
      sendMessage: async (_id, message) => {
        calls.content.push(message.type);
        if (message.type === 'secondhand:pageState') return state();
        if (message.type === 'secondhand:continue') { if (!continueStays) navigate(); return { continued: true, reason: 'Continued to the next screen.' }; }
        if (message.type === 'secondhand:fill') {
          const keys = message.fields.filter(key => message.values[key]);
          keys.forEach(key => filled.add(key));
          return { ok: true, filledCount: keys.length, skippedCount: message.fields.length - keys.length };
        }
        return generalPage(message, current().general || nothingPlanned()) || { focused: true };
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated')
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    scripting: { executeScript: async () => {} },
    runtime: {
      id: 'testextension', getURL: file => `chrome-extension://testextension/${file}`,
      onMessage: { addListener: callback => { listener = callback; } },
      connectNative: () => {
        let onMessage;
        return {
          onMessage: { addListener: callback => { onMessage = callback; } }, onDisconnect: { addListener: () => {} }, disconnect: () => {},
          postMessage: request => {
            calls.native.push(request);
            queueMicrotask(() => {
              const reply = data => onMessage({ id: request.id, ok: true, data });
              if (request.type === 'status') return reply({ unlocked: vault.unlocked, applicationCount: 0 });
              if (request.type === 'getFields') return reply({ values: Object.fromEntries(request.fields.filter(key => vault.values[key]).map(key => [key, vault.values[key]])) });
              return reply({ recorded: true });
            });
          }
        };
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'), 'utf8'),
    { chrome, SecondHandIowa: adapter, SecondHandGeneric: engine, importScripts: () => {}, crypto: webcrypto, setTimeout, clearTimeout, setImmediate, URL, Map, Set, console });
  const send = (message, sender = { id: 'testextension', url: PANEL_URL }) => new Promise(resolve => { if (!listener({ tabId: 7, ...message }, sender, resolve)) resolve(undefined); });
  return { calls, vault, events, send, filled: () => [...filled], at: () => current().name,
    userContinues: () => navigate(),
    leave: url => { tab.url = url; events.updated?.(7, { status: 'loading' }); setImmediate(() => events.updated?.(7, { status: 'complete' })); },
    returnTo: path => { tab.url = `${adapter.PORTAL}${path}`; index = Math.min(index + 1, screens.length - 1); events.updated?.(7, { status: 'loading' }); setImmediate(() => events.updated?.(7, { status: 'complete' })); },
    continues: () => calls.content.filter(type => type === 'secondhand:continue').length,
    getFields: () => calls.native.filter(call => call.type === 'getFields') };
}
const info = (name, path, pageKey) => ({ name, path, page: { kind: 'info', pageKey } });
const walk = () => [
  { name: 'household', path: '/applyForBenefits/guestLogin', fields: ['householdApplyProg'],
    page: filled => filled.has('householdApplyProg') ? { kind: 'blocked', pageKey: 'iowa-captcha', todo: 'Solve the CAPTCHA, then click Continue.', checklist: [] }
      : { kind: 'fillable', pageKey: 'iowa-program-intent', checklist: [{ key: 'householdApplyProg', label: 'q', required: true, status: 'missing' }] } },
  info('beforeYouStart', '/applyForBenefits/welcome', 'iowa-before-start'),
  { name: 'consent', path: '/applyForBenefits/letsGetStarted', page: { kind: 'blocked', pageKey: 'iowa-consent', todo: 'Read and accept Iowa’s consent, then click Continue.', checklist: [] } },
  info('importantInfo', '/applyForBenefits/importantInfo', 'iowa-information'),
  info('instructions', '/applyForBenefits/instructions', 'iowa-instructions'),
  { name: 'applicant', path: '/applyForBenefits/enterPersonalInfo', fields: ['firstName', 'lastName'],
    page: filled => ({ kind: 'fillable', pageKey: 'iowa-personal-information', todo: 'Check your answers, then click Save and Continue.',
      checklist: ['firstName', 'lastName'].map(key => ({ key, label: key, required: true, status: filled.has(key) ? 'complete' : 'missing' })) }) },
  { name: 'members', path: '/applyForBenefits/householdMembers', page: { kind: 'manual', pageKey: 'iowa-manual', checklist: [] } }
];
const lastResult = async w => (await w.send({ type: 'ui:pageState' })).data;

test('one click walks the application: fills, continues info screens, and waits wherever the applicant is needed', async () => {
  const w = journey({ screens: walk() });
  const first = (await w.send({ type: 'ui:autofill', confirmed: true })).data;
  assert.deepEqual(plain(w.getFields()[0].fields), ['programSnap', 'programFip', 'programMedicaid']);
  assert.deepEqual(w.filled(), ['householdApplyProg']);
  assert.match(first.message, /Filled 1\. Solve the CAPTCHA, then click Continue\./);
  assert.equal((await lastResult(w)).autopilot, true);

  w.userContinues(); await settle();            // applicant solved the CAPTCHA
  assert.equal(w.at(), 'consent', 'Before You Start was continued automatically');
  assert.equal((await lastResult(w)).result.message, 'Read and accept Iowa’s consent, then click Continue.');

  w.userContinues(); await settle();            // applicant accepted consent
  assert.equal(w.at(), 'applicant');
  assert.equal(w.continues(), 3);
  assert.equal(w.getFields().length, 2);
  assert.deepEqual(plain(w.getFields()[1].fields), Object.keys(adapter.definitions));
  const applicant = (await lastResult(w)).result;
  assert.match(applicant.message, /^Filled 2\. Check your answers, then click Save and Continue\.$/);

  w.userContinues(); await settle();            // applicant saved the page
  const unknown = await lastResult(w);
  assert.equal(unknown.autopilot, false);
  assert.match(unknown.result.message, /doesn’t know this page yet/);
  assert.equal(w.getFields().length, 2, 'values are only requested on pages that need them');
  assert.doesNotMatch(JSON.stringify(w.calls.native.filter(call => call.type !== 'getFields')), /Synthetic private/);
});

test('the walk fills an unknown page with the general engine, waits for the applicant, then carries on', async () => {
  const w = journey({ engine: generalEngine, desktop: { values: financialValues }, screens: [
    { name: 'financial', path: '/applyForBenefits/financialInformation', general: financialPlan(), page: { kind: 'manual', pageKey: 'iowa-manual', checklist: [] } },
    info('importantInfo', '/applyForBenefits/importantInfo', 'iowa-information'),
    { name: 'members', path: '/applyForBenefits/householdMembers', page: { kind: 'manual', pageKey: 'iowa-manual', checklist: [] } }
  ] });
  const first = (await w.send({ type: 'ui:autofill', confirmed: true })).data;
  assert.equal(first.message, 'Filled 2 · 2 need you. Check your answers, then click Continue.');
  await settle();
  w.events.updated(7, { status: 'complete' }); await settle();
  const waiting = await lastResult(w);
  assert.equal(w.at(), 'financial');
  assert.equal(waiting.autopilot, true);
  assert.equal(waiting.result.message, first.message);
  assert.equal(w.continues(), 0, 'SecondHand never clicks Continue on a page the general engine filled');
  assert.equal(w.calls.content.filter(type => type === 'secondhand:generic:fill').length, 1);

  w.userContinues(); await settle();            // applicant checked the answers and continued
  assert.equal(w.continues(), 1, 'the next information screen is continued as before');
  const unknown = await lastResult(w);
  assert.equal(w.at(), 'members');
  assert.equal(unknown.autopilot, false);
  assert.match(unknown.result.message, /doesn’t know this page yet/);
  assert.equal(w.getFields().length, 1);
});

test('Stop ends autofill; later page loads do nothing', async () => {
  const w = journey({ screens: [info('a', '/applyForBenefits/welcome', 'iowa-before-start'), info('b', '/applyForBenefits/importantInfo', 'iowa-information')], continueStays: true });
  await w.send({ type: 'ui:autofill', confirmed: true });
  assert.equal(w.continues(), 1);
  const stopped = (await w.send({ type: 'ui:stop', confirmed: true })).data;
  assert.equal(stopped.state, 'stopped');
  w.userContinues(); await settle();
  assert.equal(w.continues(), 1);
  assert.equal((await lastResult(w)).autopilot, false);
});

test('an info screen that does not navigate is never continued twice', async () => {
  const w = journey({ screens: [info('a', '/applyForBenefits/welcome', 'iowa-before-start')], continueStays: true });
  await w.send({ type: 'ui:autofill', confirmed: true });
  for (let i = 0; i < 3; i++) { await lastResult(w); w.events.updated(7, { status: 'complete' }); await settle(); }
  assert.equal(w.continues(), 1);
});

test('a locked vault stops autofill at the first page that needs values', async () => {
  const w = journey({ screens: walk().slice(1), desktop: { unlocked: false } });
  await w.send({ type: 'ui:autofill', confirmed: true });
  await settle();
  assert.equal(w.at(), 'consent');
  w.userContinues(); await settle();            // applicant accepted consent
  const state = await lastResult(w);
  assert.equal(w.at(), 'applicant');
  assert.equal(state.result.state, 'locked');
  assert.equal(state.autopilot, false);
  assert.equal(w.getFields().length, 0);
});

test('autofill stops after 15 automatic steps', async () => {
  const screens = Array.from({ length: 20 }, (_, i) => info(`info${i}`, `/applyForBenefits/step${i}`, 'iowa-information'));
  const w = journey({ screens });
  await w.send({ type: 'ui:autofill', confirmed: true });
  await settle(); await settle();
  assert.equal(w.continues(), 15);
  const state = await lastResult(w);
  assert.equal(state.autopilot, false);
  assert.match(state.result.message, /15 steps/);
});

test('the widget can stop its own tab only, and pages cannot start autofill', async () => {
  const w = journey({ screens: walk().slice(1, 3), continueStays: true });
  const launcher = { id: 'testextension', url: `${PANEL_URL}?surface=launcher`, frameId: 3, tab: { id: 7, url: `${adapter.PORTAL}/applyForBenefits/welcome` } };
  assert.equal(await w.send({ type: 'ui:autofill' }, launcher), undefined);
  await w.send({ type: 'ui:autofill', confirmed: true }, launcher);
  assert.equal(await w.send({ type: 'ui:stop' }, launcher), undefined);
  assert.equal((await w.send({ type: 'ui:stop', confirmed: true, tabId: 99 }, launcher)).data.state, 'stopped');
  assert.equal((await lastResult(w)).autopilot, false);
});

test('leaving Iowa turns autofill off even when Chrome hides the new URL', async () => {
  const w = journey({ screens: [info('a', '/applyForBenefits/welcome', 'iowa-before-start'), info('b', '/applyForBenefits/importantInfo', 'iowa-information')], continueStays: true });
  await w.send({ type: 'ui:autofill', confirmed: true });
  w.leave('https://example.com/');                 // no changeInfo.url without the tabs permission
  await settle();
  w.returnTo('/applyForBenefits/importantInfo');
  await settle();
  assert.equal(w.continues(), 1, 'coming back later does not resume');
  assert.equal((await lastResult(w)).autopilot, false);
});
