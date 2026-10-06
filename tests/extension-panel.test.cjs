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
// An outdated worker: the widget's line beside its Restart button (the whole of it, or the short form when the
// frame can't hold the whole), and the side panel's notice above its own.
const OUTDATED = 'SecondHand was updated. Click Restart, then reload or go to the next page.';
const OUTDATED_SHORT = 'SecondHand was updated.';
const OUTDATED_PANEL = 'SecondHand was updated and needs to restart. This side panel will close. To use SecondHand again, go on to the next page of your form, or reload its page; reloading clears what you typed.';


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
  for (const [kind, todo, size] of [['info', undefined, 'full'], ['blocked', 'Type the characters shown in Iowa’s security check, then click Continue.', 'full'], ['manual', 'Pick the correct address, then click Continue.', 'full'], ['manual', undefined, 'pill'], ['unsupported', undefined, 'pill']]) {
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
  for (const [kind, todo] of [['fillable'], ['info'], ['blocked', 'Type the characters shown in Iowa’s security check, then click Continue.'], ['manual', 'Pick the correct address, then click Continue.'], ['unsupported']]) {
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
// Results as the worker sends them: its message, and the catalog key and parameters it was written from.
const doneResult = { state: 'done', filled: 3, needYou: ['firstName', 'lastName'], message: 'Filled 3 answers · 2 left for you.', messageKey: 'result.filledNeedYou', messageParams: { count: 3, needYou: 2 }, pageKey: 'iowa-personal-information' };

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
    ...(initial.savable ? { savable: structuredClone(initial.savable) } : {}), ...(initial.held ? { held: structuredClone(initial.held) } : {}) } : {
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
  window.chrome = {
    // `shortcuts`: the keys Chrome lists for SecondHand's commands, as chrome://extensions/shortcuts sets them.
    ...(initial.shortcuts ? { commands: { getAll: async () => structuredClone(initial.shortcuts) } } : {}),
    tabs: {
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
    // `autofillHeld`: a promise the app's answer waits for, as while its window asks for permission.
    else if (payload.type === 'ui:autofill') { await initial.autofillHeld; state.result = initial.autofill || doneResult; state.autopilot = Boolean(initial.autopilotAfterAutofill); data = structuredClone(state.result); }
    else if (payload.type === 'ui:fillAndContinue') { state.result = initial.fillAndContinue || { state: 'continuing', pageKey: 'general', autoContinue: true, filled: 2, messageKey: 'worker.siteContinuing' }; state.autopilot = state.result.autoContinue === true; data = structuredClone(state.result); }
    else if (payload.type === 'ui:stop') { state.autopilot = false; state.result = { state: 'stopped', filled: 0, needYou: [], message: 'Autofill stopped. Nothing was erased.', pageKey: 'iowa-personal-information' }; data = structuredClone(state.result); }
    else if (payload.type === 'ui:desktopStatus') data = { ...desktop };
    else if (payload.type === 'ui:focusField') data = { focused: true };
    else if (payload.type === 'ui:saveAnswer') {
      // Save to My information (#98): the worker reads that one box and the app saves it after its confirmation.
      if (initial.saveError) return { ok: false, ...initial.saveError };
      state.savable = state.savable.filter(item => item.id !== payload.id);
      data = { saved: true };
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
  const mapStorage = map => ({ getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: mapStorage(storage) });
  // And session storage, which a widget's frame keeps for its tab.
  const session = initial.session || new Map();
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: mapStorage(session) });
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
  // An unlocked app needs nothing from the reader: its row stays out of the way and says nothing.
  assert.equal(view.get('desktop-status').parentElement.hidden, true);
  assert.equal(view.get('desktop-status').textContent, '');
  assert.equal(view.get('desktop-action').hidden, true);
});

test('trusted side-panel Autofill targets the active tab, shows the result, and rechecks the desktop', async t => {
  const view = await panel(t);
  await view.userClick('panel-autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:autofill')), { type: 'ui:autofill', confirmed: true, tabId: 7 });
  assert.match(view.get('status').textContent, /Filled 3 answers · 2 left for you/);
  assert.equal(view.types().filter(type => type === 'ui:desktopStatus').length, 2);
});

test('checklist uses plain labels and a trusted row click finds the field', async t => {
  const view = await panel(t);
  // Before Autofill has run on this page, a required question is only not filled yet.
  assert.equal(view.row('firstName').textContent, 'First nameNot filled yet');
  assert.equal(view.row('firstName').classList.contains('pending'), true);
  assert.equal(view.row('firstName').classList.contains('missing'), false);
  assert.equal(view.row('lastName').textContent, 'Last nameDone');
  // A finished row carries the drawn check mark; the others an empty ring.
  assert.equal(view.row('lastName').querySelectorAll('.checklist-mark svg path').length, 1);
  for (const key of ['firstName', 'middleName', 'unverified']) assert.equal(view.row(key).querySelector('.checklist-mark').childNodes.length, 0, key);
  assert.match(view.row('middleName').textContent, /Optional/);
  assert.match(view.row('unverified').textContent, /Do it yourself/);
  assert.equal(view.get('checklist-summary').textContent, '', 'no count until Autofill has run');
  assert.equal(view.get('checklist-note').hidden, true);
  view.row('firstName').click(); await tick();
  assert.equal(view.types().includes('ui:focusField'), false);
  await view.userClick(view.row('firstName'));
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:focusField')), { type: 'ui:focusField', key: 'firstName', tabId: 7 });
  // After Autofill, what it left waits for the reader, and the count is what the status line and the widget say:
  // required questions without an answer, and steps SecondHand never does. Optional ones are not counted.
  await view.userClick('panel-autofill');
  assert.equal(view.row('firstName').textContent, 'First nameNeeds your answer');
  assert.equal(view.row('firstName').classList.contains('missing'), true);
  assert.equal(view.get('checklist-summary').textContent, '2 left');
  // A result from another page of Iowa's says nothing about this one.
  const earlier = await panel(t, { result: { ...doneResult, pageKey: 'iowa-program-intent' } });
  assert.equal(earlier.row('firstName').textContent, 'First nameNot filled yet');
  assert.equal(earlier.get('checklist-summary').textContent, '');
  const complete = await panel(t, { result: { ...doneResult, needYou: [] }, pageState: state => { const next = structuredClone(state); for (const item of next.page.checklist) if (item.status !== 'optional') item.status = 'complete'; return next; } });
  assert.equal(complete.get('checklist-summary').textContent, 'Nothing left for you');
});

test('after Autofill, a link under the status goes to each question left in turn, as the widget’s does', async t => {
  let checklist = null;
  const view = await panel(t, { pageState: state => { const next = structuredClone(state); if (checklist) next.page.checklist = structuredClone(checklist); return next; } });
  const focused = () => view.requests.filter(request => request.type === 'ui:focusField').map(request => request.key);
  assert.equal(view.get('panel-left').hidden, true, 'nothing is left before Autofill has run');
  await view.userClick('panel-autofill');
  // The required question without an answer and the step SecondHand never does; not the optional one.
  assert.equal(view.get('panel-left').hidden, false);
  assert.equal(view.get('panel-left').textContent, 'Go to the next of the 2 questions left');
  view.get('panel-left').click(); await tick();
  assert.deepEqual(focused(), [], 'a click the page made up goes nowhere');
  for (let i = 0; i < 3; i++) await view.userClick('panel-left');
  assert.deepEqual(focused(), ['firstName', 'unverified', 'firstName']);
  assert.deepEqual(plainRequests(view.requests.findLast(request => request.type === 'ui:focusField')), { type: 'ui:focusField', key: 'firstName', tabId: 7 });
  // The link follows the page: an answer typed since is no longer left.
  checklist = structuredClone(view.state.page.checklist);
  checklist.find(item => item.key === 'firstName').status = 'complete';
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange')); await settle();
  assert.equal(view.get('panel-left').textContent, 'Go to the question left');
  assert.equal(view.get('status').textContent, 'Filled 3 answers · 1 left for you.', 'the status line counts what is left now');
  await view.userClick('panel-left');
  assert.equal(focused().at(-1), 'unverified');
  checklist.find(item => item.key === 'unverified').status = 'complete';
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange')); await settle();
  assert.equal(view.get('panel-left').hidden, true);
  assert.equal(view.get('checklist-summary').textContent, 'Nothing left for you');
  assert.equal(view.get('status').textContent, 'Filled 3 answers.');
  // Another site has no checklist: what Autofill reported is listed by name instead, and each row is its own link.
  const site = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: siteDone });
  assert.equal(site.get('panel-left').hidden, true);
  await site.userClick('panel-autofill');
  assert.equal(site.get('panel-left').hidden, true);
  assert.equal(site.get('left-list').children.length, 2);
  const spanish = await panel(t, { language: 'es-ES' });
  await spanish.userClick('panel-autofill');
  assert.equal(spanish.get('panel-left').textContent, strings.text('es', 'panel.goToLeft', { count: 2 }));
});

