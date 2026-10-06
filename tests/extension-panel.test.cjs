'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const strings = require('../extension/strings.js');
const { plain, evalFile, layout } = require('./helpers/harness.cjs');
const extensionId = 'a'.repeat(32);
const extensionURL = file => `chrome-extension://${extensionId}/${file}`;
const source = file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const BUILD = source('panel.js').match(/const BUILD = '([^']+)'/)[1];
const OUTDATED = 'SecondHand was updated. Open chrome://extensions and click the reload arrow on SecondHand, then reload this page.';


// Stand-in for generic-adapter.js; the real engine has its own tests. Plans carry
// elements and values so the tests can prove only metadata leaves the page.
function generalEngine(window, calls, { matched = true, settled = null } = {}) {
  const element = () => window.document.getElementById('firstName');
  return {
    plan: () => {
      calls.push('plan');
      return { token: 'plan-1', element: element(),
        matched: matched ? [{ id: 'sh-1-0', key: 'householdAdults', confidence: 'high', element: element(), value: 'Synthetic private value' }] : [],
        unmatched: [{ id: 'sh-1-1', label: 'Is anyone blind?', type: 'radio', options: ['Yes', 'No'], required: true, element: element(), value: 'Synthetic private value' }] };
    },
    fillFields: (_doc, token, assignments, values) => { calls.push({ token, assignments: plain(assignments), values: plain(values) }); return { ok: true, filled: ['sh-1-0'], skipped: [], rejected: ['sh-1-9'], pending: [], values }; },
    settle: async (_doc, token, result) => { calls.push(`settle:${token}`); return settled ? settled(result) : result; },
    focusField: (_doc, id) => { calls.push(`focus:${id}`); if (id !== 'sh-1-1') return false; element().focus(); return true; }
  };
}

function content(t, url = `${adapter.PORTAL}/applicant`, { engine = true, matched = true, navigation = false, settled = null } = {}) {
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
  let advanced = 0;
  const privateNavigation = { answer: 'Synthetic private address' };
  const calls = [];
  window.chrome = { runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener: callback => { listener = callback; } } } };
  if (engine) window.SecondHandGeneric = generalEngine(window, calls, { matched, settled });
  window.SecondHandIowa = {
    isSupportedUrl: adapter.isSupportedUrl,
    NAVIGATION_PAGE_KEYS: adapter.NAVIGATION_PAGE_KEYS,
    scan: () => {
      const element = window.document.getElementById('firstName');
      const fields = element.value ? [] : [{ key: 'firstName', label: 'First name' }];
      return { supported: true, recognizedPage: true, fields, bindings: fields.map(field => ({ key: field.key, element })), ambiguous: [], skipped: [] };
    },
    probePage: () => ({ kind, todo, pageKey: navigation ? 'iowa-personal-information' : 'primary-applicant', canAdvance: navigation, heading: 'Enter Personal Information', reason: '', fields: [{ key: 'firstName', label: 'First name' }], requiredRemaining: 0, manualRemaining: 0 }),
    captureNavigation: () => privateNavigation,
    advance: (_doc, _url, snapshot) => { assert.equal(snapshot, privateNavigation); advanced++; return { advanced: true }; },
    continuePage: () => { continued++; return { continued: true, reason: 'Continued to the next screen.' }; },
    focusField: (_document, _url, key) => { if (key !== 'firstName') return false; window.document.getElementById('firstName').focus(); return true; },
    fill: (_document, _url, bindings, values) => { for (const binding of bindings) binding.element.value = values[binding.key]; return { filled: bindings.map(binding => binding.key), skipped: [] }; }
  };
  evalFile(window, 'extension/page-text.js');
  evalFile(window, 'extension/content.js');
  return { window, frames, calls, setKind: (value, instruction) => { kind = value; todo = instruction; }, get continued() { return continued; }, get advanced() { return advanced; },
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
  assert.equal(page.frames[0].getAttribute('allow'), 'language-detector', 'the widget may use Chrome’s on-device language detector');
  evalFile(page.window, 'extension/content.js');
  assert.equal(page.frames.length, 1);

  const wrong = content(t, 'https://hhsservices.iowa.gov.evil.example/apspssp/ssp.portal');
  assert.equal(wrong.window.document.querySelector('[data-secondhand-assistant]'), null);
  const outside = content(t, 'https://hhsservices.iowa.gov/unrelated');
  assert.equal(outside.frames.length, 0);
  const child = page.window.document.createElement('iframe');
  page.window.document.body.append(child);
  child.contentWindow.SecondHandIowa = page.window.SecondHandIowa;
  child.contentWindow.chrome = page.window.chrome;
  evalFile(child.contentWindow, 'extension/content.js');
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

test('fill uses a fresh one-use preview; an unrecognized page gets no usable navigation token', t => {
  const page = content(t);
  const first = page.request({ type: 'secondhand:pageState' });
  assert.equal(first.nextToken, null);
  const filled = page.request({ type: 'secondhand:fill', token: first.scan.token, fields: ['firstName'], values: { firstName: 'Synthetic applicant' } });
  assert.equal(filled.filledCount, 1);
  assert.equal(JSON.stringify(filled).includes('Synthetic applicant'), false);
  assert.equal(page.request({ type: 'secondhand:fill', token: first.scan.token, fields: ['firstName'], values: { firstName: 'Replay' } }).ok, false);
  assert.equal(page.request({ type: 'secondhand:next', token: 'anything', authorized: true }).advanced, false);
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
  assert.equal(host.style.height, '46px');
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'pill');
  assert.equal(host.style.height, '46px');
  assert.equal(host.style.width, '46px');
  page.setKind('fillable');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
});

test('the Iowa content script loads the general engine and the page reader before content.js', () => {
  assert.deepEqual(JSON.parse(source('manifest.json')).content_scripts[0].js, ['address-policy.js', 'iowa-later-adapter.js', 'iowa-record-adapter.js', 'iowa-adapter.js', 'generic-adapter.js', 'page-text.js', 'content.js']);
});

test('on Iowa pages the adapter has not verified, the general engine plans, fills, and focuses with metadata only', async t => {
  const page = content(t);
  page.setKind('manual');
  const plan = page.request({ type: 'secondhand:generic:plan' });
  assert.deepEqual(plain(plan), { token: 'plan-1', lang: '', matched: [{ id: 'sh-1-0', key: 'householdAdults', confidence: 'high' }],
    unmatched: [{ id: 'sh-1-1', label: 'Is anyone blind?', type: 'radio', options: ['Yes', 'No'], required: true }] });
  const filled = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1-0', key: 'householdAdults', guessed: false }], values: { householdAdults: '2' } });
  assert.deepEqual(plain(filled), { ok: true, filled: ['sh-1-0'], skipped: [], rejected: ['sh-1-9'] }, 'answers the page refused come back');
  assert.deepEqual(page.calls[1], { token: 'plan-1', assignments: [{ id: 'sh-1-0', key: 'householdAdults', guessed: false }], values: { householdAdults: '2' } });
  assert.equal(page.calls[2], 'settle:plan-1', 'choices the page confirms a moment later are settled before answering');
  assert.doesNotMatch(JSON.stringify([plan, filled]), /Synthetic private/);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-1-1' })), { focused: true });
  assert.equal(page.window.document.activeElement.id, 'firstName');
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-9-9' })), { focused: false });
  page.window.document.documentElement.lang = 'es';
  assert.equal(page.request({ type: 'secondhand:generic:plan' }).lang, 'es', 'the language the page declares, for reading its questions to Laya');
});

