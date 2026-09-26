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
const BUILD = source('panel.js').match(/const BUILD = '([^']+)'/)[1];
const OUTDATED = 'SecondHand was updated. Open chrome://extensions and click the reload arrow on SecondHand, then reload this page.';

const plain = value => JSON.parse(JSON.stringify(value));

// Stand-in for generic-adapter.js; the real engine has its own tests. Plans carry
// elements and values so the tests can prove only metadata leaves the page.
function generalEngine(window, calls, { matched = true } = {}) {
  const element = () => window.document.getElementById('firstName');
  return {
    plan: () => {
      calls.push('plan');
      return { token: 'plan-1', element: element(),
        matched: matched ? [{ id: 'sh-1-0', key: 'householdAdults', confidence: 'high', element: element(), value: 'Synthetic private value' }] : [],
        unmatched: [{ id: 'sh-1-1', label: 'Is anyone blind?', type: 'radio', options: ['Yes', 'No'], required: true, element: element(), value: 'Synthetic private value' }] };
    },
    fillFields: (_doc, token, assignments, values) => { calls.push({ token, assignments: plain(assignments), values: plain(values) }); return { ok: true, filled: ['sh-1-0'], skipped: [], rejected: ['sh-1-9'], pending: [], values }; },
    settle: async (_doc, token, result) => { calls.push(`settle:${token}`); return result; },
    focusField: (_doc, id) => { calls.push(`focus:${id}`); if (id !== 'sh-1-1') return false; element().focus(); return true; }
  };
}

function content(t, url = `${adapter.PORTAL}/applicant`, { engine = true, matched = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><form><input id="firstName"><button type="button">Save and Continue</button></form></body>', { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  let listener;
  const frames = [];
  const create = window.document.createElement.bind(window.document);
  window.document.createElement = name => { const element = create(name); if (name === 'iframe') frames.push(element); return element; };
  let kind = 'fillable';
  let todo;
  let continued = 0;
  const calls = [];
  window.chrome = { runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener: callback => { listener = callback; } } } };
  if (engine) window.SecondHandGeneric = generalEngine(window, calls, { matched });
  window.SecondHandIowa = {
    isSupportedUrl: adapter.isSupportedUrl,
    scan: () => {
      const element = window.document.getElementById('firstName');
      const fields = element.value ? [] : [{ key: 'firstName', label: 'First name' }];
      return { supported: true, recognizedPage: true, fields, bindings: fields.map(field => ({ key: field.key, element })), ambiguous: [], skipped: [] };
    },
    probePage: () => ({ kind, todo, pageKey: 'primary-applicant', heading: 'Enter Personal Information', reason: '', fields: [{ key: 'firstName', label: 'First name' }], requiredRemaining: 0, manualRemaining: 0 }),
    continuePage: () => { continued++; return { continued: true, reason: 'Continued to the next screen.' }; },
    focusField: (_document, _url, key) => { if (key !== 'firstName') return false; window.document.getElementById('firstName').focus(); return true; },
    fill: (_document, _url, bindings, values) => { for (const binding of bindings) binding.element.value = values[binding.key]; return { filled: bindings.map(binding => binding.key), skipped: [] }; }
  };
  window.eval(source('content.js'));
  return { window, frames, calls, setKind: (value, instruction) => { kind = value; todo = instruction; }, get continued() { return continued; },
    host: () => window.document.querySelector('[data-secondhand-assistant]'),
    request(message, sender = { id: extensionId }) { let response; listener?.(message, sender, value => { response = value; }); return response; },
    // For answers the content script sends after awaiting (fills settle their choices first).
    requestAsync(message, sender = { id: extensionId }) {
      return new Promise(resolve => { if (listener?.(message, sender, resolve) !== true) resolve(undefined); });
    } };
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

test('continue runs the adapter once for our extension only', t => {
  const page = content(t);
  assert.equal(page.request({ type: 'secondhand:continue' }, { id: 'b'.repeat(32) }), undefined);
  assert.equal(page.continued, 0);
  assert.deepEqual({ ...page.request({ type: 'secondhand:continue' }) }, { continued: true, reason: 'Continued to the next screen.' });
  assert.equal(page.continued, 1);
});