test('on a page with no checklist, the side panel names each question Autofill left, and a row finds it', async t => {
  const left = [{ key: 'f0:sh-4', label: '  Do you have a pet?  ' }, { key: 'f4:sh-3', label: '' }, { key: 'f9:sh-9', label: 'Not in needYou' }, { key: 'f0:sh-4' }, 'f0:sh-4'];
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: { ...siteDone, left } });
  assert.equal(view.get('left-section').hidden, true);
  await view.userClick('panel-autofill');
  assert.equal(view.get('left-section').hidden, false);
  assert.equal(view.get('left-title').textContent, 'Left for you');
  assert.equal(view.get('left-summary').textContent, '2 left');
  const rows = [...view.get('left-list').children];
  // One row per key the result lists as left, in its order; a name for a key it doesn't list is ignored.
  assert.deepEqual(rows.map(row => row.dataset.leftKey), ['f0:sh-4', 'f4:sh-3']);
  assert.equal(rows[0].querySelector('.checklist-label').textContent, 'Do you have a pet?');
  assert.equal(rows[0].querySelector('.checklist-detail').textContent, 'Needs your answer');
  assert.equal(rows[0].getAttribute('aria-label'), 'Do you have a pet?: Needs your answer. Go to this question.');
  assert.equal(rows[1].querySelector('.checklist-label').textContent, 'A question with no label');
  assert.equal(view.get('panel-left').hidden, true, 'the rows are the way to each question');
  rows[0].click(); await tick();
  assert.equal(view.types().includes('ui:focusField'), false);
  await view.userClick(rows[1]);
  assert.deepEqual(plainRequests(view.requests.findLast(request => request.type === 'ui:focusField')), { type: 'ui:focusField', key: 'f4:sh-3', tabId: SITE.id });
  // A question the page reports as answered since (one it may save) turns to done, and both counts follow.
  const answering = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: { ...siteDone, left: [{ key: 'f0:sh-4', label: 'Apartment number' }, { key: 'f4:sh-3', label: 'Guardian name' }] },
    savable: [{ id: 'f0:sh-4', label: 'Apartment number', answered: false }] });
  await answering.userClick('panel-autofill');
  assert.equal(answering.get('left-summary').textContent, '2 left');
  answering.state.savable[0].answered = true;
  answering.window.document.dispatchEvent(new answering.window.Event('visibilitychange')); await settle();
  const apartment = answering.get('left-list').children[0];
  assert.equal(apartment.classList.contains('complete'), true);
  assert.equal(apartment.querySelector('.checklist-detail').textContent, 'Done');
  assert.equal(apartment.querySelectorAll('.checklist-mark svg').length, 1);
  assert.equal(answering.get('left-list').children[1].classList.contains('missing'), true);
  assert.equal(answering.get('left-summary').textContent, '1 left');
  assert.equal(answering.get('status').textContent, 'Filled 2 answers · 1 left for you. Check them before you submit.', 'the status line counts what is left now');
  answering.state.savable = [{ id: 'f0:sh-4', label: 'Apartment number', answered: true }, { id: 'f4:sh-3', label: 'Guardian name', answered: true }];
  answering.window.document.dispatchEvent(new answering.window.Event('visibilitychange')); await settle();
  assert.equal(answering.get('status').textContent, 'Filled 2 answers. Check them before you submit.');
  assert.equal(answering.get('left-summary').textContent, 'Nothing left for you');
  // The page's words are shown as text, never as markup.
  const markup = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: { ...siteDone, left: [{ key: 'f0:sh-4', label: '<img src=x onerror=alert(1)>' }] } });
  await markup.userClick('panel-autofill');
  assert.equal(markup.get('left-list').querySelector('img'), null);
  assert.equal(markup.get('left-list').children[0].querySelector('.checklist-label').textContent, '<img src=x onerror=alert(1)>');
  // The list follows the language picker, and leaves with the tab.
  view.get('language').value = 'es';
  view.get('language').dispatchEvent(new view.window.Event('change'));
  await settle();
  assert.equal(view.get('left-title').textContent, strings.text('es', 'left.title'));
  assert.equal(view.get('left-list').children[0].querySelector('.checklist-detail').textContent, spanish('checklist.missing'));
  view.tabs.current = { id: 8, url: 'http://example.invalid/' };
  view.listeners.activated({ tabId: 8 }); await settle();
  assert.equal(view.get('left-section').hidden, true);
  assert.equal(view.get('left-list').children.length, 0);
  // Iowa's checklist already names its questions: no second list there.
  const iowa = await panel(t, { autofill: { ...doneResult, left: [{ key: 'firstName', label: 'First name' }] } });
  await iowa.userClick('panel-autofill');
  assert.equal(iowa.get('left-section').hidden, true);
  assert.equal(iowa.get('panel-left').hidden, false);
});

test('on a page with no checklist, the side panel names what Autofill filled, folded away, with guesses marked', async t => {
  const filledQuestions = [{ label: ' First name ', guessed: false }, { label: 'Email', guessed: true }, { label: '', guessed: false }, { label: 7 }, 'ZIP'];
  const view = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: { ...siteDone, filled: 3, filledQuestions } });
  assert.equal(view.get('filled-section').hidden, true);
  await view.userClick('panel-autofill');
  assert.equal(view.get('filled-section').hidden, false);
  assert.equal(view.get('filled-section').open, false, 'folded until the reader wants the names');
  assert.equal(view.get('filled-title').textContent, 'Filled by SecondHand');
  assert.equal(view.get('filled-summary').textContent, '3 questions');
  const rows = [...view.get('filled-list').children];
  assert.deepEqual(rows.map(row => [row.tagName, row.querySelector('.checklist-label').textContent, row.querySelector('.checklist-detail').textContent]), [
    ['DIV', 'First name', 'Done'], ['DIV', 'Email', 'Guessed, check it'], ['DIV', 'A question with no label', 'Done']]);
  assert.equal(rows.every(row => row.querySelectorAll('.checklist-mark svg').length === 1), true, 'each is marked done');
  assert.equal(view.get('filled-list').querySelector('button'), null, 'rows are names, not links');
  // The list leaves with the tab, and Iowa's own checklist never gets one.
  view.tabs.current = { id: 8, url: 'http://example.invalid/' };
  view.listeners.activated({ tabId: 8 }); await settle();
  assert.equal(view.get('filled-section').hidden, true);
  const iowa = await panel(t, { autofill: { ...doneResult, filledQuestions: [{ label: 'First name', guessed: false }] } });
  await iowa.userClick('panel-autofill');
  assert.equal(iowa.get('filled-section').hidden, true);
});

test('after Autofill, a question whose answer isn’t saved says to type it in Iowa’s form, and one note points to My information', async t => {
  const autofill = { ...doneResult, needYou: ['firstName', 'middleName', 'unverified'], notSaved: ['firstName', 'middleName', 'lastName'] };
  const view = await panel(t, { autofill });
  const detail = key => view.row(key).querySelector('.checklist-detail').textContent;
  assert.equal(detail('firstName'), 'Not filled yet');
  assert.equal(view.get('checklist-note').hidden, true);
  await view.userClick('panel-autofill');
  assert.equal(detail('firstName'), 'No saved answer: type it in Iowa’s form');
  assert.equal(detail('middleName'), 'Optional, no saved answer');
  assert.equal(view.row('firstName').getAttribute('aria-label'), 'First name: No saved answer: type it in Iowa’s form. Go to this question.');
  // Where the answer goes now is on the row; where to save it for next time is said once, above the list.
  assert.equal(view.get('checklist-note').hidden, false);
  assert.equal(view.get('checklist-note').textContent, 'To have an answer filled next time, add it in the SecondHand app, under My information.');
  // A question answered since shows as done; one SecondHand can't fill still says to do it yourself.
  assert.equal(detail('lastName'), 'Done');
  assert.equal(detail('unverified'), 'Do it yourself');
  const spanish = await panel(t, { language: 'es', autofill });
  await spanish.userClick('panel-autofill');
  assert.equal(spanish.row('firstName').querySelector('.checklist-detail').textContent, 'Sin respuesta guardada: escríbala en el formulario de Iowa');
  assert.match(spanish.get('checklist-note').textContent, /en la aplicación SecondHand, en “My information”/);
  // Only a list of question keys is read from the worker's result.
  const malformed = await panel(t, { autofill: { ...doneResult, notSaved: 'firstName' } });
  await malformed.userClick('panel-autofill');
  assert.equal(malformed.row('firstName').querySelector('.checklist-detail').textContent, 'Needs your answer');
  assert.equal(malformed.get('checklist-note').hidden, true);
});

test('desktop line shows locked with Unlock, and not running with Open SecondHand', async t => {
  const locked = await panel(t, { desktop: { unlocked: false } });
  assert.equal(locked.get('desktop-status').textContent, 'The SecondHand app on this computer is locked.');
  assert.equal(locked.get('desktop-action').hidden, false);
  assert.equal(locked.get('desktop-action').textContent, 'Unlock');
  // Unlock is the button to press: Autofill is still there, drawn as an outline.
  const filled = button => [button.classList.contains('primary'), button.classList.contains('secondary')];
  assert.deepEqual(filled(locked.get('desktop-action')), [true, false]);
  assert.deepEqual(filled(locked.get('panel-autofill')), [false, true]);
  assert.equal(locked.get('panel-autofill').disabled, false);
  const open = await panel(t);
  assert.deepEqual(filled(open.get('panel-autofill')), [true, false], 'with the app open and unlocked, Autofill is the filled button');
  await locked.userClick('desktop-action');
  assert.deepEqual(plainRequests(locked.requests.find(request => request.type === 'ui:showApp')), { type: 'ui:showApp', confirmed: true });
  const offline = await panel(t, { desktop: { connected: false, unlocked: false } });
  assert.equal(offline.get('desktop-status').textContent, 'The SecondHand app on this computer is closed.');
  assert.equal(offline.get('desktop-action').hidden, false);
  assert.equal(offline.get('desktop-action').textContent, 'Open SecondHand');
  assert.deepEqual(filled(offline.get('panel-autofill')), [false, true]);
});

// Unlock with Touch ID (#99): the side panel asks the app to show its own Touch ID prompt when the
// app's status says it's ready. Otherwise, or when Touch ID doesn't unlock, Unlock brings SecondHand
// forward as before.
test('when the app says Touch ID is ready, Unlock asks the app for Touch ID and the row then goes, as an unlocked app needs nothing', async t => {
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
  assert.equal(view.get('desktop-status').parentElement.hidden, true, 'an unlocked app needs nothing from the applicant');
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
  await until(() => view.get('desktop-status').textContent === 'The SecondHand app on this computer is locked.');
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
  assert.equal(view.get('status').textContent, '');
  assert.equal(view.get('status').classList.contains('error'), false);
  assert.equal(view.get('desktop-status').textContent, 'The SecondHand app on this computer is closed.');
  assert.equal(view.get('desktop-action').textContent, 'Open SecondHand');
  // The worker's remembered result isn't repeated when the panel opens again either.
  const reopened = await panel(t, { desktop: CLOSED, result: offlineResult });
  assert.equal(reopened.get('status').textContent, '');
  assert.equal(shownText(reopened).filter(text => /Open the SecondHand app|is closed/.test(text)).length, 1);
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
  assert.equal(view.get('panel-autofill').hidden, false);
  // Plain http, and an https tab whose address Chrome hides until the user invokes SecondHand.
  for (const [id, url] of [[8, 'http://example.invalid/'], [9, undefined]]) {
    view.tabs.current = { id, url };
    view.listeners.activated({ tabId: id }); await tick(); await tick();
    assert.equal(view.get('page-checklist').children.length, 0);
    assert.equal(view.get('panel-autofill').disabled, true);
    assert.equal(view.get('panel-autofill').hidden, true, 'no Autofill button where there is nothing to read');
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
  assert.equal(view.get('panel-autofill').hidden, true);
  assert.match(view.get('status').textContent, /Open Iowa/);
});

test('Autofill keeps its place, disabled, while a tab SecondHand reads is checked again', async t => {
  let hold;
  const view = await panel(t, { pageState: state => hold ? hold.then(() => structuredClone(state)) : structuredClone(state) });
  assert.equal(view.get('panel-autofill').hidden, false);
  assert.equal(view.get('panel-autofill').disabled, false);
  // The tab loads its next page: until that page is read, the button waits where it was instead of blinking out.
  let release;
  hold = new Promise(done => { release = done; });
  view.listeners.updated(7, { status: 'loading' }); await tick();
  assert.equal(view.get('panel-autofill').hidden, false);
  assert.equal(view.get('panel-autofill').disabled, true);
  release(); await settle();
  assert.equal(view.get('panel-autofill').hidden, false);
  assert.equal(view.get('panel-autofill').disabled, false);
});

test('widget on a fillable page offers one-click Autofill and cycles through what needs you', async t => {
  const view = await panel(t, { launcher: true });
  assert.equal(view.get('sidepanel').hidden, true);
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState' }, { type: 'ui:widgetSize', line: true }]);
  assert.equal(view.get('widget').hidden, false);
  assert.equal(view.get('pill').hidden, true);
  assert.equal(view.get('need-you').hidden, true);
  assert.equal(view.get('summary-line'), null, 'the key-points line is gone');
  assert.equal(view.get('details').textContent.trim(), '', 'the logo is the details button and has no words');
  assert.equal(view.get('details').getAttribute('aria-label'), EN['widget.detailsTitle']);
  assert.equal(view.get('widget-text').textContent, EN['widget.iowaReady']);
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false, 'what Autofill will do is shown before it is clicked');
  view.get('autofill').click(); await tick();
  assert.equal(view.types().includes('ui:autofill'), false);
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:autofill')), { type: 'ui:autofill', confirmed: true });
  assert.equal(view.types().includes('ui:plan'), false, 'Iowa never asks the on-device AI');
  assert.equal(view.get('widget-text').textContent, 'Filled 3 answers. Stop erases nothing.', 'what it did, and what its Stop button would do');
  assert.equal(view.get('need-you').hidden, false);
  assert.equal(view.get('need-you').textContent, '2 questions left');
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false, 'what Autofill did is shown above the link to what is left');
  assert.ok(view.requests.filter(request => request.type === 'ui:widgetSize').every(request => request.line === true), 'the widget keeps its line');
  for (let i = 0; i < 3; i++) await view.userClick('need-you');
  assert.deepEqual(view.requests.filter(request => request.type === 'ui:focusField').map(request => request.key), ['firstName', 'lastName', 'firstName']);
  assert.ok(view.requests.filter(request => request.type === 'ui:focusField').every(request => request.confirmed === true && !('tabId' in request)));
  await view.userClick('details');
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:openPanel', confirmed: true });
});