test('on Iowa pages a general fill the page interrupted by changing answers that the page changed', async t => {
  const page = content(t, undefined, { settled: result => ({ ...result, ok: false, pageChanged: true, pending: [] }) });
  page.setKind('manual');
  page.request({ type: 'secondhand:generic:plan' });
  const filled = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1-0', key: 'householdAdults', guessed: false }], values: { householdAdults: '2' } });
  assert.deepEqual(plain(filled), { ok: false, pageChanged: true, filled: ['sh-1-0'], skipped: [], rejected: ['sh-1-9'] });
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
  assert.equal(host.style.height, '46px');
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
  assert.equal(host.style.height, '46px');
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
  // General sites expose metadata and may run explicitly requested Fill and continue.
  const state = initial.site ? { page: { kind: 'general', pageKey: 'general' }, result: initial.result || null, autopilot: false, site: { ...initial.site },
    ...(initial.savable ? { savable: structuredClone(initial.savable) } : {}), ...(initial.held ? { held: structuredClone(initial.held) } : {}),
    ...(initial.rememberable ? { rememberable: structuredClone(initial.rememberable) } : {}) } : {
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
  } }, runtime: { id: extensionId, getPlatformInfo: async () => ({ os: initial.os ?? 'mac' }), sendMessage: async payload => {
    requests.push(structuredClone(payload));
    // An outdated worker ignores messages it doesn't know: Chrome resolves with no response.
    if (initial.silent === true || initial.silent?.includes(payload.type)) return undefined;
    let data;
    if (payload.type === 'ui:ping') data = { build: initial.build ?? BUILD };
    else if (payload.type === 'ui:plan') data = structuredClone(initial.plan ?? { unmatched: [], allowedKeys: ['email'] });
    else if (payload.type === 'ui:pageState') {
      data = initial.pageState ? await initial.pageState(state) : structuredClone(state);
      // The worker hands the side panel a widget's request for the question list once.
      if (!initial.launcher && showQuestions) { showQuestions = false; data = { ...data, showQuestions: true }; }
    } else if (payload.type === 'ui:questions') data = structuredClone(initial.questions ?? { lang: 'en', pending: 0, questions: [] });
    else if (payload.type === 'ui:pageText') data = structuredClone(initial.pageText ?? { pages: [] });
    else if (payload.type === 'ui:keepSummary') data = { kept: true };
    else if (payload.type === 'ui:widgetSize') data = { sized: true };
    else if (payload.type === 'ui:autofill') { state.result = initial.autofill || doneResult; state.autopilot = Boolean(initial.autopilotAfterAutofill); data = structuredClone(state.result); }
    else if (payload.type === 'ui:fillAndContinue') { state.result = initial.fillAndContinue || { state: 'continuing', pageKey: 'general', autoContinue: true, filled: 2, messageKey: 'worker.siteContinuing' }; state.autopilot = state.result.autoContinue === true; data = structuredClone(state.result); }
    else if (payload.type === 'ui:stop') { state.autopilot = false; state.result = { state: 'stopped', filled: 0, needYou: [], message: 'Autofill stopped.', pageKey: 'iowa-personal-information' }; data = structuredClone(state.result); }
    else if (payload.type === 'ui:desktopStatus') data = { ...desktop };
    else if (payload.type === 'ui:focusField') data = { focused: true };
    else if (payload.type === 'ui:saveAnswer') {
      // Save to My information (#98): the worker reads that one box and the app saves it after its confirmation.
      if (initial.saveError) return { ok: false, ...initial.saveError };
      state.savable = state.savable.filter(item => item.id !== payload.id);
      data = { saved: true };
    }
    else if (payload.type === 'ui:rememberAnswers') {
      // Remember for next time (#186): the worker reads the chosen boxes and the app keeps them after its confirmation.
      await initial.rememberAnswered;
      if (initial.rememberError) return { ok: false, ...initial.rememberError };
      state.rememberable = state.rememberable.filter(item => !payload.ids.includes(item.id));
      data = { remembered: payload.ids.length };
    }
    else if (payload.type === 'ui:fillHeld') {
      // Fill sensitive details (#176): the app's sensitive prompt for the held questions, then the tab's new result.
      await initial.fillHeldAnswered;
      if (initial.fillHeldError) return { ok: false, ...initial.fillHeldError };
      delete state.held;
      state.result = structuredClone(initial.heldResult);
      data = structuredClone(state.result);
    }
    else if (payload.type === 'ui:showApp') data = { shown: true };
    else if (payload.type === 'ui:unlockWithTouchId' && initial.unlockWithTouchId) {
      const reply = await initial.unlockWithTouchId(desktop);
      if (reply?.ok === false) return reply;
      data = reply;
    }
    else if (payload.type === 'ui:openApp') { if (initial.openApp) return initial.openApp(desktop); data = { opened: 'launched' }; }
    else if (payload.type === 'ui:openPanel') data = { opened: true };
    else if (payload.type === 'ui:enableFrames') { state.site.frames.forEach(frame => { frame.enabled = true; }); data = { enabled: true }; }
    else if (payload.type === 'ui:enableAllSites' || payload.type === 'ui:disableAllSites') {
      if (initial.allSitesError) return { ok: false, ...initial.allSitesError };
      desktop.allSites = payload.type === 'ui:enableAllSites';
      if (state.site) state.site.enabled = desktop.allSites;
      data = desktop.allSites ? { enabled: true, message: strings.english('worker.allSitesOn'), messageKey: 'worker.allSitesOn', messageParams: {} }
        : { enabled: false, lost: [], ...(initial.allSitesOff || { message: strings.english('worker.allSitesOff'), messageKey: 'worker.allSitesOff', messageParams: {} }) };
    } else if (payload.type === 'ui:enableSite' || payload.type === 'ui:disableSite') {
      state.site.enabled = payload.type === 'ui:enableSite';
      data = { enabled: state.site.enabled, origin: state.site.origin };
    } else return { ok: false, error: `Unexpected ${payload.type}` };
    return { ok: true, data };
  } } };
  let showQuestions = initial.showQuestions === true;
  // Chrome's on-device AI exists only where a test provides a stand-in.
  if (initial.LanguageModel) window.LanguageModel = initial.LanguageModel;
  if (initial.Translator) window.Translator = initial.Translator;
  if (initial.LanguageDetector) window.LanguageDetector = initial.LanguageDetector;
  if (initial.Summarizer) window.Summarizer = initial.Summarizer;
  // Chrome gives extension pages localStorage; jsdom has none for this origin. A shared map is one browser profile.
  const storage = initial.storage || new Map();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => { storage.set(key, String(value)); }, removeItem: key => { storage.delete(key); } } });
  if (initial.language) Object.defineProperty(window.navigator, 'language', { configurable: true, get: () => initial.language });
  // Opening SecondHand checks the desktop once a second; `hurry` lets those seconds pass at once.
  if (initial.hurry) {
    const wait = window.setTimeout.bind(window);
    window.setTimeout = (callback, ms, ...args) => wait(callback, ms === 1000 ? 0 : ms, ...args);
  }
  // Run the page's own scripts, in the order panel.html lists them.
  for (const [, file] of source('panel.html').matchAll(/<script src="([^"]+)"/g)) {
    evalFile(window, `extension/${file}`);
    // A shorter wait before a download that never starts is reported (the service's own tests cover the timing).
    if (file === 'translation.js' && initial.stallMs) {
      const service = window.SecondHandTranslation;
      window.SecondHandTranslation = { ...service, create: (scope, options) => service.create(scope, { ...options, stallMs: initial.stallMs }) };
    }
    if (file === 'summary.js' && initial.stallMs) {
      const service = window.SecondHandSummary;
      window.SecondHandSummary = { ...service, create: (scope, options) => service.create(scope, { ...options, stallMs: initial.stallMs }) };
    }
  }
  await tick(); await tick();
  const get = id => window.document.getElementById(id);
  const clickNow = target => clicks.get(typeof target === 'string' ? get(target) : target)({ isTrusted: true });
  return { window, requests, state, desktop, tabs, listeners, get, clickNow, storage,
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

test('after Autofill, a question whose answer isn’t saved says so and points to My information', async t => {
  const autofill = { ...doneResult, needYou: ['firstName', 'middleName', 'unverified'], notSaved: ['firstName', 'middleName', 'lastName'] };
  const view = await panel(t, { autofill });
  const detail = key => view.row(key).querySelector('.checklist-detail').textContent;
  assert.equal(detail('firstName'), 'Needs you');
  await view.userClick('panel-autofill');
  assert.equal(detail('firstName'), 'Not saved in SecondHand: add it in My information');
  assert.equal(detail('middleName'), 'Not saved in SecondHand: add it in My information');
  assert.equal(view.row('firstName').getAttribute('aria-label'), 'First name: Not saved in SecondHand: add it in My information. Find it in Iowa’s form.');
  // A question answered since shows as done; one SecondHand can't fill still says to do it yourself.
  assert.equal(detail('lastName'), 'Done');
  assert.equal(detail('unverified'), 'Do it yourself');
  const spanish = await panel(t, { language: 'es', autofill });
  await spanish.userClick('panel-autofill');
  assert.equal(spanish.row('firstName').querySelector('.checklist-detail').textContent, 'No está guardado en SecondHand: agréguelo en “My information”');
  // Only a list of question keys is read from the worker's result.
  const malformed = await panel(t, { autofill: { ...doneResult, notSaved: 'firstName' } });
  await malformed.userClick('panel-autofill');
  assert.equal(malformed.row('firstName').querySelector('.checklist-detail').textContent, 'Needs you');
});

test('desktop line shows locked with Unlock, and not running with Open SecondHand', async t => {
  const locked = await panel(t, { desktop: { unlocked: false } });
  assert.match(locked.get('desktop-status').textContent, /locked/);
  assert.equal(locked.get('desktop-action').hidden, false);
  assert.equal(locked.get('desktop-action').textContent, 'Unlock');
  await locked.userClick('desktop-action');
  assert.deepEqual(plainRequests(locked.requests.find(request => request.type === 'ui:showApp')), { type: 'ui:showApp', confirmed: true });
  const offline = await panel(t, { desktop: { connected: false, unlocked: false } });
  assert.equal(offline.get('desktop-status').textContent, 'SecondHand isn’t running. Open the app on this computer.');
  assert.equal(offline.get('desktop-action').hidden, false);
  assert.equal(offline.get('desktop-action').textContent, 'Open SecondHand');
});

// Unlock with Touch ID (#99): the side panel asks the app to show its own Touch ID prompt when the
// app's status says it's ready. Otherwise, or when Touch ID doesn't unlock, Unlock brings SecondHand
// forward as before.
test('when the app says Touch ID is ready, Unlock asks the app for Touch ID and the line then says unlocked', async t => {
  let answer;
  const view = await panel(t, { desktop: { unlocked: false, touchId: 'ready' },
    unlockWithTouchId: desktop => new Promise(resolve => { answer = () => { desktop.unlocked = true; resolve({ unlocked: true }); }; }) });
  assert.equal(view.get('desktop-action').hidden, false);
  assert.equal(view.get('desktop-action').textContent, 'Unlock with Touch ID');
  view.get('desktop-action').click(); await tick();
  assert.equal(view.types().includes('ui:unlockWithTouchId'), false, 'only a trusted click asks');
  await view.userClick('desktop-action');
  assert.deepEqual(plainRequests(view.requests.filter(request => request.type === 'ui:unlockWithTouchId')), [{ type: 'ui:unlockWithTouchId', confirmed: true }]);
  assert.equal(view.get('desktop-status').textContent, 'Use Touch ID to unlock SecondHand.');
  assert.equal(view.get('desktop-action').hidden, true, 'no second click while Touch ID asks');
  answer(); await tick(); await tick(); await tick();
  assert.match(view.get('desktop-status').textContent, /unlocked/);
  assert.equal(view.get('desktop-action').hidden, true);
  assert.equal(view.types().includes('ui:showApp'), false, 'the app stays where it is');
});

test('when Touch ID doesn’t unlock, Unlock does what it does today: brings SecondHand forward, and says why', async t => {
  const lines = { cancelled: 'Touch ID didn’t unlock SecondHand. Enter your password in SecondHand, then click Autofill.',
    off: 'Unlock SecondHand, then click Autofill.' };
  for (const [reason, line] of Object.entries(lines)) {
    const view = await panel(t, { desktop: { unlocked: false, touchId: 'ready' }, unlockWithTouchId: () => ({ unlocked: false, reason }) });
    await view.userClick('desktop-action'); await tick();
    assert.deepEqual(plainRequests(view.requests.filter(request => ['ui:unlockWithTouchId', 'ui:showApp'].includes(request.type))),
      [{ type: 'ui:unlockWithTouchId', confirmed: true }, { type: 'ui:showApp', confirmed: true }], reason);
    assert.equal(view.get('desktop-status').textContent, line, reason);
    assert.equal(view.get('desktop-action').hidden, false, `${reason}: Unlock can be clicked again`);
  }
  const failing = await panel(t, { desktop: { unlocked: false, touchId: 'ready' }, unlockWithTouchId: () => ({ ok: false, error: 'The request could not be completed. Check the desktop app.' }) });
  await failing.userClick('desktop-action'); await tick();
  assert.equal(failing.get('desktop-status').textContent, 'The request could not be completed. Check the desktop app.');
  assert.equal(failing.types().includes('ui:showApp'), false);
});

test('when Touch ID is off, or the app says nothing about it, Unlock only brings SecondHand forward, as before', async t => {
  for (const touchId of ['off', undefined]) {
    const view = await panel(t, { desktop: { unlocked: false, ...(touchId ? { touchId } : {}) }, unlockWithTouchId: () => assert.fail('Touch ID was asked for') });
    assert.equal(view.get('desktop-action').textContent, 'Unlock', String(touchId));
    await view.userClick('desktop-action');
    assert.equal(view.types().includes('ui:unlockWithTouchId'), false, String(touchId));
    assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:showApp')), { type: 'ui:showApp', confirmed: true }, String(touchId));
    assert.equal(view.get('desktop-status').textContent, 'Unlock SecondHand, then click Autofill.', String(touchId));
  }
});

test('Unlock with Touch ID speaks the applicant’s language', async t => {
  const view = await panel(t, { language: 'es', desktop: { unlocked: false, touchId: 'ready' }, unlockWithTouchId: () => ({ unlocked: false, reason: 'cancelled' }) });
  assert.equal(view.get('desktop-action').textContent, strings.text('es', 'panel.unlockTouchId'));
  await view.userClick('desktop-action'); await tick();
  assert.equal(view.get('desktop-status').textContent, strings.text('es', 'desktop.touchIdDidntUnlock'));
});

// Waits for the panel to reach a state; each open check is about a second apart.
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${check}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const CLOSED = { connected: false, unlocked: false, laya: 'unavailable' };
const offlineResult = { state: 'offline', filled: 0, needYou: [], message: 'Open the SecondHand app, then click Autofill again.', messageKey: 'worker.openAppThenAutofill', messageParams: {}, pageKey: 'iowa-personal-information' };

test('Open SecondHand asks the worker to open the app, waits for it, then shows it locked with Unlock', async t => {
  const view = await panel(t, { desktop: CLOSED });
  view.get('desktop-action').click(); await tick();
  assert.equal(view.types().includes('ui:openApp'), false, 'an untrusted click does nothing');
  await view.userClick('desktop-action');
  assert.deepEqual(plainRequests(view.requests.filter(request => request.type === 'ui:openApp')), [{ type: 'ui:openApp', confirmed: true }]);
  assert.equal(view.get('desktop-status').textContent, 'Opening SecondHand…');
  assert.equal(view.get('desktop-action').hidden, true, 'no second click while it opens');
  // The app starts locked; the panel's next check finds it.
  Object.assign(view.desktop, { connected: true, unlocked: false });
  await until(() => view.get('desktop-status').textContent === 'SecondHand is locked.');
  assert.equal(view.get('desktop-action').hidden, false);
  assert.equal(view.get('desktop-action').textContent, 'Unlock');
  await view.userClick('desktop-action');
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:showApp', confirmed: true });
  assert.match(view.get('desktop-status').textContent, /Unlock SecondHand, then click Autofill/);
  assert.equal(view.types().filter(type => type === 'ui:openApp').length, 1);
});

test('if SecondHand never answers, the panel stops after about 20 seconds with one plain line for this computer', async t => {
  for (const [os, line] of [['mac', 'SecondHand didn’t open. Open it from your Applications folder.'], ['win', 'SecondHand didn’t open. Open it from the Start menu.'],
    ['linux', 'SecondHand didn’t open. Open it on this computer.']]) {
    const view = await panel(t, { os, hurry: true, desktop: CLOSED });
    await view.userClick('desktop-action');
    await until(() => view.get('desktop-status').textContent === line);
    assert.equal(view.types().filter(type => type === 'ui:desktopStatus').length, 1 + 20, `${os}: one check a second for 20 seconds`);
    assert.equal(view.get('desktop-status').parentElement.classList.contains('error'), true, os);
    assert.equal(view.get('laya-status').hidden, true, os);
  }
});

test('an open the host can’t do (no host, an older Windows relay, a failed start) says so at once, without waiting', async t => {
  const refusals = [{ ok: false, error: 'Cannot reach SecondHand. Open the app and prepare its Chrome extension.', errorKey: 'worker.desktopOffline', errorParams: {} },
    { ok: false, error: 'SecondHand could not be started (Windows error 2).', errorKey: 'detail', errorParams: { detail: 'SecondHand could not be started (Windows error 2).' } }];
  for (const refusal of refusals) {
    const view = await panel(t, { os: 'win', desktop: CLOSED, openApp: () => refusal });
    await view.userClick('desktop-action');
    await until(() => view.get('desktop-status').textContent === 'SecondHand didn’t open. Open it from the Start menu.');
    assert.equal(view.types().filter(type => type === 'ui:desktopStatus').length, 1, 'no checks for an app that wasn’t opened');
  }
});

test('with SecondHand closed, Autofill leaves the one desktop line and its button to say so, with no red repeat under Autofill', async t => {
  const view = await panel(t, { desktop: CLOSED, autofill: offlineResult });
  await view.userClick('panel-autofill');
  await settle();
  assert.equal(view.get('status').textContent, 'Click Autofill. SecondHand fills what it can and tells you what it needs.');
  assert.equal(view.get('status').classList.contains('error'), false);
  assert.equal(view.get('desktop-status').textContent, 'SecondHand isn’t running. Open the app on this computer.');
  assert.equal(view.get('desktop-action').textContent, 'Open SecondHand');
  // The worker's remembered result isn't repeated when the panel opens again either.
  const reopened = await panel(t, { desktop: CLOSED, result: offlineResult });
  assert.equal(reopened.get('status').textContent, 'Click Autofill. SecondHand fills what it can and tells you what it needs.');
  assert.equal(shownText(reopened).filter(text => /Open the SecondHand app|isn’t running/.test(text)).length, 1);
});

test('opening SecondHand speaks the applicant’s language', async t => {
  const view = await panel(t, { language: 'es-ES', pageState: keyedChecklist, desktop: CLOSED, hurry: true });
  assert.equal(view.get('desktop-action').textContent, spanish('desktop.open'));
  await view.userClick('desktop-action');
  assert.equal(view.get('desktop-status').textContent, spanish('desktop.opening'));
  await until(() => view.get('desktop-status').textContent === spanish('desktop.didntOpenMac'));
  assert.deepEqual(shownText(view).filter(text => englishOnly.has(text)), []);
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

test('a side panel with no Iowa page follows its tab onto Iowa’s portal when it navigates, not at the next poll', async t => {
  // A blank tab: Chrome hides its address.
  const view = await panel(t, { tab: { id: 7, url: undefined } });
  assert.match(view.get('status').textContent, /Open Iowa/);
  assert.equal(view.get('panel-autofill').disabled, true);
  view.tabs.current = { id: 7, url: `${adapter.PORTAL}/applicant`, status: 'loading' };
  // Another tab loading in the background is not this panel's business.
  view.listeners.updated(9, { status: 'loading' }, { id: 9, active: false }); await tick(); await tick();
  assert.deepEqual(view.types().filter(type => type === 'ui:pageState'), []);
  view.listeners.updated(7, { status: 'loading', url: view.tabs.current.url }, { ...view.tabs.current, active: true }); await tick(); await tick();
  assert.deepEqual(view.requests.filter(request => request.type === 'ui:pageState').map(request => request.tabId), [7]);
  assert.equal(view.get('panel-autofill').disabled, false);
  assert.equal(view.get('page-checklist').children.length, 4);
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
  assert.equal(view.get('summary-line'), null, 'the key-points line is gone');
  assert.equal(view.get('details').textContent.trim(), '', 'the logo is the details button and has no words');
  assert.equal(view.get('details').getAttribute('aria-label'), EN['widget.detailsTitle']);
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), true, 'the ready line is read to screen readers, not shown');
  view.get('autofill').click(); await tick();
  assert.equal(view.types().includes('ui:autofill'), false);
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:autofill')), { type: 'ui:autofill', confirmed: true });
  assert.equal(view.types().includes('ui:plan'), false, 'Iowa never asks the on-device AI');
  assert.equal(view.get('widget-text').textContent, 'Filled 3');
  assert.equal(view.get('need-you').hidden, false);
  assert.equal(view.get('need-you').textContent, '2 need you');
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), true, 'the yellow link says what is left; no line is added');
  assert.equal(view.types().includes('ui:widgetSize'), false, 'the widget stays one row');
  for (let i = 0; i < 3; i++) await view.userClick('need-you');
  assert.deepEqual(view.requests.filter(request => request.type === 'ui:focusField').map(request => request.key), ['firstName', 'lastName', 'firstName']);
  assert.ok(view.requests.filter(request => request.type === 'ui:focusField').every(request => request.confirmed === true && !('tabId' in request)));
  await view.userClick('details');
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:openPanel', confirmed: true });
});