test('widget stays full size on info screens and steps that need the applicant', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  for (const [kind, todo, size] of [['info', undefined, 'full'], ['blocked', 'Solve the CAPTCHA, then click Continue.', 'full'], ['manual', 'Pick the correct address, then click Continue.', 'full'], ['manual', undefined, 'pill'], ['unsupported', undefined, 'pill']]) {
    page.setKind(kind, todo);
    page.window.dispatchEvent(new page.window.Event('popstate'));
    assert.equal(host.getAttribute('data-secondhand-size'), size, `${kind} ${todo}`);
  }
});

test('widget host is a full bar on fillable pages and a small pill elsewhere', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
  assert.equal(host.style.height, '70px');
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'pill');
  assert.equal(host.style.height, '46px');
  assert.equal(host.style.width, '46px');
  page.setKind('fillable');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
});

test('the Iowa content script loads the general engine before content.js', () => {
  assert.deepEqual(JSON.parse(source('manifest.json')).content_scripts[0].js, ['iowa-adapter.js', 'generic-adapter.js', 'content.js']);
});

test('on Iowa pages the adapter has not verified, the general engine plans, fills, and focuses with metadata only', async t => {
  const page = content(t);
  page.setKind('manual');
  const plan = page.request({ type: 'secondhand:generic:plan' });
  assert.deepEqual(plain(plan), { token: 'plan-1', matched: [{ id: 'sh-1-0', key: 'householdAdults', confidence: 'high' }],
    unmatched: [{ id: 'sh-1-1', label: 'Is anyone blind?', type: 'radio', options: ['Yes', 'No'], required: true }] });
  const filled = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1-0', key: 'householdAdults', guessed: false }], values: { householdAdults: '2' } });
  assert.deepEqual(plain(filled), { ok: true, filled: ['sh-1-0'], skipped: [], rejected: ['sh-1-9'] }, 'answers the page refused come back');
  assert.deepEqual(page.calls[1], { token: 'plan-1', assignments: [{ id: 'sh-1-0', key: 'householdAdults', guessed: false }], values: { householdAdults: '2' } });
  assert.equal(page.calls[2], 'settle:plan-1', 'choices the page confirms a moment later are settled before answering');
  assert.doesNotMatch(JSON.stringify([plan, filled]), /Synthetic private/);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-1-1' })), { focused: true });
  assert.equal(page.window.document.activeElement.id, 'firstName');
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-9-9' })), { focused: false });
});

test('verified Iowa pages and pages with Iowa instructions never reach the general engine', t => {
  const page = content(t);
  for (const [kind, todo] of [['fillable'], ['info'], ['blocked', 'Solve the CAPTCHA, then click Continue.'], ['manual', 'Pick the correct address, then click Continue.'], ['unsupported']]) {
    page.setKind(kind, todo);
    assert.equal(page.request({ type: 'secondhand:generic:plan' }).ok, false, kind);
    assert.equal(page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1-0', key: 'householdAdults', guessed: false }], values: { householdAdults: '2' } }).ok, false, kind);
  }
  assert.deepEqual(page.calls, []);
});

test('general-engine messages refuse other extensions, malformed fills, and a missing engine', t => {
  const page = content(t);
  page.setKind('manual');
  const foreign = { id: 'b'.repeat(32) };
  assert.equal(page.request({ type: 'secondhand:generic:plan' }, foreign), undefined);
  assert.equal(page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} }, foreign), undefined);
  assert.equal(page.request({ type: 'secondhand:generic:focus', id: 'sh-1-1' }, foreign), undefined);
  for (const message of [{ token: 'plan-1', assignments: 'sh-1-0', values: {} }, { token: 'plan-1', assignments: [], values: [] }, { token: 7, assignments: [], values: {} }]) {
    assert.equal(page.request({ type: 'secondhand:generic:fill', ...message }).ok, false);
  }
  assert.deepEqual(page.calls, []);
  const missing = content(t, undefined, { engine: false });
  missing.setKind('manual');
  assert.ok(missing.host(), 'Iowa pages keep their widget without the general engine');
  const refused = missing.request({ type: 'secondhand:generic:plan' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Reinstall/);
});

