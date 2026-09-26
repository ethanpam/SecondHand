'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const extensionId = 'a'.repeat(32);
const extensionURL = file => `chrome-extension://${extensionId}/${file}`;
const source = file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function content(t, url = `${adapter.PORTAL}/applicant`) {
  const dom = new JSDOM('<!doctype html><body><form><input id="firstName"><button type="button">Save and Continue</button></form></body>', { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  let listener;
  const frames = [];
  const create = window.document.createElement.bind(window.document);
  window.document.createElement = name => { const element = create(name); if (name === 'iframe') frames.push(element); return element; };
  let kind = 'fillable';
  window.chrome = { runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener: callback => { listener = callback; } } } };
  window.SecondHandIowa = {
    isSupportedUrl: adapter.isSupportedUrl,
    scan: () => {
      const element = window.document.getElementById('firstName');
      const fields = element.value ? [] : [{ key: 'firstName', label: 'First name' }];
      return { supported: true, recognizedPage: true, fields, bindings: fields.map(field => ({ key: field.key, element })), ambiguous: [], skipped: [] };
    },
    probePage: () => ({ kind, pageKey: 'primary-applicant', heading: 'Enter Personal Information', reason: '', fields: [{ key: 'firstName', label: 'First name' }], requiredRemaining: 0, manualRemaining: 0 }),
    focusField: (_document, _url, key) => { if (key !== 'firstName') return false; window.document.getElementById('firstName').focus(); return true; },
    fill: (_document, _url, bindings, values) => { for (const binding of bindings) binding.element.value = values[binding.key]; return { filled: bindings.map(binding => binding.key), skipped: [] }; }
  };
  window.eval(source('content.js'));
  return { window, frames, setKind: value => { kind = value; },
    request(message, sender = { id: extensionId }) { let response; listener?.(message, sender, value => { response = value; }); return response; } };
}

test('on-page assistant is isolated in a fixed extension iframe only on the exact Iowa top-level portal', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  assert.ok(host);
  assert.equal(host.shadowRoot, null);
  assert.equal(page.frames.length, 1);
  assert.equal(page.frames[0].src, extensionURL('panel.html?surface=launcher'));
  assert.equal(page.frames[0].referrerPolicy, 'no-referrer');
  assert.equal(page.frames[0].getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  page.window.eval(source('content.js'));
  assert.equal(page.frames.length, 1);

  const wrong = content(t, 'https://hhsservices.iowa.gov.evil.example/apspssp/ssp.portal');
  assert.equal(wrong.window.document.querySelector('[data-secondhand-assistant]'), null);
  const outside = content(t, 'https://hhsservices.iowa.gov/unrelated');
  assert.equal(outside.frames.length, 0);
  const child = page.window.document.createElement('iframe');
  page.window.document.body.append(child);
  child.contentWindow.SecondHandIowa = page.window.SecondHandIowa;
  child.contentWindow.chrome = page.window.chrome;
  child.contentWindow.eval(source('content.js'));
  assert.equal(child.contentWindow.secondHandContentInstalled, undefined);
});

test('page-state polls reuse unchanged preview tokens and never serialize field values', async t => {
  const page = content(t);
  await tick();
  const first = page.request({ type: 'secondhand:pageState' });
  const second = page.request({ type: 'secondhand:pageState' });
  assert.equal(second.scan.token, first.scan.token);
  const serialized = JSON.stringify(second);
  assert.equal(serialized.includes('bindings'), false);
  assert.equal(serialized.includes('values'), false);
  page.window.document.querySelector('form').setAttribute('data-step', 'changed');
  await tick();
  const changed = page.request({ type: 'secondhand:pageState' });
  assert.notEqual(changed.scan.token, first.scan.token);
  page.window.document.getElementById('firstName').value = 'SYNTHETIC PRIVATE NAME';
  const populated = page.request({ type: 'secondhand:pageState' });
  assert.equal(JSON.stringify(populated).includes('SYNTHETIC PRIVATE NAME'), false);
  assert.equal(populated.scan.fields.length, 0);
});

