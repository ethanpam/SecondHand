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
  let advanced = 0;
  const opaque = { element: window.document.querySelector('button'), internalValue: 'SYNTHETIC-NAVIGATION-PRIVATE-STATE' };
  window.chrome = { runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener: callback => { listener = callback; } } } };
  window.SecondHandIowa = {
    isSupportedUrl: adapter.isSupportedUrl,
    scan: () => {
      const element = window.document.getElementById('firstName');
      const fields = element.value ? [] : [{ key: 'firstName', label: 'First name' }];
      return { supported: true, recognizedPage: true, fields, bindings: fields.map(field => ({ key: field.key, element })), ambiguous: [], skipped: [] };
    },
    probePage: () => ({ kind: 'fillable', pageKey: 'primary-applicant', heading: 'Enter Personal Information', reason: '', canAdvance: true, fields: [{ key: 'firstName', label: 'First name' }], requiredRemaining: 0, manualRemaining: 0 }),
    captureNavigation: () => opaque,
    advance: (_document, _url, snapshot) => { assert.equal(snapshot, opaque); advanced++; return { advanced: true, reason: 'Continued to the next page.' }; },
    fill: (_document, _url, bindings, values) => { for (const binding of bindings) binding.element.value = values[binding.key]; return { filled: bindings.map(binding => binding.key), skipped: [] }; }
  };
  window.eval(source('content.js'));
  return { window, frames, get advanced() { return advanced; },
    request(message, sender = { id: extensionId }) { let response; listener?.(message, sender, value => { response = value; }); return response; } };
}