test('the widget grows to full size once the general engine finds fields on an unknown Iowa page', t => {
  const page = content(t);
  const host = page.host();
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'pill');
  const seen = [];
  const engine = page.window.SecondHandGeneric;
  const plan = engine.plan;
  engine.plan = doc => { seen.push(host.style.visibility); return plan(doc); };
  page.request({ type: 'secondhand:generic:plan' });
  assert.deepEqual(seen, ['hidden'], 'the widget is hidden while the engine reads the page');
  assert.equal(host.style.visibility, '');
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
  assert.equal(host.style.height, '70px');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'full', 'stays full on the same page');

  const nothing = content(t, undefined, { matched: false });
  nothing.setKind('manual');
  nothing.request({ type: 'secondhand:generic:plan' });
  assert.equal(nothing.host().getAttribute('data-secondhand-size'), 'pill', 'a page with nothing to fill keeps the pill');
});

test('foreign extension messages cannot scan or focus, and the launcher cannot expand over the form', t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  assert.equal(page.request({ type: 'secondhand:pageState' }, { id: 'b'.repeat(32) }), undefined);
  assert.equal(host.style.height, '70px');
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
  const tabs = { current: initial.tab || { id: 7, url: `${adapter.PORTAL}/applicant` } };
  // A site other than Iowa: metadata only, never a checklist or autopilot.
  const state = initial.site ? { page: { kind: 'general', pageKey: 'general' }, result: initial.result || null, autopilot: false, site: { ...initial.site } } : {
    page: { kind: initial.kind || 'fillable', pageKey: 'iowa-personal-information', reason: 'Complete this step in Iowa’s form.', checklist: [
      { key: 'firstName', label: 'First name', status: 'missing', required: true, fillable: true },
      { key: 'lastName', label: 'Last name', status: 'complete', required: true, fillable: true },
      { key: 'middleName', label: 'Middle name', status: 'optional', required: false, fillable: true },
      { key: 'unverified', label: 'Additional question', status: 'manual', required: false, fillable: false }
    ] },
    scan: { token: 'preview', recognizedPage: true, fields: [{ key: 'firstName', label: 'First name' }] },
    result: initial.result || null,
    autopilot: Boolean(initial.autopilot)
  };
  const desktop = { connected: true, unlocked: true, ...initial.desktop };
  window.chrome = { tabs: {
    query: async () => [tabs.current],
    onActivated: { addListener: callback => { listeners.activated = callback; } },
    onUpdated: { addListener: callback => { listeners.updated = callback; } }
  }, permissions: { request: async permissions => {
    requests.push({ type: 'permissions.request', ...structuredClone(permissions) });
    return initial.grant ?? true;
  } }, runtime: { sendMessage: async payload => {
    requests.push(structuredClone(payload));
    // An outdated worker ignores messages it doesn't know: Chrome resolves with no response.
    if (initial.silent === true || initial.silent?.includes(payload.type)) return undefined;
    let data;
    if (payload.type === 'ui:ping') data = { build: initial.build ?? BUILD };
    else if (payload.type === 'ui:plan') data = structuredClone(initial.plan ?? { unmatched: [], allowedKeys: ['email'] });
    else if (payload.type === 'ui:pageState') data = initial.pageState ? await initial.pageState(state) : structuredClone(state);
    else if (payload.type === 'ui:autofill') { state.result = initial.autofill || doneResult; state.autopilot = Boolean(initial.autopilotAfterAutofill); data = structuredClone(state.result); }
    else if (payload.type === 'ui:stop') { state.autopilot = false; state.result = { state: 'stopped', filled: 0, needYou: [], message: 'Autofill stopped.', pageKey: 'iowa-personal-information' }; data = structuredClone(state.result); }
    else if (payload.type === 'ui:desktopStatus') data = { ...desktop };
    else if (payload.type === 'ui:focusField') data = { focused: true };
    else if (payload.type === 'ui:showApp') data = { shown: true };
    else if (payload.type === 'ui:openPanel') data = { opened: true };
    else if (payload.type === 'ui:enableSite' || payload.type === 'ui:disableSite') {
      state.site.enabled = payload.type === 'ui:enableSite';
      data = { enabled: state.site.enabled, origin: state.site.origin };
    } else return { ok: false, error: `Unexpected ${payload.type}` };
    return { ok: true, data };
  } } };
  // Chrome's on-device AI exists only where a test provides a stand-in.
  if (initial.LanguageModel) window.LanguageModel = initial.LanguageModel;
  // Run the page's own scripts, in the order panel.html lists them.
  for (const [, file] of source('panel.html').matchAll(/<script src="([^"]+)"/g)) window.eval(source(file));
  await tick(); await tick();
  const get = id => window.document.getElementById(id);
  const clickNow = target => clicks.get(typeof target === 'string' ? get(target) : target)({ isTrusted: true });
  return { window, requests, state, tabs, listeners, get, clickNow,
    types: () => requests.map(request => request.type),
    row: key => window.document.querySelector(`[data-key="${key}"]`),
    async userClick(target) { clickNow(target); await tick(); await tick(); } };
}

