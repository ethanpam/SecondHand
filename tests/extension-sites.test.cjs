'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');

// Values created inside the worker's vm context have foreign prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const source = file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
const PANEL_URL = 'chrome-extension://testextension/panel.html';
const SITE_URL = 'https://pantry.example.org/intake?step=1';
const ORIGIN = 'https://pantry.example.org';
const SCRIPT_ID = 'site-pantry.example.org';
const SITE_SCRIPT = { id: SCRIPT_ID, matches: [`${ORIGIN}/*`], js: ['generic-adapter.js', 'generic-content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true };

// Stand-in for generic-adapter.js's pure helpers; the real engine has its own tests.
const generic = {
  requestKeys: keys => [...new Set(keys.flatMap(key => key === 'fullName' ? ['firstName', 'lastName'] : [key]))],
  deriveValues: values => ({ ...values, ...(values.firstName && values.lastName ? { fullName: `${values.firstName} ${values.lastName}` } : {}) })
};
const pantryPlan = () => ({
  token: 'plan-1',
  matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high' }, { id: 'sh-2', key: 'zip', confidence: 'high' }, { id: 'sh-3', key: 'householdSize', confidence: 'high' }],
  unmatched: [{ id: 'sh-4', label: 'Preferred pickup day', type: 'select-one', options: ['Monday', 'Friday'], required: true }]
});

function siteWorker({ url = SITE_URL, enabled = false, granted = enabled, desktop = {}, plan = pantryPlan(), frames = [], duringGetFields, keepAccess = false, discoveryError = false, topError, framesReply } = {}) {
  const tab = { id: 7, active: true, url };
  const log = [], native = [], content = [], injected = [], opened = [];
  const permissions = new Set(granted ? [`${ORIGIN}/*`] : []);
  const registered = new Map(enabled ? [[SCRIPT_ID, structuredClone(SITE_SCRIPT)]] : []);
  for (const frame of frames) {
    if (frame.granted || frame.enabled) permissions.add(`${frame.origin}/*`);
    if (frame.enabled) { const id = `frame-pantry.example.org--${new URL(frame.origin).hostname}`; registered.set(id, { ...SITE_SCRIPT, id, matches: [`${frame.origin}/*`] }); }
  }
  const vault = { reachable: true, unlocked: true, getFieldsError: null, trustError: null,
    values: { firstName: 'Synthetic private first', lastName: 'Synthetic private last', zip: '50309' }, ...desktop };
  const events = {};
  const event = key => ({ addListener: value => { events[key] = value; } });
  let listener;
  const chrome = {
    tabs: {
      get: async () => ({ ...tab }),
      sendMessage: async (tabId, message, options) => {
        content.push({ tabId, frameId: options?.frameId, ...plain(message) });
        if (options?.frameId === 0 && topError) throw new Error(topError);
        if (message.type === 'secondhand:generic:frames') return framesReply === undefined ? { origins: frames.map(frame => frame.origin) } : framesReply;
        const frame = frames.find(frame => frame.frameId === options?.frameId);
        const framePlan = frame?.plan || plan;
        if (message.type === 'secondhand:generic:plan') {
          if (frame?.planError) throw new Error('private frame failure');
          return structuredClone(framePlan);
        }
        if (message.type === 'secondhand:generic:fill') {
          if (frame?.fillError) throw new Error('private fill failure');
          if (frame?.fillResult) return structuredClone(frame.fillResult);
          if (message.token !== framePlan.token) return { ok: false, filled: [], skipped: [] };
          const filled = message.assignments.filter(item => message.values[item.key]).map(item => item.id);
          return { ok: true, filled, skipped: message.assignments.map(item => item.id).filter(id => !filled.includes(id)) };
        }
        if (message.type === 'secondhand:generic:focus') return { focused: message.id === 'sh-4' };
        throw new Error(`Unexpected content message ${message.type}`);
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated')
    },
    permissions: {
      contains: async ({ origins }) => { log.push('permissions.contains'); return origins.every(origin => permissions.has(origin)); },
      remove: async ({ origins }) => { log.push('permissions.remove'); if (!keepAccess) origins.forEach(origin => permissions.delete(origin)); return true; },
      request: async () => { log.push('permissions.request'); throw new Error('Only the side panel may request access, inside a click.'); }
    },
    scripting: {
      executeScript: async details => { log.push('scripting.executeScript'); injected.push(plain(details)); if (details.func && discoveryError) throw new Error('Cannot access an unapproved frame'); return details.func ? [{ frameId: 0, result: ORIGIN }, ...frames.map(frame => ({ frameId: frame.frameId, result: frame.origin }))] : []; },
      getRegisteredContentScripts: async ({ ids } = {}) => { log.push('scripting.getRegisteredContentScripts'); return (ids || [...registered.keys()]).filter(id => registered.has(id)).map(id => structuredClone(registered.get(id))); },
      registerContentScripts: async scripts => {
        log.push('scripting.registerContentScripts');
        for (const script of plain(scripts)) { if (registered.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`); registered.set(script.id, script); }
      },
      updateContentScripts: async scripts => {
        log.push('scripting.updateContentScripts');
        for (const script of plain(scripts)) { if (!registered.has(script.id)) throw new Error(`Nonexistent script ID '${script.id}'`); registered.set(script.id, { ...registered.get(script.id), ...script }); }
      },
      unregisterContentScripts: async ({ ids }) => {
        log.push('scripting.unregisterContentScripts');
        for (const id of ids) { if (!registered.delete(id)) throw new Error(`Nonexistent script ID '${id}'`); }
      }
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async options => { opened.push(plain(options)); } },
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
            native.push(plain(request)); log.push(`native:${request.type}`);
            queueMicrotask(() => {
              if (!vault.reachable) return onDisconnect();
              const reply = data => onMessage({ id: request.id, ok: true, data });
              const fail = error => onMessage({ id: request.id, ok: false, error });
              if (request.type === 'status') return reply({ unlocked: vault.unlocked, applicationCount: 0 });
              if (request.type === 'showApp') return reply({ shown: true });
              if (request.type === 'trustSite') return (vault.trustError || request.url === vault.declineOrigin) ? fail(vault.trustError || 'Declined') : reply({ trusted: true, origin: new URL(request.url).origin });
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
  vm.runInNewContext(source('background.js'),
    { chrome, SecondHandIowa: adapter, SecondHandGeneric: generic, importScripts: () => {}, crypto: webcrypto, setTimeout, clearTimeout, URL, Map, Set, console });
  const send = (message, sender) => new Promise(resolve => { if (!listener(message, sender, resolve)) resolve(undefined); });
  return {
    tab, log, native, content, injected, opened, permissions, registered, events, send,
    nativeTypes: () => native.map(call => call.type),
    contentTypes: () => content.map(call => call.type),
    panel: message => send({ tabId: 7, ...message }, { id: 'testextension', url: PANEL_URL }),
    launcher: message => send(message, { id: 'testextension', url: `${PANEL_URL}?surface=launcher`, frameId: 3, tab: { id: 7, url: tab.url } })
  };
}
const autofill = w => w.panel({ type: 'ui:autofill', confirmed: true });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

test('the worker loads the site engine next to the Iowa adapter and refuses to start without it', () => {
  const imported = [];
  const chrome = { runtime: { onMessage: { addListener: () => {} } }, tabs: {}, sidePanel: { setPanelBehavior: async () => {} } };
  assert.throws(() => vm.runInNewContext(source('background.js'), { chrome, SecondHandIowa: adapter, importScripts: (...files) => imported.push(...files), crypto: webcrypto, URL, Map, Set }), /generic-adapter\.js/);
  assert.deepEqual(imported, ['iowa-adapter.js', 'generic-adapter.js']);
});

test('turning a site on checks Chrome access, asks the desktop, then registers and injects the site scripts', async () => {
  const w = siteWorker({ granted: true });
  const response = await w.panel({ type: 'ui:enableSite', confirmed: true });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { enabled: true, origin: ORIGIN });
  const steps = ['permissions.contains', 'native:trustSite', 'scripting.registerContentScripts', 'scripting.executeScript'];
  assert.deepEqual(w.log.filter(name => steps.includes(name)), steps);
  assert.equal(w.log.includes('permissions.request'), false);
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'trustSite', url: `${ORIGIN}/intake` }]);
  assert.deepEqual(w.registered.get(SCRIPT_ID), SITE_SCRIPT);
  assert.deepEqual(w.injected, [{ target: { tabId: 7, frameIds: [0] }, files: ['generic-adapter.js', 'generic-content.js'] }]);
  assert.deepEqual(w.contentTypes(), []);

  const again = await w.panel({ type: 'ui:enableSite', confirmed: true });
  assert.equal(again.ok, true, again.error);
  assert.equal(w.log.filter(name => name === 'scripting.registerContentScripts').length, 1);
  assert.equal(w.log.includes('scripting.updateContentScripts'), true);
  assert.deepEqual([...w.registered.keys()], [SCRIPT_ID]);
});

test('a site is only turned on by a confirmed side-panel request with Chrome access and desktop approval', async () => {
  const w = siteWorker({ granted: true });
  assert.equal(await w.panel({ type: 'ui:enableSite' }), undefined);
  assert.equal(await w.launcher({ type: 'ui:enableSite', confirmed: true }), undefined);
  assert.equal(await w.send({ type: 'ui:enableSite', confirmed: true, tabId: 7 }, { id: 'testextension', url: SITE_URL, tab: { id: 7, url: SITE_URL } }), undefined);
  assert.deepEqual(w.native, []);

  const noAccess = siteWorker();
  const refused = await noAccess.panel({ type: 'ui:enableSite', confirmed: true });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Chrome/);
  assert.deepEqual(noAccess.native, []);
  assert.equal(noAccess.registered.size, 0);

  const declined = siteWorker({ granted: true, desktop: { trustError: 'You cancelled trusting this site.' } });
  const cancelled = await declined.panel({ type: 'ui:enableSite', confirmed: true });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cancelled trusting/);
  assert.equal(declined.registered.size, 0);
  assert.deepEqual(declined.injected, []);
  assert.equal(declined.permissions.size, 0, 'Chrome access is handed back when the desktop does not trust the site');

  for (const url of [`${adapter.PORTAL}/applyForBenefits/welcome`, 'http://pantry.example.org/intake', 'https://pantry.example.org:8443/intake', 'https://user@pantry.example.org/']) {
    const other = siteWorker({ url, granted: true });
    assert.equal((await other.panel({ type: 'ui:enableSite', confirmed: true })).ok, false, url);
    assert.deepEqual(other.native, [], url);
    assert.equal(other.registered.size, 0, url);
  }
});

test('page state tells the panel whether a site is on, with metadata only', async () => {
  const off = siteWorker({ granted: true });
  assert.deepEqual(plain((await off.panel({ type: 'ui:pageState' })).data),
    { page: { kind: 'general', pageKey: 'general' }, result: null, autopilot: false, site: { origin: ORIGIN, enabled: false, frames: [], ready: false } });
  const on = siteWorker({ enabled: true });
  assert.deepEqual(plain((await on.panel({ type: 'ui:pageState' })).data),
    { page: { kind: 'general', pageKey: 'general' }, result: null, autopilot: false, site: { origin: ORIGIN, enabled: true, frames: [], ready: true } });
  for (const w of [off, on]) assert.deepEqual(w.native, []);
  assert.deepEqual(off.content, []);
  assert.deepEqual(on.contentTypes(), ['secondhand:generic:frames']);
});

test('autofill on an approved site asks for the planned keys once and fills once without navigating', async () => {
  const w = siteWorker({ enabled: true });
  const response = await autofill(w);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields']);
  assert.deepEqual(w.native[1].fields, ['firstName', 'lastName', 'zip', 'householdSize']);
  assert.equal(w.native[1].url, `${ORIGIN}/intake`);
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan', 'secondhand:generic:fill']);
  assert.ok(w.content.every(call => call.tabId === 7 && call.frameId === 0));
  const fill = w.content.find(call => call.type === 'secondhand:generic:fill');
  assert.equal(fill.token, 'plan-1');
  assert.deepEqual(fill.assignments, [{ id: 'sh-1', key: 'fullName', guessed: false }, { id: 'sh-2', key: 'zip', guessed: false }]);
  assert.deepEqual(fill.values, { fullName: 'Synthetic private first Synthetic private last', zip: '50309' }, 'only the values being placed reach the page');
  assert.deepEqual(plain(response.data), { state: 'done', filled: 2, guessed: [], needYou: ['f0:sh-4', 'f0:sh-3'],
    message: 'Filled 2 · 2 need you. Check your answers before you submit.', pageKey: 'general' });
  assert.doesNotMatch(JSON.stringify(response), /Synthetic private/);

  const state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.equal(state.autopilot, false);
  assert.equal(state.result.message, response.data.message);
  w.events.updated(7, { status: 'complete' }); await settle();
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:frames'], 'nothing continues or navigates on its own');
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields']);
  assert.deepEqual(w.injected, [{ target: { tabId: 7, allFrames: true } }]);
  w.events.updated(7, { status: 'loading' });
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.result, null);
});

test('a form with nothing SecondHand recognizes never contacts the desktop', async () => {
  const w = siteWorker({ enabled: true, plan: { token: 'plan-1', matched: [], unmatched: pantryPlan().unmatched } });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.native, []);
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan']);
  assert.equal(result.state, 'done');
  assert.equal(result.filled, 0);
  assert.deepEqual(result.needYou, ['f0:sh-4']);
});

test('sites that are not turned on never reach the vault or the page', async () => {
  for (const setup of [{ granted: true }, { enabled: true, granted: false }, {}]) {
    const w = siteWorker(setup);
    const refused = await autofill(w);
    assert.equal(refused.ok, false, JSON.stringify(setup));
    assert.match(refused.error, /Turn on SecondHand/);
    for (const type of ['ui:autofill', 'ui:pageState', 'ui:showApp']) {
      const response = await w.launcher({ type, confirmed: true });
      assert.equal(response.ok, false, type);
    }
    assert.equal((await w.launcher({ type: 'ui:focusField', key: 'f0:sh-4', confirmed: true })).ok, false);
    assert.deepEqual(w.native, [], JSON.stringify(setup));
    assert.deepEqual(w.content, [], JSON.stringify(setup));
  }
});

test('the widget on an approved site is bound to its own tab and can open the side panel', async () => {
  const w = siteWorker({ enabled: true });
  assert.equal(await w.launcher({ type: 'ui:autofill' }), undefined);
  const response = await w.launcher({ type: 'ui:autofill', confirmed: true, tabId: 99 });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.data.filled, 2);
  assert.ok(w.content.every(call => call.tabId === 7));
  assert.equal(await w.launcher({ type: 'ui:desktopStatus' }), undefined);
  assert.equal(await w.launcher({ type: 'ui:disableSite', confirmed: true }), undefined);
  assert.deepEqual(plain((await w.launcher({ type: 'ui:openPanel', confirmed: true })).data), { opened: true });
  assert.deepEqual(w.opened, [{ tabId: 7 }]);
});

test('locked, offline, cancelled, and changed pages fill nothing on approved sites', async () => {
  const locked = siteWorker({ enabled: true, desktop: { unlocked: false } });
  assert.equal((await autofill(locked)).data.state, 'locked');
  assert.deepEqual(locked.nativeTypes(), ['status']);
  const offline = siteWorker({ enabled: true, desktop: { reachable: false } });
  const unreachable = (await autofill(offline)).data;
  assert.equal(unreachable.state, 'offline');
  assert.match(unreachable.message, /Open the SecondHand app/);
  const locking = siteWorker({ enabled: true, desktop: { getFieldsError: 'Unlock your local vault first.' } });
  assert.equal((await autofill(locking)).data.state, 'locked');
  const cancelled = siteWorker({ enabled: true, desktop: { getFieldsError: 'You cancelled this field request.' } });
  const declined = (await autofill(cancelled)).data;
  assert.equal(declined.state, 'error');
  assert.equal(declined.message, 'Cancelled. Nothing was filled.');
  const moved = siteWorker({ enabled: true, duringGetFields: tab => { tab.url = 'https://pantry.example.org/other'; } });
  assert.match((await autofill(moved)).data.message, /page changed/);
  for (const w of [locked, offline, locking, cancelled, moved]) {
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false);
    assert.equal(w.nativeTypes().filter(type => type === 'getFields').length <= 1, true);
  }
});

test('need-you focus on approved sites goes to the site engine by field id', async () => {
  const w = siteWorker({ enabled: true });
  assert.deepEqual(plain((await w.launcher({ type: 'ui:focusField', key: 'f0:sh-4', confirmed: true })).data), { focused: true });
  assert.deepEqual(plain((await w.panel({ type: 'ui:focusField', key: 'f0:sh-9' })).data), { focused: false });
  assert.deepEqual(w.content.map(({ type, id }) => ({ type, id })), [{ type: 'secondhand:generic:focus', id: 'sh-4' }, { type: 'secondhand:generic:focus', id: 'sh-9' }]);
  assert.equal(await w.launcher({ type: 'ui:focusField', key: 'input[type=password]', confirmed: true }), undefined);
});

test('turning a site off removes its script registration and Chrome access', async () => {
  const w = siteWorker({ enabled: true });
  assert.equal(await w.panel({ type: 'ui:disableSite' }), undefined);
  const response = await w.panel({ type: 'ui:disableSite', confirmed: true });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { enabled: false, origin: ORIGIN });
  assert.equal(w.registered.size, 0);
  assert.equal(w.permissions.size, 0);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.enabled, false);
  assert.equal((await autofill(w)).ok, false);
  assert.deepEqual(w.native, []);
});

// The content script that hosts the widget and runs the site engine on approved pages.
const extensionId = 'a'.repeat(32);
const extensionURL = file => `chrome-extension://${extensionId}/${file}`;
function siteContent(t, { url = SITE_URL, engine = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><form><label>Your name <input id="name"></label><label>Pickup day <select id="day"><option></option><option>Monday</option></select></label></form></body>', { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  const frames = [];
  const create = window.document.createElement.bind(window.document);
  window.document.createElement = name => { const element = create(name); if (name === 'iframe') frames.push(element); return element; };
  let listener;
  const calls = [];
  window.chrome = { runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener: callback => { listener = callback; } } } };
  if (engine) {
    window.SecondHandGeneric = {
      plan: doc => {
        calls.push('plan');
        return { token: 'plan-1', element: doc.getElementById('name'),
          matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high', element: doc.getElementById('name'), value: 'Synthetic private value' }],
          unmatched: [{ id: 'sh-2', label: 'Pickup day', type: 'select-one', options: ['Monday'], required: true, element: doc.getElementById('day'), value: 'Synthetic private value' }] };
      },
      fillFields: (doc, token, assignments, values) => {
        calls.push({ token, assignments: plain(assignments), values: plain(values) });
        doc.getElementById('name').value = values.fullName;
        return { ok: true, filled: ['sh-1'], skipped: [], values };
      },
      focusField: (doc, id) => { calls.push(`focus:${id}`); if (id !== 'sh-2') return false; doc.getElementById('day').focus(); return true; }
    };
  }
  window.eval(source('generic-content.js'));
  return { window, frames, calls,
    host: () => window.document.querySelector('[data-secondhand-assistant]'),
    request(message, sender = { id: extensionId }) { let response; listener?.(message, sender, value => { response = value; }); return response; } };
}

test('on approved sites the widget is a closed, full-size extension iframe in the top frame only', t => {
  const page = siteContent(t);
  const host = page.host();
  assert.ok(host);
  assert.equal(host.shadowRoot, null);
  assert.equal(page.frames.length, 1);
  assert.equal(page.frames[0].src, extensionURL('panel.html?surface=launcher'));
  assert.equal(page.frames[0].referrerPolicy, 'no-referrer');
  assert.equal(page.frames[0].getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
  assert.equal(host.style.height, '70px');
  assert.equal(host.style.position, 'fixed');
  page.window.eval(source('generic-content.js'));
  assert.equal(page.frames.length, 1, 'injecting again keeps one widget');

  const child = page.window.document.createElement('iframe');
  page.window.document.body.append(child);
  child.contentWindow.SecondHandGeneric = page.window.SecondHandGeneric;
  child.contentWindow.chrome = page.window.chrome;
  child.contentWindow.eval(source('generic-content.js'));
  assert.equal(child.contentWindow.document.querySelector('[data-secondhand-assistant]'), null);
  assert.equal(siteContent(t, { engine: false }).host(), null);
  assert.equal(siteContent(t, { url: 'http://pantry.example.org/intake' }).host(), null);
});

test('site plans and fills answer with field metadata only, never values or elements', t => {
  const page = siteContent(t);
  const plan = page.request({ type: 'secondhand:generic:plan' });
  assert.deepEqual(plain(plan), { token: 'plan-1', matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high' }],
    unmatched: [{ id: 'sh-2', label: 'Pickup day', type: 'select-one', options: ['Monday'], required: true }] });
  const filled = page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic private name' } });
  assert.deepEqual(plain(filled), { ok: true, filled: ['sh-1'], skipped: [], rejected: [] });
  assert.deepEqual(page.calls[1], { token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic private name' } });
  assert.equal(page.window.document.getElementById('name').value, 'Synthetic private name');
  assert.doesNotMatch(JSON.stringify([plan, filled]), /Synthetic private/);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-2' })), { focused: true });
  assert.equal(page.window.document.activeElement.id, 'day');
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-9' })), { focused: false });
});

test('other extensions, malformed fills, and Iowa messages reach nothing on approved sites', t => {
  const page = siteContent(t);
  const foreign = { id: 'b'.repeat(32) };
  assert.equal(page.request({ type: 'secondhand:generic:plan' }, foreign), undefined);
  assert.equal(page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} }, foreign), undefined);
  assert.equal(page.request({ type: 'secondhand:generic:focus', id: 'sh-2' }, foreign), undefined);
  for (const message of [{ token: 'plan-1', assignments: 'sh-1', values: {} }, { token: 'plan-1', assignments: [], values: [] }, { token: 7, assignments: [], values: {} }]) {
    assert.equal(page.request({ type: 'secondhand:generic:fill', ...message }).ok, false);
  }
  for (const type of ['secondhand:pageState', 'secondhand:continue', 'secondhand:fill', 'secondhand:focusField']) assert.equal(page.request({ type }), undefined, type);
  assert.deepEqual(page.calls, []);
});

test('the widget is hidden while the site engine checks the page and restored after an engine error', t => {
  const page = siteContent(t);
  const host = page.host();
  const seen = [];
  for (const method of ['plan', 'fillFields', 'focusField']) {
    const original = page.window.SecondHandGeneric[method];
    page.window.SecondHandGeneric[method] = (...args) => { seen.push([method, host.style.visibility]); return original(...args); };
  }
  page.request({ type: 'secondhand:generic:plan' });
  page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic' } });
  page.request({ type: 'secondhand:generic:focus', id: 'sh-2' });
  assert.deepEqual(seen, [['plan', 'hidden'], ['fillFields', 'hidden'], ['focusField', 'hidden']]);
  assert.equal(host.style.visibility, '');
  page.window.SecondHandGeneric.plan = () => { throw new Error('Synthetic failure'); };
  const failed = page.request({ type: 'secondhand:generic:plan' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /could not be checked safely/);
  assert.equal(host.style.visibility, '');
});

const FRAME_ORIGIN = 'https://form.jotform.com';
const secondFrame = (extra = {}) => ({ origin: FRAME_ORIGIN, frameId: 4, ...extra });
test('pageState discovers pending frames through the approved top frame only', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame()] });
  assert.deepEqual(plain((await w.panel({ type: 'ui:pageState' })).data.site), {
    origin: ORIGIN, enabled: true, ready: true, frames: [{ origin: FRAME_ORIGIN, enabled: false }]
  });
  assert.deepEqual(w.content, [{ tabId: 7, frameId: 0, type: 'secondhand:generic:frames' }]);
  assert.deepEqual(w.injected, []);
});
test('enableFrames re-derives origins, trusts each, registers allFrames and injects', async () => {
  const other = 'https://forms.example.org';
  const w = siteWorker({ enabled: true, frames: [secondFrame({ granted: true }), { origin: other, frameId: 5, granted: true }] });
  const result = await w.panel({ type: 'ui:enableFrames', confirmed: true, origins: ['https://evil.example'] });
  assert.equal(result?.ok, true);
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'trustSite', url: FRAME_ORIGIN }, { type: 'trustSite', url: other }]);
  for (const origin of [FRAME_ORIGIN, other]) assert.equal(w.registered.get(`frame-pantry.example.org--${new URL(origin).hostname}`).allFrames, true);
  assert.ok(w.injected.some(call => call.target.allFrames && call.files.includes('generic-content.js')));
});
test('declining a frame trust returns all pending permissions and registers nothing', async () => {
  const other = 'https://forms.example.org';
  const w = siteWorker({ enabled: true, frames: [secondFrame({ granted: true }), { origin: other, frameId: 5, granted: true }], desktop: { declineOrigin: other } });
  const result = await w.panel({ type: 'ui:enableFrames', confirmed: true });
  assert.equal(result?.ok, false);
  assert.deepEqual([...w.registered.keys()], [SCRIPT_ID]);
  assert.deepEqual([...w.permissions], [`${ORIGIN}/*`]);
  assert.deepEqual(w.injected, []);
});
test('site fill requests the union once and uses each frame token', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, plan: { token: 'child-token', matched: [{ id: 'sh-1', key: 'zip' }], unmatched: [] } })] });
  const result = (await autofill(w)).data;
  assert.equal(result.filled, 3);
  assert.deepEqual(plain(result.needYou), ['f0:sh-4', 'f0:sh-3']);
  assert.equal(w.native.filter(call => call.type === 'getFields').length, 1);
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:fill').map(call => [call.frameId, call.token]), [[0, 'plan-1'], [4, 'child-token']]);
});
for (const failure of [{ planError: true }, { fillError: true }, { plan: { token: 'bad', matched: [null], unmatched: [] } }, { fillResult: { ok: true, filled: 'bad' } }]) {
  test(`frame failure is a fixed error: ${JSON.stringify(failure)}`, async () => {
    const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, ...failure })] });
    const result = (await autofill(w)).data;
    assert.equal(result.state, 'error');
    assert.equal(result.message, 'Part of this form couldn’t be filled safely. Fill it yourself.');
  });
}
test('rejected ids are need-you even when also reported filled', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, fillResult: { ok: true, filled: ['sh-1', 'sh-2'], rejected: ['sh-2'] } })] });
  const result = (await autofill(w)).data;
  assert.equal(result.filled, 3);
  assert.ok(result.needYou.includes('f4:sh-2'));
});
test('pending embedded forms explain the second approval step', async () => {
  const w = siteWorker({ enabled: true, plan: { token: 'empty', matched: [], unmatched: [] }, frames: [secondFrame()] });
  const result = (await autofill(w)).data;
  assert.equal(result.message, 'This form is inside form.jotform.com. Click “Also turn on the embedded form” in the SecondHand side panel.');
  assert.equal(w.content.some(call => call.frameId === 4), false);
  assert.deepEqual(w.native, []);
});
test('prefixed focus routes to an enabled frame and rejects malformed ids', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true })] });
  assert.equal((await w.panel({ type: 'ui:focusField', key: 'f4:sh-4' }))?.data.focused, true);
  assert.deepEqual(w.content.at(-1), { tabId: 7, frameId: 4, type: 'secondhand:generic:focus', id: 'sh-4' });
  for (const key of ['f1234567:sh-4', 'f4:1bad', 'f4:' + 'a'.repeat(61)]) assert.equal(await w.panel({ type: 'ui:focusField', key }), undefined);
});
test('disableSite revokes enabled embedded origins and detects retained access', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true })] });
  assert.equal((await w.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  assert.equal(w.registered.size, 0);
  assert.equal(w.permissions.size, 0);
  assert.deepEqual(w.injected, []);
  const kept = siteWorker({ enabled: true, keepAccess: true });
  assert.equal((await kept.panel({ type: 'ui:disableSite', confirmed: true })).ok, false);
});