test('fill uses a fresh one-use preview and pageState carries no navigation token', t => {
  const page = content(t);
  const first = page.request({ type: 'secondhand:pageState' });
  assert.equal('nextToken' in first, false);
  const filled = page.request({ type: 'secondhand:fill', token: first.scan.token, fields: ['firstName'], values: { firstName: 'Synthetic applicant' } });
  assert.equal(filled.filledCount, 1);
  assert.equal(JSON.stringify(filled).includes('Synthetic applicant'), false);
  assert.equal(page.request({ type: 'secondhand:fill', token: first.scan.token, fields: ['firstName'], values: { firstName: 'Replay' } }).ok, false);
  assert.equal(page.request({ type: 'secondhand:next', token: 'anything', authorized: true }), undefined);
});

test('widget host is a full bar on fillable pages and a small pill elsewhere', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
  assert.equal(host.style.height, '62px');
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'pill');
  assert.equal(host.style.height, '46px');
  assert.equal(host.style.width, '46px');
  page.setKind('fillable');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
});

test('foreign extension messages cannot scan or focus, and the launcher cannot expand over the form', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  assert.equal(page.request({ type: 'secondhand:pageState' }, { id: 'b'.repeat(32) }), undefined);
  assert.equal(host.style.height, '62px');
  assert.equal(page.request({ type: 'secondhand:focusField', key: 'firstName' }, { id: 'b'.repeat(32) }), undefined);
  assert.equal(page.request({ type: 'secondhand:focusField', key: 'firstName' }).focused, true);
  assert.equal(page.window.document.activeElement.id, 'firstName');
  assert.equal(page.request({ type: 'secondhand:focusField', key: 'unverified' }).focused, false);
});

test('only the assistant overlay is hidden during portal checks and is restored even after an adapter error', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  const portalOverlay = page.window.document.createElement('div');
  portalOverlay.id = 'portal-overlay';
  page.window.document.body.append(portalOverlay);
  const observed = [];
  for (const method of ['scan', 'probePage', 'fill']) {
    const original = page.window.SecondHandIowa[method];
    page.window.SecondHandIowa[method] = (...args) => {
      assert.equal(host.style.visibility, 'hidden');
      assert.equal(portalOverlay.style.visibility, '');
      observed.push(method);
      return original(...args);
    };
  }
  const first = page.request({ type: 'secondhand:pageState' });
  assert.equal(host.style.visibility, '');
  page.request({ type: 'secondhand:fill', token: first.scan.token, fields: ['firstName'], values: { firstName: 'Synthetic' } });
  for (const method of ['scan', 'probePage', 'fill']) assert.ok(observed.includes(method));
  page.window.SecondHandIowa.probePage = () => { throw new Error('Synthetic failure'); };
  assert.equal(page.request({ type: 'secondhand:pageState' }).ok, false);
  assert.equal(host.style.visibility, '');
});

const plainRequests = requests => JSON.parse(JSON.stringify(requests));
const doneResult = { state: 'done', filled: 3, needYou: ['firstName', 'lastName'], message: 'Filled 3 · 2 need you. Review, then click Continue in Iowa’s form.', pageKey: 'iowa-personal-information' };