test('on-page assistant is isolated in a fixed extension iframe only on the exact Iowa top-level portal', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  assert.ok(host);
  assert.equal(host.shadowRoot, null);
  assert.equal(page.frames.length, 1);
  assert.equal(page.frames[0].src, extensionURL('panel.html'));
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

test('page-state polls reuse unchanged preview tokens and never serialize field values or navigation snapshots', async t => {
  const page = content(t);
  await tick();
  const first = page.request({ type: 'secondhand:pageState' });
  const second = page.request({ type: 'secondhand:pageState' });
  assert.equal(second.scan.token, first.scan.token);
  assert.ok(second.nextToken);
  const serialized = JSON.stringify(second);
  assert.equal(serialized.includes('SYNTHETIC-NAVIGATION-PRIVATE-STATE'), false);
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

test('fill invalidates prior navigation; Next requires an authorized fresh one-use token', t => {
  const page = content(t);
  const first = page.request({ type: 'secondhand:pageState' });
  const filled = page.request({ type: 'secondhand:fill', token: first.scan.token, fields: ['firstName'], values: { firstName: 'Synthetic applicant' } });
  assert.equal(filled.filledCount, 1);
  assert.equal(JSON.stringify(filled).includes('Synthetic applicant'), false);
  assert.equal(page.request({ type: 'secondhand:next', token: first.nextToken, authorized: true }).advanced, false);
  const fresh = page.request({ type: 'secondhand:pageState' });
  assert.equal(page.request({ type: 'secondhand:next', token: fresh.nextToken, authorized: true }).advanced, true);
  assert.equal(page.advanced, 1);
  assert.equal(page.request({ type: 'secondhand:next', token: fresh.nextToken, authorized: true }).advanced, false);
  const denied = page.request({ type: 'secondhand:pageState' });
  assert.equal(page.request({ type: 'secondhand:next', token: denied.nextToken }).advanced, false);
  assert.equal(page.advanced, 1);
});

test('foreign extension messages cannot scan, navigate, or resize the assistant', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  assert.equal(page.request({ type: 'secondhand:pageState' }, { id: 'b'.repeat(32) }), undefined);
  assert.equal(page.request({ type: 'secondhand:panel', collapsed: true }, { id: 'b'.repeat(32) }), undefined);
  assert.notEqual(host.style.height, '54px');
  page.request({ type: 'secondhand:panel', collapsed: true });
  assert.equal(host.style.height, '54px');
  assert.equal(page.advanced, 0);
});

test('only the assistant overlay is hidden during portal checks and is restored even after an adapter error', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  const portalOverlay = page.window.document.createElement('div');
  portalOverlay.id = 'portal-overlay';
  page.window.document.body.append(portalOverlay);
  const observed = [];
  for (const method of ['scan', 'probePage', 'captureNavigation', 'fill', 'advance']) {
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
  assert.equal(host.style.visibility, '');
  const next = page.request({ type: 'secondhand:pageState' });
  page.request({ type: 'secondhand:next', token: next.nextToken, authorized: true });
  assert.equal(host.style.visibility, '');
  for (const method of ['scan', 'probePage', 'captureNavigation', 'fill', 'advance']) assert.ok(observed.includes(method));
  page.window.SecondHandIowa.probePage = () => { throw new Error('Synthetic failure'); };
  assert.equal(page.request({ type: 'secondhand:pageState' }).ok, false);
  assert.equal(host.style.visibility, '');
});

async function panel(t, initial = {}) {
  const dom = new JSDOM(source('panel.html'), { runScripts: 'outside-only', url: extensionURL('panel.html'), pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  const clicks = new Map();
  const originalListen = window.Element.prototype.addEventListener;
  window.Element.prototype.addEventListener = function (event, callback, options) {
    if (event === 'click' && this.id) clicks.set(this.id, callback);
    return originalListen.call(this, event, callback, options);
  };
  const requests = [];
  let automatic = { enabled: false, paused: false, reason: '', ...initial.automatic };
  window.chrome = { runtime: { sendMessage: async payload => {
    requests.push(structuredClone(payload));
    let data;
    if (payload.type === 'ui:pageState') data = {
      page: { kind: 'fillable', pageKey: 'primary-applicant', canAdvance: true, reason: '' },
      scan: { token: 'reviewed-preview', recognizedPage: true, fields: [{ key: 'firstName', label: 'First name' }] },
      busy: Boolean(initial.busy), automatic, lastResult: null
    };
    else if (payload.type === 'ui:desktopStatus') data = { unlocked: true };
    else if (payload.type === 'ui:auto') { automatic = { enabled: payload.enabled, paused: !payload.enabled, reason: payload.enabled ? '' : 'Paused by you.' }; data = { automatic }; }
    else data = { message: 'Synthetic operation complete.' };
    return { ok: true, data };
  } } };
  window.eval(source('panel.js'));
  await tick();
  return { window, requests, get: id => window.document.getElementById(id),
    async userClick(id) { clicks.get(id)({ isTrusted: true }); await tick(); },
    confirm() { window.document.getElementById('confirm').checked = true; window.document.getElementById('confirm').dispatchEvent(new window.Event('change')); } };
}

test('panel metadata refresh does not contact the vault, and untrusted clicks/messages cannot fill or start automatic mode', async t => {
  const view = await panel(t);
  assert.deepEqual(view.requests.map(request => request.type), ['ui:pageState']);
  view.confirm();
  view.get('fill-page').click();
  view.get('start-auto').click();
  view.window.postMessage({ type: 'ui:auto', enabled: true }, '*');
  await tick();
  assert.deepEqual(view.requests.map(request => request.type), ['ui:pageState']);
  assert.equal(view.get('fields').textContent, 'First name');
  await view.userClick('check-desktop');
  assert.equal(view.requests.filter(request => request.type === 'ui:desktopStatus').length, 1);
  assert.match(view.get('desktop-status').textContent, /Vault unlocked/);
});

test('trusted panel filling requires confirmation and sends reviewed metadata only, with no caller-selected tab', async t => {
  const view = await panel(t);
  await view.userClick('fill-page');
  assert.equal(view.requests.some(request => request.type === 'ui:fill'), false);
  view.confirm();
  await view.userClick('fill-page');
  const fill = view.requests.find(request => request.type === 'ui:fill');
  assert.deepEqual(fill, { type: 'ui:fill', token: 'reviewed-preview', fields: ['firstName'], confirmed: true });
  assert.equal(Object.hasOwn(fill, 'values'), false);
  assert.equal(Object.hasOwn(fill, 'tabId'), false);
  assert.equal(view.get('confirm').checked, false);
});

test('guided mode remains explicitly pausable while background work is busy', async t => {
  const view = await panel(t, { automatic: { enabled: true }, busy: true });
  assert.equal(view.get('pause-auto').hidden, false);
  assert.equal(view.get('pause-auto').disabled, false);
  assert.equal(view.get('fill-page').disabled, true);
  await view.userClick('pause-auto');
  assert.deepEqual(view.requests.find(request => request.type === 'ui:auto'), { type: 'ui:auto', enabled: false, confirmed: true });
});

test('a paused but authorized guided session can be stopped before filling manually', async t => {
  const view = await panel(t, { automatic: { enabled: true, paused: true, reason: 'A required question needs your answer.' } });
  assert.equal(view.get('pause-auto').hidden, false);
  assert.equal(view.get('pause-auto').textContent, 'Stop guided session');
  assert.equal(view.get('start-auto').hidden, false);
  assert.match(view.get('start-auto').textContent, /Resume/);
  await view.userClick('pause-auto');
  assert.deepEqual(view.requests.find(request => request.type === 'ui:auto'), { type: 'ui:auto', enabled: false, confirmed: true });
  view.confirm();
  assert.equal(view.get('fill-page').disabled, false);
});

test('collapsing the helper uses extension messaging and accessible state, never page postMessage', async t => {
  const view = await panel(t);
  await view.userClick('collapse');
  assert.deepEqual(view.requests.find(request => request.type === 'ui:panel'), { type: 'ui:panel', collapsed: true });
  assert.equal(view.get('panel-body').hidden, true);
  assert.equal(view.get('collapse').getAttribute('aria-expanded'), 'false');
  await view.userClick('collapse');
  assert.equal(view.get('panel-body').hidden, false);
  assert.equal(view.get('collapse').getAttribute('aria-expanded'), 'true');
});