test('visible iframe discovery is https only, deduplicated, and excludes the page origin', t => {
  const page = siteContent(t);
  const doc = page.window.document;
  for (const [src, style] of [
    ['https://form.jotform.com/one', ''], ['https://form.jotform.com/two', ''],
    ['https://forms.example.org/', ''], [ORIGIN + '/same', ''], ['http://insecure.example/', ''],
    ['https://hidden.example/', 'display:none'], ['https://invisible.example/', 'visibility:hidden']
  ]) {
    const frame = doc.createElement('iframe'); frame.src = src; frame.style.cssText = style;
    frame.getClientRects = () => [{ width: 300, height: 200 }];
    doc.body.append(frame);
  }
  const wrapper = doc.createElement('div'); wrapper.hidden = true;
  const hidden = doc.createElement('iframe'); hidden.src = 'https://ancestor-hidden.example/';
  hidden.getClientRects = () => [{ width: 300, height: 200 }]; wrapper.append(hidden); doc.body.append(wrapper);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:frames' })), { origins: [FRAME_ORIGIN, 'https://forms.example.org'] });
});
test('an https subframe answers plans without creating a widget', t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: FRAME_ORIGIN, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.reconfigure({ windowTop: {} });
  let listener;
  dom.window.chrome = { runtime: { id: extensionId, onMessage: { addListener: callback => { listener = callback; } } } };
  dom.window.SecondHandGeneric = { plan: () => pantryPlan() };
  dom.window.eval(source('generic-content.js'));
  assert.equal(typeof listener, 'function');
  let result;
  listener({ type: 'secondhand:generic:plan' }, { id: extensionId }, value => { result = value; });
  assert.equal(result.token, 'plan-1');
  assert.equal(dom.window.document.querySelector('[data-secondhand-assistant]'), null);
});
test('content fill reports rejected ids without values', t => {
  const page = siteContent(t);
  page.window.SecondHandGeneric.fillFields = () => ({ ok: true, filled: [], skipped: [], rejected: ['sh-1'], values: { secret: 'private' } });
  const result = page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} });
  assert.deepEqual(plain(result), { ok: true, filled: [], skipped: [], rejected: ['sh-1'] });
});