async function panel(t, initial = {}) {
  const dom = new JSDOM(source('panel.html'), { runScripts: 'outside-only', url: extensionURL(`panel.html${initial.launcher ? '?surface=launcher' : ''}`), pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  const clicks = new Map();
  const originalListen = window.Element.prototype.addEventListener;
  window.Element.prototype.addEventListener = function (event, callback, options) {
    if (event === 'click') clicks.set(this, callback);
    return originalListen.call(this, event, callback, options);
  };
  const requests = [];
  const listeners = {};
  const tabs = { current: { id: 7, url: `${adapter.PORTAL}/applicant` } };
  const state = {
    page: { kind: initial.kind || 'fillable', pageKey: 'iowa-personal-information', reason: 'Complete this step in Iowa’s form.', checklist: [
      { key: 'firstName', label: 'First name', status: 'missing', required: true, fillable: true },
      { key: 'lastName', label: 'Last name', status: 'complete', required: true, fillable: true },
      { key: 'middleName', label: 'Middle name', status: 'optional', required: false, fillable: true },
      { key: 'unverified', label: 'Additional question', status: 'manual', required: false, fillable: false }
    ] },
    scan: { token: 'preview', recognizedPage: true, fields: [{ key: 'firstName', label: 'First name' }] },
    result: initial.result || null
  };
  const desktop = { connected: true, unlocked: true, ...initial.desktop };
  window.chrome = { tabs: {
    query: async () => [tabs.current],
    onActivated: { addListener: callback => { listeners.activated = callback; } },
    onUpdated: { addListener: callback => { listeners.updated = callback; } }
  }, runtime: { sendMessage: async payload => {
    requests.push(structuredClone(payload));
    let data;
    if (payload.type === 'ui:pageState') data = initial.pageState ? await initial.pageState(state) : structuredClone(state);
    else if (payload.type === 'ui:autofill') { state.result = initial.autofill || doneResult; data = structuredClone(state.result); }
    else if (payload.type === 'ui:desktopStatus') data = { ...desktop };
    else if (payload.type === 'ui:focusField') data = { focused: true };
    else if (payload.type === 'ui:showApp') data = { shown: true };
    else if (payload.type === 'ui:openPanel') data = { opened: true };
    else return { ok: false, error: `Unexpected ${payload.type}` };
    return { ok: true, data };
  } } };
  window.eval(source('panel.js'));
  await tick(); await tick();
  const get = id => window.document.getElementById(id);
  return { window, requests, state, tabs, listeners, get,
    types: () => requests.map(request => request.type),
    row: key => window.document.querySelector(`[data-key="${key}"]`),
    async userClick(target) { const element = typeof target === 'string' ? get(target) : target; clicks.get(element)({ isTrusted: true }); await tick(); await tick(); } };
}

test('side panel reads page and desktop state, has no guided or field-picker controls, and ignores untrusted clicks', async t => {
  const view = await panel(t);
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:pageState', tabId: 7 }, { type: 'ui:desktopStatus' }]);
  for (const id of ['start-auto', 'pause-auto', 'fill-page', 'fill-next', 'confirm', 'fields']) assert.equal(view.get(id), null, id);
  assert.equal(view.get('panel-autofill').disabled, false);
  view.get('panel-autofill').click();
  view.window.postMessage({ type: 'ui:autofill', confirmed: true }, '*');
  await tick();
  assert.equal(view.types().includes('ui:autofill'), false);
  assert.match(view.get('desktop-status').textContent, /unlocked/);
  assert.equal(view.get('desktop-action').hidden, true);
});

test('trusted side-panel Autofill targets the active tab, shows the result, and rechecks the desktop', async t => {
  const view = await panel(t);
  await view.userClick('panel-autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:autofill')), { type: 'ui:autofill', confirmed: true, tabId: 7 });
  assert.match(view.get('status').textContent, /Filled 3 · 2 need you/);
  assert.equal(view.types().filter(type => type === 'ui:desktopStatus').length, 2);
});

test('checklist uses plain labels and a trusted row click finds the field', async t => {
  const view = await panel(t);
  assert.match(view.row('firstName').textContent, /First name.*Needs you/);
  assert.match(view.row('lastName').textContent, /✓.*Done/);
  assert.match(view.row('middleName').textContent, /Optional/);
  assert.match(view.row('unverified').textContent, /Do it yourself/);
  assert.equal(view.get('checklist-summary').textContent, '1 of 4 done');
  view.row('firstName').click(); await tick();
  assert.equal(view.types().includes('ui:focusField'), false);
  await view.userClick(view.row('firstName'));
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:focusField')), { type: 'ui:focusField', key: 'firstName', tabId: 7 });
});

test('desktop line shows locked with Unlock, and not running without an action', async t => {
  const locked = await panel(t, { desktop: { unlocked: false } });
  assert.match(locked.get('desktop-status').textContent, /locked/);
  assert.equal(locked.get('desktop-action').hidden, false);
  await locked.userClick('desktop-action');
  assert.deepEqual(plainRequests(locked.requests.find(request => request.type === 'ui:showApp')), { type: 'ui:showApp', confirmed: true });
  const offline = await panel(t, { desktop: { connected: false, unlocked: false } });
  assert.match(offline.get('desktop-status').textContent, /isn’t running/);
  assert.equal(offline.get('desktop-action').hidden, true);
});