test('side panel reads page and desktop state, has no guided or field-picker controls, and ignores untrusted clicks', async t => {
  const view = await panel(t);
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState', tabId: 7 }, { type: 'ui:desktopStatus' }]);
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
  // Plain http, and an https tab whose address Chrome hides until the user invokes SecondHand.
  for (const [id, url] of [[8, 'http://example.invalid/'], [9, undefined]]) {
    view.tabs.current = { id, url };
    view.listeners.activated({ tabId: id }); await tick(); await tick();
    assert.equal(view.get('page-checklist').children.length, 0);
    assert.equal(view.get('panel-autofill').disabled, true);
    assert.equal(view.get('site-enable').hidden, true);
    assert.match(view.get('status').textContent, /Open Iowa/);
  }
  assert.deepEqual(view.requests.filter(request => request.type === 'ui:pageState').map(request => request.tabId), [7]);
});

test('a late old-tab response cannot restore a checklist', async t => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const view = await panel(t, { pageState: () => response });
  view.tabs.current = { id: 8, url: 'http://example.invalid/' };
  view.listeners.activated({ tabId: 8 });
  resolve(structuredClone(view.state)); await tick(); await tick();
  assert.equal(view.get('page-checklist').children.length, 0);
  assert.match(view.get('status').textContent, /Open Iowa/);
});

test('widget on a fillable page offers one-click Autofill and cycles through what needs you', async t => {
  const view = await panel(t, { launcher: true });
  assert.equal(view.get('sidepanel').hidden, true);
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState' }]);
  assert.equal(view.get('widget').hidden, false);
  assert.equal(view.get('pill').hidden, true);
  assert.equal(view.get('need-you').hidden, true);
  view.get('autofill').click(); await tick();
  assert.equal(view.types().includes('ui:autofill'), false);
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:autofill')), { type: 'ui:autofill', confirmed: true });
  assert.equal(view.types().includes('ui:plan'), false, 'Iowa never asks the on-device AI');
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

const waitingResult = { state: 'waiting', filled: 0, needYou: [], message: 'Solve the CAPTCHA, then click Continue.', pageKey: 'iowa-personal-information' };

test('while autofill is on, the widget shows Stop and the current instruction', async t => {
  const view = await panel(t, { launcher: true, autofill: { ...doneResult, needYou: [], todo: 'Check your answers, then click Save and Continue.' }, autopilotAfterAutofill: true });
  await view.userClick('autofill');
  assert.equal(view.get('stop').hidden, false);
  assert.equal(view.get('autofill').hidden, true);
  assert.equal(view.get('widget-text').textContent, 'Filled 3 · Check your answers, then click Save and Continue.');
  view.state.result = waitingResult;
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('widget-text').textContent, 'Solve the CAPTCHA, then click Continue.', 'polls follow the worker while autofill is on');
  view.get('stop').click(); await tick();
  assert.equal(view.types().includes('ui:stop'), false);
  await view.userClick('stop');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:stop')), { type: 'ui:stop', confirmed: true });
  assert.equal(view.get('stop').hidden, true);
  assert.equal(view.get('autofill').hidden, false);
  assert.equal(view.get('widget-text').textContent, 'Autofill stopped.');
});

test('a widget that loads mid-run picks up the running autofill', async t => {
  const view = await panel(t, { launcher: true, kind: 'blocked', autopilot: true, result: waitingResult });
  assert.equal(view.get('widget').hidden, false, 'instructions stay readable on steps that need you');
  assert.equal(view.get('stop').hidden, false);
  assert.equal(view.get('widget-text').textContent, 'Solve the CAPTCHA, then click Continue.');
});

test('side panel turns its button into Stop while autofill is on', async t => {
  const view = await panel(t, { autopilot: true, result: waitingResult });
  assert.equal(view.get('panel-autofill').textContent, 'Stop autofill');
  await view.userClick('panel-autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:stop')), { type: 'ui:stop', confirmed: true, tabId: 7 });
  assert.equal(view.get('panel-autofill').textContent, 'Autofill this page');
});