test('widget frame fits the logo and its buttons, grows for the yellow link, and asks again only when that changes', async t => {
  const view = await panel(t, { launcher: true });
  // jsdom lays nothing out, so the widget reports the width Chrome would.
  view.get('widget').getBoundingClientRect = () => ({ width: view.get('need-you').hidden ? 151.2 : 214.6 });
  const sizes = () => plainRequests(view.requests.filter(request => request.type === 'ui:widgetSize'));
  await view.userClick('autofill');
  assert.deepEqual(sizes(), [{ type: 'ui:widgetSize', line: false, width: 152 }, { type: 'ui:widgetSize', line: false, width: 215 }]);
  await view.userClick('autofill');
  assert.equal(sizes().length, 2, 'the same width is not asked for again');
});

test('widget frame is taller for a line and stays as wide as the widget with it', async t => {
  const view = await panel(t, { launcher: true, autofill: { state: 'locked', filled: 0, needYou: [], message: 'Unlock SecondHand to autofill.', pageKey: 'iowa-personal-information' } });
  // jsdom lays nothing out: as Chrome would, the widget is as wide as its buttons without the line,
  // and when its height is let go, the line takes more rows the narrower the widget is.
  const card = view.get('widget');
  card.getBoundingClientRect = () => {
    const width = card.style.width ? parseFloat(card.style.width) : view.get('widget-text').classList.contains('visually-hidden') ? 180.4 : 231.8;
    return { width, height: card.style.height === 'auto' ? (width < 200 ? 97.3 : 71.6) : 86 };
  };
  const sizes = () => plainRequests(view.requests.filter(request => request.type === 'ui:widgetSize'));
  await view.userClick('autofill');
  assert.deepEqual(sizes(), [{ type: 'ui:widgetSize', line: false, width: 181 }]);
  await view.userClick('unlock');
  assert.deepEqual(sizes().at(-1), { type: 'ui:widgetSize', line: true, width: 232, height: 72, narrowWidth: 181, narrowHeight: 98 },
    'how tall the line makes it at its own width, and at its buttons’ width');
  assert.equal(card.getAttribute('style'), '', 'measuring leaves nothing behind');
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false);
  await view.userClick('autofill');
  assert.deepEqual(sizes().at(-1), { type: 'ui:widgetSize', line: false, width: 181 });
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
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), true, 'the Unlock button says it all');
  await view.userClick('unlock');
  assert.deepEqual(plainRequests(view.requests.slice(-2)), [{ type: 'ui:showApp', confirmed: true }, { type: 'ui:widgetSize', line: true }]);
  assert.equal(view.get('autofill').hidden, false);
  assert.match(view.get('widget-text').textContent, /Unlock SecondHand, then click Autofill/);
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false);
});

test('widget offers Open SecondHand in Autofill’s place when the app is closed, and restores an earlier result after reloading', async t => {
  const offline = await panel(t, { launcher: true, autofill: offlineResult });
  await offline.userClick('autofill');
  assert.equal(offline.get('autofill').hidden, true);
  assert.equal(offline.get('unlock').hidden, true);
  assert.equal(offline.get('open-app').hidden, false);
  assert.equal(offline.get('open-app').textContent, 'Open SecondHand');
  assert.match(offline.get('widget-text').textContent, /Open the SecondHand app/, 'screen readers still hear why');
  assert.equal(offline.get('widget-text').classList.contains('visually-hidden'), true, 'the button says it all: the card grows no row');
  offline.get('open-app').click(); await tick();
  assert.equal(offline.types().includes('ui:openApp'), false, 'an untrusted click does nothing');
  await offline.userClick('open-app');
  assert.deepEqual(plainRequests(offline.requests.find(request => request.type === 'ui:openApp')), { type: 'ui:openApp', confirmed: true });
  assert.equal(offline.get('open-app').hidden, true);
  assert.equal(offline.get('autofill').hidden, false);
  assert.match(offline.get('widget-text').textContent, /Unlock SecondHand, then click Autofill/);
  // An open that fails says so in one line that stays, and Autofill is back to check again.
  const failing = await panel(t, { launcher: true, os: 'win', autofill: offlineResult, openApp: () => ({ ok: false, error: 'SecondHand could not be started (Windows error 2).' }) });
  await failing.userClick('autofill');
  await failing.userClick('open-app');
  await until(() => failing.get('widget-text').textContent === 'SecondHand didn’t open. Open it from the Start menu.');
  assert.equal(failing.get('widget-text').classList.contains('visually-hidden'), false);
  assert.equal(failing.get('open-app').hidden, true);
  assert.equal(failing.get('autofill').hidden, false);
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
  assert.equal(partial.get('widget-text').textContent, 'Iowa · uses first home address suggestion');
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
const siteDone = { state: 'done', filled: 2, guessed: 0, needYou: ['f0:sh-4', 'f4:sh-3'], message: 'Filled 2 · 2 need you. Check your answers before you submit.', pageKey: 'general' };
// What the worker's ui:plan answers: the questions the rules left open, and the keys the AI may use.
const openPlan = { unmatched: [
  { id: 'f4:sh-1-2', label: 'Where can we email you?', type: 'email', options: [], required: false },
  { id: 'f4:sh-1-1', label: 'Preferred pickup day', type: 'select-one', options: ['Monday', 'Friday'], required: true },
  { id: 'f4:sh-1-3', label: '  ', type: 'text', options: [], required: false }
], allowedKeys: ['email', 'phone'] };
// A stand-in for Chrome's LanguageModel (the Prompt API).
function languageModel({ availability = 'available', answer = JSON.stringify({ 'f4:sh-1-2': 'email', 'f4:sh-1-1': null }), failure } = {}) {
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
  const guessed = { state: 'done', filled: 3, guessed: 1, needYou: ['sh-2-0'], message: 'Filled 3 · 1 suggested · 1 need you. Check your answers before you submit.', pageKey: 'general' };
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: openPlan, LanguageModel: ai.LanguageModel, autofill: guessed });
  assert.equal(ai.calls.availability, 0, 'nothing is asked before a click');
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.slice(-2)), [{ type: 'ui:plan', confirmed: true }, { type: 'ui:autofill', confirmed: true, guesses: { 'f4:sh-1-2': 'email' } }]);
  assert.equal(ai.calls.prompt.length, 1);
  assert.match(ai.calls.prompt[0].text, /Where can we email you\?/);
  assert.doesNotMatch(ai.calls.prompt[0].text, /sh-1-3/, 'a question without a label is not sent');
  const system = ai.calls.create[0].initialPrompts[0].content;
  assert.match(system, /- email:/);
  assert.match(system, /- phone:/);
  assert.doesNotMatch(system, /ssn|birthDate|Income|firstName/, 'the AI only learns the keys the worker allows');
  assert.equal(view.get('widget-text').textContent, 'Filled 3 · 1 suggested');
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
  assert.deepEqual(calls[0].fields.map(field => field.id), ['f4:sh-1-2', 'f4:sh-1-1']);
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
  const nothing = { state: 'done', filled: 0, guessed: [], needYou: ['sh-1-0', 'f4:sh-1-1'], message: 'Nothing here matches your saved profile. 2 need you.', pageKey: 'general' };
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
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:focusField')), { type: 'ui:focusField', key: 'f0:sh-4', confirmed: true });
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('stop').hidden, true);
  const locked = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: { state: 'locked', filled: 0, guessed: [], needYou: [], message: 'Unlock SecondHand to autofill.', pageKey: 'general' } });
  await locked.userClick('autofill');
  assert.equal(locked.get('unlock').hidden, false);
  assert.equal(locked.get('stop').hidden, true);
});

test('embedded form button asks Chrome synchronously before sending any worker message', async t => {
  const frames = [{ origin: 'https://form.jotform.com', enabled: false }, { origin: 'https://forms.example.org', enabled: false }, { origin: 'https://approved.example.org', enabled: true }];
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true, frames } });
  assert.ok(view.get('frames-enable'));
  assert.equal(view.get('frames-enable').hidden, false);
  assert.equal(view.get('frames-enable').textContent, 'Also turn on the embedded form (form.jotform.com, forms.example.org)');
  view.get('frames-enable').click(); await tick();
  assert.equal(view.types().includes('permissions.request'), false);
  const before = view.requests.length;
  view.clickNow('frames-enable');
  assert.equal(view.requests.length, before + 1);
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'permissions.request', origins: ['https://form.jotform.com/*', 'https://forms.example.org/*'] });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:enableFrames')), { type: 'ui:enableFrames', confirmed: true, tabId: 7 });
  assert.equal(view.get('frames-enable').hidden, true);
});
test('declining frame permission sends no enableFrames request', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true, frames: [{ origin: 'https://form.jotform.com', enabled: false }] }, grant: false });
  assert.ok(view.get('frames-enable'));
  await view.userClick('frames-enable');
  assert.equal(view.types().includes('ui:enableFrames'), false);
  assert.equal(view.get('frames-enable').hidden, false);
});

for (const loading of [false, true]) {
  test(`unready site keeps Turn off and explains ${loading ? 'loading' : 'reload'}`, async t => {
    const view = await panel(t, { tab: { ...SITE, status: loading ? 'loading' : 'complete' }, site: {
      origin: ORIGIN, enabled: true, ready: false, frames: [{ origin: 'https://form.jotform.com', enabled: false }]
    } });
    assert.equal(view.get('status').textContent, loading ? 'Waiting for the page to finish loading…' : 'Reload this page so SecondHand can read it.');
    assert.equal(view.get('status').classList.contains('error'), false);
    assert.equal(view.get('site-disable').hidden, false);
    assert.equal(view.get('panel-autofill').disabled, true);
    assert.equal(view.get('frames-enable').hidden, true);
  });
}


test('Iowa widget and sidebar disclose first-address selection before Autofill; other sites do not', async t => {
  const widget = await panel(t, { launcher: true });
  assert.match(widget.get('widget-text').textContent, /first home address suggestion/);
  assert.match(widget.get('autofill').title, /continues where SecondHand can/);
  assert.match(widget.get('autofill').title, /Check every answer, your Social Security number, and the home address/);
  const sidebar = await panel(t);
  assert.equal(sidebar.get('iowa-policy').hidden, false);
  const policy = sidebar.get('iowa-policy').textContent;
  assert.match(policy, /Social Security number; check it in Iowa’s form/);
  assert.match(policy, /first suggested home address/);
  assert.match(policy, /Review all answers and that address before submitting/);
  assert.match(policy, /one person’s record at a time/);
  assert.match(policy, /saves supported pages when complete/);
  assert.match(policy, /You handle summaries, unmatched questions, consent, signatures, submission/);
  const other = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true } });
  assert.equal(other.get('iowa-policy').hidden, true);
});

test('manual-only Tell Us More instruction is preserved without invented required-answer or automatic-Next text', async t => {
  const result = { state: 'done', pageKey: 'iowa-self-details', filled: 1, needYou: [], message: 'Date of birth filled. Review the remaining questions and continue in Iowa’s form.', todo: 'Review the remaining questions and continue in Iowa’s form.' };
  const widget = await panel(t, { launcher: true, result, autopilot: true });
  assert.match(widget.get('widget-text').textContent, /continue in Iowa’s form/);
  assert.doesNotMatch(widget.get('widget-text').textContent, /missing required|automatically/);
  const sidebar = await panel(t, { result, autopilot: true });
  assert.equal(sidebar.get('status').textContent, result.message);
});


test('the Iowa question request answers the page language, info-screen text, and the general engine’s labels, for our extension only', t => {
  const page = content(t);
  page.window.document.documentElement.lang = 'en';
  page.window.SecondHandIowa.instructions = () => ['Have these ready before you start your application.'];
  page.window.SecondHandGeneric.questions = doc => [{ id: 'sq-1-0', label: 'Is anyone blind?', element: doc.getElementById('firstName'), value: 'Synthetic private value' }];
  page.setKind('manual');
  const reply = page.request({ type: 'secondhand:questions' });
  assert.deepEqual(plain(reply), { lang: 'en', instructions: ['Have these ready before you start your application.'], questions: [{ id: 'sq-1-0', label: 'Is anyone blind?' }] });
  assert.doesNotMatch(JSON.stringify(reply), /Synthetic private/);
  assert.equal(page.request({ type: 'secondhand:questions' }, { id: 'b'.repeat(32) }), undefined, 'another extension gets nothing');
  page.setKind('fillable');
  assert.deepEqual(plain(page.request({ type: 'secondhand:questions' })).questions, [], 'a verified page is listed from its checklist, never the general engine');
});

test('the Iowa page-text request answers only an information-only screen’s words, for our extension only', t => {
  const page = content(t);
  const doc = page.window.document;
  doc.documentElement.lang = 'en';
  doc.body.insertAdjacentHTML('afterbegin', '<main><h1>Important Information when applying and what to expect.</h1><p>What you need to do.</p><input value="Synthetic private value"></main>');
  layout(doc);
  page.window.SecondHandIowa.informationScreen = () => 'iowa-information';
  assert.deepEqual(plain(page.request({ type: 'secondhand:pageText' })), { lang: 'en', pageKey: 'iowa-information', text: 'Important Information when applying and what to expect.\nWhat you need to do.' });
  page.window.SecondHandIowa.informationScreen = () => '';
  assert.deepEqual(plain(page.request({ type: 'secondhand:pageText' })), { lang: 'en', pageKey: '', text: '' }, 'a screen with questions can hold answers, so its words are never read');
  assert.equal(page.request({ type: 'secondhand:pageText' }, { id: 'b'.repeat(32) }), undefined, 'another extension gets nothing');
});

test('verified navigation keeps its private snapshot local and consumes one authorized content token', t => {
  const page = content(t, `${adapter.PORTAL}/applicant`, { navigation: true });
  const first = page.request({ type: 'secondhand:pageState' });
  assert.equal(typeof first.nextToken, 'string');
  assert.equal(JSON.stringify(first).includes('Synthetic private address'), false);
  const metadataPoll = page.request({ type: 'secondhand:pageState', navigationPreview: false });
  assert.equal(metadataPoll.nextToken, null, 'UI polling receives no navigation token and must not invalidate the action preview.');
  assert.equal(page.request({ type: 'secondhand:next', token: first.nextToken, authorized: true }, { id: 'wrong-extension' }), undefined);
  assert.equal(page.advanced, 0);
  assert.equal(page.request({ type: 'secondhand:next', token: first.nextToken, authorized: true }).advanced, true);
  assert.equal(page.advanced, 1);
  assert.equal(page.request({ type: 'secondhand:next', token: first.nextToken, authorized: true }).advanced, false);
  const fresh = page.request({ type: 'secondhand:pageState' });
  assert.equal(page.request({ type: 'secondhand:next', token: fresh.nextToken }).advanced, false);
  assert.equal(page.request({ type: 'secondhand:next', token: fresh.nextToken, authorized: true }).advanced, false);
  assert.equal(page.advanced, 1);
});