test('pages with nothing to fill disable Autofill and explain the step', async t => {
  const view = await panel(t, { kind: 'manual' });
  assert.equal(view.get('panel-autofill').disabled, true);
  assert.match(view.get('status').textContent, /Complete this step/);
});

test('tab activation clears a stale checklist without sending data to an unsupported tab', async t => {
  const view = await panel(t);
  view.tabs.current = { id: 8, url: 'https://example.invalid/' };
  view.listeners.activated({ tabId: 8 }); await tick(); await tick();
  assert.equal(view.get('page-checklist').children.length, 0);
  assert.equal(view.get('panel-autofill').disabled, true);
  assert.match(view.get('status').textContent, /Open Iowa/);
  assert.deepEqual(view.requests.filter(request => request.type === 'ui:pageState').map(request => request.tabId), [7]);
});

test('a late old-tab response cannot restore a checklist', async t => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const view = await panel(t, { pageState: () => response });
  view.tabs.current = { id: 8, url: 'https://example.invalid/' };
  view.listeners.activated({ tabId: 8 });
  resolve(structuredClone(view.state)); await tick(); await tick();
  assert.equal(view.get('page-checklist').children.length, 0);
  assert.match(view.get('status').textContent, /Open Iowa/);
});

test('widget on a fillable page offers one-click Autofill and cycles through what needs you', async t => {
  const view = await panel(t, { launcher: true });
  assert.equal(view.get('sidepanel').hidden, true);
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:pageState' }]);
  assert.equal(view.get('widget').hidden, false);
  assert.equal(view.get('pill').hidden, true);
  assert.equal(view.get('need-you').hidden, true);
  view.get('autofill').click(); await tick();
  assert.equal(view.types().includes('ui:autofill'), false);
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:autofill')), { type: 'ui:autofill', confirmed: true });
  assert.equal(view.get('widget-text').textContent, 'Filled 3');
  assert.equal(view.get('need-you').hidden, false);
  assert.equal(view.get('need-you').textContent, '2 need you');
  for (let i = 0; i < 3; i++) await view.userClick('need-you');
  assert.deepEqual(view.requests.filter(request => request.type === 'ui:focusField').map(request => request.key), ['firstName', 'lastName', 'firstName']);
  assert.ok(view.requests.filter(request => request.type === 'ui:focusField').every(request => request.confirmed === true && !('tabId' in request)));
  await view.userClick('details');
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:openPanel', confirmed: true });
});

test('widget is a pill off the applicant page and opens the side panel from it', async t => {
  const view = await panel(t, { launcher: true, kind: 'manual' });
  assert.equal(view.get('widget').hidden, true);
  assert.equal(view.get('pill').hidden, false);
  await view.userClick('pill');
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:openPanel', confirmed: true });
});

test('widget shows Unlock when the vault is locked and returns to Autofill after bringing the app forward', async t => {
  const view = await panel(t, { launcher: true, autofill: { state: 'locked', filled: 0, needYou: [], message: 'Unlock SecondHand to autofill.', pageKey: 'iowa-personal-information' } });
  await view.userClick('autofill');
  assert.equal(view.get('unlock').hidden, false);
  assert.equal(view.get('autofill').hidden, true);
  await view.userClick('unlock');
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:showApp', confirmed: true });
  assert.equal(view.get('autofill').hidden, false);
  assert.match(view.get('widget-text').textContent, /Unlock SecondHand, then click Autofill/);
});

test('widget reports an unreachable desktop and restores an earlier result after reloading', async t => {
  const offline = await panel(t, { launcher: true, autofill: { state: 'offline', filled: 0, needYou: [], message: 'Open the SecondHand app, then click Autofill again.', pageKey: 'iowa-personal-information' } });
  await offline.userClick('autofill');
  assert.match(offline.get('widget-text').textContent, /Open the SecondHand app/);
  assert.equal(offline.get('autofill').hidden, false);
  const restored = await panel(t, { launcher: true, result: doneResult });
  assert.equal(restored.get('widget-text').textContent, 'Filled 3');
  assert.equal(restored.get('need-you').textContent, '2 need you');
});