test('widget frame fits the logo and its buttons, grows for the yellow link, and asks again only when that changes', async t => {
  const view = await panel(t, { launcher: true });
  // jsdom lays nothing out, so the widget reports the width Chrome would: its line fills the card, and
  // without the line it is as wide as its buttons.
  view.get('widget').getBoundingClientRect = () => ({ width: view.get('widget-text').classList.contains('visually-hidden') ? view.get('need-you').hidden ? 151.2 : 214.6 : 272 });
  const sizes = () => plainRequests(view.requests.filter(request => request.type === 'ui:widgetSize'));
  await view.userClick('autofill');
  // The first request was sent before this test could say how wide the widget is.
  assert.deepEqual(sizes(), [{ type: 'ui:widgetSize', line: true }, { type: 'ui:widgetSize', line: true, width: 272, narrowWidth: 152 }, { type: 'ui:widgetSize', line: true, width: 272, narrowWidth: 215 }]);
  await view.userClick('autofill');
  assert.equal(sizes().length, 3, 'the same width is not asked for again');
});

// A Chrome that has started Autofill before, on an Iowa page where the card has nothing to say before Autofill.
const quietCard = { launcher: true, pageState: state => ({ ...structuredClone(state), page: { ...structuredClone(state.page), pageKey: 'iowa-tell-us-more' } }),
  autofill: { state: 'locked', filled: 0, needYou: [], message: 'Unlock SecondHand to autofill.', pageKey: 'iowa-tell-us-more' } };

test('widget frame is taller for a line and stays as wide as the widget with it', async t => {
  const view = await panel(t, { ...quietCard, storage: new Map([['secondhand.autofillStarted', '1']]) });
  // jsdom lays nothing out: as Chrome would, the widget is as wide as its buttons without the line, its
  // row alone is 46px tall, and the line takes more rows the narrower the widget is.
  const card = view.get('widget');
  card.getBoundingClientRect = () => {
    const hidden = view.get('widget-text').classList.contains('visually-hidden');
    const width = card.style.width ? parseFloat(card.style.width) : hidden ? 180.4 : 231.8;
    return { width, height: hidden ? 46 : width < 200 ? 97.3 : 71.6 };
  };
  const sizes = () => plainRequests(view.requests.filter(request => request.type === 'ui:widgetSize'));
  // Before the click the widget's row alone, the frame it starts with; then a locked app, said in a line beside Unlock.
  await view.userClick('autofill');
  assert.deepEqual(sizes(), [{ type: 'ui:widgetSize', line: true, width: 232, height: 72, narrowWidth: 181, narrowHeight: 98 }],
    'how tall the line makes it at its own width, and at its buttons’ width');
  assert.equal(card.getAttribute('style'), '', 'measuring leaves nothing behind');
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false);
});

test('widget frame is as tall as the widget measured itself, and is asked for again when its lines change', async t => {
  const view = await panel(t, { ...quietCard, storage: new Map([['secondhand.autofillStarted', '1']]) });
  // The row alone, then the row under two lines of 16px with the 4px between them, or three for the longer
  // line while Autofill waits for the app; three lines at the row's width.
  const card = view.get('widget');
  card.getBoundingClientRect = () => {
    const text = view.get('widget-text');
    if (text.classList.contains('visually-hidden')) return { width: 180.4, height: 46 };
    return card.style.width ? { width: parseFloat(card.style.width), height: 95.6 } : { width: 253.1, height: text.textContent.startsWith('Waiting') ? 95.6 : 79.6 };
  };
  const sizes = () => plainRequests(view.requests.filter(request => request.type === 'ui:widgetSize'));
  const withLine = { type: 'ui:widgetSize', line: true, width: 254, height: 80, narrowWidth: 181, narrowHeight: 96 };
  const longer = { ...withLine, height: 96 };
  await view.userClick('autofill');
  assert.deepEqual(sizes(), [longer, withLine], 'the row alone is the frame it starts with; a line makes the frame as tall as the widget with it');
  await view.userClick('unlock');
  assert.equal(sizes().length, 2, 'the same size is not asked for again');
  await view.userClick('autofill');
  assert.deepEqual(sizes().slice(-2), [longer, withLine]);
  await view.userClick('unlock');
  await view.userClick('unlock');
  assert.equal(sizes().length, 4);
});

test('widget is a pill off the applicant page and opens the side panel from it', async t => {
  const view = await panel(t, { launcher: true, kind: 'manual' });
  assert.equal(view.get('widget').hidden, true);
  assert.equal(view.get('pill').hidden, false);
  assert.equal(view.get('pill').title, EN['widget.pillTitle']);
  await view.userClick('pill');
  assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:openPanel', confirmed: true });
});

test('the widget can be hidden to its logo and shown again from it, by the reader only, and the choice holds for the tab', async t => {
  const storage = new Map();
  const session = new Map();
  const view = await panel(t, { launcher: true, storage, session });
  const sizes = () => plainRequests(view.requests.filter(request => request.type === 'ui:widgetSize'));
  assert.equal(view.get('hide').textContent, 'Hide', 'a word, not a sign');
  assert.equal(view.get('hide').title, 'Hide this card. Hiding doesn’t stop Autofill.');
  view.get('hide').click(); await tick();
  assert.equal(view.get('widget').hidden, false, 'a click the page made up hides nothing');
  await view.userClick('hide');
  assert.equal(view.get('widget').hidden, true);
  assert.equal(view.get('pill').hidden, false);
  assert.equal(view.get('pill').title, EN['widget.showTitle']);
  assert.equal(view.get('pill').getAttribute('aria-label'), EN['widget.showTitle']);
  assert.equal(view.get('pill-label').hidden, false);
  assert.equal(view.get('pill-label').textContent, 'Show', 'the logo says the word that shows the card again');
  assert.equal(view.get('pill').classList.contains('labeled'), true);
  assert.equal(view.window.document.activeElement, view.get('pill'), 'the keyboard stays on the control that brings it back');
  assert.deepEqual(sizes().at(-1), { type: 'ui:widgetSize', line: true, pill: true }, 'the frame is asked to be the logo alone');
  // It stays hidden while the page is checked again, and while Autofill runs elsewhere.
  const asked = sizes().length;
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('widget').hidden, true);
  assert.equal(sizes().length, asked);
  await view.userClick('pill');
  assert.equal(view.types().includes('ui:openPanel'), false, 'the logo of a hidden card shows the card; it does not open the side panel');
  assert.equal(view.get('widget').hidden, false);
  assert.equal(view.get('pill').hidden, true);
  assert.equal(view.window.document.activeElement, view.get('hide'));
  assert.deepEqual(sizes().at(-1), { type: 'ui:widgetSize', line: true });
  assert.deepEqual([...storage.keys()], [], 'nothing goes in the extension’s own storage');
  assert.equal(session.get('secondhand.cardHidden'), undefined, 'shown again, the tab forgets the hiding');
  // Hidden, the choice holds for the next page in this tab, and the logo says when the hidden card needs the reader.
  await view.userClick('hide');
  assert.equal(session.get('secondhand.cardHidden'), '1');
  const next = await panel(t, { launcher: true, storage, session, result: doneResult });
  assert.equal(next.get('widget').hidden, true, 'the next page keeps the card hidden');
  assert.equal(next.get('pill').hidden, false);
  assert.equal(next.get('pill').classList.contains('waiting'), true, 'two questions are left for the reader');
  assert.equal(next.get('pill').title, 'Show SecondHand’s card: it needs you');
  assert.equal(next.get('pill').getAttribute('aria-label'), 'Show SecondHand’s card: it needs you');
  // A screen reader still hears what the hidden card says, from the status region outside the card.
  const status = next.get('widget-status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(next.get('widget').contains(status), false);
  assert.equal(status.textContent, next.get('widget-text').textContent);
  assert.match(status.textContent, /^Filled /);
  assert.equal(next.get('widget-text').getAttribute('role'), null, 'one region speaks, not two');
  const quiet = await panel(t, { launcher: true, storage, session });
  assert.equal(quiet.get('pill').classList.contains('waiting'), false);
  assert.equal(quiet.get('pill').title, 'Show SecondHand’s card');
  await quiet.userClick('pill');
  assert.equal(session.has('secondhand.cardHidden'), false);
  // The link to what is left says what it does.
  assert.equal(next.get('need-you').title, 'Go to the next question left, in the form.');
  assert.equal(next.get('details').getAttribute('aria-label'), 'Open SecondHand’s side panel');
  assert.equal(next.get('hide').textContent, 'Hide');
  // Another site's widget hides the same way.
  const site = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true } });
  await site.userClick('hide');
  assert.equal(site.get('pill').title, EN['widget.showTitle']);
  assert.deepEqual(plainRequests(site.requests.at(-1)), { type: 'ui:widgetSize', line: false, pill: true });
});

test('widget shows Unlock when the vault is locked and returns to Autofill after bringing the app forward', async t => {
  const view = await panel(t, { launcher: true, autofill: { state: 'locked', filled: 0, needYou: [], message: 'Unlock SecondHand to autofill.', pageKey: 'iowa-personal-information' } });
  await view.userClick('autofill');
  assert.equal(view.get('unlock').hidden, false);
  assert.equal(view.get('autofill').hidden, true);
  assert.equal(view.get('widget-text').textContent, 'The SecondHand app on this computer is locked.', 'as the side panel says it');
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false);
  assert.equal(view.get('unlock').textContent, 'Unlock', 'the side panel’s button');
  await view.userClick('unlock');
  assert.deepEqual(plainRequests(view.requests.findLast(request => request.type !== 'ui:widgetSize')), { type: 'ui:showApp', confirmed: true });
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
  assert.equal(offline.get('widget-text').textContent, 'The SecondHand app on this computer is closed.', 'as the side panel says it');
  assert.equal(offline.get('widget-text').classList.contains('visually-hidden'), false);
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
  assert.equal(restored.get('widget-text').textContent, 'Filled 3 answers.');
  assert.equal(restored.get('need-you').textContent, '2 questions left');
});

const waitingResult = { state: 'waiting', filled: 0, needYou: [], message: 'Type the characters shown in Iowa’s security check, then click Continue.', pageKey: 'iowa-personal-information' };

