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
  let automatic = { enabled: false, paused: false, reason: '', ...initial.automatic };
  const state = {
    page: { kind: 'fillable', pageKey: 'primary-applicant', canAdvance: true, reason: '', checklist: [
      { key: 'firstName', label: 'First name', status: 'missing', required: true, fillable: true },
      { key: 'lastName', label: 'Last name', status: 'complete', required: true, fillable: true },
      { key: 'middleName', label: 'Middle name', status: 'optional', required: false, fillable: true },
      { key: 'unverified', label: 'Additional question', status: 'manual', required: false, fillable: false }
    ] },
    scan: { token: 'reviewed-preview', recognizedPage: true, fields: [{ key: 'firstName', label: 'First name' }] },
    busy: Boolean(initial.busy), missingProfileFields: initial.missingProfileFields || [], lastResult: null
  };
  window.chrome = { tabs: {
    query: async () => [tabs.current],
    onActivated: { addListener: callback => { listeners.activated = callback; } },
    onUpdated: { addListener: callback => { listeners.updated = callback; } }
  }, runtime: { sendMessage: async payload => {
    requests.push(structuredClone(payload));
    let data;
    if (payload.type === 'ui:pageState') data = initial.pageState ? await initial.pageState({ ...state, automatic }) : { ...state, automatic };
    else if (payload.type === 'ui:desktopStatus') data = { unlocked: true };
    else if (payload.type === 'ui:auto') { automatic = { enabled: payload.enabled, paused: false, reason: payload.enabled ? '' : 'Paused by you.' }; data = { automatic }; }
    else if (payload.type === 'ui:focusField') data = { focused: true };
    else data = { message: 'Synthetic operation complete.' };
    return { ok: true, data };
  } } };
  window.eval(source('panel.js'));
  await tick();
  return { window, requests, state, tabs, listeners, get: id => window.document.getElementById(id),
    async userClick(target) { const element = typeof target === 'string' ? window.document.getElementById(target) : target; clicks.get(element)({ isTrusted: true }); await tick(); },
    confirm() { window.document.getElementById('confirm').checked = true; window.document.getElementById('confirm').dispatchEvent(new window.Event('change')); } };
}

test('native sidebar metadata does not contact the vault and rejects untrusted actions', async t => {
  const view = await panel(t);
  assert.deepEqual(view.requests, [{ type: 'ui:pageState', tabId: 7 }]);
  view.confirm(); view.get('fill-page').click(); view.get('start-auto').click();
  view.window.postMessage({ type: 'ui:auto', enabled: true }, '*');
  await tick();
  assert.deepEqual(view.requests.map(request => request.type), ['ui:pageState']);
  assert.equal(view.get('fields').textContent, 'First name');
  await view.userClick('check-desktop');
  assert.equal(view.requests.filter(request => request.type === 'ui:desktopStatus').length, 1);
  assert.match(view.get('desktop-status').textContent, /Vault unlocked/);
});

test('trusted sidebar filling confirms reviewed metadata and derives its target from the active tab', async t => {
  const view = await panel(t);
  await view.userClick('fill-page');
  assert.equal(view.requests.some(request => request.type === 'ui:fill'), false);
  view.confirm(); await view.userClick('fill-page');
  assert.deepEqual(view.requests.find(request => request.type === 'ui:fill'), { type: 'ui:fill', token: 'reviewed-preview', fields: ['firstName'], confirmed: true, tabId: 7 });
  assert.equal(view.get('confirm').checked, false);
});

test('guided mode can be stopped while busy, paused, or waiting for missing information', async t => {
  for (const automatic of [{ enabled: true }, { enabled: true, paused: true }, { enabled: true, waitingForInfo: true, reason: 'First name is missing.' }]) {
    const view = await panel(t, { automatic, busy: !automatic.paused && !automatic.waitingForInfo });
    assert.equal(view.get('pause-auto').hidden, false);
    assert.equal(view.get('pause-auto').disabled, false);
    assert.equal(view.get('fill-page').disabled, true);
    if (automatic.waitingForInfo) {
      assert.equal(view.get('guided-state').textContent, 'WAITING FOR MISSING INFORMATION');
      assert.match(view.get('automatic-reason').textContent, /check again automatically/);
      assert.equal(view.get('start-auto').textContent, 'Check and continue →');
    }
    await view.userClick('pause-auto');
    assert.deepEqual(view.requests.find(request => request.type === 'ui:auto'), { type: 'ui:auto', enabled: false, confirmed: true, tabId: 7 });
  }
});

test('checklist distinguishes completion, required and optional blanks, manual answers, and approved profile gaps', async t => {
  const view = await panel(t, { missingProfileFields: ['firstName'] });
  const row = key => view.window.document.querySelector(`[data-key="${key}"]`);
  assert.match(row('firstName').textContent, /Missing from saved profile/);
  assert.match(row('lastName').textContent, /✓.*Complete/);
  assert.match(row('middleName').textContent, /Optional · blank/);
  assert.match(row('unverified').textContent, /Needs manual review/);
  assert.equal(view.get('checklist-summary').textContent, '1/4 complete · 1 required');
  row('firstName').click(); await tick();
  assert.equal(view.requests.some(request => request.type === 'ui:focusField'), false);
  await view.userClick(row('firstName'));
  assert.deepEqual(view.requests.find(request => request.type === 'ui:focusField'), { type: 'ui:focusField', key: 'firstName', tabId: 7 });
  view.state.page.checklist[0].status = 'complete';
  await view.userClick('refresh');
  assert.match(row('firstName').textContent, /✓.*Complete/);
  assert.equal(view.get('checklist-summary').textContent, '2/4 complete');
});

test('tab activation clears stale checklist and confirmation without sending data to an unsupported tab', async t => {
  const view = await panel(t); view.confirm();
  view.tabs.current = { id: 8, url: 'https://example.invalid/' };
  view.listeners.activated({ tabId: 8 }); await tick();
  assert.equal(view.get('page-checklist').children.length, 0);
  assert.equal(view.get('confirm').checked, false);
  assert.equal(view.get('fill-page').disabled, true);
  assert.match(view.get('status').textContent, /Open Iowa/);
  assert.deepEqual(view.requests, [{ type: 'ui:pageState', tabId: 7 }]);
});

test('a late old-tab response cannot restore a checklist or authorize a stale fill', async t => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const view = await panel(t, { pageState: () => response });
  view.tabs.current = { id: 8, url: 'https://example.invalid/' };
  view.listeners.activated({ tabId: 8 });
  resolve({ ...view.state, automatic: { enabled: false } }); await tick(); await tick();
  assert.equal(view.get('page-checklist').children.length, 0);
  assert.equal(view.get('refresh').disabled, false);
  assert.match(view.get('status').textContent, /Open Iowa/);
});

test('launcher has no page or vault access and opens the native sidebar only after a trusted click', async t => {
  const view = await panel(t, { launcher: true });
  assert.deepEqual(view.requests, []);
  assert.equal(view.get('sidepanel').hidden, true);
  view.get('open-side-panel').click(); await tick();
  assert.deepEqual(view.requests, []);
  await view.userClick('open-side-panel');
  assert.deepEqual(view.requests, [{ type: 'ui:openPanel', confirmed: true }]);
  assert.match(view.get('launcher-status').textContent, /sidebar/);
});