// Applicant-language tests. Mocks of Chrome's Translator and LanguageDetector live only here.
const { en: EN, es: ES } = strings.catalogs;
const englishOnly = new Set(Object.keys(EN).filter(key => typeof EN[key] === 'string' && EN[key] !== ES[key]).map(key => EN[key]));
// Every word of SecondHand's the applicant can see or hear: visible text, tooltips, and screen-reader
// labels. The page's own words, kept under their translation in the question list, are the page's.
function shownText(view) {
  const found = [view.window.document.title];
  for (const element of view.window.document.body.querySelectorAll('*')) {
    if (element.closest('[hidden]') || element.closest('#questions-list .checklist-detail')) continue;
    for (const node of element.childNodes) if (node.nodeType === 3 && node.textContent.trim()) found.push(node.textContent.trim());
    for (const name of ['title', 'aria-label']) if (element.getAttribute(name)) found.push(element.getAttribute(name));
  }
  return found;
}
const spanish = key => strings.text('es', key);
function translatorStub({ availability = 'available', create } = {}) {
  const calls = { availability: [], create: [], translate: [] };
  const Translator = {
    async availability(options) { calls.availability.push(options); return availability; },
    async create(options) {
      calls.create.push(options);
      if (create) return create(options);
      return { async translate(text) { calls.translate.push(text); return `[${options.targetLanguage}] ${text}`; } };
    }
  };
  return { Translator, calls };
}
function detectorStub({ availability = 'available', detected = 'en', failure } = {}) {
  const calls = { detect: [] };
  const LanguageDetector = {
    async availability() { return availability; },
    async create() { return { async detect(text) { calls.detect.push(text); if (failure) throw failure; return [{ detectedLanguage: detected, confidence: 0.95 }]; } }; }
  };
  return { LanguageDetector, calls };
}
const keyedChecklist = state => ({ ...structuredClone(state), page: { ...structuredClone(state.page), reasonKey: 'iowa.manualStep', reasonParams: {},
  checklist: state.page.checklist.map(item => ({ ...item, labelKey: `iowa.${item.key}`, labelParams: {} })).filter(item => Object.hasOwn(EN, item.labelKey)) } });
const pageQuestions = { lang: 'en', pending: 0, questions: [
  { id: '', label: 'Have these ready before you start your application.' },
  { id: 'firstName', label: 'First name', labelKey: 'iowa.firstName', labelParams: {} },
  { id: 'f0:sq-1-0', label: 'Preferred pickup day' }] };
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

test('with Spanish as the browser language, the side panel shows none of SecondHand’s English', async t => {
  const view = await panel(t, { language: 'es-ES', pageState: keyedChecklist });
  assert.equal(view.window.document.documentElement.lang, 'es');
  assert.equal(view.window.document.title, spanish('app.title'));
  assert.equal(view.get('panel-autofill').textContent, spanish('panel.autofill'));
  assert.equal(view.get('status').textContent, spanish('panel.iowaHint'));
  assert.equal(view.get('desktop-status').textContent, spanish('desktop.unlocked'));
  assert.match(view.row('firstName').textContent, new RegExp(`${spanish('iowa.firstName')}.*${spanish('checklist.missing')}`));
  assert.equal(view.get('checklist-summary').textContent, strings.text('es', 'checklist.summary', { done: 1, total: 3 }));
  assert.equal(view.get('language').value, 'es');
  assert.deepEqual(shownText(view).filter(text => englishOnly.has(text)), []);
  // Nothing about the language changes what the panel asks the worker.
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState', tabId: 7 }, { type: 'ui:desktopStatus' }]);
});

test('with Spanish as the browser language, the widget shows none of SecondHand’s English', async t => {
  const view = await panel(t, { launcher: true, language: 'es-ES' });
  assert.equal(view.get('autofill').textContent, spanish('widget.autofill'));
  assert.equal(view.get('widget-text').textContent, spanish('widget.iowaReady'));
  assert.equal(view.get('autofill').title, spanish('widget.autofillIowaTitle'));
  assert.deepEqual(shownText(view).filter(text => englishOnly.has(text)), []);
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState' }], 'without Chrome’s translator the widget asks nothing more');
});

test('results the worker names by key show in Spanish in the widget and the side panel; a bare message shows as sent', async t => {
  const iowa = { state: 'done', filled: 3, needYou: ['firstName', 'lastName'], pageKey: 'iowa-personal-information',
    message: 'Filled 3 · 2 need you. Complete the missing answers in Iowa’s form. SecondHand will check again before continuing.',
    messageKey: 'result.thenTodo', messageParams: { summary: { key: 'result.filledNeedYou', params: { count: 3, needYou: 2 } }, todo: { key: 'iowa.missingAnswers', params: {} } },
    todo: 'Complete the missing answers in Iowa’s form. SecondHand will check again before continuing.', todoKey: 'iowa.missingAnswers', todoParams: {} };
  const widget = await panel(t, { launcher: true, language: 'es-ES', autofill: iowa });
  await widget.userClick('autofill');
  assert.equal(widget.get('widget-text').textContent, `${strings.text('es', 'widget.filled', { count: 3 })} · ${spanish('iowa.missingAnswers')}`);
  assert.equal(widget.get('need-you').textContent, 'Faltan 2');
  assert.equal(widget.get('widget-text').title, strings.text('es', iowa.messageKey, iowa.messageParams));
  const side = await panel(t, { language: 'es-ES', autofill: iowa });
  await side.userClick('panel-autofill');
  assert.equal(side.get('status').textContent, strings.text('es', iowa.messageKey, iowa.messageParams));

  const site = await panel(t, { launcher: true, language: 'es-ES', tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: openPlan,
    autofill: { ...siteDone, messageKey: 'result.siteFilledNeedYou', messageParams: { count: 2, needYou: 2 } } });
  assert.equal(site.get('widget-text').textContent, strings.text('es', 'widget.siteReady', { host: 'pantry.example.org' }));
  await site.userClick('autofill');
  assert.equal(site.get('widget-text').textContent, `${strings.text('es', 'widget.filled', { count: 2 })} · ${spanish('widget.aiUnavailable')}`);
  // A result without a key (an older worker) is shown exactly as it arrived.
  const bare = await panel(t, { language: 'es-ES', autofill: { ...siteDone, message: 'Synthetic bare message.' }, tab: SITE, site: { origin: ORIGIN, enabled: true } });
  await bare.userClick('panel-autofill');
  assert.equal(bare.get('status').textContent, 'Synthetic bare message.');
});

test('an error reply the worker names by key shows in Spanish; one without a key is marked as English', async t => {
  const reply = { ok: false, error: 'Open the official Iowa portal in the active tab, then try again.', errorKey: 'worker.openIowaPortal', errorParams: {} };
  const view = await panel(t, { language: 'es-ES', pageState: () => { throw Object.assign(new Error(reply.error), { reply }); } });
  view.window.chrome.runtime.sendMessage = async payload => {
    if (payload.type === 'ui:pageState') return reply;
    return { ok: true, data: payload.type === 'ui:ping' ? { build: BUILD } : { connected: true, unlocked: true } };
  };
  view.listeners.activated({ tabId: 7 }); await settle();
  assert.equal(view.get('status').textContent, spanish('worker.openIowaPortal'));
  assert.equal(view.get('status').classList.contains('error'), true);
  reply.errorKey = undefined; reply.error = 'Synthetic Chrome error.';
  view.listeners.activated({ tabId: 7 }); await settle();
  assert.equal(view.get('status').textContent, strings.text('es', 'detail', { detail: 'Synthetic Chrome error.' }));
});

test('the language picker saves the choice in the extension’s storage, changes the panel at once, survives a reload, and the widget follows', async t => {
  const storage = new Map();
  const view = await panel(t, { storage, pageState: keyedChecklist });
  assert.equal(view.get('language').value, 'en');
  assert.equal(view.get('panel-autofill').textContent, 'Autofill this page');
  view.get('language').value = 'es';
  view.get('language').dispatchEvent(new view.window.Event('change'));
  await settle();
  assert.equal(storage.get('secondhand.language'), 'es');
  assert.equal(view.get('panel-autofill').textContent, spanish('panel.autofill'));
  assert.equal(view.get('status').textContent, spanish('panel.iowaHint'));
  assert.equal(view.get('iowa-policy').textContent, spanish('panel.iowaPolicy'));
  assert.deepEqual(shownText(view).filter(text => englishOnly.has(text)), []);

  const reloaded = await panel(t, { storage });
  assert.equal(reloaded.get('language').value, 'es', 'the saved choice wins over the English browser');
  assert.equal(reloaded.get('panel-autofill').textContent, spanish('panel.autofill'));
  const widget = await panel(t, { launcher: true, storage });
  assert.equal(widget.get('autofill').textContent, spanish('widget.autofill'));
  // A choice made while the widget is open reaches it through the storage event.
  storage.set('secondhand.language', 'en');
  widget.window.dispatchEvent(Object.assign(new widget.window.Event('storage'), { key: 'secondhand.language' }));
  await settle();
  assert.equal(widget.get('autofill').textContent, 'Autofill');
  assert.equal(widget.get('widget-text').textContent, 'Iowa · uses first home address suggestion');
});

test('the side panel lists every question in Spanish; a row click finds it through the existing focus route; nothing is written to the page', async t => {
  const ai = translatorStub();
  const detector = detectorStub();
  const view = await panel(t, { language: 'es-ES', Translator: ai.Translator, LanguageDetector: detector.LanguageDetector, questions: pageQuestions, pageState: keyedChecklist });
  assert.equal(view.get('questions-show').hidden, false);
  assert.equal(view.get('questions-show').textContent, spanish('questions.show'));
  view.get('questions-show').click(); await settle();
  assert.equal(view.types().includes('ui:questions'), false, 'an untrusted click does nothing');
  await view.userClick('questions-show'); await settle();
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:questions')), { type: 'ui:questions', tabId: 7 });
  assert.deepEqual(detector.calls.detect, ['Have these ready before you start your application.\nPreferred pickup day'], 'the detector reads the page’s own words');
  assert.deepEqual(ai.calls.create.map(options => [options.sourceLanguage, options.targetLanguage]), [['en', 'es']]);
  assert.deepEqual(ai.calls.translate, ['Have these ready before you start your application.', 'Preferred pickup day'], 'SecondHand’s own labels come from its catalog, not the translator');
  const rows = [...view.get('questions-list').children];
  assert.deepEqual(rows.map(row => [row.tagName, row.querySelector('.checklist-label').textContent, row.querySelector('.checklist-detail').textContent]), [
    ['DIV', '[es] Have these ready before you start your application.', 'Have these ready before you start your application.'],
    ['BUTTON', spanish('iowa.firstName'), ''],
    ['BUTTON', '[es] Preferred pickup day', 'Preferred pickup day']]);
  assert.equal(view.get('questions').hidden, false);
  assert.equal(view.get('questions-summary').textContent, strings.text('es', 'questions.count', { count: 2 }));
  assert.equal(view.get('questions-note').textContent, spanish('translate.done'));
  assert.equal(view.get('questions-show').textContent, spanish('questions.refresh'));
  await view.userClick(rows[2]);
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:focusField', key: 'f0:sq-1-0', tabId: 7 });
  assert.deepEqual([...new Set(view.types())].sort(), ['ui:desktopStatus', 'ui:focusField', 'ui:pageState', 'ui:ping', 'ui:questions']);
  assert.doesNotMatch(JSON.stringify(view.requests), /\[es\]/, 'no translation is ever sent toward the page');
  assert.deepEqual(shownText(view).filter(text => englishOnly.has(text)), []);
});

test('without the Translator API the question list is hidden behind one plain line, and nothing else changes', async t => {
  const view = await panel(t, { language: 'es-ES' });
  assert.equal(view.get('questions-show').hidden, true);
  assert.equal(view.get('questions-note').hidden, false);
  assert.equal(view.get('questions-note').textContent, spanish('translate.missing'));
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState', tabId: 7 }, { type: 'ui:desktopStatus' }]);
  const english = await panel(t, {});
  assert.equal(english.get('questions-show').hidden, true);
  assert.equal(english.get('questions-note').hidden, true, 'an applicant reading English sees nothing new');
  assert.equal(english.get('questions').hidden, true);
});

test('a language pair Chrome can’t translate, a page already in Spanish, or a failed translation each says so in one line and keeps the questions', async t => {
  const unavailable = await panel(t, { language: 'es-ES', Translator: translatorStub({ availability: 'unavailable' }).Translator, questions: pageQuestions });
  await unavailable.userClick('questions-show'); await settle();
  assert.equal(unavailable.get('questions-note').textContent, strings.text('es', 'translate.unavailable', { source: 'inglés', target: 'español' }));
  assert.equal(unavailable.get('questions-list').children.length, 3, 'the questions are still listed in their own words');
  const same = await panel(t, { language: 'es-ES', Translator: translatorStub().Translator, questions: { ...pageQuestions, lang: 'es' } });
  await same.userClick('questions-show'); await settle();
  assert.equal(same.get('questions-note').textContent, strings.text('es', 'questions.sameLanguage', { language: 'español' }));
  const failing = translatorStub({ create: async () => ({ async translate() { throw new Error('Synthetic translation failure'); } }) });
  const failed = await panel(t, { language: 'es-ES', Translator: failing.Translator, questions: pageQuestions });
  await failed.userClick('questions-show'); await settle();
  assert.equal(failed.get('questions-note').textContent, strings.text('es', 'translate.failed', { detail: 'Synthetic translation failure' }));
  assert.equal(failed.get('questions-note').classList.contains('error'), true);
  const unknown = await panel(t, { language: 'es-ES', Translator: translatorStub().Translator, questions: { ...pageQuestions, lang: '' } });
  await unknown.userClick('questions-show'); await settle();
  assert.equal(unknown.get('questions-note').textContent, spanish('questions.unknownLanguage'));
});