test('while autofill is on, the widget shows Stop and the current instruction', async t => {
  const checked = { ...doneResult, needYou: [], message: 'Filled 3 answers. Check your answers, then click Continue.', messageKey: 'result.thenTodo',
    messageParams: { summary: { key: 'result.filled', params: { count: 3 } }, todo: { key: 'worker.checkThenContinue', params: {} } }, todo: 'Check your answers, then click Continue.', todoKey: 'worker.checkThenContinue', todoParams: {} };
  const view = await panel(t, { launcher: true, autofill: checked, autopilotAfterAutofill: true });
  await view.userClick('autofill');
  assert.equal(view.get('stop').hidden, false);
  assert.equal(view.get('autofill').hidden, true);
  assert.equal(view.get('widget-text').textContent, 'Filled 3 answers. Check your answers, then click Continue. Stop erases nothing.');
  view.state.result = waitingResult;
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('widget-text').textContent, 'Type the characters shown in Iowa’s security check, then click Continue. Stop erases nothing.', 'polls follow the worker while autofill is on');
  view.get('stop').click(); await tick();
  assert.equal(view.types().includes('ui:stop'), false);
  await view.userClick('stop');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:stop')), { type: 'ui:stop', confirmed: true });
  assert.equal(view.get('stop').hidden, true);
  assert.equal(view.get('autofill').hidden, false);
  assert.equal(view.get('widget-text').textContent, 'Autofill stopped. Nothing was erased.', 'and no longer what Stop would do');
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false, 'what Stop did is shown');
  assert.equal(view.get('stop').title, EN['widget.stopTitle']);
});

test('a widget that loads mid-run picks up the running autofill', async t => {
  const view = await panel(t, { launcher: true, kind: 'blocked', autopilot: true, result: waitingResult });
  assert.equal(view.get('widget').hidden, false, 'instructions stay readable on steps that need you');
  assert.equal(view.get('stop').hidden, false);
  assert.equal(view.get('widget-text').textContent, 'Type the characters shown in Iowa’s security check, then click Continue. Stop erases nothing.');
});

// Autofill on Iowa's applicant page, waiting for one answer: once nothing is left, it clicks Save and Continue.
const missingResult = { state: 'done', filled: 3, needYou: ['firstName'], pageKey: 'iowa-personal-information',
  message: 'Filled 3 answers · 1 left for you. Check what was filled before you answer what is left: once nothing is left, SecondHand clicks Save and Continue.',
  messageKey: 'result.thenTodo', messageParams: { summary: { key: 'result.filledNeedYou', params: { count: 3, needYou: 1 } }, todo: { key: 'iowa.missingAnswers', params: {} } },
  todo: 'Check what was filled before you answer what is left: once nothing is left, SecondHand clicks Save and Continue.', todoKey: 'iowa.missingAnswers', todoParams: {} };

test('while Autofill waits for answers it would save and continue after, both surfaces say Stop lets the reader check first', async t => {
  const missing = missingResult;
  const side = await panel(t, { autopilot: true, result: missing });
  assert.ok(side.get('status').textContent.endsWith(missing.todo));
  assert.equal(side.get('stop-note').textContent, 'To check and continue yourself, click Stop Autofill. It erases nothing.');
  const card = await panel(t, { launcher: true, autopilot: true, result: missing });
  assert.equal(card.get('widget-text').textContent, 'Filled 3 answers. Check what was filled before you answer what is left: once nothing is left, SecondHand clicks Save and Continue. To check and continue yourself, click Stop. It erases nothing.');
  // Anywhere else, Stop only ends Autofill.
  const waiting = await panel(t, { autopilot: true, result: waitingResult });
  assert.equal(waiting.get('stop-note').textContent, 'Stop ends Autofill and erases nothing.');
});

test('while Autofill waits for the app, both surfaces say where its window is on this computer', async t => {
  for (const [os, where] of [['mac', 'Can’t see that window? Click SecondHand in the Dock.'], ['win', 'Can’t see that window? Click SecondHand in the taskbar.'],
    ['linux', 'Can’t see that window? It may be behind Chrome.']]) {
    const waiting = `Waiting for the SecondHand app. If its window asks for your OK, nothing is filled until you allow it. ${where}`;
    let release;
    const autofillHeld = new Promise(done => { release = done; });
    const card = await panel(t, { launcher: true, os, autofillHeld });
    const cardClick = card.userClick('autofill');
    await settle();
    assert.equal(card.get('widget-text').textContent, waiting, os);
    assert.equal(card.get('autofill').disabled, true);
    const side = await panel(t, { os, autofillHeld });
    const sideClick = side.userClick('panel-autofill');
    await settle();
    assert.equal(side.get('status').textContent, waiting, os);
    release();
    await Promise.all([cardClick, sideClick]);
    await settle();
    assert.match(card.get('widget-text').textContent, /^Filled 3 answers/);
  }
});

test('once Autofill has been started again from this Chrome, both surfaces say the short form of what it waits for, without Stop’s note', async t => {
  const storage = new Map([['secondhand.autofillStarted', '2']]);
  const card = await panel(t, { launcher: true, storage, autopilot: true, result: missingResult });
  assert.equal(card.get('widget-text').textContent, 'Filled 3 answers. SecondHand moves on once nothing is left.');
  assert.equal(card.get('widget-text').title, missingResult.message, 'all of it stays in the tooltip');
  const side = await panel(t, { storage, autopilot: true, result: missingResult });
  assert.match(side.get('status').textContent, /^Filled 3 answers · \d left for you\. SecondHand moves on once nothing is left\.$/);
  assert.equal(side.get('stop-note').hidden, true);
  // Anywhere else the line is as it was, without Stop's note.
  const message = await panel(t, { launcher: true, storage, kind: 'blocked', autopilot: true, result: waitingResult });
  assert.equal(message.get('widget-text').textContent, 'Type the characters shown in Iowa’s security check, then click Continue.');
  // Through the first run, all of it.
  const first = await panel(t, { launcher: true, storage: new Map([['secondhand.autofillStarted', '1']]), autopilot: true, result: missingResult });
  assert.match(first.get('widget-text').textContent, /once nothing is left, SecondHand clicks Save and Continue\. To check and continue yourself, click Stop\. It erases nothing\.$/);
});

test('side panel turns its button into Stop while autofill is on', async t => {
  const view = await panel(t, { autopilot: true, result: waitingResult });
  assert.equal(view.get('panel-autofill').textContent, 'Stop Autofill');
  assert.equal(view.get('stop-note').hidden, false);
  assert.equal(view.get('stop-note').textContent, 'Stop ends Autofill and erases nothing.');
  await view.userClick('panel-autofill');
  assert.deepEqual(plainRequests(view.requests.find(request => request.type === 'ui:stop')), { type: 'ui:stop', confirmed: true, tabId: 7 });
  assert.equal(view.get('panel-autofill').textContent, 'Start Autofill');
  assert.equal(view.get('stop-note').hidden, true);
});