test('a worker that never answers gets exact reload steps in the widget and the side panel', async t => {
  const widget = await panel(t, { launcher: true, silent: true });
  assert.equal(widget.get('widget').hidden, false, 'the steps stay readable instead of a pill');
  assert.equal(widget.get('pill').hidden, true);
  assert.equal(widget.get('widget-text').textContent, OUTDATED);
  assert.equal(widget.get('widget').classList.contains('outdated'), true);
  const side = await panel(t, { silent: true });
  assert.equal(side.get('status').textContent, OUTDATED);
  assert.equal(side.get('panel-autofill').disabled, true);

  // A worker that answers page state but not a newer message is outdated too.
  const partial = await panel(t, { launcher: true, silent: ['ui:autofill'], build: BUILD });
  assert.equal(partial.get('widget-text').textContent, 'Iowa SNAP · ready');
  await partial.userClick('autofill');
  assert.equal(partial.get('widget-text').textContent, OUTDATED);
  const before = partial.requests.length;
  partial.window.document.dispatchEvent(new partial.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(partial.requests.length, before, 'an outdated worker is not polled again');
});

test('a worker from another build gets the same reload steps even though it answers', async t => {
  const widget = await panel(t, { launcher: true, build: 'older-build' });
  assert.deepEqual(plainRequests(widget.requests), [{ type: 'ui:ping' }]);
  assert.equal(widget.get('widget-text').textContent, OUTDATED);
  assert.equal(widget.get('widget-text').title, OUTDATED);
  await widget.userClick('autofill');
  assert.equal(widget.types().includes('ui:autofill'), false);
  const side = await panel(t, { build: 'older-build' });
  assert.deepEqual(plainRequests(side.requests), [{ type: 'ui:ping' }]);
  assert.equal(side.get('status').textContent, OUTDATED);
  assert.equal(side.get('status').classList.contains('error'), true);
  assert.equal(side.get('panel-autofill').disabled, true);
  side.listeners.activated({ tabId: 7 }); await tick(); await tick();
  assert.equal(side.get('status').textContent, OUTDATED, 'switching tabs keeps the reload steps');
  assert.equal(side.types().includes('ui:pageState'), false);
});

test('the pill is a fixed circle that cannot stretch into an oval', () => {
  assert.match(source('panel.css'), /\.pill\{width:46px;height:46px;flex:none/);
});

// Sites other than Iowa, turned on one at a time.
const SITE = { id: 7, url: 'https://pantry.example.org/intake?step=1' };
const ORIGIN = 'https://pantry.example.org';
const siteDone = { state: 'done', filled: 2, guessed: 0, needYou: ['sh-4', 'sh-3'], message: 'Filled 2 · 2 need you. Check your answers before you submit.', pageKey: 'general' };
// What the worker's ui:plan answers: the questions the rules left open, and the keys the AI may use.
const openPlan = { unmatched: [
  { id: 'sh-1-2', label: 'Where can we email you?', type: 'email', options: [], required: false },
  { id: 'sh-1-1', label: 'Preferred pickup day', type: 'select-one', options: ['Monday', 'Friday'], required: true },
  { id: 'sh-1-3', label: '  ', type: 'text', options: [], required: false }
], allowedKeys: ['email', 'phone'] };
// A stand-in for Chrome's LanguageModel (the Prompt API).
function languageModel({ availability = 'available', answer = JSON.stringify({ 'sh-1-2': 'email', 'sh-1-1': null }), failure } = {}) {
  const calls = { availability: 0, create: [], prompt: [] };
  const LanguageModel = {
    async availability() { calls.availability++; return availability; },
    async create(options) {
      calls.create.push(options);
      return { async prompt(text, options) { calls.prompt.push({ text, options }); if (failure) throw failure; return answer; }, destroy() {} };
    }
  };
  return { LanguageModel, calls };
}
const AI_UNAVAILABLE = 'On-device AI unavailable. Rule matches only.';

test('side panel offers to turn SecondHand on for an https tab that is not Iowa, and ignores untrusted clicks', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: false } });
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState', tabId: 7 }, { type: 'ui:desktopStatus' }]);
  assert.equal(view.get('site-enable').hidden, false);
  assert.equal(view.get('site-enable').textContent, 'Turn on SecondHand for this site');
  assert.equal(view.get('panel-autofill').hidden, true);
  assert.equal(view.get('site-disable').hidden, true);
  assert.equal(view.get('checklist-section').hidden, true);
  assert.match(view.get('status').textContent, /pantry\.example\.org/);
  view.get('site-enable').click(); await tick();
  assert.equal(view.types().includes('permissions.request'), false);
  assert.equal(view.types().includes('ui:enableSite'), false);
});