test('a translator Chrome must download starts from the applicant’s click, shows its progress, and says so when the download never starts', async t => {
  let monitor, finish;
  const downloading = translatorStub({ availability: 'downloadable', create: options => { options.monitor(monitor = new EventTarget()); return new Promise(resolve => { finish = resolve; }); } });
  const view = await panel(t, { language: 'es-ES', Translator: downloading.Translator, questions: pageQuestions });
  await view.userClick('questions-show'); await settle();
  assert.equal(view.get('questions-note').textContent, strings.text('es', 'translate.downloading', { language: 'español', percent: 0 }));
  monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.42 }));
  assert.equal(view.get('questions-note').textContent, strings.text('es', 'translate.downloading', { language: 'español', percent: 42 }));
  finish({ async translate(text) { return `[es] ${text}`; } }); await settle();
  assert.equal(view.get('questions-note').textContent, spanish('translate.done'));
  assert.equal(view.get('questions-list').children[2].querySelector('.checklist-label').textContent, '[es] Preferred pickup day');

  // A download that never starts is reported after its stall time, on a clock the test runs.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = translatorStub({ availability: 'downloadable', create: () => new Promise(() => {}) });
  const stalled = await panel(t, { language: 'es-ES', Translator: stuck.Translator, questions: pageQuestions, stallMs: 15 });
  await stalled.userClick('questions-show'); await settle();
  const note = strings.text('es', 'translate.stalled', { language: 'español', source: 'inglés' });
  t.mock.timers.tick(14); await settle();
  assert.notEqual(stalled.get('questions-note').textContent, note, 'not before its stall time');
  t.mock.timers.tick(1); await settle();
  assert.equal(stalled.get('questions-note').textContent, note);
  assert.equal(stalled.get('questions-list').children.length, 3, 'the questions stay listed in their own words');
});

test('the widget offers the Spanish view when the page is in English, and the offer opens the side panel on the list', async t => {
  const detector = detectorStub();
  const view = await panel(t, { launcher: true, language: 'es-ES', Translator: translatorStub().Translator, LanguageDetector: detector.LanguageDetector, questions: pageQuestions });
  await settle();
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState' }, { type: 'ui:questions' }, { type: 'ui:widgetSize', line: true }], 'the offer gets a row');
  assert.equal(view.get('translate-offer').hidden, false);
  assert.equal(view.get('translate-offer').textContent, spanish('widget.offer'));
  assert.equal(view.get('translate-offer').title, spanish('widget.offerTitle'));
  view.get('translate-offer').click(); await tick();
  assert.equal(view.types().includes('ui:openPanel'), false);
  view.clickNow('translate-offer');
  // Sent inside the click: Chrome opens the side panel only from the applicant's gesture.
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:openPanel', confirmed: true, questions: true });

  // Without a ready detector, the page's declared language decides (headless Chromium has none).
  const declared = await panel(t, { launcher: true, language: 'es-ES', Translator: translatorStub().Translator, LanguageDetector: detectorStub({ availability: 'unavailable' }).LanguageDetector, questions: pageQuestions });
  await settle();
  assert.equal(declared.get('translate-offer').hidden, false);
  const english = await panel(t, { launcher: true, Translator: translatorStub().Translator, LanguageDetector: detectorStub().LanguageDetector, questions: pageQuestions });
  await settle();
  assert.equal(english.get('translate-offer').hidden, true, 'an English page for an English reader needs no offer');
  const pill = await panel(t, { launcher: true, kind: 'manual', language: 'es-ES', Translator: translatorStub().Translator, questions: pageQuestions });
  await settle();
  assert.equal(pill.types().includes('ui:questions'), false, 'a page with nothing to fill is not read');
  const failing = await panel(t, { launcher: true, language: 'es-ES', Translator: translatorStub().Translator, LanguageDetector: detectorStub({ failure: new Error('Synthetic detector failure') }).LanguageDetector, questions: pageQuestions });
  await settle();
  assert.equal(failing.get('translate-offer').hidden, true);
  assert.equal(failing.get('widget-text').textContent, spanish('widget.languageCheckFailed'));
});

test('when the widget’s offer opened the side panel, the panel shows the list by itself and asks for a click only to download', async t => {
  const ai = translatorStub({ availability: 'downloadable' });
  const view = await panel(t, { language: 'es-ES', Translator: ai.Translator, questions: pageQuestions, showQuestions: true });
  await settle();
  assert.equal(view.types().filter(type => type === 'ui:questions').length, 1);
  assert.equal(view.get('questions-list').children.length, 3);
  assert.deepEqual(ai.calls.create, [], 'no download starts without the applicant’s click');
  assert.equal(view.get('questions-note').textContent, strings.text('es', 'translate.needsDownload', { language: 'español' }));
  assert.equal(view.get('questions-show').textContent, strings.text('es', 'translate.download', { language: 'español' }));
  await view.userClick('questions-show'); await settle();
  assert.equal(ai.calls.create.length, 1);
  assert.equal(view.get('questions-note').textContent, spanish('translate.done'));
  // An English reader on a page the widget found to be in another language gets the list too.
  const english = await panel(t, { Translator: translatorStub().Translator, questions: { ...pageQuestions, lang: 'es' }, showQuestions: true });
  await settle();
  assert.equal(english.get('questions').hidden, false);
  assert.equal(english.get('questions-list').children[2].querySelector('.checklist-label').textContent, '[en] Preferred pickup day');
});

// Laya, the desktop's local AI (#39, #42): when it is ready, Chrome's on-device AI stays off.
const layaDone = { state: 'done', filled: 2, guessed: 1, laya: 1, needYou: ['f0:sh-1-1'], pageKey: 'general',
  message: 'Filled 2 · 1 suggested · 1 need you. Check your answers before you submit. Suggestions came from Laya on this computer.',
  messageKey: 'result.suggestedByLaya', messageParams: { summary: { key: 'result.siteFilledSuggestedNeedYou', params: { count: 2, suggested: 1, needYou: 1 } } } };

test('with Laya ready, the widget leaves Chrome’s on-device AI off, fills the plan Laya answers for, and says who suggested the guesses', async t => {
  const ai = languageModel();
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true }, LanguageModel: ai.LanguageModel, autofill: layaDone });
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.slice(-2)), [{ type: 'ui:plan', confirmed: true }, { type: 'ui:autofill', confirmed: true, guesses: {} }]);
  assert.equal(ai.calls.availability, 0, 'Chrome’s on-device AI is never asked');
  assert.equal(view.get('widget-text').textContent, 'Filled 2 · 1 suggested · suggested by Laya');
  assert.equal(view.get('widget-text').title, layaDone.message);
  assert.equal(view.get('need-you').textContent, '1 need you');

  const spanishView = await panel(t, { launcher: true, language: 'es-ES', tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true }, autofill: layaDone });
  await spanishView.userClick('autofill');
  assert.equal(spanishView.get('widget-text').textContent, `${strings.text('es', 'widget.filledSuggested', { count: 2, suggested: 1 })} · ${spanish('widget.suggestedByLaya')}`);
  assert.deepEqual(shownText(spanishView).filter(text => englishOnly.has(text)), []);
});

test('with Laya not ready, the widget asks Chrome’s on-device AI exactly as before', async t => {
  const ai = languageModel();
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: false }, LanguageModel: ai.LanguageModel, autofill: siteDone });
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.slice(-2)), [{ type: 'ui:plan', confirmed: true }, { type: 'ui:autofill', confirmed: true, guesses: { 'f4:sh-1-2': 'email' } }]);
  assert.equal(ai.calls.prompt.length, 1);
  assert.equal(view.get('widget-text').textContent, 'Filled 2');
});

test('the side panel shows whether Laya is ready, in the applicant’s language, and nothing when the app is closed', async t => {
  const lines = { ready: 'desktop.layaReady', off: 'desktop.layaOff', downloading: 'desktop.layaDownloading', 'not-downloaded': 'desktop.layaNotReady', error: 'desktop.layaNotReady', unavailable: 'desktop.layaNotReady' };
  for (const [laya, key] of Object.entries(lines)) {
    const view = await panel(t, { desktop: { laya } });
    assert.equal(view.get('laya-status').hidden, false, laya);
    assert.equal(view.get('laya-status').textContent, strings.text('en', key), laya);
  }
  const closed = await panel(t, { desktop: { connected: false, unlocked: false, laya: 'unavailable' } });
  assert.equal(closed.get('laya-status').hidden, true);
  const older = await panel(t);
  assert.equal(older.get('laya-status').hidden, true, 'a worker that reports no Laya state shows no line');
  const spanishView = await panel(t, { language: 'es-ES', pageState: keyedChecklist, desktop: { laya: 'ready' } });
  assert.equal(spanishView.get('laya-status').textContent, spanish('desktop.layaReady'));
  assert.deepEqual(shownText(spanishView).filter(text => englishOnly.has(text)), []);
});

// "What this page says". Mocks of Chrome's Summarizer live only here.
const IMPORTANT_TEXT = 'Important Information when applying and what to expect.\nWhat you need to do.';
const summaryPage = { id: 'read-1', pageKey: 'iowa-information', lang: 'en', current: true, text: IMPORTANT_TEXT, unread: false, summary: null };
const KEY_POINTS = ['Have your documents ready.', 'Answer every question with a star.'];
function summarizerStub({ availability = 'available', output = () => '* Have your documents ready.\n* Answer every question with a star.\n* You qualify for SNAP.', create, failure } = {}) {
  const calls = { availability: [], create: [], summarize: [] };
  const instance = () => ({ inputQuota: 4000, async measureInputUsage(text) { return Math.ceil(text.length / 4); },
    async summarize(text) { calls.summarize.push(text); if (failure) throw failure; return output(text); } });
  const Summarizer = {
    async availability(options) { calls.availability.push(options); return typeof availability === 'function' ? availability(options) : availability; },
    async create(options) { calls.create.push(options); return create ? create(options, instance) : instance(); }
  };
  return { Summarizer, calls };
}
const points = view => [...view.get('summary-list').querySelectorAll('li')].map(item => item.textContent);
const groups = view => [...view.get('summary-list').children].map(group => [group.querySelector('h3')?.textContent || '', [...group.querySelectorAll('li, p')].map(node => node.textContent)]);
const kept = view => plainRequests(view.requests.filter(request => request.type === 'ui:keepSummary'));

test('without the Summarizer API the side panel says so in one line, hides the section, and never reads the page', async t => {
  const view = await panel(t, { pageText: { pages: [summaryPage] } });
  assert.equal(view.get('summary').hidden, true);
  assert.equal(view.get('summary-get').hidden, true);
  assert.equal(view.get('summary-note').hidden, false);
  assert.equal(view.get('summary-note').textContent, EN['summary.missing']);
  assert.equal(view.types().includes('ui:pageText'), false);
  assert.equal((await panel(t, { language: 'es-ES' })).get('summary-note').textContent, spanish('summary.missing'));
  const elsewhere = await panel(t, { tab: { id: 7, url: 'chrome://newtab/' } });
  assert.equal(elsewhere.get('summary-note').hidden, true, 'nothing is said where there is no page to read');
});

test('with Chrome’s model ready, the side panel lists the page’s key points by itself, labelled as automatic, from the page’s words alone', async t => {
  const ai = summarizerStub();
  const view = await panel(t, { Summarizer: ai.Summarizer, pageText: { pages: [summaryPage] } });
  await settle();
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:pageText')), { type: 'ui:pageText', tabId: 7 });
  assert.deepEqual(ai.calls.summarize, [IMPORTANT_TEXT], 'Chrome reads the page’s own words and nothing else');
  assert.equal(ai.calls.create[0].outputLanguage, 'en');
  assert.deepEqual([...ai.calls.create[0].expectedInputLanguages], ['en']);
  assert.equal(view.get('summary').hidden, false);
  assert.equal(view.get('summary-title').textContent, 'What this page says');
  assert.deepEqual(groups(view), [['Important application information', KEY_POINTS]], 'at most five points, and never one saying the reader qualifies');
  assert.ok([...view.get('summary-list').querySelectorAll('li')].every(item => item.dir === 'auto'), 'each point reads in its own direction, even in Arabic');
  assert.equal(view.get('summary-caveat').textContent, 'Written automatically by Chrome on this computer. Read the page for details.');
  assert.equal(view.get('summary-english').hidden, true);
  assert.equal(view.get('summary-note').hidden, true);
  assert.deepEqual(kept(view), [{ type: 'ui:keepSummary', tabId: 7, id: 'read-1', summary: { language: 'en', points: KEY_POINTS, english: false } }]);

  const site = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, Summarizer: ai.Summarizer, pageText: { pages: [{ ...summaryPage, pageKey: 'general' }] } });
  await settle();
  assert.deepEqual(groups(site), [['', KEY_POINTS]], 'a site’s page has no screen name');
  const off = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: false }, Summarizer: ai.Summarizer, pageText: { pages: [summaryPage] } });
  await settle();
  assert.equal(off.types().includes('ui:pageText'), false, 'a site that is not on is never read');
  assert.equal(off.get('summary-note').hidden, true);
});

test('when Chrome can’t summarize here, the section is hidden behind one plain line; a page without words says nothing', async t => {
  const ai = summarizerStub({ availability: 'unavailable' });
  const view = await panel(t, { Summarizer: ai.Summarizer, pageText: { pages: [summaryPage] } });
  await settle();
  assert.equal(view.get('summary').hidden, true);
  assert.equal(view.get('summary-note').textContent, EN['summary.unavailable']);
  assert.equal(view.get('summary-note').classList.contains('error'), false);
  assert.deepEqual(ai.calls.create, []);
  const empty = await panel(t, { Summarizer: summarizerStub().Summarizer, pageText: { pages: [] } });
  await settle();
  assert.equal(empty.get('summary-note').hidden, true);
  assert.equal(empty.get('summary').hidden, true);
});

test('a model Chrome must download starts from the applicant’s click, shows its progress, and says so when the download never starts', async t => {
  let monitor, finish;
  const ai = summarizerStub({ availability: 'downloadable', create: (options, instance) => { options.monitor(monitor = new EventTarget()); return new Promise(resolve => { finish = () => resolve(instance()); }); } });
  const view = await panel(t, { Summarizer: ai.Summarizer, pageText: { pages: [summaryPage] } });
  await settle();
  assert.deepEqual(ai.calls.create, [], 'no download starts without the applicant’s click');
  assert.equal(view.get('summary-note').textContent, EN['summary.needsDownload']);
  assert.equal(view.get('summary-get').hidden, false);
  assert.equal(view.get('summary-get').textContent, 'Download Chrome’s summary model');
  view.get('summary-get').click(); await settle();
  assert.deepEqual(ai.calls.create, [], 'an untrusted click does nothing');
  await view.userClick('summary-get'); await settle();
  assert.equal(ai.calls.create.length, 1);
  assert.equal(view.get('summary-get').hidden, true);
  assert.equal(view.get('summary-note').textContent, strings.text('en', 'summary.downloading', { percent: 0 }));
  monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.42 }));
  assert.equal(view.get('summary-note').textContent, strings.text('en', 'summary.downloading', { percent: 42 }));
  finish(); await settle();
  assert.deepEqual(points(view), KEY_POINTS);
  assert.equal(view.get('summary-note').hidden, true);

  // A download that never starts is reported after its stall time, on a clock the test runs.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = summarizerStub({ availability: 'downloadable', create: () => new Promise(() => {}) });
  const stalled = await panel(t, { Summarizer: stuck.Summarizer, pageText: { pages: [summaryPage] }, stallMs: 15 });
  await settle();
  await stalled.userClick('summary-get'); await settle();
  t.mock.timers.tick(14); await settle();
  assert.notEqual(stalled.get('summary-note').textContent, EN['summary.stalled'], 'not before its stall time');
  t.mock.timers.tick(1); await settle();
  assert.equal(stalled.get('summary-note').textContent, EN['summary.stalled']);
  assert.equal(stalled.get('summary-note').classList.contains('error'), true);
});