test('a worker that never answers gets a plain notice and a Restart button in the widget and the side panel', async t => {
  const widget = await panel(t, { launcher: true, silent: true });
  assert.equal(widget.get('widget').hidden, false, 'the notice stays readable instead of a pill');
  assert.equal(widget.get('pill').hidden, true);
  assert.equal(widget.get('widget-text').textContent, OUTDATED);
  assert.equal(widget.get('widget-text').classList.contains('visually-hidden'), false);
  assert.equal(widget.get('widget').classList.contains('outdated'), true);
  assert.equal(widget.get('restart').hidden, false);
  assert.equal(widget.get('restart').textContent, 'Restart');
  assert.equal(widget.get('restart').title, EN['widget.restartTitle']);
  for (const id of ['autofill', 'stop', 'unlock', 'open-app', 'need-you', 'translate-offer', 'hide']) assert.equal(widget.get(id).hidden, true, `${id} is not offered`);
  const side = await panel(t, { silent: true });
  assert.equal(side.get('desktop-status').textContent, OUTDATED_PANEL);
  assert.equal(side.get('desktop-status').parentElement.hidden, false);
  assert.equal(side.get('desktop-status').parentElement.classList.contains('error'), false, 'an update is not an error');
  assert.equal(side.get('desktop-action').hidden, false);
  assert.equal(side.get('desktop-action').textContent, 'Restart SecondHand');
  assert.equal(side.get('status').textContent, '');
  assert.equal(side.get('panel-autofill').disabled, true);
  assert.equal(side.get('panel-autofill').hidden, true, 'only the restart is offered');
  assert.doesNotMatch(`${OUTDATED} ${OUTDATED_SHORT} ${OUTDATED_PANEL} ${EN['widget.restartTitle']}`, /chrome:\/\/|reload arrow/, 'no address to type and no arrow to find');
  assert.equal(widget.get('widget').classList.contains('restartable'), true);
  // The outdated worker is asked once, in the oldest form of the request, for a frame with room for a line.
  assert.deepEqual(plainRequests(widget.requests).filter(request => request.type === 'ui:widgetSize'), [{ type: 'ui:widgetSize', line: true }]);
  // A frame too small for the whole notice gets the short form beside the button.
  const small = await panel(t, { launcher: true, silent: true });
  Object.defineProperties(small.get('widget-text'), { scrollHeight: { get() { return this.textContent === OUTDATED ? 56 : 28; } }, clientHeight: { get: () => 42 } });
  small.window.dispatchEvent(new small.window.Event('resize'));
  assert.equal(small.get('widget-text').textContent, OUTDATED_SHORT);

  // A worker that answers page state but not a newer message is outdated too.
  const partial = await panel(t, { launcher: true, silent: ['ui:autofill'], build: BUILD });
  assert.equal(partial.get('widget-text').textContent, EN['widget.iowaReady']);
  await partial.userClick('autofill');
  assert.equal(partial.get('widget-text').textContent, OUTDATED);
  const before = partial.requests.length;
  partial.window.document.dispatchEvent(new partial.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(partial.requests.length, before, 'an outdated worker is not polled again');
});

test('an outdated card the page can size directly is drawn whole, can be hidden, and asks the page, not the worker', async t => {
  const widget = await panel(t, { launcher: true, silent: true });
  assert.equal(widget.get('hide').hidden, true, 'without the page’s word, hiding would leave an empty frame over the page');
  assert.equal(widget.get('widget').classList.contains('outdated'), true, 'and the notice keeps to the frame it has');
  const posted = [];
  widget.window.postMessage = (data, origin) => posted.push([data, origin]);
  // The greeting counts only from the page around the card.
  widget.window.dispatchEvent(new widget.window.MessageEvent('message', { data: { type: 'secondhand:cardHello' }, source: null }));
  assert.equal(widget.get('hide').hidden, true);
  widget.window.dispatchEvent(new widget.window.MessageEvent('message', { data: { type: 'secondhand:cardHello' }, source: widget.window.parent }));
  assert.equal(widget.get('hide').hidden, false);
  // The page sizes the frame, so the notice is drawn as any card is: the whole of it, Restart, and the way to hide it.
  assert.equal(widget.get('widget').classList.contains('outdated'), false);
  assert.equal(widget.get('widget-text').textContent, OUTDATED);
  assert.equal(widget.get('restart').hidden, false);
  assert.deepEqual(plain(posted.map(([data]) => data)), [{ type: 'secondhand:cardSize', line: true }], 'asked of the page, as the worker would be');
  assert.equal(posted[0][1], '*', 'jsdom knows no page around the card');
  const sizes = widget.requests.filter(request => request.type === 'ui:widgetSize').length;
  await widget.userClick('hide');
  assert.equal(widget.get('widget').hidden, true);
  assert.equal(widget.get('pill').hidden, false);
  assert.equal(widget.get('pill').title, EN['widget.showWaitingTitle'], 'the hidden notice still needs the reader');
  assert.deepEqual(plain(posted.map(([data]) => data)).at(-1), { type: 'secondhand:cardSize', line: true, pill: true });
  assert.equal(widget.requests.filter(request => request.type === 'ui:widgetSize').length, sizes, 'the outdated worker is not asked');
  await widget.userClick('pill');
  assert.equal(widget.get('widget').hidden, false);
  assert.equal(widget.get('widget-text').textContent, OUTDATED);
  assert.deepEqual(plain(posted.map(([data]) => data)).at(-1), { type: 'secondhand:cardSize', line: true });
  // A card left behind when SecondHand restarted can be hidden the same way.
  const left = await panel(t, { launcher: true });
  const leftPosted = [];
  left.window.postMessage = data => leftPosted.push(data);
  left.window.dispatchEvent(new left.window.MessageEvent('message', { data: { type: 'secondhand:cardHello' }, source: left.window.parent }));
  delete left.window.chrome.runtime.id;
  left.window.chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
  await left.userClick('autofill');
  assert.equal(left.get('widget-text').textContent, EN['panel.reloadPage']);
  assert.equal(left.get('widget').classList.contains('outdated'), false);
  await left.userClick('hide');
  assert.deepEqual(plain(leftPosted).at(-1), { type: 'secondhand:cardSize', line: true, pill: true });
});

test('a worker from another build gets the same notice even though it answers, and Restart reloads SecondHand', async t => {
  const widget = await panel(t, { launcher: true, build: 'older-build' });
  let reloads = 0;
  widget.window.chrome.runtime.reload = () => { reloads++; };
  assert.deepEqual(plainRequests(widget.requests), [{ type: 'ui:ping' }, { type: 'ui:widgetSize', line: true }]);
  assert.equal(widget.get('widget-text').textContent, OUTDATED);
  assert.equal(widget.get('widget-text').title, OUTDATED);
  await widget.userClick('autofill');
  assert.equal(widget.types().includes('ui:autofill'), false);
  widget.get('restart').click(); await tick();
  assert.equal(reloads, 0, 'a click the page made up restarts nothing');
  await widget.userClick('restart');
  assert.equal(reloads, 1);
  // The frame is now left behind by the reload: it says how to get SecondHand back on this page.
  assert.equal(widget.get('widget-text').textContent, EN['panel.reloadPage']);
  assert.equal(widget.get('restart').hidden, true);
  assert.equal(widget.get('widget').classList.contains('restartable'), false);
  assert.deepEqual(plainRequests(widget.requests), [{ type: 'ui:ping' }, { type: 'ui:widgetSize', line: true }], 'the outdated worker is asked nothing more');

  const side = await panel(t, { build: 'older-build' });
  let restarts = 0;
  side.window.chrome.runtime.reload = () => { restarts++; };
  assert.deepEqual(plainRequests(side.requests), [{ type: 'ui:ping' }]);
  assert.equal(side.get('desktop-status').textContent, OUTDATED_PANEL);
  assert.equal(side.get('status').textContent, '');
  assert.equal(side.get('status').classList.contains('error'), false);
  assert.equal(side.get('panel-autofill').disabled, true);
  side.listeners.activated({ tabId: 7 }); await tick(); await tick();
  assert.equal(side.get('desktop-status').textContent, OUTDATED_PANEL, 'switching tabs keeps the notice');
  assert.equal(side.get('desktop-action').textContent, 'Restart SecondHand');
  assert.equal(side.types().includes('ui:pageState'), false);
  side.get('desktop-action').click(); await tick();
  assert.equal(restarts, 0);
  await side.userClick('desktop-action');
  assert.equal(restarts, 1);
  assert.deepEqual(plainRequests(side.requests), [{ type: 'ui:ping' }], 'restarting asks the outdated worker nothing');
});

test('a worker that stops answering while the side panel is open leaves only the notice and Restart', async t => {
  const view = await panel(t, { silent: ['ui:autofill'], build: BUILD });
  assert.ok(view.get('page-checklist').children.length > 0);
  await view.userClick('panel-autofill'); await settle();
  assert.equal(view.get('desktop-status').textContent, OUTDATED_PANEL);
  assert.equal(view.get('desktop-action').textContent, 'Restart SecondHand');
  assert.equal(view.get('status').textContent, '', 'the notice is said once, not again as an error');
  assert.equal(view.get('panel-autofill').hidden, true);
  assert.equal(view.get('page-checklist').children.length, 0);
  const asked = view.requests.length;
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await settle();
  assert.equal(view.requests.length, asked, 'an outdated worker is not asked again');
  // The notice follows the language picker like everything else.
  view.get('language').value = 'es';
  view.get('language').dispatchEvent(new view.window.Event('change'));
  await settle();
  assert.equal(view.get('desktop-status').textContent, strings.text('es', 'panel.outdated'));
  assert.equal(view.get('desktop-action').textContent, strings.text('es', 'panel.restart'));
});

test('the pill is a fixed circle that cannot stretch into an oval', () => {
  assert.match(source('panel.css'), /\.pill\{width:46px;height:46px;flex:none/);
});

// Sites other than Iowa, turned on one at a time.
const SITE = { id: 7, url: 'https://pantry.example.org/intake?step=1' };
const ORIGIN = 'https://pantry.example.org';
const siteDone = { state: 'done', filled: 2, guessed: 0, needYou: ['f0:sh-4', 'f4:sh-3'], message: 'Filled 2 answers · 2 left for you. Check them before you submit.', messageKey: 'result.siteFilledNeedYou', messageParams: { count: 2, needYou: 2 }, pageKey: 'general' };
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
const AI_UNAVAILABLE = 'Chrome’s AI isn’t available, so nothing was guessed.';

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
  const guessed = { state: 'done', filled: 3, guessed: 1, needYou: ['sh-2-0'], message: 'Filled 3 answers · 1 guessed · 1 left for you. Check them before you submit.', messageKey: 'result.siteFilledGuessedNeedYou', messageParams: { count: 3, guessed: 1, needYou: 1 }, pageKey: 'general' };
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
  // The side panel's sentence, without the count the link beside it carries.
  assert.equal(view.get('widget-text').textContent, 'Filled 3 answers · 1 guessed. Check them before you submit.');
  assert.equal(view.get('need-you').textContent, '1 question left');
});

test('without the on-device AI the widget fills with rule matches only and says so', async t => {
  const setups = [{}, { availability: 'downloadable' }, { availability: 'downloading' }, { failure: new Error('Synthetic model failure') }, { answer: 'not json' }];
  for (const setup of setups) {
    const options = { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: openPlan, autofill: siteDone };
    const view = await panel(t, Object.keys(setup).length ? { ...options, LanguageModel: languageModel(setup).LanguageModel } : options);
    await view.userClick('autofill');
    assert.deepEqual(plainRequests(view.requests.at(-1)), { type: 'ui:autofill', confirmed: true }, JSON.stringify(setup));
    // Why Chrome's AI guessed nothing is in the tooltip; the line stays what was filled and what to do.
    assert.equal(view.get('widget-text').textContent, 'Filled 2 answers. Check them before you submit.', JSON.stringify(setup));
    assert.match(view.get('widget-text').title, new RegExp(`^Filled 2 answers · 2 left for you\\. Check them before you submit\\. ${AI_UNAVAILABLE.replace(/[.’]/g, '\\$&')}`), JSON.stringify(setup));
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
  assert.equal(answered.get('widget-text').textContent, 'Filled 2 answers. Check them before you submit.');
  assert.deepEqual(plainRequests(answered.requests.at(-1)), { type: 'ui:autofill', confirmed: true });
});

test('a worker too old to plan for the AI gets the update notice, not a fill', async t => {
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, silent: ['ui:plan'], LanguageModel: languageModel().LanguageModel });
  await view.userClick('autofill');
  assert.equal(view.get('widget-text').textContent, OUTDATED);
  assert.equal(view.types().includes('ui:autofill'), false);
});

test('widget and side panel say when nothing on a site matches the saved profile instead of Filled 0', async t => {
  const nothing = { state: 'done', filled: 0, guessed: [], needYou: ['sh-1-0', 'f4:sh-1-1'], message: 'No question here matches your answers in My information. 2 left for you.', messageKey: 'result.nothingMatchesNeedYou', messageParams: { count: 2 }, pageKey: 'general' };
  const widget = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: nothing });
  await widget.userClick('autofill');
  assert.equal(widget.get('widget-text').textContent, 'No question here matches your answers in My information.');
  assert.equal(widget.get('widget-text').title, nothing.message);
  assert.equal(widget.get('need-you').textContent, '2 questions left');
  const side = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: nothing });
  await side.userClick('panel-autofill');
  assert.equal(side.get('status').textContent, nothing.message);

  const next = { ...nothing, needYou: [], message: 'Nothing to fill here. Click Next, then Autofill again.', messageKey: 'result.nothingToFillNext', messageParams: {} };
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
  assert.equal(view.get('widget-text').textContent, 'Filled 2 answers. Check them before you submit.');
  assert.equal(view.get('need-you').textContent, '2 questions left');
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