test('a trusted click asks Chrome for the site inside the click, then asks the worker to turn it on', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: false } });
  view.clickNow('site-enable');
  // Chrome only prompts inside the user's gesture, so the request is made before anything is awaited.
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'permissions.request', origins: [`${ORIGIN}/*`] });
  for (let i = 0; i < 6; i++) await tick();
  const types = view.types();
  assert.ok(types.indexOf('permissions.request') < types.indexOf('ui:enableSite'));
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:enableSite')), { type: 'ui:enableSite', confirmed: true, tabId: 7 });
  assert.equal(view.get('site-enable').hidden, true);
  assert.equal(view.get('panel-autofill').hidden, false);
  assert.equal(view.get('panel-autofill').disabled, false);
  assert.equal(view.get('site-disable').hidden, false);
  assert.match(view.get('status').textContent, /on for pantry\.example\.org/);
});

test('declining Chrome access turns nothing on', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: false }, grant: false });
  await view.userClick('site-enable'); await tick();
  assert.equal(view.types().includes('permissions.request'), true);
  assert.equal(view.types().includes('ui:enableSite'), false);
  assert.match(view.get('status').textContent, /didn’t allow/);
  assert.equal(view.get('site-enable').hidden, false);
});

test('on a site that is on, Autofill fills once without Stop, and Turn off asks the worker', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: siteDone });
  assert.equal(view.get('site-enable').hidden, true);
  assert.equal(view.get('site-disable').hidden, false);
  await view.userClick('panel-autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:autofill')), { type: 'ui:autofill', confirmed: true, tabId: 7 });
  assert.equal(view.get('status').textContent, siteDone.message);
  assert.equal(view.get('panel-autofill').textContent, 'Autofill this page');
  view.get('site-disable').click(); await tick();
  assert.equal(view.types().includes('ui:disableSite'), false);
  await view.userClick('site-disable'); await tick(); await tick();
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:disableSite')), { type: 'ui:disableSite', confirmed: true, tabId: 7 });
  assert.equal(view.get('site-enable').hidden, false);
  assert.equal(view.get('site-disable').hidden, true);
  assert.match(view.get('status').textContent, /off for this site/);
});

test('widget on a site asks the on-device AI about open questions and sends its guesses with Autofill', async t => {
  const ai = languageModel();
  const guessed = { state: 'done', filled: 3, guessed: 1, needYou: ['sh-2-0'], message: 'Filled 3 · 1 guessed · 1 need you. Check your answers before you submit.', pageKey: 'general' };
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: openPlan, LanguageModel: ai.LanguageModel, autofill: guessed });
  assert.equal(ai.calls.availability, 0, 'nothing is asked before a click');
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.slice(-2)), [{ type: 'ui:plan', confirmed: true }, { type: 'ui:autofill', confirmed: true, guesses: { 'sh-1-2': 'email' } }]);
  assert.equal(ai.calls.prompt.length, 1);
  assert.match(ai.calls.prompt[0].text, /Where can we email you\?/);
  assert.doesNotMatch(ai.calls.prompt[0].text, /sh-1-3/, 'a question without a label is not sent');
  const system = ai.calls.create[0].initialPrompts[0].content;
  assert.match(system, /- email:/);
  assert.match(system, /- phone:/);
  assert.doesNotMatch(system, /ssn|birthDate|Income|firstName/, 'the AI only learns the keys the worker allows');
  assert.equal(view.get('widget-text').textContent, 'Filled 3 · 1 guessed');
  assert.equal(view.get('need-you').textContent, '1 need you');
});