test('Iowa’s information screens stay listed by name after autofill moves on, and points already written are not written again', async t => {
  const ai = summarizerStub();
  const screens = { pages: [
    { id: 'read-2', pageKey: 'iowa-instructions', lang: 'en', current: false, text: 'Instructions\nOK. Let’s start the application.', unread: false,
      summary: { language: 'en', points: ['Questions with a star must be answered.'], english: false } },
    { id: 'read-1', pageKey: 'iowa-information', lang: 'en', current: false, text: '', unread: true, summary: null }] };
  const view = await panel(t, { Summarizer: ai.Summarizer, pageText: screens });
  await settle();
  assert.equal(view.get('summary-title').textContent, 'What Iowa’s earlier screens said');
  assert.deepEqual(groups(view), [['Instructions', ['Questions with a star must be answered.']], ['Important application information', [EN['summary.unread']]]]);
  assert.deepEqual(ai.calls.summarize, [], 'points kept for the tab are not written again');
  assert.deepEqual(kept(view), []);
});

test('points come in the applicant’s language: written by Chrome in Spanish, translated for other languages, or said plainly to be in English', async t => {
  const es = summarizerStub({ output: () => '* Tenga listos sus documentos.\n* Usted califica para SNAP.' });
  const view = await panel(t, { language: 'es-ES', Summarizer: es.Summarizer, pageText: { pages: [summaryPage] }, pageState: keyedChecklist });
  await settle();
  assert.equal(es.calls.create[0].outputLanguage, 'es');
  assert.deepEqual(points(view), ['Tenga listos sus documentos.']);
  assert.equal(view.get('summary-title').textContent, spanish('summary.title'));
  assert.deepEqual(shownText(view).filter(text => englishOnly.has(text)), []);
  assert.deepEqual(kept(view)[0].summary, { language: 'es', points: ['Tenga listos sus documentos.'], english: false });

  const vi = await panel(t, { language: 'vi-VN', Summarizer: summarizerStub().Summarizer, Translator: translatorStub().Translator, pageText: { pages: [summaryPage] } });
  await settle();
  assert.deepEqual(points(vi), KEY_POINTS.map(point => `[vi] ${point}`));
  assert.equal(vi.get('summary-english').hidden, true);
  assert.deepEqual(kept(vi)[0].summary, { language: 'vi', points: KEY_POINTS.map(point => `[vi] ${point}`), english: false });

  const french = await panel(t, { language: 'fr-FR', Summarizer: summarizerStub().Summarizer, pageText: { pages: [summaryPage] } });
  await settle();
  assert.deepEqual(points(french), KEY_POINTS);
  assert.equal(french.get('summary-english').hidden, false);
  assert.equal(french.get('summary-english').textContent, strings.text('fr', 'summary.inEnglish'));
  assert.deepEqual(kept(french)[0].summary, { language: 'fr', points: KEY_POINTS, english: true });

  const failing = translatorStub({ create: async () => ({ async translate() { throw new Error('Synthetic translation failure'); } }) });
  const arabic = await panel(t, { language: 'ar-EG', Summarizer: summarizerStub().Summarizer, Translator: failing.Translator, pageText: { pages: [summaryPage] } });
  await settle();
  assert.deepEqual(points(arabic), KEY_POINTS);
  assert.equal(arabic.get('summary-english').hidden, false);
  assert.equal(arabic.get('summary-note').textContent, strings.text('ar', 'summary.translateFailed', { detail: 'Synthetic translation failure' }));
  assert.equal(arabic.get('summary-note').classList.contains('error'), true);
});

test('choosing another language writes the page’s points again in it', async t => {
  const ai = summarizerStub({ output: text => text === IMPORTANT_TEXT ? '* Have your documents ready.' : '* Unexpected.' });
  const view = await panel(t, { Summarizer: ai.Summarizer, pageText: { pages: [summaryPage] } });
  await settle();
  assert.deepEqual(points(view), ['Have your documents ready.']);
  view.get('language').value = 'es';
  view.get('language').dispatchEvent(new view.window.Event('change'));
  await settle();
  assert.deepEqual(ai.calls.create.map(options => options.outputLanguage), ['en', 'es']);
  assert.deepEqual(kept(view).map(request => request.summary.language), ['en', 'es']);
  assert.equal(view.get('summary-title').textContent, spanish('summary.title'));
});

test('a summary that fails, or a worker reply that is not pages, says why in one line', async t => {
  const view = await panel(t, { Summarizer: summarizerStub({ failure: new Error('Synthetic summary failure') }).Summarizer, pageText: { pages: [summaryPage] } });
  await settle();
  assert.equal(view.get('summary').hidden, true);
  assert.equal(view.get('summary-note').textContent, strings.text('en', 'summary.failed', { detail: 'Synthetic summary failure' }));
  assert.equal(view.get('summary-note').classList.contains('error'), true);
  const odd = await panel(t, { Summarizer: summarizerStub().Summarizer, pageText: { pages: [{ id: 7 }] } });
  await settle();
  assert.equal(odd.get('summary-note').textContent, EN['worker.pageTextUnreadable']);
  assert.equal(odd.get('summary-note').classList.contains('error'), true);
});

test('the Iowa widget grows by one row while it shows a message, when the worker asks for our extension', t => {
  const page = content(t);
  const host = page.host();
  assert.deepEqual(plain(page.request({ type: 'secondhand:widgetSize', line: true })), { sized: true });
  assert.equal(host.style.height, '86px');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.style.height, '86px', 'the room stays while the message is shown');
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.style.height, '46px', 'a pill has no message');
  page.setKind('fillable');
  assert.deepEqual(plain(page.request({ type: 'secondhand:widgetSize', line: false })), { sized: true });
  assert.equal(host.style.height, '46px');
  assert.equal(page.request({ type: 'secondhand:widgetSize', line: true }, { id: 'b'.repeat(32) }), undefined, 'another extension gets nothing');
  assert.equal(host.style.height, '46px');
});

test('the Iowa widget frame is as wide as the widget measured itself, never past 272px', t => {
  const page = content(t);
  const host = page.host();
  assert.match(host.style.width, /^min\(272px/);
  assert.deepEqual(plain(page.request({ type: 'secondhand:widgetSize', line: false, width: 152 })), { sized: true });
  assert.match(host.style.width, /^min\(152px, 272px/, 'never wider than the full card');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.match(host.style.width, /^min\(152px/, 'the width stays across page changes');
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.style.width, '46px', 'a pill');
  page.setKind('fillable');
  page.request({ type: 'secondhand:widgetSize', line: true, width: 231 });
  assert.match(host.style.width, /^min\(231px/, 'a line keeps the widget’s width');
  assert.equal(host.style.height, '86px');
  page.request({ type: 'secondhand:widgetSize', line: false });
  assert.match(host.style.width, /^min\(272px/, 'a widget that could not measure itself gets the full card');
  for (const width of [0, 1.5, '152', 5000]) assert.equal(page.request({ type: 'secondhand:widgetSize', line: false, width }), undefined, `width ${width}`);
  assert.match(host.style.width, /^min\(272px/);
});

test('the Iowa widget frame is as tall as its line needs, up to 110px, and narrow on a narrow page', t => {
  const page = content(t);
  const host = page.host();
  const size = { type: 'secondhand:widgetSize', line: true, width: 272, height: 72, narrowWidth: 133, narrowHeight: 97 };
  assert.deepEqual(plain(page.request(size)), { sized: true });
  assert.match(host.style.width, /^min\(272px/);
  assert.equal(host.style.height, '86px', 'never shorter than one row taller');
  page.request({ ...size, height: 108 });
  assert.equal(host.style.height, '108px');
  page.request({ ...size, height: 140 });
  assert.equal(host.style.height, '110px', 'never taller than 110px');
  // Under 640px wide, the frame keeps the widget's buttons' width and the line's rows, as the page resizes.
  page.request(size);
  Object.defineProperty(page.window, 'innerWidth', { value: 639, configurable: true });
  page.window.dispatchEvent(new page.window.Event('resize'));
  assert.match(host.style.width, /^min\(133px, 272px/);
  assert.equal(host.style.height, '97px');
  page.request({ ...size, narrowHeight: 140 });
  assert.equal(host.style.height, '110px');
  page.request({ type: 'secondhand:widgetSize', line: false, width: 133 });
  assert.equal(host.style.height, '46px', 'no line, the size at rest');
  page.request({ type: 'secondhand:widgetSize', line: true, width: 179 });
  assert.match(host.style.width, /^min\(179px/, 'a widget that sent no narrow size keeps its width');
  assert.equal(host.style.height, '86px');
  page.request(size);
  Object.defineProperty(page.window, 'innerWidth', { value: 640, configurable: true });
  page.window.dispatchEvent(new page.window.Event('resize'));
  assert.match(host.style.width, /^min\(272px/);
  assert.equal(host.style.height, '86px');
  for (const key of ['height', 'narrowWidth', 'narrowHeight']) {
    for (const value of [0, 1.5, '97', 5000, null]) assert.equal(page.request({ ...size, [key]: value }), undefined, `${key} ${value}`);
  }
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.style.height, '46px', 'a pill');
  assert.equal(host.style.width, '46px');
});

// SecondHand on all websites.
const ALL_ON = 'SecondHand is on for all websites. Open a form and click Autofill.';
const OTHER_SITE = { id: 8, url: 'https://wic.example.gov/apply' };
test('the side panel offers all websites on a tab it can’t read, with the Iowa hint below, and ignores untrusted clicks', async t => {
  const view = await panel(t, { tab: { id: 9, url: undefined }, desktop: { allSites: false } });
  assert.equal(view.get('all-sites-enable').hidden, false);
  assert.equal(view.get('all-sites-enable').textContent, 'Use SecondHand on all websites');
  assert.equal(view.get('all-sites-disable').hidden, true);
  assert.match(view.get('status').textContent, /^Open Iowa’s SNAP application in this tab/);
  view.get('all-sites-enable').click(); await tick();
  assert.equal(view.types().includes('permissions.request'), false);
  assert.equal(view.types().includes('ui:enableAllSites'), false);
});

test('all websites is offered whenever it is off: on Iowa, on a site that is off, and on a site turned on by itself', async t => {
  for (const options of [{}, { tab: SITE, site: { origin: ORIGIN, enabled: false } }, { tab: SITE, site: { origin: ORIGIN, enabled: true } }]) {
    const view = await panel(t, { ...options, desktop: { allSites: false } });
    assert.equal(view.get('all-sites-enable').hidden, false, JSON.stringify(options));
    assert.equal(view.get('all-sites-disable').hidden, true);
  }
  const unknown = await panel(t, { tab: { id: 9, url: undefined }, silent: ['ui:desktopStatus'] });
  assert.equal(unknown.get('all-sites-enable').hidden, true, 'nothing is offered until the worker says it is off');
});

test('a trusted click asks Chrome for every https site inside the click, then asks the worker with the active tab', async t => {
  const view = await panel(t, { tab: { id: 9, url: undefined }, desktop: { allSites: false } });
  view.clickNow('all-sites-enable');
  // Chrome only prompts inside the user's gesture, so the request is made before anything is awaited.
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'permissions.request', origins: ['https://*/*'] });
  for (let i = 0; i < 8; i++) await tick();
  const types = view.types();
  assert.ok(types.indexOf('permissions.request') < types.indexOf('ui:enableAllSites'));
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:enableAllSites')), { type: 'ui:enableAllSites', confirmed: true, tabId: 9 });
  assert.equal(view.get('all-sites-enable').hidden, true);
  assert.equal(view.get('all-sites-disable').hidden, false);
  assert.equal(view.get('status').textContent, ALL_ON);
});

test('declining Chrome’s prompt for all websites turns nothing on', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: false }, desktop: { allSites: false }, grant: false });
  await view.userClick('all-sites-enable'); await tick();
  assert.equal(view.types().includes('permissions.request'), true);
  assert.equal(view.types().includes('ui:enableAllSites'), false);
  assert.equal(view.get('status').textContent, 'Chrome didn’t allow SecondHand on all websites. Nothing changed.');
  assert.equal(view.get('status').classList.contains('error'), true);
  assert.equal(view.get('all-sites-enable').hidden, false);
});

test('when all websites is on, its off button shows, the per-site buttons step aside, and turning off asks the worker', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, desktop: { allSites: true } });
  assert.equal(view.get('all-sites-enable').hidden, true);
  assert.equal(view.get('all-sites-disable').hidden, false);
  assert.equal(view.get('all-sites-disable').textContent, 'Turn off on all websites');
  assert.equal(view.get('site-enable').hidden, true);
  assert.equal(view.get('site-disable').hidden, true, 'one site can’t be turned off inside all websites');
  assert.equal(view.get('panel-autofill').disabled, false);
  view.get('all-sites-disable').click(); await tick();
  assert.equal(view.types().includes('ui:disableAllSites'), false);
  await view.userClick('all-sites-disable'); for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:disableAllSites')), { type: 'ui:disableAllSites', confirmed: true });
  assert.equal(view.types().includes('permissions.request'), false, 'turning off needs no prompt');
  assert.equal(view.get('status').textContent, 'SecondHand is off on other websites. Sites you turned on one at a time stay on.');
  assert.equal(view.get('all-sites-enable').hidden, false);
  assert.equal(view.get('all-sites-disable').hidden, true);
});

test('the off message, with how to remove Chrome’s kept grant, stays on screen until the tab changes', async t => {
  // The side panel checks the page every 1.5 seconds; the test runs that clock itself.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const taken = 'SecondHand is off on other websites. Sites you turned on one at a time stay on. Chrome still lists SecondHand’s access to all websites, but nothing uses it. To remove it, open chrome://extensions, then SecondHand, then Details, then Site access.';
  const params = { first: { key: 'worker.allSitesOff', params: {} }, second: { key: 'worker.chromeStillAllows', params: {} } };
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, desktop: { allSites: true },
    allSitesOff: { message: taken, messageKey: 'joined', messageParams: params } });
  await view.userClick('all-sites-disable'); for (let i = 0; i < 6; i++) await tick();
  assert.equal(view.get('status').textContent, taken);
  const checks = view.types().filter(type => type === 'ui:pageState').length;
  t.mock.timers.tick(1500); for (let i = 0; i < 6; i++) await tick();
  assert.equal(view.types().filter(type => type === 'ui:pageState').length, checks + 1, 'the regular page check ran');
  assert.equal(view.get('status').textContent, taken, 'the regular page check doesn’t replace it');
  view.tabs.current = { id: 8, url: OTHER_SITE.url };
  view.listeners.activated({ tabId: 8 }); for (let i = 0; i < 4; i++) await tick();
  assert.notEqual(view.get('status').textContent, taken);
  const spanish = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, desktop: { allSites: true }, language: 'es-MX',
    allSitesOff: { message: taken, messageKey: 'joined', messageParams: params } });
  await spanish.userClick('all-sites-disable'); for (let i = 0; i < 6; i++) await tick();
  assert.equal(spanish.get('status').textContent, strings.text('es', 'joined', params));
});