test('Iowa widget and sidebar say what Autofill will do before it is clicked, in full the first time; other sites do not', async t => {
  const storage = new Map();
  const widget = await panel(t, { launcher: true, storage });
  const FIRST = 'The SecondHand app asks you first. Then SecondHand fills each page and moves on. If Iowa suggests addresses, SecondHand picks the first: make sure it is yours. It never signs or sends your application.';
  assert.equal(widget.get('widget-text').textContent, FIRST);
  assert.equal(widget.get('widget-text').classList.contains('visually-hidden'), false, 'the widget shows it, not only its tooltip');
  assert.equal(widget.get('autofill').title, EN['widget.autofillIowaTitle']);
  assert.match(widget.get('autofill').title, /continues where SecondHand can/);
  assert.match(widget.get('autofill').title, /Check every answer, your Social Security number, and the home address/);
  const sidebar = await panel(t, { storage });
  assert.equal(sidebar.get('iowa-policy').hidden, false);
  // The side panel's line says what Autofill does on Iowa (#167), on every page until Autofill has run there.
  assert.equal(sidebar.get('iowa-policy').textContent, EN['panel.iowaPolicy']);
  const policy = sidebar.get('iowa-policy').textContent;
  assert.match(policy, /Social Security number; check it in Iowa’s form/);
  assert.match(policy, /first suggested home address/);
  assert.match(policy, /Review all answers and that address before submitting/);
  assert.match(policy, /one person’s record at a time/);
  assert.match(policy, /saves supported pages when complete/);
  assert.match(policy, /You handle summaries, unmatched questions, consent, signatures, submission/);
  assert.equal(sidebar.get('iowa-policy').classList.contains('note'), false, 'it is not small print');
  assert.equal(sidebar.get('panel-autofill').textContent, 'Start Autofill', 'on Iowa the button starts something that goes on by itself');
  // Once Autofill has run, the status line says what it did and the note is not repeated under it.
  await sidebar.userClick('panel-autofill');
  assert.equal(sidebar.get('iowa-policy').hidden, true);
  assert.match(sidebar.get('status').textContent, /^Filled 3/);
  // Started once from this Chrome, the card says only what matters where it matters: on the applicant page, that
  // Iowa's address page comes next.
  assert.equal(storage.get('secondhand.autofillStarted'), '1');
  widget.window.dispatchEvent(Object.assign(new widget.window.Event('storage'), { key: 'secondhand.autofillStarted' }));
  await settle();
  assert.equal(widget.get('widget-text').textContent, 'On the next page, if Iowa suggests addresses, SecondHand picks the first: make sure it is yours.');
  assert.equal(widget.get('widget-status').textContent, widget.get('widget-text').textContent);
  // Elsewhere on Iowa's form the card is only its buttons, and says nothing.
  const elsewhere = await panel(t, { launcher: true, storage, pageState: state => ({ ...structuredClone(state), page: { ...structuredClone(state.page), pageKey: 'iowa-tell-us-more' } }) });
  assert.equal(elsewhere.get('widget-text').classList.contains('visually-hidden'), true);
  assert.equal(elsewhere.get('widget-status').textContent, '');
  assert.equal(elsewhere.get('autofill').hidden, false);
  const later = await panel(t, { storage });
  assert.equal(later.get('iowa-policy').textContent, EN['panel.iowaPolicy'], 'the side panel says all of it every time');
  const laterWidget = await panel(t, { launcher: true, storage });
  await laterWidget.userClick('autofill');
  assert.deepEqual([...storage.keys()].sort(), ['secondhand.autofillStarted', 'secondhand.build'], 'the widget notes a start too; the side panel had noted its build');
  assert.equal(storage.get('secondhand.autofillStarted'), '2', 'counted up to two: started again');
  const third = await panel(t, { launcher: true, storage });
  await third.userClick('autofill');
  assert.equal(storage.get('secondhand.autofillStarted'), '2');
  // Another site's Autofill fills once and notes nothing.
  const siteStorage = new Map();
  const siteWidget = await panel(t, { launcher: true, storage: siteStorage, tab: SITE, site: { origin: ORIGIN, enabled: true } });
  await siteWidget.userClick('autofill');
  assert.equal(siteStorage.size, 0);
  const running = await panel(t, { autopilot: true, result: waitingResult });
  assert.equal(running.get('iowa-policy').hidden, true);
  // An information-only page says there is nothing to fill before Autofill is clicked, above the note.
  const info = await panel(t, { pageState: state => ({ ...structuredClone(state), page: { kind: 'info', pageKey: 'iowa-instructions', reason: 'Nothing to fill on this page. Click Continue in Iowa’s form, or let Autofill go on for you.', reasonKey: 'iowa.infoOnly', reasonParams: {}, checklist: [] } }) });
  assert.equal(info.get('status').textContent, 'Nothing to fill on this page. Click Continue in Iowa’s form, or let Autofill go on for you.');
  assert.equal(info.get('iowa-policy').hidden, false);
  assert.equal(info.get('panel-autofill').disabled, false);
  const other = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: true } });
  assert.equal(other.get('iowa-policy').hidden, true);
  const otherWidget = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true } });
  assert.doesNotMatch(otherWidget.get('widget-text').textContent, /address|next/);
  assert.equal(otherWidget.get('widget-text').classList.contains('visually-hidden'), true, 'another site’s widget is its row alone until Autofill has something to say');
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
// labels. The words kept under each question in the question list are the form's, there to match it with.
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
  assert.equal(view.get('panel-autofill').textContent, spanish('panel.autofillIowa'));
  // Ready to fill, with the app unlocked: there is nothing more to say.
  assert.equal(view.get('status').textContent, '');
  assert.equal(view.get('desktop-status').parentElement.hidden, true);
  assert.equal(view.get('iowa-policy').textContent, spanish('panel.iowaPolicy'));
  assert.match(view.row('firstName').textContent, new RegExp(`${spanish('iowa.firstName')}.*${spanish('checklist.pending')}`));
  assert.equal(view.get('checklist-summary').textContent, '');
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
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState' }, { type: 'ui:widgetSize', line: true }], 'without Chrome’s translator the widget asks nothing about the page’s language');
});

test('results the worker names by key show in Spanish in the widget and the side panel; a bare message shows as sent', async t => {
  const iowa = { state: 'done', filled: 3, needYou: ['firstName', 'lastName'], pageKey: 'iowa-personal-information',
    message: 'Filled 3 answers · 2 left for you. Check what was filled before you answer what is left: once nothing is left, SecondHand clicks Save and Continue.',
    messageKey: 'result.thenTodo', messageParams: { summary: { key: 'result.filledNeedYou', params: { count: 3, needYou: 2 } }, todo: { key: 'iowa.missingAnswers', params: {} } },
    todo: 'Check what was filled before you answer what is left: once nothing is left, SecondHand clicks Save and Continue.', todoKey: 'iowa.missingAnswers', todoParams: {} };
  const widget = await panel(t, { launcher: true, language: 'es-ES', autofill: iowa });
  await widget.userClick('autofill');
  assert.equal(widget.get('widget-text').textContent, `${strings.text('es', 'result.thenTodo', { summary: { key: 'result.filled', params: { count: 3 } }, todo: { key: 'iowa.missingAnswers', params: {} } })} ${spanish('widget.stopToCheck')}`, 'SecondHand clicks Save and Continue once nothing is left: Stop lets the reader check first');
  assert.equal(widget.get('need-you').textContent, 'Faltan 2');
  assert.equal(widget.get('widget-text').title, strings.text('es', iowa.messageKey, iowa.messageParams));
  const side = await panel(t, { language: 'es-ES', autofill: iowa });
  await side.userClick('panel-autofill');
  assert.equal(side.get('status').textContent, strings.text('es', iowa.messageKey, iowa.messageParams));

  const site = await panel(t, { launcher: true, language: 'es-ES', tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: openPlan,
    autofill: { ...siteDone, messageKey: 'result.siteFilledNeedYou', messageParams: { count: 2, needYou: 2 } } });
  assert.equal(site.get('widget-text').textContent, strings.text('es', 'widget.siteReady', { host: 'pantry.example.org' }));
  await site.userClick('autofill');
  assert.equal(site.get('widget-text').textContent, strings.text('es', 'result.siteFilled', { count: 2 }));
  assert.match(site.get('widget-text').title, new RegExp(spanish('widget.aiUnavailable').replace(/[.’()]/g, '\\$&')));
  // A result without a key (an older worker) is shown exactly as it arrived.
  const bare = await panel(t, { language: 'es-ES', autofill: { ...siteDone, message: 'Synthetic bare message.', messageKey: undefined, messageParams: undefined }, tab: SITE, site: { origin: ORIGIN, enabled: true } });
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
  assert.equal(view.get('panel-autofill').textContent, 'Start Autofill');
  view.get('language').value = 'es';
  view.get('language').dispatchEvent(new view.window.Event('change'));
  await settle();
  assert.equal(storage.get('secondhand.language'), 'es');
  assert.equal(view.get('panel-autofill').textContent, spanish('panel.autofillIowa'));
  assert.equal(view.get('checklist-summary').textContent, '');
  assert.equal(view.get('iowa-policy').textContent, spanish('panel.iowaPolicy'));
  assert.deepEqual(shownText(view).filter(text => englishOnly.has(text)), []);

  const reloaded = await panel(t, { storage });
  assert.equal(reloaded.get('language').value, 'es', 'the saved choice wins over the English browser');
  assert.equal(reloaded.get('panel-autofill').textContent, spanish('panel.autofillIowa'));
  const widget = await panel(t, { launcher: true, storage });
  assert.equal(widget.get('autofill').textContent, spanish('widget.autofill'));
  // A choice made while the widget is open reaches it through the storage event.
  storage.set('secondhand.language', 'en');
  widget.window.dispatchEvent(Object.assign(new widget.window.Event('storage'), { key: 'secondhand.language' }));
  await settle();
  assert.equal(widget.get('autofill').textContent, 'Autofill');
  assert.equal(widget.get('widget-text').textContent, EN['widget.iowaReady']);
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
    // SecondHand's own label is in Spanish from its catalog, with the English it stands for under it.
    ['BUTTON', spanish('iowa.firstName'), 'First name'],
    ['BUTTON', '[es] Preferred pickup day', 'Preferred pickup day']]);
  assert.equal(rows[1].querySelector('.checklist-detail').hidden, false);
  assert.equal(rows[1].querySelector('.checklist-detail').getAttribute('lang'), 'en', 'the English under SecondHand’s own label is marked as English');
  assert.equal(rows[2].querySelector('.checklist-detail').getAttribute('lang'), null, 'a page’s own words are in the page’s language');
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
  assert.deepEqual(plainRequests(view.requests), [{ type: 'ui:ping' }, { type: 'ui:pageState' }, { type: 'ui:widgetSize', line: true }, { type: 'ui:questions' }]);
  assert.equal(view.get('translate-offer').hidden, false);
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false, 'the offer sits under what Autofill will do');
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
  // On Iowa the line keeps saying what Autofill will do; the failure is in its tooltip. Another site's line says it.
  assert.equal(failing.get('widget-text').textContent, spanish('widget.iowaReady'));
  assert.match(failing.get('widget-text').title, /Synthetic detector failure/);
  const elsewhere = await panel(t, { launcher: true, language: 'es-ES', tab: SITE, site: { origin: ORIGIN, enabled: true }, Translator: translatorStub().Translator, LanguageDetector: detectorStub({ failure: new Error('Synthetic detector failure') }).LanguageDetector, questions: pageQuestions });
  await settle();
  assert.equal(elsewhere.get('widget-text').textContent, spanish('widget.languageCheckFailed'));
  // The offer stays once Autofill has something to report: the reader still needs the questions in their language.
  await view.userClick('autofill');
  assert.equal(view.get('translate-offer').hidden, false);
  assert.equal(view.get('widget-text').classList.contains('visually-hidden'), false);
  assert.equal(view.get('need-you').hidden, false);
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
  message: 'Filled 2 answers · 1 guessed · 1 left for you. Check them before you submit. Guesses were suggested by Laya on this computer.',
  messageKey: 'result.suggestedByLaya', messageParams: { summary: { key: 'result.siteFilledGuessedNeedYou', params: { count: 2, guessed: 1, needYou: 1 } } } };

test('with Laya ready, the widget leaves Chrome’s on-device AI off, fills the plan Laya answers for, and says who suggested the guesses', async t => {
  const ai = languageModel();
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true }, LanguageModel: ai.LanguageModel, autofill: layaDone });
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.slice(-2)), [{ type: 'ui:plan', confirmed: true }, { type: 'ui:autofill', confirmed: true, guesses: {} }]);
  assert.equal(ai.calls.availability, 0, 'Chrome’s on-device AI is never asked');
  assert.equal(view.get('widget-text').textContent, 'Filled 2 answers · 1 guessed. Check them before you submit. Guesses were suggested by Laya on this computer.');
  assert.equal(view.get('widget-text').title, layaDone.message);
  assert.equal(view.get('need-you').textContent, '1 question left');

  const spanishView = await panel(t, { launcher: true, language: 'es-ES', tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true }, autofill: layaDone });
  await spanishView.userClick('autofill');
  assert.equal(spanishView.get('widget-text').textContent, strings.text('es', 'result.suggestedByLaya', { summary: { key: 'result.siteFilledGuessed', params: { count: 2, guessed: 1 } } }));
  assert.deepEqual(shownText(spanishView).filter(text => englishOnly.has(text)), []);
});