test('malformed engine fill arrays fail visibly instead of becoming an empty success', t => {
  const page = siteContent(t);
  for (const result of [
    { ok: true, filled: 'bad', skipped: [] },
    { ok: true, filled: [], skipped: [], rejected: null },
    { ok: true, filled: [42], skipped: [] }
  ]) {
    page.window.SecondHandGeneric.fillFields = () => result;
    assert.equal(page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} }).ok, false);
  }
});
test('a malformed rejected list makes a frame fill fail', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, fillResult: { ok: true, filled: [], rejected: null } })] });
  assert.equal((await autofill(w)).data.state, 'error');
});

test('a pending form explains approval before attempting all-frame script execution', async () => {
  const w = siteWorker({ enabled: true, plan: { token: 'empty', matched: [], unmatched: [] }, frames: [secondFrame()], discoveryError: true });
  const result = (await autofill(w)).data;
  assert.match(result.message, /Click “Also turn on the embedded form”/);
  assert.deepEqual(w.injected, []);
});

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
test('missing top receiver preserves enabled page state with ready false', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  const reply = await w.panel({ type: 'ui:pageState' });
  assert.equal(reply.ok, true);
  assert.deepEqual(plain(reply.data.site), { origin: ORIGIN, enabled: true, frames: [], ready: false });
});
test('loading page state does not message the top document', async () => {
  const w = siteWorker({ enabled: true }); w.tab.status = 'loading';
  const reply = await w.panel({ type: 'ui:pageState' });
  assert.equal(reply.data.site.ready, false);
  assert.deepEqual(w.content, []);
});
test('a ready content script reports ready true', async () => {
  const w = siteWorker({ enabled: true });
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.ready, true);
});
test('malformed frames and other receiver errors still fail page state', async () => {
  for (const setup of [{ framesReply: {} }, { topError: 'The message port closed before a response was received.' }]) {
    const w = siteWorker({ enabled: true, ...setup });
    assert.equal((await w.panel({ type: 'ui:pageState' })).ok, false);
  }
});
const ownedFrameId = `frame-pantry.example.org--form.jotform.com`;
function registerOwnedFrame(w, id = ownedFrameId) {
  w.registered.set(id, { ...SITE_SCRIPT, id, matches: [`${FRAME_ORIGIN}/*`] });
  w.permissions.add(`${FRAME_ORIGIN}/*`);
}
test('enableFrames records the top site in its persistent frame registration', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ granted: true })] });
  assert.equal((await w.panel({ type: 'ui:enableFrames', confirmed: true })).ok, true);
  assert.deepEqual(w.registered.get(ownedFrameId), { ...SITE_SCRIPT, id: ownedFrameId, matches: [`${FRAME_ORIGIN}/*`] });
});
test('a frame owned by another site is enabled when permission is held', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame()] });
  registerOwnedFrame(w, 'frame-other.example.org--form.jotform.com');
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.frames[0].enabled, true);
  w.permissions.delete(`${FRAME_ORIGIN}/*`);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.frames[0].enabled, false);
});
test('disable without a receiver removes owned frame registrations and access', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  registerOwnedFrame(w);
  assert.equal((await w.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  assert.equal(w.registered.size, 0);
  assert.equal(w.permissions.size, 0);
  assert.deepEqual(w.content, []);
});
test('disable preserves frame permission while another registration uses it', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  registerOwnedFrame(w);
  const other = 'frame-other.example.org--form.jotform.com';
  registerOwnedFrame(w, other);
  assert.equal((await w.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  assert.deepEqual([...w.registered.keys()], [other]);
  assert.deepEqual([...w.permissions], [`${FRAME_ORIGIN}/*`]);
});
test('autofill without a top receiver asks for reload', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  assert.equal((await autofill(w)).data.message, 'Reload this page, then click Autofill.');
  assert.deepEqual(w.native, []);
});