test('an error turning all websites on or off is shown in the applicant’s language', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: false }, desktop: { allSites: false },
    allSitesError: { error: strings.english('worker.appDidNotApproveAllSites'), errorKey: 'worker.appDidNotApproveAllSites', errorParams: {} } });
  await view.userClick('all-sites-enable'); for (let i = 0; i < 6; i++) await tick();
  assert.equal(view.get('status').textContent, 'The SecondHand app did not approve all websites.');
  assert.equal(view.get('status').classList.contains('error'), true);
});

test('with all websites on, a tab SecondHand can’t read asks for a form', async t => {
  const on = await panel(t, { tab: { id: 9, url: 'chrome://newtab/' }, desktop: { allSites: true } });
  assert.equal(on.get('status').textContent, 'Open Iowa’s SNAP application or another food-assistance form in this tab.');
  assert.equal(on.get('all-sites-disable').hidden, false);
});

test('turning all websites back on asks Chrome inside the click again, which answers at once from the kept grant', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, desktop: { allSites: true } });
  await view.userClick('all-sites-disable'); for (let i = 0; i < 6; i++) await tick();
  assert.equal(view.get('all-sites-enable').hidden, false);
  view.clickNow('all-sites-enable');
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'permissions.request', origins: ['https://*/*'] });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(view.types().filter(type => type === 'ui:enableAllSites').length, 1);
  assert.equal(view.get('all-sites-disable').hidden, false);
  assert.equal(view.get('status').textContent, ALL_ON);
});

// Updating itself (#85): the side panel says once that SecondHand was updated, and shows the steps
// when the worker can't update itself.
const BUILD_KEY = 'secondhand.build';
const noteOf = view => view.get('update-note').hidden ? null : view.get('update-note').textContent;

test('after an update, the side panel says once that SecondHand was updated', async t => {
  const storage = new Map([[BUILD_KEY, '2026-01-01.1']]);
  const view = await panel(t, { storage });
  await settle();
  assert.equal(noteOf(view), strings.english('panel.updated'));
  assert.equal(view.get('update-note').classList.contains('error'), false);
  assert.equal(storage.get(BUILD_KEY), BUILD);
  const again = await panel(t, { storage });
  await settle();
  assert.equal(noteOf(again), null, 'said once');
  const spanish = await panel(t, { storage: new Map([[BUILD_KEY, '2026-01-01.1'], ['secondhand.language', 'es']]) });
  await settle();
  assert.equal(noteOf(spanish), strings.text('es', 'panel.updated'));
});

test('the first side panel says nothing and remembers the build; the widget and an outdated worker leave it alone', async t => {
  const storage = new Map();
  const first = await panel(t, { storage });
  await settle();
  assert.equal(noteOf(first), null);
  assert.equal(storage.get(BUILD_KEY), BUILD);
  const earlier = new Map([[BUILD_KEY, '2026-01-01.1']]);
  await panel(t, { storage: earlier, launcher: true });
  await settle();
  assert.equal(earlier.get(BUILD_KEY), '2026-01-01.1', 'the widget neither says nor remembers it');
  const outdated = await panel(t, { storage: earlier, build: 'older-build' });
  await settle();
  assert.equal(noteOf(outdated), null);
  assert.equal(earlier.get(BUILD_KEY), '2026-01-01.1', 'not updated until Chrome runs the new worker');
});

test('when SecondHand can’t update itself, the side panel shows the steps to do it by hand', async t => {
  const failed = await panel(t, { desktop: { update: 'failed' } });
  await settle();
  assert.equal(noteOf(failed), strings.english('panel.updateFailed'));
  assert.equal(failed.get('update-note').classList.contains('error'), true);
  const elsewhere = await panel(t, { desktop: { update: 'elsewhere' }, storage: new Map([[BUILD_KEY, '2026-01-01.1']]) });
  await settle();
  assert.equal(noteOf(elsewhere), strings.english('panel.updateElsewhere'), 'the steps come before the note that it was updated');
  const vietnamese = await panel(t, { desktop: { update: 'failed' }, language: 'vi-VN' });
  await settle();
  assert.equal(noteOf(vietnamese), strings.text('vi', 'panel.updateFailed'));
  // Once the worker no longer reports it, the line goes.
  failed.desktop.update = undefined;
  failed.window.document.dispatchEvent(new failed.window.Event('visibilitychange'));
  await settle();
  assert.equal(noteOf(failed), null);
});

test('a widget left on a page when SecondHand reloaded asks for the page to be reloaded, and stops asking the worker', async t => {
  const widget = await panel(t, { launcher: true });
  assert.equal(widget.get('widget-text').textContent, 'Iowa · uses first home address suggestion');
  // As Chrome leaves an extension frame whose extension reloaded: no id, and every message refused.
  const runtime = widget.window.chrome.runtime;
  delete runtime.id;
  runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
  await widget.userClick('autofill');
  assert.equal(widget.get('widget-text').textContent, strings.english('panel.reloadPage'));
  assert.equal(widget.get('widget').classList.contains('outdated'), true);
  const spanish = await panel(t, { launcher: true, language: 'es-ES' });
  delete spanish.window.chrome.runtime.id;
  spanish.window.chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
  await spanish.userClick('autofill');
  assert.equal(spanish.get('widget-text').textContent, strings.text('es', 'panel.reloadPage'));
  // Any other failure is shown as it is.
  const other = await panel(t, { launcher: true });
  other.window.chrome.runtime.sendMessage = async () => { throw new Error('Synthetic Chrome failure.'); };
  await other.userClick('autofill');
  assert.equal(other.get('widget-text').textContent, 'Synthetic Chrome failure.');
});

// Save to My information (#98).
const PANTRY_SITE = { origin: 'https://pantry.example.org', enabled: true, ready: true, frames: [] };
const pantryTab = { id: 7, url: 'https://pantry.example.org/intake' };
const SAVABLE = [{ id: 'f0:sh-2-1', label: 'Apartment number', answered: false }, { id: 'f0:sh-2-2', label: 'County', answered: true }];

test('the side panel lists questions with no saved answer by their own words, and offers Save to My information once the page holds an answer', async t => {
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, savable: SAVABLE });
  assert.equal(view.get('save-section').hidden, false);
  assert.equal(view.get('save-title').textContent, 'Not saved in SecondHand');
  const row = id => view.window.document.querySelector(`[data-save-id="${id}"]`);
  assert.match(row('f0:sh-2-1').textContent, /Apartment number.*Answer it on the page to save it\./);
  assert.equal(row('f0:sh-2-1').querySelector('button'), null, 'nothing to save until the page holds an answer');
  const button = row('f0:sh-2-2').querySelector('button');
  assert.equal(button.textContent, 'Save to My information');
  assert.equal(button.getAttribute('aria-label'), 'Save your answer to “County” to My information');
  assert.doesNotMatch(view.get('save-section').textContent, /Story/, 'the panel never shows what the page holds');
  button.click(); await tick();
  assert.equal(view.types().includes('ui:saveAnswer'), false, 'only a trusted click');
  await view.userClick(button);
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:saveAnswer')), { type: 'ui:saveAnswer', id: 'f0:sh-2-2', confirmed: true, tabId: 7 });
  assert.equal(view.get('status').textContent, 'Saved to My information. SecondHand can fill it next time.');
  assert.equal(row('f0:sh-2-2'), null, 'a saved answer leaves the list');
  assert.ok(row('f0:sh-2-1'));
});

test('a save the worker or the app refuses shows why, and nothing else changes', async t => {
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, savable: SAVABLE,
    saveError: { error: strings.english('worker.saveCancelled'), errorKey: 'worker.saveCancelled', errorParams: {} } });
  await view.userClick(view.window.document.querySelector('[data-save-id="f0:sh-2-2"] button'));
  assert.equal(view.get('status').textContent, 'Cancelled. Nothing was saved.');
  assert.equal(view.get('status').classList.contains('error'), true);
  assert.ok(view.window.document.querySelector('[data-save-id="f0:sh-2-2"] button'));
});

test('the list shows only well-formed questions, in the applicant’s language, and is gone with nothing to save', async t => {
  const odd = [...SAVABLE, { id: 'not an id!', label: 'Bad id', answered: true }, { id: 'f0:sh-2-3', label: 42, answered: true }, { id: 'f0:sh-2-4', label: 'No flag' }];
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, savable: odd, language: 'es' });
  assert.deepEqual([...view.window.document.querySelectorAll('[data-save-id]')].map(row => row.dataset.saveId), ['f0:sh-2-1', 'f0:sh-2-2']);
  assert.equal(view.get('save-title').textContent, 'No está guardado en SecondHand');
  assert.equal(view.window.document.querySelector('[data-save-id="f0:sh-2-2"] button').textContent, 'Guardar en “My information”');
  const none = await panel(t, { tab: pantryTab, site: PANTRY_SITE });
  assert.equal(none.get('save-section').hidden, true);
});

// Fill sensitive details (#176): the questions whose saved answers the app held back until the applicant allows them.
const HELD = [{ id: 'f0:sh-2-0', label: 'Date of birth' }, { id: 'f0:sh-2-1', label: 'Social Security number' }];
const WAITING = 'Filled 1 · 3 need you. Check your answers before you submit. 2 sensitive details wait until you click Fill sensitive details in the side panel.';
const heldDone = { state: 'done', filled: 1, guessed: 0, needYou: ['f0:sh-2-2', 'f0:sh-2-0', 'f0:sh-2-1'], held: 2, message: WAITING, messageKey: 'result.withHeld',
  messageParams: { summary: { key: 'result.siteFilledNeedYou', params: { count: 1, needYou: 3 } }, count: 2 }, pageKey: 'general' };
const heldFilled = { state: 'done', filled: 3, guessed: 0, needYou: ['f0:sh-2-2'], message: 'Filled 3 · 1 need you. Check your answers before you submit.',
  messageKey: 'result.siteFilledNeedYou', messageParams: { count: 3, needYou: 1 }, pageKey: 'general' };

test('the side panel lists the held questions by their own words with one Fill sensitive details button, which asks the worker from a trusted click (#176)', async t => {
  let answer;
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, held: HELD, result: heldDone, heldResult: heldFilled, fillHeldAnswered: new Promise(resolve => { answer = resolve; }) });
  assert.equal(view.get('held-section').hidden, false);
  assert.equal(view.get('held-title').textContent, 'Sensitive details waiting');
  assert.equal(view.get('held-section').querySelector('.save-hint').textContent, 'SecondHand fills these only after you allow it in the SecondHand app.');
  assert.deepEqual([...view.window.document.querySelectorAll('[data-held-id]')].map(row => [row.dataset.heldId, row.textContent]),
    [['f0:sh-2-0', 'Date of birth'], ['f0:sh-2-1', 'Social Security number']]);
  assert.equal(view.get('held-fill').textContent, 'Fill sensitive details');
  assert.equal(view.get('held-section').querySelectorAll('button').length, 1, 'one button for them all');
  assert.equal(view.get('status').textContent, WAITING);
  view.get('held-fill').click(); await tick();
  assert.equal(view.types().includes('ui:fillHeld'), false, 'only a trusted click');
  view.clickNow('held-fill');
  assert.equal(view.get('held-fill').disabled, true, 'while the app asks');
  await tick(); await tick();
  assert.equal(view.get('status').textContent, 'Allow or cancel in the SecondHand app.');
  answer();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:fillHeld')), { type: 'ui:fillHeld', confirmed: true, tabId: 7 });
  assert.equal(view.get('status').textContent, heldFilled.message);
  assert.equal(view.get('held-section').hidden, true, 'nothing waits now');
  assert.equal(view.window.document.querySelectorAll('[data-held-id]').length, 0);
});

test('a Cancel in the app keeps the held questions listed, with the button, and says so (#176)', async t => {
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, held: HELD, result: heldDone,
    fillHeldError: { error: strings.english('worker.heldCancelled'), errorKey: 'worker.heldCancelled', errorParams: {} } });
  await view.userClick('held-fill');
  assert.equal(view.get('status').textContent, 'Cancelled. The sensitive details weren’t filled, and they are still listed.');
  assert.equal(view.get('status').classList.contains('error'), true);
  assert.equal(view.window.document.querySelectorAll('[data-held-id]').length, 2);
  assert.equal(view.get('held-fill').disabled, false);
});

test('the held list shows only well-formed questions, in the applicant’s language, and is gone with nothing held (#176)', async t => {
  const odd = [...HELD, { id: 'not an id!', label: 'Bad id' }, { id: 'f0:sh-2-3', label: 42 }, null];
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, held: odd, language: 'es' });
  assert.deepEqual([...view.window.document.querySelectorAll('[data-held-id]')].map(row => row.dataset.heldId), ['f0:sh-2-0', 'f0:sh-2-1']);
  assert.equal(view.get('held-title').textContent, 'Datos sensibles en espera');
  assert.equal(view.get('held-fill').textContent, 'Llenar datos sensibles');
  view.get('language').value = 'fr';
  view.get('language').dispatchEvent(new view.window.Event('change'));
  assert.equal(view.get('held-fill').textContent, 'Remplir les informations sensibles');
  const none = await panel(t, { tab: pantryTab, site: PANTRY_SITE });
  assert.equal(none.get('held-section').hidden, true);
});