test('with Laya not ready, the widget asks Chrome’s on-device AI exactly as before', async t => {
  const ai = languageModel();
  const view = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: false }, LanguageModel: ai.LanguageModel, autofill: siteDone });
  await view.userClick('autofill');
  assert.deepEqual(plainRequests(view.requests.slice(-2)), [{ type: 'ui:plan', confirmed: true }, { type: 'ui:autofill', confirmed: true, guesses: { 'f4:sh-1-2': 'email' } }]);
  assert.equal(ai.calls.prompt.length, 1);
  assert.equal(view.get('widget-text').textContent, 'Filled 2 answers. Check them before you submit.');
});

test('on a site that is on, the side panel says why Laya isn’t guessing, in the applicant’s language; never when it is ready, on Iowa, or with the app closed', async t => {
  const site = { tab: SITE, site: { origin: ORIGIN, enabled: true } };
  const lines = { off: 'desktop.layaOff', downloading: 'desktop.layaDownloading', 'not-downloaded': 'desktop.layaNotReady', error: 'desktop.layaNotReady', unavailable: 'desktop.layaNotReady' };
  for (const [laya, key] of Object.entries(lines)) {
    const view = await panel(t, { ...site, desktop: { laya } });
    assert.equal(view.get('laya-status').hidden, false, laya);
    assert.equal(view.get('laya-status').textContent, strings.text('en', key), laya);
    // Iowa's form is filled by its own rules, so Laya isn't mentioned there.
    const iowa = await panel(t, { desktop: { laya } });
    assert.equal(iowa.get('laya-status').hidden, true, `${laya} on Iowa`);
    assert.equal(iowa.get('laya-status').textContent, '', `${laya} on Iowa`);
  }
  // A Laya that is ready needs no line: each fill's result names its guesses.
  const ready = await panel(t, { ...site, desktop: { laya: 'ready' } });
  assert.equal(ready.get('laya-status').hidden, true);
  assert.equal(ready.get('laya-status').textContent, '');
  const off = await panel(t, { tab: SITE, site: { origin: ORIGIN, enabled: false }, desktop: { laya: 'off' } });
  assert.equal(off.get('laya-status').hidden, true, 'nothing about Laya on a site that is off');
  const closed = await panel(t, { ...site, desktop: { connected: false, unlocked: false, laya: 'unavailable' } });
  assert.equal(closed.get('laya-status').hidden, true);
  const older = await panel(t, site);
  assert.equal(older.get('laya-status').hidden, true, 'a worker that reports no Laya state shows no line');
  const spanishView = await panel(t, { ...site, language: 'es-ES', desktop: { laya: 'off' } });
  assert.equal(spanishView.get('laya-status').textContent, spanish('desktop.layaOff'));
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

test('without the Summarizer API the side panel says nothing about it, hides the section, and never reads the page', async t => {
  const view = await panel(t, { pageText: { pages: [summaryPage] } });
  assert.equal(view.get('summary').hidden, true);
  assert.equal(view.get('summary-get').hidden, true);
  assert.equal(view.get('summary-note').hidden, true);
  assert.equal(view.get('summary-note').textContent, '');
  assert.equal(view.types().includes('ui:pageText'), false);
  assert.equal((await panel(t, { language: 'es-ES' })).get('summary-note').hidden, true);
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

test('when Chrome can’t summarize here, the section stays hidden and nothing is said; a page without words says nothing', async t => {
  const ai = summarizerStub({ availability: 'unavailable' });
  const view = await panel(t, { Summarizer: ai.Summarizer, pageText: { pages: [summaryPage] } });
  await settle();
  assert.equal(ai.calls.availability.length, 1, 'Chrome was asked');
  assert.equal(view.get('summary').hidden, true);
  assert.equal(view.get('summary-get').hidden, true);
  assert.equal(view.get('summary-note').hidden, true);
  assert.equal(view.get('summary-note').textContent, '');
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
  // The frame is as tall as the widget measured itself: its row alone, or up to four lines above it.
  assert.deepEqual(plain(page.request({ type: 'secondhand:widgetSize', line: true, width: 254, height: 95 })), { sized: true });
  assert.equal(host.style.height, '95px');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.style.height, '95px', 'the height stays across page changes');
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.style.height, '46px', 'a pill is never taller');
  page.setKind('fillable');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.style.height, '95px', 'and the widget gets its height back');
  for (const height of [0, 45, 167, 80.5, '80', null]) assert.equal(page.request({ type: 'secondhand:widgetSize', line: true, width: 254, height }), undefined, `height ${height}`);
  assert.equal(host.style.height, '95px');
  page.request({ type: 'secondhand:widgetSize', line: true });
  assert.equal(host.style.height, '86px', 'a widget that could not measure itself gets a row for its line');
});

test('an outdated card asks the Iowa page’s content script directly for its frame, and only its own frame is heard', t => {
  const page = content(t);
  const host = page.host();
  const [frame] = page.frames;
  assert.ok(frame.contentWindow, 'the card’s frame has a window');
  // Once the card loads, the script tells it that it can be asked directly.
  const greeted = [];
  frame.contentWindow.postMessage = (data, origin) => greeted.push([data, origin]);
  frame.dispatchEvent(new page.window.Event('load'));
  assert.deepEqual(plain(greeted), [[{ type: 'secondhand:cardHello' }, `chrome-extension://${extensionId}`]]);
  const post = (data, { source = frame.contentWindow, origin = `chrome-extension://${extensionId}` } = {}) =>
    page.window.dispatchEvent(new page.window.MessageEvent('message', { data, source, origin }));
  page.request({ type: 'secondhand:widgetSize', line: true, width: 254, height: 95 });
  const hidden = { type: 'secondhand:cardSize', line: true, width: 92, pill: true };
  // The page's own scripts, another origin, and a size the worker would refuse change nothing.
  post(hidden, { source: page.window });
  post(hidden, { origin: 'https://hhsservices.iowa.gov' });
  for (const pill of ['true', 1, null, false]) post({ ...hidden, pill });
  for (const height of [45, 167, '95']) post({ type: 'secondhand:cardSize', line: true, width: 254, height });
  post({ ...hidden, type: 'secondhand:widgetSize' });
  assert.deepEqual([host.style.height, host.getAttribute('data-secondhand-size')], ['95px', 'full']);
  post(hidden);
  assert.match(host.style.width, /^min\(92px/, 'as wide as the logo and the word beside it');
  assert.deepEqual([host.style.height, host.style.borderRadius, host.getAttribute('data-secondhand-size')], ['46px', '23px', 'pill']);
  // The card shown again, as tall as its notice needs.
  post({ type: 'secondhand:cardSize', line: true, width: 254, height: 118 });
  assert.deepEqual([host.style.height, host.getAttribute('data-secondhand-size')], ['118px', 'full']);
});

test('the Iowa widget the reader hid is its logo and the word that shows it again, until the widget asks for its card back', t => {
  const page = content(t);
  const host = page.host();
  page.request({ type: 'secondhand:widgetSize', line: true, width: 254, height: 95 });
  assert.deepEqual(plain(page.request({ type: 'secondhand:widgetSize', line: true, width: 92, pill: true })), { sized: true });
  assert.match(host.style.width, /^min\(92px/);
  assert.deepEqual([host.style.height, host.style.borderRadius, host.getAttribute('data-secondhand-size')], ['46px', '23px', 'pill']);
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.match(host.style.width, /^min\(92px/, 'it stays hidden while this page stays');
  // A widget that gives no width is the round logo alone.
  page.request({ type: 'secondhand:widgetSize', line: true, pill: true });
  assert.deepEqual([host.style.width, host.style.height, host.style.borderRadius], ['46px', '46px', '50%']);
  page.request({ type: 'secondhand:widgetSize', line: true, width: 254, height: 95 });
  assert.match(host.style.width, /^min\(254px/);
  assert.deepEqual([host.style.height, host.style.borderRadius, host.getAttribute('data-secondhand-size')], ['95px', '12px', 'full']);
  for (const pill of [false, 'true', 1, null]) assert.equal(page.request({ type: 'secondhand:widgetSize', line: true, pill }), undefined, `pill ${pill}`);
  assert.equal(page.request({ type: 'secondhand:widgetSize', line: true, pill: true }, { id: 'b'.repeat(32) }), undefined, 'another extension gets nothing');
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
});

test('the Iowa widget frame is as tall as its line needs, up to 166px, and narrow on a narrow page', t => {
  const page = content(t);
  const host = page.host();
  const size = { type: 'secondhand:widgetSize', line: true, width: 272, height: 72, narrowWidth: 133, narrowHeight: 97 };
  assert.deepEqual(plain(page.request(size)), { sized: true });
  assert.match(host.style.width, /^min\(272px/);
  assert.equal(host.style.height, '72px');
  page.request({ ...size, height: 108 });
  assert.equal(host.style.height, '108px');
  page.request({ ...size, height: 166 });
  assert.equal(host.style.height, '166px', 'six lines and the translation offer');
  // Under 640px wide, the frame keeps the widget's buttons' width and the line's rows, as the page resizes.
  page.request(size);
  Object.defineProperty(page.window, 'innerWidth', { value: 639, configurable: true });
  page.window.dispatchEvent(new page.window.Event('resize'));
  assert.match(host.style.width, /^min\(133px, 272px/);
  assert.equal(host.style.height, '97px');
  page.request({ ...size, narrowHeight: 140 });
  assert.equal(host.style.height, '140px');
  page.request({ type: 'secondhand:widgetSize', line: false, width: 133 });
  assert.equal(host.style.height, '46px', 'no line, the size at rest');
  page.request({ type: 'secondhand:widgetSize', line: true, width: 179 });
  assert.match(host.style.width, /^min\(179px/, 'a widget that sent no narrow size keeps its width');
  assert.equal(host.style.height, '86px');
  page.request(size);
  Object.defineProperty(page.window, 'innerWidth', { value: 640, configurable: true });
  page.window.dispatchEvent(new page.window.Event('resize'));
  assert.match(host.style.width, /^min\(272px/);
  assert.equal(host.style.height, '72px', 'at 640px and wider, the widget’s own size');
  for (const key of ['height', 'narrowWidth', 'narrowHeight']) {
    for (const value of [0, 1.5, '97', 5000, null]) assert.equal(page.request({ ...size, [key]: value }), undefined, `${key} ${value}`);
  }
  for (const value of [45, 167]) assert.equal(page.request({ ...size, narrowHeight: value }), undefined, `narrowHeight ${value}`);
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
  // Under the link, what it is for and that it fills nothing by itself.
  assert.equal(view.get('all-sites-note').hidden, false);
  assert.equal(view.get('all-sites-note').textContent, 'For food-assistance forms on other websites. SecondHand fills one only when you click Autofill there.');
  assert.equal(view.get('all-sites-disable').hidden, true);
  assert.match(view.get('status').textContent, /^Open Iowa’s SNAP application and your checklist appears here/);
  // Under it, a link to the one address SecondHand's Iowa script runs on. It opens beside the page the reader has.
  const link = view.get('open-iowa');
  assert.equal(link.hidden, false);
  assert.equal(link.textContent, 'Open Iowa’s SNAP application');
  assert.equal(link.getAttribute('href'), adapter.PORTAL);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal((await panel(t)).get('open-iowa').hidden, true, 'not on Iowa’s own form');
  assert.equal((await panel(t, { build: 'older-build' })).get('open-iowa').hidden, true, 'nor under the update notice');
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
  assert.equal(view.get('all-sites-note').hidden, true, 'the note goes with the link it explains');
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
  const taken = 'SecondHand is off on other websites. Sites you turned on one at a time stay on. Chrome’s own settings may still list SecondHand’s access to all websites; SecondHand no longer uses it.';
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
  assert.equal(on.get('panel-autofill').hidden, true);
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
  assert.equal(widget.get('widget-text').textContent, EN['widget.iowaReady']);
  // As Chrome leaves an extension frame whose extension reloaded: no id, and every message refused.
  const runtime = widget.window.chrome.runtime;
  delete runtime.id;
  runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
  await widget.userClick('autofill');
  assert.equal(widget.get('widget-text').textContent, strings.english('panel.reloadPage'));
  assert.equal(widget.get('widget-text').textContent, 'SecondHand works again on the next page. To use it here, reload (the round arrow by the address bar); that clears what you typed.');
  assert.equal(widget.get('widget').classList.contains('outdated'), true);
  assert.equal(widget.get('restart').hidden, true, 'SecondHand already restarted: only the page is left to reload');
  // A frame too small for both sentences keeps the one that says what to do; the tooltip has both.
  const small = await panel(t, { launcher: true });
  delete small.window.chrome.runtime.id;
  small.window.chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
  Object.defineProperties(small.get('widget-text'), { scrollHeight: { get() { return this.textContent === EN['panel.reloadPage'] ? 56 : 28; } }, clientHeight: { get: () => 42 } });
  await small.userClick('autofill');
  assert.equal(small.get('widget-text').textContent, 'Reload this page to use SecondHand, or go on to the next page.');
  assert.equal(small.get('widget-text').title, EN['panel.reloadPage']);
  // Letters that overhang their line by a pixel are not a line cut off.
  const snug = await panel(t, { launcher: true });
  delete snug.window.chrome.runtime.id;
  snug.window.chrome.runtime.sendMessage = async () => { throw new Error('Extension context invalidated.'); };
  Object.defineProperties(snug.get('widget-text'), { scrollHeight: { get: () => 43 }, clientHeight: { get: () => 42 } });
  await snug.userClick('autofill');
  assert.equal(snug.get('widget-text').textContent, EN['panel.reloadPage']);
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
const WAITING = 'Filled 1 answer · 3 left for you. Check it before you submit. 2 sensitive details wait until you click Fill sensitive details in the side panel.';
const heldDone = { state: 'done', filled: 1, guessed: 0, needYou: ['f0:sh-2-2', 'f0:sh-2-0', 'f0:sh-2-1'], held: 2, message: WAITING, messageKey: 'result.withHeld',
  messageParams: { summary: { key: 'result.siteFilledNeedYou', params: { count: 1, needYou: 3 } }, count: 2 }, pageKey: 'general' };
const heldFilled = { state: 'done', filled: 3, guessed: 0, needYou: ['f0:sh-2-2'], message: 'Filled 3 answers · 1 left for you. Check them before you submit.',
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
  assert.equal(view.get('need-you').textContent, '3 questions left');
  assert.equal(view.get('widget-text').textContent, 'Filled 1 answer. Check it before you submit. 2 sensitive details wait until you click Fill sensitive details in the side panel.');
  // Fill sensitive details in the side panel changes the tab's result: the widget takes it at its next look.
  view.state.result = structuredClone(heldFilled);
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('need-you').textContent, '1 question left');
  assert.equal(view.get('widget-text').textContent, 'Filled 3 answers. Check them before you submit.');
  // With nothing held any more, it keeps its own result again.
  view.state.result = { ...heldFilled, filled: 9 };
  view.window.document.dispatchEvent(new view.window.Event('visibilitychange'));
  await tick(); await tick();
  assert.equal(view.get('widget-text').textContent, 'Filled 3 answers. Check them before you submit.');

  // Nothing else filled: the held questions matched, so it never says that nothing matched.
  const onlyParams = { summary: { key: 'result.siteNeedYou', params: { count: 1 } }, count: 1 };
  const only = { ...heldDone, filled: 0, held: 1, needYou: ['f0:sh-2-1'], message: strings.text('en', 'result.withHeld', onlyParams), messageParams: onlyParams };
  const alone = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: only });
  await alone.userClick('autofill');
  assert.equal(alone.get('widget-text').textContent, '1 sensitive detail waits until you click Fill sensitive details in the side panel.');
  assert.equal(alone.get('need-you').textContent, '1 question left');
  const spanish = await panel(t, { launcher: true, language: 'es', tab: SITE, site: { origin: ORIGIN, enabled: true }, autofill: heldDone });
  await spanish.userClick('autofill');
  assert.equal(spanish.get('widget-text').textContent, 'Se llenó 1 respuesta. Revísela antes de enviar. 2 datos sensibles esperan hasta que usted haga clic en “Llenar datos sensibles” en el panel lateral.');
});

test('the buttons that the keyboard shortcuts work name them in their tooltips, in the applicant’s language, and say nothing of one that is unset', async t => {
  const shortcuts = [{ name: 'autofill', shortcut: '⌥⇧F', description: 'Start Autofill on this page, or stop it' }, { name: 'next-question', shortcut: '', description: 'Go to the next question left' },
    { name: '_execute_action', shortcut: '' }];
  const widget = await panel(t, { launcher: true, shortcuts });
  await settle();
  assert.equal(widget.get('autofill').title, `${EN['widget.autofillIowaTitle']} Keyboard shortcut: ⌥⇧F.`);
  assert.equal(widget.get('stop').title, `${EN['widget.stopTitle']} Keyboard shortcut: ⌥⇧F.`);
  assert.equal(widget.get('need-you').title, EN['widget.needYouTitle'], 'no shortcut is set for the next question');
  const both = await panel(t, { launcher: true, result: doneResult, shortcuts: [...shortcuts.slice(0, 1), { name: 'next-question', shortcut: '⌥⇧N' }] });
  await settle();
  assert.equal(both.get('need-you').title, 'Go to the next question left, in the form. Keyboard shortcut: ⌥⇧N.', 'a sentence, then the shortcut');
  const side = await panel(t, { shortcuts: [...shortcuts.slice(0, 1), { name: 'next-question', shortcut: '⌥⇧N' }] });
  await settle();
  assert.equal(side.get('panel-autofill').title, 'Keyboard shortcut: ⌥⇧F.');
  assert.equal(side.get('panel-left').title, 'Keyboard shortcut: ⌥⇧N.');
  const spanish = await panel(t, { language: 'es', shortcuts });
  await settle();
  assert.equal(spanish.get('panel-autofill').title, 'Atajo de teclado: ⌥⇧F.');
  // Without the commands API (an older Chrome, or none set), no tooltip names one.
  const none = await panel(t, {});
  await settle();
  assert.equal(none.get('panel-autofill').title, '');
});

// #185: Laya's best guesses, listed for the applicant to find and check.
const GUESSES = [{ id: 'f0:sh-1-1', label: 'How many people live in your household?' }, { id: 'f4:sh-1-3', label: 'Preferred pickup day' }];
const GUESSED = 'Filled 4 answers · 1 guessed. Check them before you submit. Guesses were suggested by Laya on this computer. 2 guessed by Laya, check them.';
const guessedDone = { state: 'done', filled: 4, guessed: 1, laya: 1, layaGuessed: 2, layaGuesses: GUESSES, needYou: [], pageKey: 'general', message: GUESSED, messageKey: 'result.layaGuessed',
  messageParams: { summary: { key: 'result.suggestedByLaya', params: { summary: { key: 'result.siteFilledGuessed', params: { count: 4, guessed: 1 } } } }, count: 2 } };

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

test('in another language, a site’s question lists point to the translated view, then show each question translated over the form’s words', async t => {
  const ai = translatorStub();
  const questions = { lang: 'en', pending: 0, questions: GUESSES.map(({ id, label }) => ({ id, label })) };
  const view = await panel(t, { tab: pantryTab, site: PANTRY_SITE, result: guessedDone, language: 'es-ES', Translator: ai.Translator, LanguageDetector: detectorStub().LanguageDetector, questions });
  assert.equal(view.get('words-hint').hidden, false);
  assert.equal(view.get('words-hint-text').textContent, 'Las preguntas de abajo están en el idioma del formulario.');
  assert.equal(view.get('words-translate').textContent, 'Ver las preguntas en español', 'the question list’s button, under the line');
  assert.equal(view.get('questions-show').hidden, true, 'one button for it, the one nearer what it is for');
  view.get('words-translate').click(); await settle();
  assert.equal(ai.calls.translate.length, 0, 'only a trusted click');
  await view.userClick('words-translate'); await settle();
  const row = view.window.document.querySelector('[data-guess-id="f0:sh-1-1"]');
  assert.deepEqual([...row.querySelectorAll('.checklist-label, .checklist-detail')].map(element => element.textContent),
    ['[es] How many people live in your household?', 'How many people live in your household?'], 'the reader’s language on top, the form’s words under it');
  assert.equal(row.getAttribute('aria-label'), strings.text('es', 'guesses.rowLabel', { label: '[es] How many people live in your household?' }));
  assert.equal(view.get('words-hint').hidden, true, 'translated, the line has nothing left to say');
  assert.equal(view.get('questions-show').textContent, spanish('questions.refresh'));
  assert.equal(view.get('questions-show').hidden, false);
  // In English there is nothing to point to.
  const english = await panel(t, { tab: pantryTab, site: PANTRY_SITE, result: guessedDone, Translator: ai.Translator });
  assert.equal(english.get('words-hint').hidden, true);
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
  assert.equal(view.get('widget-text').textContent, GUESSED);
  const one = await panel(t, { launcher: true, tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true },
    autofill: { ...guessedDone, filled: 1, guessed: 0, laya: undefined, layaGuessed: 1, layaGuesses: GUESSES.slice(0, 1), message: 'Filled 1 answer. Check it before you submit. 1 guessed by Laya, check it.',
      messageParams: { summary: { key: 'result.siteFilled', params: { count: 1 } }, count: 1 } } });
  await one.userClick('autofill');
  assert.equal(one.get('widget-text').textContent, 'Filled 1 answer. Check it before you submit. 1 guessed by Laya, check it.');
  const spanishView = await panel(t, { launcher: true, language: 'es', tab: SITE, site: { origin: ORIGIN, enabled: true }, plan: { ...openPlan, laya: true }, autofill: guessedDone });
  await spanishView.userClick('autofill');
  assert.equal(spanishView.get('widget-text').textContent, strings.text('es', guessedDone.messageKey, guessedDone.messageParams));
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
  assert.equal(view.get('panel-autofill').textContent, 'Stop Autofill');
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