test('without the on-device AI the widget fills with rule matches only and says so', async t => {
  const setups = [{}, { availability: 'downloadable' }, { availability: 'downloading' }, { failure: new Error('Synthetic model failure') }, { answer: 'not json' }];
  for (const setup of setups) {
    const options = { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: openPlan, autofill: siteDone };
    const view = await panel(t, Object.keys(setup).length ? { ...options, LanguageModel: languageModel(setup).LanguageModel } : options);
    await view.userClick('autofill');
    assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:autofill', confirmed: true }, JSON.stringify(setup));
    assert.equal(view.get('widget-text').textContent, `Filled 2 · ${AI_UNAVAILABLE}`, JSON.stringify(setup));
    assert.match(view.get('widget-text').title, /On-device AI unavailable/);
  }
});

test('the widget asks the on-device AI once per click, with a time limit, and only about open questions', async t => {
  const ai = languageModel();
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: openPlan, LanguageModel: ai.LanguageModel, autofill: siteDone });
  const calls = [];
  const mapper = view.window.SecondHandAI;
  view.window.SecondHandAI = { ...mapper, mapWithChromeAI: (fields, options) => { calls.push({ fields, options }); return mapper.mapWithChromeAI(fields, options); } };
  await view.userClick('autofill');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].fields.map(field => field.id), ['sh-1-2', 'sh-1-1']);
  assert.deepEqual([...calls[0].options.allowedKeys], openPlan.allowedKeys);
  assert.ok(Number.isFinite(calls[0].options.timeoutMs) && calls[0].options.timeoutMs > 0 && calls[0].options.timeoutMs <= 10000);

  const answered = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { unmatched: [], allowedKeys: ['email'] }, LanguageModel: ai.LanguageModel, autofill: siteDone });
  await answered.userClick('autofill');
  assert.equal(ai.calls.availability, 1, 'no open questions, no AI');
  assert.equal(answered.get('widget-text').textContent, 'Filled 2');
  assert.deepEqual(plainRequests(answered.requests.at(-1)), { type: 'ui:autofill', confirmed: true });
});

test('a worker too old to plan for the AI gets the reload steps, not a fill', async t => {
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, silent: ['ui:plan'], LanguageModel: languageModel().LanguageModel });
  await view.userClick('autofill');
  assert.equal(view.get('widget-text').textContent, OUTDATED);
  assert.equal(view.types().includes('ui:autofill'), false);
});

test('widget and side panel say when nothing on a site matches the saved profile instead of Filled 0', async t => {
  const nothing = { state: 'done', filled: 0, guessed: [], needYou: ['sh-1-0', 'sh-1-1'], message: 'Nothing here matches your saved profile. 2 need you.', pageKey: 'general' };
  const widget = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: nothing });
  await widget.userClick('autofill');
  assert.equal(widget.get('widget-text').textContent, 'Nothing here matches your saved profile.');
  assert.equal(widget.get('widget-text').title, nothing.message);
  assert.equal(widget.get('need-you').textContent, '2 need you');
  const side = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: nothing });
  await side.userClick('panel-autofill');
  assert.equal(side.get('status').textContent, nothing.message);

  const next = { ...nothing, needYou: [], message: 'Nothing to fill here. Click Next, then Autofill again.' };
  const paged = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: next });
  await paged.userClick('autofill');
  assert.equal(paged.get('widget-text').textContent, next.message);
  assert.equal(paged.get('need-you').hidden, true);
});

test('widget on a site that is on autofills once, lists what needs you, and never shows Stop', async t => {
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: siteDone });
  assert.equal(view.get('widget').hidden, false);
  assert.equal(view.get('pill').hidden, true);
  assert.equal(view.get('widget-text').textContent, 'pantry.example.org · ready');
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:autofill')), { type: 'ui:autofill', confirmed: true });
  assert.equal(view.get('stop').hidden, true);
  assert.equal(view.get('autofill').hidden, false);
  assert.equal(view.get('widget-text').textContent, 'Filled 2');
  assert.equal(view.get('need-you').textContent, '2 need you');
  await view.userClick('need-you');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:focusField')), { type: 'ui:focusField', key: 'sh-4', confirmed: true });
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('stop').hidden, true);
  const locked = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: { state: 'locked', filled: 0, guessed: [], needYou: [], message: 'Unlock SecondHand to autofill.', pageKey: 'general' } });
  await locked.userClick('autofill');
  assert.equal(locked.get('unlock').hidden, false);
  assert.equal(locked.get('stop').hidden, true);
});