test('the widget counts held questions under need-you, says they wait in the side panel, and follows the worker once they fill (#176)', async t => {
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: heldDone });
  await view.userClick('autofill');
  assert.equal(view.get('need-you').textContent, '3 need you');
  assert.equal(view.get('widget-text').textContent, 'Filled 1 · 2 sensitive details wait in the side panel');
  // Fill sensitive details in the side panel changes the tab's result: the widget takes it at its next look.
  view.state.result = structuredClone(heldFilled);
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('need-you').textContent, '1 need you');
  assert.equal(view.get('widget-text').textContent, 'Filled 3');
  // With nothing held any more, it keeps its own result again.
  view.state.result = { ...heldFilled, filled: 9 };
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('widget-text').textContent, 'Filled 3');

  // Nothing else filled: the held questions matched, so it never says that nothing matched.
  const only = { ...heldDone, filled: 0, held: 1, needYou: ['f0:sh-2-1'], message: strings.text('en', 'result.withHeld', { summary: { key: 'result.siteNeedYou', params: { count: 1 } }, count: 1 }) };
  const alone = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: only });
  await alone.userClick('autofill');
  assert.equal(alone.get('widget-text').textContent, '1 sensitive detail waits in the side panel');
  assert.equal(alone.get('need-you').textContent, '1 need you');
  const spanish = await panel(t, { launcher: true, language: 'es', tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: heldDone });
  await spanish.userClick('autofill');
  assert.equal(spanish.get('widget-text').textContent, 'Completadas: 1 · 2 datos sensibles esperan en el panel lateral');
});

// #185: Laya's best guesses, listed for the applicant to find and check.
const GUESSES = [{ id: 'f0:sh-1-1', label: 'How many people live in your household?' }, { id: 'f4:sh-1-3', label: 'Preferred pickup day' }];
const GUESSED = 'Filled 4 · 1 suggested. Check your answers before you submit. Suggestions came from Laya on this computer. 2 guessed by Laya, check them.';
const guessedDone = { state: 'done', filled: 4, guessed: 1, laya: 1, layaGuessed: 2, layaGuesses: GUESSES, needYou: [], pageKey: 'general', message: GUESSED, messageKey: 'result.layaGuessed',
  messageParams: { summary: { key: 'result.suggestedByLaya', params: { summary: { key: 'result.siteFilledSuggested', params: { count: 4, suggested: 1 } } } }, count: 2 } };

test('#185: the side panel lists Laya’s guesses by their own words, and a trusted row click finds each one on the page', async t => {
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, result: guessedDone });
  assert.equal(view.get('guesses-section').hidden, false);
  assert.equal(view.get('guesses-title').textContent, 'Guessed by Laya, check them');
  assert.equal(view.get('guesses-section').querySelector('.save-hint').textContent,
    'Laya wasn’t sure of these answers, so each has a dotted outline on the page. Click one to find it and check it.');
  const rows = [...view.window.document.querySelectorAll('[data-guess-id]')];
  assert.deepEqual(rows.map(row => [row.tagName, row.dataset.guessId, row.textContent, row.getAttribute('aria-label')]), [
    ['BUTTON', 'f0:sh-1-1', 'How many people live in your household?', 'Find Laya’s guess for “How many people live in your household?” on the page'],
    ['BUTTON', 'f4:sh-1-3', 'Preferred pickup day', 'Find Laya’s guess for “Preferred pickup day” on the page']]);
  assert.equal(view.get('status').textContent, GUESSED);
  rows[1].click(); await tick();
  assert.equal(view.types().includes('ui:focusField'), false, 'only a trusted click');
  await view.userClick(rows[1]);
  assert.deepEqual(plainRequests(view.requests.filter(request => request.type === 'ui:focusField')), [{ type: 'ui:focusField', key: 'f4:sh-1-3', tabId: 7 }]);
  assert.equal(view.get('status').textContent, GUESSED, 'found: nothing more to say');
});

test('#185: the guess list shows only well-formed questions, in the applicant’s language, and is gone with no guesses', async t => {
  const odd = { ...guessedDone, layaGuesses: [...GUESSES, { id: 'not an id!', label: 'Bad id' }, { id: 'f0:sh-1-5', label: 7 }, null] };
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, result: odd, language: 'es' });
  assert.deepEqual([...view.window.document.querySelectorAll('[data-guess-id]')].map(row => row.dataset.guessId), ['f0:sh-1-1', 'f4:sh-1-3']);
  assert.equal(view.get('guesses-title').textContent, 'Respuestas adivinadas por Laya, revíselas');
  assert.equal(view.window.document.querySelector('[data-guess-id]').getAttribute('aria-label'), strings.text('es', 'guesses.rowLabel', { label: GUESSES[0].label }));
  view.get('language').value = 'fr';
  view.get('language').dispatchEvent(new view.window.Event('change'));
  assert.equal(view.get('guesses-title').textContent, 'Réponses devinées par Laya, à vérifier');
  assert.equal(view.window.document.querySelector('[data-guess-id]').getAttribute('aria-label'), strings.text('fr', 'guesses.rowLabel', { label: GUESSES[0].label }));
  for (const result of [siteDone, null]) {
    const none = await panel(t, { tab: pantryTab, site: PANTRY_SITE, result });
    assert.equal(none.get('guesses-section').hidden, true);
  }
});

test('#185: the widget says how many Laya guessed, apart from its sure answers, in the applicant’s language', async t => {
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true }, autofill: guessedDone });
  await view.userClick('autofill');
  assert.equal(view.get('widget-text').textContent, 'Filled 4 · 1 suggested · suggested by Laya · 2 guessed by Laya, check them');
  assert.equal(view.get('widget-text').title, GUESSED);
  const one = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true },
    autofill: { ...guessedDone, filled: 1, guessed: 0, laya: undefined, layaGuessed: 1, layaGuesses: GUESSES.slice(0, 1) } });
  await one.userClick('autofill');
  assert.equal(one.get('widget-text').textContent, 'Filled 1 · 1 guessed by Laya, check it');
  const spanishView = await panel(t, { launcher: true, language: 'es', tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true }, autofill: guessedDone });
  await spanishView.userClick('autofill');
  assert.equal(spanishView.get('widget-text').textContent,
    `${strings.text('es', 'widget.filledSuggested', { count: 4, suggested: 1 })} · ${spanish('widget.suggestedByLaya')} · ${strings.text('es', 'widget.layaGuessed', { count: 2 })}`);
  assert.deepEqual(shownText(spanishView).filter(text => englishOnly.has(text)), []);
});


test('Fill and continue is a trusted, explicit side-panel action with an ordinary-Next disclosure and Stop', async t => {
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true, ready: true } });
  assert.equal(view.get('site-continue').hidden, false);
  assert.equal(view.get('site-continue').disabled, false);
  assert.match(view.get('site-continue-hint').textContent, /saved/i);
  assert.match(view.get('site-continue-hint').textContent, /send|save/i);
  assert.match(view.get('site-continue-hint').textContent, /consent|signature|submit/i);
  view.get('site-continue').click(); await tick();
  assert.equal(view.types().includes('ui:fillAndContinue'), false);
  await view.userClick('site-continue');
  assert.deepEqual(plainRequests(view.requests.filter(r => r.type === 'ui:fillAndContinue')), [{ type: 'ui:fillAndContinue', confirmed: true, tabId: 7 }]);
  assert.equal(view.types().includes('ui:plan'), false, 'this mode never asks Chrome AI for guesses');
  assert.equal(view.get('site-continue').hidden, true);
  assert.equal(view.get('panel-autofill').textContent, 'Stop autofill');
  await view.userClick('panel-autofill');
  assert.equal(view.types().includes('ui:stop'), true);
  assert.equal(view.get('site-continue').hidden, false);
});

test('Fill and continue is unavailable off enabled ready general sites and recovers after a pause', async t => {
  for (const site of [null, { origin: ORIGIN, enabled: false }, { origin: ORIGIN, enabled: true, ready: false }]) {
    const view = await panel(t, site ? { tab: SITE, site } : {});
    assert.equal(view.get('site-continue').hidden, true);
    await view.userClick('site-continue');
    assert.equal(view.types().includes('ui:fillAndContinue'), false);
  }
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true, ready: true }, fillAndContinue: {
    state: 'waiting', pageKey: 'general', autoContinue: false, messageKey: 'worker.siteNext.missing' } });
  await view.userClick('site-continue');
  assert.equal(view.get('site-continue').hidden, false);
  assert.equal(view.get('panel-autofill').textContent, 'Autofill this page');
  assert.match(view.get('status').textContent, /required/i);
});

// Remember for next time (#186): the open questions the applicant answered on the page, each with a checkbox.
const REMEMBERABLE = [{ id: 'f0:sh-2-1', label: 'EMPLID', timeBound: false, answered: true }, { id: 'f0:sh-2-2', label: 'Preferred pickup day', timeBound: true, answered: true },
  { id: 'f0:sh-2-3', label: 'How did you hear about us?', timeBound: false, answered: false }];
const rememberRow = (view, id) => view.window.document.querySelector(`[data-remember-id="${id}"]`);
const rememberBox = (view, id) => rememberRow(view, id).querySelector('input[type="checkbox"]');
const tick6 = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('the side panel offers Remember for next time beside each open question answered on the page, checked unless its answer changes over time (#186)', async t => {
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, rememberable: REMEMBERABLE });
  assert.equal(view.get('remember-section').hidden, false);
  assert.equal(view.get('remember-title').textContent, 'Your answers on this page');
  assert.deepEqual([...view.window.document.querySelectorAll('[data-remember-id]')].map(row => row.dataset.rememberId), ['f0:sh-2-1', 'f0:sh-2-2'], 'only questions the page holds an answer for');
  assert.match(rememberRow(view, 'f0:sh-2-1').textContent, /^EMPLID.*Remember for next time$/);
  assert.equal(rememberBox(view, 'f0:sh-2-1').getAttribute('aria-label'), 'Remember your answer to “EMPLID” for next time');
  assert.equal(rememberBox(view, 'f0:sh-2-1').checked, true, 'checked by default');
  assert.equal(rememberBox(view, 'f0:sh-2-2').checked, false, 'a time-bound answer starts unchecked');
  assert.match(rememberRow(view, 'f0:sh-2-2').textContent, /This answer may change, so it starts unchecked\./);
  assert.equal(view.get('remember-save').textContent, 'Remember checked answers');
  view.get('remember-save').click(); await tick();
  assert.equal(view.types().includes('ui:rememberAnswers'), false, 'only a trusted click');
  view.clickNow('remember-save');
  await tick();
  assert.equal(view.get('remember-save').disabled, true, 'while the app asks');
  await tick6();
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:rememberAnswers')), { type: 'ui:rememberAnswers', ids: ['f0:sh-2-1'], confirmed: true, tabId: 7 });
  assert.equal(view.get('status').textContent, 'Remembered 1 answer. SecondHand can fill it next time.');
  assert.equal(rememberRow(view, 'f0:sh-2-1'), null, 'a remembered answer leaves the list');
  // Checking the time-bound one remembers it too; with nothing checked, there is nothing to send.
  rememberBox(view, 'f0:sh-2-2').checked = true; rememberBox(view, 'f0:sh-2-2').dispatchEvent(new view.window.Event('change'));
  assert.equal(view.get('remember-save').disabled, false);
  rememberBox(view, 'f0:sh-2-2').checked = false; rememberBox(view, 'f0:sh-2-2').dispatchEvent(new view.window.Event('change'));
  assert.equal(view.get('remember-save').disabled, true, 'nothing checked, nothing to remember');
  rememberBox(view, 'f0:sh-2-2').checked = true; rememberBox(view, 'f0:sh-2-2').dispatchEvent(new view.window.Event('change'));
  await view.userClick('remember-save'); await tick6();
  assert.deepEqual(plainRequests(view.requests.filter(request => request.type === 'ui:rememberAnswers').at(-1)).ids, ['f0:sh-2-2']);
  assert.equal(view.get('remember-section').hidden, true, 'nothing left to remember');
});

test('a remember the worker or the app refuses says why, and keeps the rows and the applicant’s choices (#186)', async t => {
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, rememberable: REMEMBERABLE,
    rememberError: { error: strings.english('worker.rememberCancelled'), errorKey: 'worker.rememberCancelled', errorParams: {} } });
  rememberBox(view, 'f0:sh-2-2').checked = true; rememberBox(view, 'f0:sh-2-2').dispatchEvent(new view.window.Event('change'));
  await view.userClick('remember-save'); await tick6();
  assert.equal(view.get('status').textContent, 'Cancelled. Nothing was remembered.');
  assert.equal(view.get('status').classList.contains('error'), true);
  assert.deepEqual([rememberBox(view, 'f0:sh-2-1').checked, rememberBox(view, 'f0:sh-2-2').checked], [true, true]);
  // A poll keeps the choices made here.
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange')); await tick6();
  assert.deepEqual([rememberBox(view, 'f0:sh-2-1').checked, rememberBox(view, 'f0:sh-2-2').checked], [true, true]);
  assert.equal(view.get('remember-save').disabled, false);
});

test('the remember list shows only well-formed rows, in the applicant’s language, and is gone with nothing to remember (#186)', async t => {
  const odd = [...REMEMBERABLE, { id: 'not an id!', label: 'Bad id', timeBound: false, answered: true }, { id: 'f0:sh-2-4', label: 42, timeBound: false, answered: true },
    { id: 'f0:sh-2-5', label: 'No flag', answered: true }, null];
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, rememberable: odd, language: 'es' });
  assert.deepEqual([...view.window.document.querySelectorAll('[data-remember-id]')].map(row => row.dataset.rememberId), ['f0:sh-2-1', 'f0:sh-2-2']);
  assert.equal(view.get('remember-title').textContent, 'Sus respuestas en esta página');
  assert.equal(view.get('remember-save').textContent, 'Recordar las respuestas marcadas');
  assert.match(rememberRow(view, 'f0:sh-2-1').textContent, /Recordar para la próxima vez/);
  view.get('language').value = 'fr';
  view.get('language').dispatchEvent(new view.window.Event('change'));
  assert.equal(view.get('remember-save').textContent, 'Retenir les réponses cochées');
  assert.match(rememberRow(view, 'f0:sh-2-1').textContent, /Retenir pour la prochaine fois/);
  const none = await panel(t, { tab: pantryTab, site: PANTRY_SITE, rememberable: [REMEMBERABLE[2]] });
  assert.equal(none.get('remember-section').hidden, true, 'nothing answered yet');
  const empty = await panel(t, { tab: pantryTab, site: PANTRY_SITE });
  assert.equal(empty.get('remember-section').hidden, true);
});

test('the widget says how many answers came from custom answers (#186)', async t => {
  const fromCustom = { state: 'done', filled: 3, guessed: 0, needYou: [], custom: 2, pageKey: 'general', message: 'Filled 3. Check your answers before you submit. 2 from your custom answers.',
    messageKey: 'result.fromCustom', messageParams: { summary: { key: 'result.siteFilled', params: { count: 3 } }, count: 2 } };
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: fromCustom });
  await view.userClick('autofill');
  assert.equal(view.get('widget-text').textContent, 'Filled 3 · 2 from your custom answers');
  const spanish = await panel(t, { launcher: true, language: 'es', tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: fromCustom });
  await spanish.userClick('autofill');
  assert.equal(spanish.get('widget-text').textContent, 'Completadas: 3 · 2 de sus respuestas personalizadas');
});
