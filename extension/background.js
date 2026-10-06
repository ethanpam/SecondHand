'use strict';
importScripts('address-policy.js', 'iowa-later-adapter.js', 'iowa-record-adapter.js', 'iowa-adapter.js', 'generic-adapter.js', 'strings.js', 'translation.js');
if (typeof globalThis.SecondHandGeneric?.requestKeys !== 'function' || typeof globalThis.SecondHandGeneric.deriveValues !== 'function' || !Array.isArray(globalThis.SecondHandGeneric.GENERIC_KEYS) ||
  typeof globalThis.SecondHandGeneric.unsafeQuestion !== 'function' || typeof globalThis.SecondHandGeneric.layaQuestion !== 'function' ||
  typeof globalThis.SecondHandGeneric.isBandKey !== 'function' || !Array.isArray(globalThis.SecondHandGeneric.SAVE_KEYS) ||
  typeof globalThis.SecondHandGeneric.canRemember !== 'function' || typeof globalThis.SecondHandGeneric.timeBound !== 'function') {
  throw new Error('SecondHand could not load generic-adapter.js. Reinstall the extension.');
}
if (typeof globalThis.SecondHandStrings?.english !== 'function' || typeof globalThis.SecondHandStrings.describeEnglish !== 'function') {
  throw new Error('SecondHand could not load strings.js. Reinstall the extension.');
}
if (typeof globalThis.SecondHandTranslation?.create !== 'function') {
  throw new Error('SecondHand could not load translation.js. Reinstall the extension.');
}
// Must match BUILD in panel.js: change both together, with every change to the extension. The panel
// compares them to tell when Chrome is still running an older worker than the pages it loaded from
// disk, and the worker compares it with the build the desktop app ships to update itself (#85).
const BUILD = '2026-10-06.16';
const HOST = 'org.secondhand.bridge';
const IOWA_ORIGIN = new URL(SecondHandIowa.PORTAL).origin;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,59}$/; // Iowa field keys and saved profile keys
// A key the site engine may plan: a saved field, a derived answer, or a household count by age ("householdCount:0-5").
const plannedKey = key => typeof key === 'string' && (KEY.test(key) || SecondHandGeneric.isBandKey(key));
const SITE_FIELD_ID = /^f\d{1,6}:[A-Za-z][A-Za-z0-9_-]{0,59}$/;
// Every message the panel shows travels as English text plus its catalog key and parameters,
// so each page can show it in the applicant's language. Errors carry the same three.
const english = (key, params = {}) => SecondHandStrings.english(key, params);
const say = (key, params = {}) => ({ message: english(key, params), messageKey: key, messageParams: params });
const fault = (key, params = {}) => Object.assign(new Error(english(key, params)), { messageKey: key, messageParams: params });
// Fixed English written by the Iowa adapter or a content script, with the key it has in the catalog.
function adapterSays(text, field = 'message') {
  const { key, params } = SecondHandStrings.describeEnglish(text);
  return { [field]: text, [`${field}Key`]: key, [`${field}Params`]: params };
}
const FRAME_ERROR = 'worker.frameUnsafe';
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/; // field ids from the site engine's plan
const results = new Map(); // tabId -> last autofill result: counts, keys, and fixed messages only. Never answers.
const siteRuns = new Map(); // tabId -> the fill running on an approved site, so two clicks share one request.
const sitePilots = new Map(); // Explicit Fill and continue sessions, same origin and active tab only.
// Save to My information (#98). tabId -> { url, origin ('' on Iowa's portal), items: Map(id -> { frameId, documentId, planId, token, key, label }) }:
// the questions the last Autofill matched to a saved field that has no saved answer. Memory only, forgotten when
// the tab navigates. Keys and plan ids stay in the worker; the side panel gets each question's id and label.
const savables = new Map();
// Fill sensitive details (#176). tabId -> { url, origin, reason, items: Map(id -> { frameId, documentId, planId, token, key, label, url, fields }) }:
// the questions the last Autofill matched to a saved field whose answer the app held back until the applicant allows it, each
// with the address of its site and the held fields it needs. Memory only, forgotten when the tab navigates or a new fill starts.
// Keys and plan ids stay in the worker; the side panel gets each question's id and label.
const heldDetails = new Map();
// Remember for next time (#186). tabId -> { url, origin, items: Map(id -> { frameId, documentId, planId, token, label, url, question, timeBound }) }:
// the open questions the last Autofill on a site left that a custom answer may fill, each with its question (label, type and
// choices) and the address of its site. Memory only, forgotten when the tab navigates. The side panel gets each one's id,
// label, whether its answer changes over time, and whether the page holds an answer now.
const rememberables = new Map();
const sitePlans = new Map(); // tabId -> { url, frames } the widget's on-device AI saw. Field metadata only.
// Tabs whose widget asked the side panel to open on the question list. The panel takes it once.
const questionViews = new Set();
// tabId -> Map(url -> { id, url, pageKey, lang, text, unread, summary }): the words of pages the side
// panel summarizes and the key points it wrote for them. Memory only. Iowa's information-only screens
// stay until the tab leaves Iowa; other pages are kept by address, the latest few.
const pageReads = new Map();
const PAGE_TEXT_LIMIT = 16000;
const KEPT_PAGES = 8;
// tabId -> { steps, handled, running }. Memory only: a page can never turn autofill on,
// and if Chrome restarts this worker, autofill is off and the widget shows Autofill again.
const autopilots = new Map();
const MAX_STEPS = 64;
// tabId -> the Iowa page (origin + path) where the general engine found fields, until the tab navigates.
const generalPages = new Map();
const GENERAL_TODO = 'worker.checkThenContinue';
const MAX_GENERAL_PASSES = 4;
// Sensitive answers (identity, money, health, immigration) are placed only by a confident
// rule match, never by an AI guess.
const SENSITIVE_KEYS = Object.freeze(['ssn', 'birthDate', 'ageRange', 'totalMonthlyIncome', 'annualIncome', 'assetsOnHand', 'monthlyMedicalExpenses',
  'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare']);
const AI_KEYS = Object.freeze(SecondHandGeneric.GENERIC_KEYS.filter(key => !SENSITIVE_KEYS.includes(key)));
// Laya, the desktop app's local AI: it matches text boxes to saved fields (#39) and answers choice
// questions from the saved profile (#42). It gets question labels, types, and options only, within
// the bridge's limits. Chrome's on-device AI runs only when Laya isn't ready.
// Each Autofill click gives Laya `budgetMs` in all; every request carries what the click has left.
// Which questions Laya may take is the site engine's rule (SecondHandGeneric.layaQuestion), so the
// on-page card and the worker agree on it.
const LAYA = Object.freeze({ fields: 40, questions: 30, bytes: 48 * 1024, budgetMs: 3000 });
const LAYA_NOT_READY = 'LAYA_NOT_READY';
const LAYA_STATES = Object.freeze(['off', 'unavailable', 'not-downloaded', 'downloading', 'ready', 'error']);
// A native host that runs but can't reach the desktop app says so with this code. The Windows relay
// and hosts from before the code send one of these fixed sentences instead. Either means the app is closed.
const DESKTOP_UNREACHABLE = 'DESKTOP_UNREACHABLE';
const UNREACHABLE_WORDS = Object.freeze(['Open SecondHand, connect this extension, and unlock SecondHand.', 'Open SecondHand, connect this extension, and unlock your local vault.']);

function nativeRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let settled = false, port, timer;
    const finish = (error, data, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* already disconnected */ }
      if (error) reject(Object.assign(error, code ? { code } : {})); else resolve(data);
    };
    try {
      port = chrome.runtime.connectNative(HOST);
      timer = setTimeout(() => finish(fault('worker.desktopTimedOut')), 115000);
      port.onMessage.addListener(message => {
        if (!message || message.id !== id) return finish(fault('worker.desktopUnexpected'));
        if (message.ok !== true) {
          // A host that can't reach the desktop app means the app is closed, as when there is no host.
          if (message.code === DESKTOP_UNREACHABLE || UNREACHABLE_WORDS.includes(message.error)) return finish(fault('worker.desktopOffline'), undefined, 'offline');
          // The desktop app's own wording travels as a detail.
          return finish(typeof message.error === 'string' ? new Error(message.error.slice(0, 240)) : fault('worker.desktopDeclined'), undefined, message.code === LAYA_NOT_READY ? LAYA_NOT_READY : undefined);
        }
        finish(null, message.data);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finish(fault('worker.desktopOffline'), undefined, 'offline');
      });
      port.postMessage({ id, type, ...payload });
    } catch { finish(fault('worker.desktopOffline'), undefined, 'offline'); }
  });
}
function safeUrl(raw) { const url = new URL(raw); return url.origin + url.pathname; }
async function activePortal(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.id !== tabId || !tab.active || !SecondHandIowa.isSupportedUrl(tab.url)) throw fault('worker.openIowaPortal');
  return tab;
}
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['address-policy.js', 'iowa-later-adapter.js', 'iowa-record-adapter.js', 'iowa-adapter.js', 'generic-adapter.js', 'page-text.js', 'content.js'] });
}
async function readPage(tabId, navigationPreview = true) {
  const tab = await activePortal(tabId);
  await inject(tabId);
  const state = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:pageState', navigationPreview }, { frameId: 0 });
  const current = await activePortal(tabId);
  if (current.url !== tab.url || !state?.page || !state.scan) throw fault('worker.pageLoading');
  return { ...state, url: tab.url };
}
const needYou = page => (Array.isArray(page.checklist) ? page.checklist : [])
  .filter(item => (item.required && item.status === 'missing') || item.status === 'manual').map(item => item.key);
function remember(tabId, result) { results.set(tabId, result); return result; }
function failed(error) {
  const text = typeof error?.message === 'string' ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240) : '';
  if (error?.code === 'offline') return { state: 'offline', ...say('worker.openAppThenAutofill') };
  if (/Unlock/.test(text)) return { state: 'locked', ...say('worker.unlockToAutofill') };
  if (/cancelled/i.test(text)) return { state: 'error', ...say('worker.cancelled') };
  if (!text) return { state: 'error', ...say('worker.autofillFailed') };
  if (error.messageKey) return { state: 'error', message: text, messageKey: error.messageKey, messageParams: error.messageParams };
  return { state: 'error', message: text, messageKey: 'detail', messageParams: { detail: text } };
}

// Why the desktop left saved answers out (#135): a saved date of birth it can't use. Null when it left none out.
function desktopReason(response) {
  if (response?.reason === undefined) return null;
  if (response.reason !== 'birthDate') throw fault('worker.desktopUnexpected');
  return { key: 'worker.birthDateUnusable', params: {} };
}
// Desktop receipt revisions are authorization metadata, never profile values.
function receiptRevision(response) {
  if (!Number.isSafeInteger(response?.accessRevision) || response.accessRevision < 0) throw fault('worker.authorizationOutdated');
  return response.accessRevision;
}
async function checkAccess(revision) {
  const desktop = await desktopStatus();
  if (!desktop?.unlocked) throw fault('worker.unlockToAutofill');
  if (receiptRevision(desktop) !== revision) throw fault('worker.accessChanged');
}
function currentPilot(tabId, pilot) {
  if (autopilots.get(tabId) !== pilot) throw fault('worker.pilotStopped');
}
function stopAutopilot(tabId, result, pilot) {
  if (pilot && autopilots.get(tabId) !== pilot) return results.get(tabId) || result;
  autopilots.delete(tabId);
  return remember(tabId, result);
}
async function fillPage(tabId, state, pilot) {
  const { url } = state;
  const pageKey = state.page.pageKey;
  let values = null;
  try {
    const desktop = await desktopStatus();
    currentPilot(tabId, pilot);
    if (!desktop?.unlocked) return { state: 'locked', filled: 0, needYou: [], ...say('worker.unlockToAutofill'), pageKey };
    const response = await nativeRequest('getFields', { url: safeUrl(url), fields: SecondHandIowa.profileRequest(pageKey) });
    currentPilot(tabId, pilot);
    const revision = receiptRevision(response);
    if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw fault('worker.noProfileFields');
    const reason = desktopReason(response);
    values = SecondHandIowa.pageValues(pageKey, response.values);
    let filled = 0;
    const attempted = pilot.attempted;
    // Questions this page offered that have no saved answer: the side panel points to My information.
    const unsaved = new Set();
    for (let pass = 0; pass < 4; pass++) {
      currentPilot(tabId, pilot);
      if ((await activePortal(tabId)).url !== url) throw fault('worker.pageChangedAutofill');
      currentPilot(tabId, pilot);
      const fresh = pass === 0 ? state : await readPage(tabId);
      currentPilot(tabId, pilot);
      if (fresh.page.kind === 'blocked') break; // A household answer can reveal CAPTCHA.
      if (fresh.pageInstance !== state.pageInstance || fresh.page.pageKey !== pageKey || !fresh.scan.recognizedPage) throw fault('worker.pageChangedAutofill');
      const offered = fresh.scan.fields.map(field => field.key).filter(key => !attempted.has(key));
      offered.forEach(key => attempted.add(key));
      const keys = offered.filter(key => typeof values[key] === 'string' && values[key]);
      offered.filter(key => !keys.includes(key)).forEach(key => unsaved.add(key));
      if (!keys.length) break;
      await checkAccess(revision);
      currentPilot(tabId, pilot);
      if ((await activePortal(tabId)).url !== url) throw fault('worker.pageChangedAutofill');
      currentPilot(tabId, pilot);
      const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:fill', token: fresh.scan.token, pageInstance: fresh.pageInstance, fields: keys,
        values: Object.fromEntries(keys.map(key => [key, values[key]])) }, { frameId: 0 });
      currentPilot(tabId, pilot);
      if (!result?.ok) throw fault('worker.pageUnsafe');
      filled += result.filledCount;
      if (!result.filledCount) break;
    }
    values = null;
    const after = await readPage(tabId);
    currentPilot(tabId, pilot);
    if (after.pageInstance !== state.pageInstance || after.url !== url || (after.page.pageKey !== pageKey && after.page.kind !== 'blocked')) throw fault('worker.pageChangedCheck');
    if (filled > 0) await nativeRequest('recordProgress', { url: safeUrl(url), filledCount: Math.min(filled, 100) }).catch(() => {});
    currentPilot(tabId, pilot);
    const missing = needYou(after.page);
    const summary = withReason(filled ? filledSummary(filled, missing)
      : missing.length ? { key: 'result.needYouNotSaved', params: { count: missing.length } } : { key: 'result.nothingNew', params: {} }, reason);
    // This receipt stays only in the worker. It never reaches a panel result.
    pilot.accessRevision = revision;
    const todo = after.page.todo ? adapterSays(after.page.todo, 'todo') : { todo: '' };
    const message = todo.todo ? say('result.thenTodo', { summary, todo: { key: todo.todoKey, params: todo.todoParams } }) : say(summary.key, summary.params);
    return { state: 'done', filled, needYou: missing, notSaved: missing.filter(key => unsaved.has(key)), ...message, ...todo, pageKey: after.page.pageKey };
  } catch (error) {
    return { ...failed(error), filled: 0, needYou: [], pageKey };
  } finally { values = null; }
}

async function fillRecordPage(tabId, state, pilot) {
  const pageKey = state.page.pageKey, request = SecondHandIowa.recordRequest(pageKey);
  let values = null;
  try {
    const desktop = await desktopStatus(); currentPilot(tabId, pilot);
    if (!desktop?.unlocked) return { state: 'locked', filled: 0, needYou: [], ...say('worker.unlockToAutofill'), pageKey };
    const recipient = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:recordContext', token: state.scan.token, pageInstance: state.pageInstance }, { frameId: 0 });
    currentPilot(tabId, pilot);
    if (!request || !recipient?.ok || (recipient.personName !== undefined && (typeof recipient.personName !== 'string' || recipient.personName.length > 200))) throw fault('worker.pageChangedReview');
    const response = await nativeRequest('getRecordFields', { url: safeUrl(state.url), pageKey, recordType: request.recordType, fields: request.fields,
      ...(recipient.personName ? { personName: recipient.personName } : {}) });
    currentPilot(tabId, pilot);
    const revision = receiptRevision(response);
    if (response?.reason === 'recordMissing') return { state: 'waiting', filled: 0, needYou: needYou(state.page), ...say('worker.recordMissing'), pageKey };
    if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values) || typeof response.recordId !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(response.recordId) || typeof response.values.person !== 'string' || !response.values.person.trim() ||
        Object.entries(response.values).some(([key, value]) => !request.fields.includes(key) || typeof value !== 'string' || value.length > 200)) throw fault('worker.desktopUnexpected');
    values = response.values;
    let filled = 0; const unsaved = new Set();
    // A single approved record covers bounded conditional reveals. Never request a whole record list.
    for (let pass = 0; pass < 6; pass++) {
      const fresh = pass === 0 ? state : await readPage(tabId); currentPilot(tabId, pilot);
      if (fresh.url !== state.url || fresh.pageInstance !== state.pageInstance || fresh.page.pageKey !== pageKey || !fresh.scan.recognizedPage) throw fault('worker.pageChangedAutofill');
      const offered = fresh.scan.fields.map(field => field.key).filter(key => !pilot.attempted.has(key));
      offered.forEach(key => pilot.attempted.add(key));
      const keys = offered.filter(key => typeof values[key] === 'string' && values[key]);
      offered.filter(key => !keys.includes(key)).forEach(key => unsaved.add(key));
      if (!keys.length) break;
      await checkAccess(revision); currentPilot(tabId, pilot);
      if ((await activePortal(tabId)).url !== state.url) throw fault('worker.pageChangedAutofill');
      currentPilot(tabId, pilot);
      const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:fill', token: fresh.scan.token, pageInstance: fresh.pageInstance,
        fields: keys, values }, { frameId: 0 });
      currentPilot(tabId, pilot);
      if (!result?.ok) throw fault('worker.pageUnsafe');
      filled += result.filledCount;
      if (!result.filledCount) break;
    }
    values = null;
    const after = await readPage(tabId); currentPilot(tabId, pilot);
    if (after.url !== state.url || after.pageInstance !== state.pageInstance || after.page.pageKey !== pageKey) throw fault('worker.pageChangedCheck');
    pilot.accessRevision = revision;
    if (filled > 0) await nativeRequest('recordProgress', { url: safeUrl(state.url), filledCount: Math.min(filled, 100) }).catch(() => {});
    currentPilot(tabId, pilot);
    const missing = needYou(after.page), summary = filled ? filledSummary(filled, missing) : missing.length ? { key: 'result.needYouNotSaved', params: { count: missing.length } } : { key: 'result.nothingNew', params: {} };
    return { state: 'done', filled, needYou: missing, notSaved: missing.filter(key => unsaved.has(key)), ...say(summary.key, summary.params), pageKey };
  } catch (error) { return { ...failed(error), filled: 0, needYou: [], pageKey }; }
  finally { values = null; }
}

const NAVIGATION_PAGES = new Set(SecondHandIowa.NAVIGATION_PAGE_KEYS);
// Semantic identity is separate from a document UUID. A same-step server reload must never
// turn a possibly successful Next into another automatic attempt. The two Tell Us More routes
// are one step; independently observed household screens have fixed, nonpersonal step keys.
function stepIdentity(state) {
  if (['iowa-tell-us-more', 'iowa-self-details'].includes(state.page.pageKey)) return 'iowa-tell-us-more';
  return state.page.stepKey || `${safeUrl(state.url)}|${state.page.pageKey}`;
}
async function advanceVerified(tabId, state, pilot, filledResult, authorize = false) {
  const pageKey = state.page.pageKey, semantic = stepIdentity(state);
  if (!NAVIGATION_PAGES.has(pageKey) || !state.page.canAdvance || !state.nextToken) return filledResult;
  if (pilot.navigationAttempts.has(semantic)) return filledResult;
  if (typeof state.pageInstance !== 'string' || !state.pageInstance) throw fault('worker.pageChangedReview');
  // Keep the already-captured token across native approval. Re-capturing after approval would
  // silently approve answers changed while the desktop dialog was open.
  if (authorize && SecondHandIowa.recordRequest(pageKey) && Number.isSafeInteger(pilot.accessRevision)) { await checkAccess(pilot.accessRevision); currentPilot(tabId, pilot); }
  if (authorize || !Number.isSafeInteger(pilot.accessRevision)) {
    const response = await nativeRequest('getFields', { url: safeUrl(state.url), fields: [] });
    currentPilot(tabId, pilot);
    pilot.accessRevision = receiptRevision(response);
    if (!response?.values || Object.keys(response.values).length) throw fault('worker.invalidNavigation');
  }
  const fresh = await readPage(tabId, false);
  currentPilot(tabId, pilot);
  if (fresh.pageInstance !== state.pageInstance || fresh.url !== state.url || fresh.page.pageKey !== pageKey || !fresh.page.canAdvance) throw fault('worker.pageChangedReview');
  await checkAccess(pilot.accessRevision);
  currentPilot(tabId, pilot);
  if ((await activePortal(tabId)).url !== state.url) throw fault('worker.pageChangedBeforeNext');
  currentPilot(tabId, pilot);
  pilot.waiting = null;
  // Consume before sending, even if the port disappears during the form POST.
  pilot.navigationAttempts.add(semantic);
  const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:next', token: state.nextToken, pageInstance: state.pageInstance, authorized: true }, { frameId: 0 });
  currentPilot(tabId, pilot);
  if (!result?.advanced) return { ...filledResult, state: 'waiting', ...(result?.reason ? adapterSays(result.reason) : say('worker.reviewContinueIowa')), pageKey };
  return { ...filledResult, state: 'continuing', ...say('worker.selectedSaveContinue'), pageKey };
}

function step(tabId) {
  const pilot = autopilots.get(tabId);
  if (!pilot) return Promise.resolve(results.get(tabId) || null);
  if (pilot.running) return pilot.running;
  pilot.running = (async () => {
    let state;
    try { state = await readPage(tabId); } catch { return results.get(tabId) || null; }
    if (autopilots.get(tabId) !== pilot) return results.get(tabId) || null;
    const { page } = state;
    pilot.pageKey = page.pageKey;
    const signature = stepIdentity(state);
    if (pilot.currentStep && pilot.currentStep !== signature) results.delete(tabId);
    pilot.currentStep = signature;
    if (pilot.navigationAttempts.has(signature)) return results.get(tabId) || null;
    if (pilot.handled.has(signature) && !(pilot.waiting === signature && (page.canAdvance || state.scan.fields.some(field => !pilot.attempted.has(field.key))))) return results.get(tabId) || null;
    const resuming = pilot.handled.has(signature);
    if (!resuming) pilot.attempted = new Set();
    pilot.handled.add(signature);
    if (!resuming && ++pilot.steps > MAX_STEPS) return stopAutopilot(tabId, { state: 'stopped', filled: 0, needYou: [], ...say('worker.stoppedAfterSteps', { steps: MAX_STEPS }), pageKey: page.pageKey }, pilot);
    try {
      if (resuming && page.canAdvance && !state.scan.fields.some(field => !pilot.attempted.has(field.key))) {
        const result = await advanceVerified(tabId, state, pilot, results.get(tabId) || { filled: 0, needYou: [] }, true);
        currentPilot(tabId, pilot);
        return remember(tabId, result);
      }
      if (page.kind === 'info') {
        remember(tabId, { state: 'continuing', filled: 0, needYou: [], ...say('worker.continuing'), pageKey: page.pageKey });
        currentPilot(tabId, pilot);
        await keepIowaScreen(tabId, state.url, page.pageKey);
        currentPilot(tabId, pilot);
        const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:continue' }, { frameId: 0 });
        currentPilot(tabId, pilot);
        if (!result?.continued) return remember(tabId, { state: 'waiting', filled: 0, needYou: [], ...(result?.reason ? adapterSays(result.reason) : say('iowa.clickContinue')), pageKey: page.pageKey });
        return results.get(tabId);
      }
      if (page.kind === 'fillable' && state.scan.recognizedPage) {
        let result;
        if (page.pageKey === 'iowa-select-address') {
          result = await advanceVerified(tabId, state, pilot, { filled: 0, needYou: [], pageKey: page.pageKey }, true);
        } else {
          result = await (SecondHandIowa.recordRequest(page.pageKey) ? fillRecordPage(tabId, state, pilot) : fillPage(tabId, state, pilot));
          currentPilot(tabId, pilot);
          if (result.state === 'done' && NAVIGATION_PAGES.has(page.pageKey)) {
            const fresh = await readPage(tabId); currentPilot(tabId, pilot);
            if (fresh.pageInstance !== state.pageInstance || fresh.page.pageKey !== page.pageKey) throw fault('worker.pageChangedReview');
            if (fresh.page.canAdvance) result = await advanceVerified(tabId, fresh, pilot, result);
            else pilot.waiting = signature;
          }
        }
        currentPilot(tabId, pilot);
        return ['done', 'waiting', 'continuing'].includes(result.state) ? remember(tabId, result) : stopAutopilot(tabId, result, pilot);
      }
      if (page.todo) return remember(tabId, { state: 'waiting', filled: 0, needYou: needYou(page), ...adapterSays(page.todo), pageKey: page.pageKey });
      if (page.kind === 'manual') {
        const plan = await planGeneral(tabId); currentPilot(tabId, pilot);
        const url = safeUrl(state.url);
        if (plan.matched.length || generalPages.get(tabId) === url || page.pageKey === 'iowa-household-screening-rules') {
          generalPages.set(tabId, url);
          const result = await fillIowaGeneral(tabId, state, plan, () => currentPilot(tabId, pilot));
          currentPilot(tabId, pilot);
          return result.state === 'done' ? remember(tabId, result) : stopAutopilot(tabId, result, pilot);
        }
        // The rules found nothing here, but Laya may answer this page's questions.
        const { boxes, choices } = layaQuestions([{ frameId: 0, plan }], false);
        if ((boxes.length || choices.length) && await layaReady()) {
          currentPilot(tabId, pilot);
          const result = await fillIowaGeneral(tabId, state, plan, () => currentPilot(tabId, pilot), true);
          currentPilot(tabId, pilot);
          if (result.state !== 'done' || result.filled) {
            generalPages.set(tabId, url);
            return result.state === 'done' ? remember(tabId, result) : stopAutopilot(tabId, result, pilot);
          }
        }
      }
      return stopAutopilot(tabId, { state: 'stopped', filled: 0, needYou: [], ...say('worker.unknownPage'), pageKey: page.pageKey }, pilot);
    } catch (error) {
      return stopAutopilot(tabId, { ...failed(error), filled: 0, needYou: [], pageKey: page.pageKey }, pilot);
    }
  })().finally(() => { pilot.running = null; });
  return pilot.running;
}
async function startAutopilot(tabId) {
  if (autopilots.get(tabId)?.running) return autopilots.get(tabId).running;
  const pilot = { steps: 0, handled: new Set(), navigationAttempts: new Set(), running: null, waiting: null, accessRevision: null, attempted: new Set() };
  autopilots.set(tabId, pilot);
  try { await activePortal(tabId); currentPilot(tabId, pilot); return step(tabId); }
  catch (error) { return stopAutopilot(tabId, { ...failed(error), filled: 0, needYou: [], pageKey: results.get(tabId)?.pageKey || '' }, pilot); }
}
async function stop(tabId) {
  // Revoke first, before any asynchronous inspection, so a pending native reply
  // cannot fill or click while Stop is waiting for a page response.
  sitePilots.delete(tabId);
  return stopAutopilot(tabId, { state: 'stopped', filled: 0, needYou: [], ...say('worker.autofillStopped'), pageKey: autopilots.get(tabId)?.pageKey || results.get(tabId)?.pageKey || '' });
}
async function iowaPageState(tabId) {
  // Metadata must remain responsive while the desktop is awaiting approval.
  // step owns its serialized run and stores its eventual sanitized result.
  if (autopilots.has(tabId) && !autopilots.get(tabId).running) void step(tabId);
  // Polls must never replace the private navigation snapshot held by an
  // in-flight authorization. Only a worker action captures a Next preview.
  const state = await readPage(tabId, false);
  const result = results.get(tabId);
  const general = state.page.kind === 'manual' && !state.page.todo && generalPages.get(tabId) === safeUrl(state.url);
  const page = keyedPage(general ? { ...state.page, todo: english(GENERAL_TODO) } : state.page);
  return { page, scan: state.scan, result: result && result.pageKey === state.page.pageKey ? result : null, autopilot: autopilots.has(tabId), ...summaryLine(tabId, state.url) };
}
// The adapter's instruction, reason, and checklist labels, each with its catalog key.
function keyedPage(page) {
  return { ...page, ...(page.todo ? adapterSays(page.todo, 'todo') : {}), ...(page.reason ? adapterSays(page.reason, 'reason') : {}),
    ...(Array.isArray(page.checklist) ? { checklist: page.checklist.map(item => typeof item?.label === 'string' ? { ...item, ...adapterSays(item.label, 'label') } : item) } : {}) };
}

// Other https sites the user turned on: Chrome access for the origin plus our
// registered content script. The desktop keeps its own trusted list and has the final say.
// A host named "all" would take the all-websites registration's id, so it is not a site here.
function siteOrigin(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname && url.hostname !== 'all' && !url.username && !url.password && !url.port && url.origin !== IOWA_ORIGIN ? url.origin : '';
  } catch { return ''; }
}
const SITE_FILES = Object.freeze({ js: ['generic-adapter.js', 'generic-navigation.js', 'page-text.js', 'generic-content.js'] });
const siteScript = origin => ({ id: `site-${new URL(origin).hostname}`, matches: [`${origin}/*`],
  js: [...SITE_FILES.js], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true });
const frameScriptPrefix = origin => `frame-${new URL(origin).hostname}--`;
const frameScript = (topOrigin, origin) => ({ ...siteScript(origin), id: `${frameScriptPrefix(topOrigin)}${new URL(origin).hostname}` });
// SecondHand on all websites: one registration for every https page but Iowa's site, which keeps its
// own scripts, plus Chrome's access to every https site. The desktop keeps its own allSites setting.
// Once given, Chrome's grant is kept: removing it would also take back every origin it covers, Iowa's
// included until Chrome restarts. Without the registration it runs nothing, and the app trusts no site
// for it, so a site is on only when its script is registered (or site-all is) and the app trusts it.
const ALL_SITES = Object.freeze(['https://*/*']);
const ALL_SITES_ID = 'site-all';
const IOWA_HOST = `${IOWA_ORIGIN}/*`;
const allSitesScript = () => ({ id: ALL_SITES_ID, matches: [...ALL_SITES], excludeMatches: [IOWA_HOST], js: [...SITE_FILES.js],
  allFrames: true, runAt: 'document_idle', persistAcrossSessions: true });
async function siteEnabled(origin) {
  const [scripts, allowed] = await Promise.all([chrome.scripting.getRegisteredContentScripts(),
    chrome.permissions.contains({ origins: [`${origin}/*`] })]);
  return allowed && scripts.some(script => script.id === ALL_SITES_ID || script.matches.includes(`${origin}/*`));
}
async function allSitesOn() {
  const [scripts, allowed] = await Promise.all([chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] }),
    chrome.permissions.contains({ origins: [...ALL_SITES] })]);
  return scripts.length > 0 && allowed;
}
async function requireSite(origin) {
  if (!(await siteEnabled(origin))) throw fault('worker.turnOnSiteFirst');
}
async function activeSite(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = siteOrigin(tab.url);
  if (tab.id !== tabId || !tab.active || !origin) throw fault('worker.openFormActiveTab');
  return { tab, origin };
}

async function enableSite(tabId) {
  const { tab, origin } = await activeSite(tabId);
  const origins = [`${origin}/*`];
  // The side panel asks Chrome inside the user's click; the worker only confirms it happened.
  if (!(await chrome.permissions.contains({ origins }))) throw fault('worker.chromeNotAllowedSite');
  try {
    const trust = await nativeRequest('trustSite', { url: safeUrl(tab.url) });
    if (trust?.trusted !== true || trust.origin !== origin) throw fault('worker.appDidNotApproveSite');
  } catch (error) {
    // Nothing stays half on: without the app's approval, Chrome access goes back too.
    await dropAccess([origin]);
    throw error;
  }
  const script = siteScript(origin);
  if ((await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] })).length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
  // The registration covers later loads; the page already open gets the scripts now.
  if (siteOrigin((await chrome.tabs.get(tabId)).url) === origin) await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: script.js });
  return { enabled: true, origin };
}

// Only Chrome's absent-receiver error means the top content script is missing.
// A closed port or malformed response is a real failure, not a readiness signal.
const NO_RECEIVER = Object.freeze(['Could not establish connection. Receiving end does not exist.', 'Receiving end does not exist.']);
async function topSiteMessage(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }); }
  catch (error) {
    if (NO_RECEIVER.includes(error.message)) {
      const missing = fault('worker.reloadThenAutofill');
      missing.code = 'site-not-ready';
      throw missing;
    }
    throw error;
  }
}

async function siteReadiness(tab, origin) {
  if (tab.status === 'loading') return { frames: [], ready: false };
  try { return { frames: await siteFrames(tab.id, origin), ready: true }; }
  catch (error) {
    if (error.code === 'site-not-ready') return { frames: [], ready: false };
    throw error;
  }
}

// Discover embedded origins through the approved top document, without reaching
// into an iframe before Chrome and the desktop have approved its origin.
async function siteFrames(tabId, origin) {
  const reply = await topSiteMessage(tabId, { type: 'secondhand:generic:frames' });
  if (!reply || !Array.isArray(reply.origins) || reply.origins.some(value => typeof value !== 'string')) throw fault(FRAME_ERROR);
  const origins = [...new Set(reply.origins.map(siteOrigin).filter(value => value && value !== origin))];
  return Promise.all(origins.map(async origin => ({ origin, enabled: await siteEnabled(origin) })));
}

// Chrome access to sites SecondHand no longer uses. Under Chrome's kept grant for every https site
// there is nothing narrower to take back, and they stay off by having no script and no trust.
async function dropAccess(origins) {
  if (!origins.length || await chrome.permissions.contains({ origins: [...ALL_SITES] })) return;
  const patterns = origins.map(origin => `${origin}/*`);
  const removed = await chrome.permissions.remove({ origins: patterns });
  const kept = await Promise.all(patterns.map(origin => chrome.permissions.contains({ origins: [origin] })));
  if (!removed || kept.some(Boolean)) throw fault('worker.chromeKeptAccess');
}
// The app stops trusting sites SecondHand turned off. It needs no unlock: it only takes access away.
async function untrustSites(origins) {
  for (const origin of origins) {
    let reply;
    try { reply = await nativeRequest('untrustSite', { url: origin }); }
    catch (error) { throw Object.assign(fault('worker.siteStillTrustedInApp'), { cause: error }); }
    if (reply?.trusted !== false || reply.origin !== origin) throw fault('worker.desktopUnexpected');
  }
}
// Sites SecondHand no longer uses lose Chrome access and the app's trust. Both are tried, so one
// failing doesn't leave the other on, and the first failure is reported.
async function forgetSites(origins) {
  let failure = null;
  try { await dropAccess(origins); } catch (error) { failure = error; }
  try { await untrustSites(origins); } catch (error) { failure ||= error; }
  if (failure) throw failure;
}

// Sites Chrome took back (#142): the person removed SecondHand's access in Chrome's settings, or Chrome did. Each
// site or embedded form SecondHand had on that Chrome no longer allows is turned off as Turn off does, but the app
// stops trusting it first: its registration stays until then, as the reminder that the app hasn't heard. Without
// Chrome's access a registration runs nothing, so the site is off at once. Chrome's event starts this, and every
// desktop status tries again before anything else is asked. Changes that come while it runs get another pass.
let revoking = null;
let revokedAgain = false;
function forgetRevoked() {
  if (revoking) { revokedAgain = true; return revoking; }
  revoking = (async () => { do { revokedAgain = false; await forgetRevokedOnce(); } while (revokedAgain); })().finally(() => { revoking = null; });
  return revoking;
}
async function forgetRevokedOnce() {
  if ((await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] })).length && !(await chrome.permissions.contains({ origins: [...ALL_SITES] }))) {
    const reply = await nativeRequest('untrustAllSites');
    if (reply?.allSites !== false) throw fault('worker.desktopUnexpected');
    await removeAllSites();
  }
  const scripts = (await chrome.scripting.getRegisteredContentScripts()).filter(script => script.id !== ALL_SITES_ID && /^(site|frame)-/.test(script.id));
  const originsOf = script => script.matches.map(pattern => siteOrigin(pattern.slice(0, -2))).filter(Boolean);
  const revoked = [];
  for (const origin of new Set(scripts.flatMap(originsOf))) if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) revoked.push(origin);
  if (!revoked.length) return;
  // A revoked site's own script and the embedded forms it turned on, and any registration for a revoked embedded form.
  const owned = scripts.filter(script => originsOf(script).some(origin => revoked.includes(origin)) || revoked.some(origin => script.id.startsWith(frameScriptPrefix(origin))));
  const remaining = scripts.filter(script => !owned.includes(script));
  // Its embedded forms no other site uses go too, as when the site is turned off.
  const orphans = [...new Set(owned.flatMap(originsOf))].filter(origin => !revoked.includes(origin) && !remaining.some(script => script.matches.includes(`${origin}/*`)));
  await untrustSites([...revoked, ...orphans]);
  await chrome.scripting.unregisterContentScripts({ ids: owned.map(script => script.id) });
  for (const origin of revoked) {
    for (const [tabId, kept] of savables) if (kept.origin === origin) savables.delete(tabId);
    for (const [tabId, kept] of rememberables) if (kept.origin === origin) rememberables.delete(tabId);
    for (const [tabId, kept] of heldDetails) if (kept.origin === origin) heldDetails.delete(tabId);
    for (const [tabId, stored] of sitePlans) if (siteOrigin(stored.url) === origin) sitePlans.delete(tabId);
    for (const tabId of [...pageReads.keys()]) forgetReads(tabId, entry => siteOrigin(entry.url) === origin);
  }
  await dropAccess(orphans);
}
// Without the app, the sites wait for the next status. Anything else is a real failure, left for Chrome to report.
const appClosed = error => error?.code === 'offline' || error?.cause?.code === 'offline';

async function enableFrames(tabId) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  const pending = (await siteFrames(tabId, origin)).filter(frame => !frame.enabled).map(frame => frame.origin);
  for (const frameOrigin of pending) {
    if (!(await chrome.permissions.contains({ origins: [`${frameOrigin}/*`] }))) throw fault('worker.chromeNotAllowedFrames');
  }
  // Obtain every approval before registering any of the new scripts.
  const approved = [];
  try {
    for (const frameOrigin of pending) {
      const trust = await nativeRequest('trustSite', { url: frameOrigin });
      if (trust?.trusted !== true || trust.origin !== frameOrigin) throw fault('worker.appDidNotApproveFrames');
      approved.push(frameOrigin);
    }
    const current = await chrome.tabs.get(tabId);
    if (current.url !== tab.url || !current.active) throw fault('worker.pageChangedTryAgain');
  } catch (error) {
    // Nothing stays half on: Chrome access goes back, and the app forgets the forms it approved.
    await dropAccess(pending.filter(frameOrigin => !approved.includes(frameOrigin)));
    await forgetSites(approved);
    throw error;
  }
  for (const frameOrigin of pending) {
    const script = frameScript(origin, frameOrigin);
    if ((await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] })).length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  }
  if (pending.length) await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: siteScript(origin).js });
  return { enabled: true, origin };
}

async function disableSite(tabId) {
  sitePilots.delete(tabId);
  const { origin } = await activeSite(tabId);
  // All websites covers every site; one can't be turned off inside it.
  if (await allSitesOn()) throw fault('worker.allSitesCoverSite');
  // Registrations survive worker/extension restarts and identify which frames
  // this site enabled, even when no content script can answer in the open tab.
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const owned = scripts.filter(script => script.id === siteScript(origin).id || script.id.startsWith(frameScriptPrefix(origin)));
  if (owned.length) await chrome.scripting.unregisterContentScripts({ ids: owned.map(script => script.id) });
  results.delete(tabId);
  sitePlans.delete(tabId);
  heldDetails.delete(tabId);
  forgetReads(tabId, entry => siteOrigin(entry.url) === origin);
  // The site and the embedded forms no other site uses are forgotten.
  const remaining = await chrome.scripting.getRegisteredContentScripts();
  const frameOrigins = owned.flatMap(script => script.matches.map(pattern => siteOrigin(pattern.slice(0, -2)))).filter(Boolean);
  await forgetSites([...new Set([origin, ...frameOrigins])].filter(value => !remaining.some(script => script.matches.includes(`${value}/*`))));
  return { enabled: false, origin };
}

const joined = (first, second) => ({ key: 'joined', params: { first, second } });
const messageOf = error => error?.messageKey ? { key: error.messageKey, params: error.messageParams || {} } : { key: 'detail', params: { detail: String(error?.message || '').slice(0, 240) } };
// While Chrome still holds its unused grant for every https site, a message about all websites says so
// and how to remove it in Chrome's settings.
async function withChromeGrant(message) {
  return await chrome.permissions.contains({ origins: [...ALL_SITES] }) ? joined(message, { key: 'worker.chromeStillAllows', params: {} }) : message;
}

async function enableAllSites(tabId) {
  // The side panel asks Chrome inside the user's click; the worker only confirms it happened.
  if (!(await chrome.permissions.contains({ origins: [...ALL_SITES] }))) throw fault('worker.chromeNotAllowedAllSites');
  try {
    const trust = await nativeRequest('trustAllSites');
    if (trust?.allSites !== true) throw fault('worker.appDidNotApproveAllSites');
  } catch (error) {
    // Nothing is registered and the app trusts nothing new. Chrome's grant stays, unused.
    const declined = { key: 'worker.appDidNotApproveAllSites', params: {} };
    const { key, params } = await withChromeGrant(error.messageKey === declined.key ? declined : joined(declined, messageOf(error)));
    throw Object.assign(fault(key, params), { cause: error });
  }
  const script = allSitesScript();
  if ((await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] })).length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
  // The registration covers later loads; the page already open gets the scripts now.
  if (Number.isInteger(tabId) && siteOrigin((await chrome.tabs.get(tabId)).url)) await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: script.js });
  return { enabled: true, ...say('worker.allSitesOn') };
}

// Turns all websites off in Chrome: the registration, and the card on open pages that are no longer on.
// Sites turned on one at a time keep theirs. Chrome's grant is left as it is (see ALL_SITES).
async function removeAllSites() {
  if ((await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] })).length) await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_ID] });
  for (const tab of await chrome.tabs.query({})) {
    const origin = siteOrigin(tab.url);
    if (!origin || await siteEnabled(origin)) continue;
    formFrames.delete(tab.id);
    formChecks.delete(tab.id);
    // Every frame of the page drops SecondHand: the top one its card, embedded ones their reports.
    try { await chrome.tabs.sendMessage(tab.id, { type: 'secondhand:generic:off' }); }
    catch (error) { if (!NO_RECEIVER.includes(error.message)) throw error; }
  }
}

async function disableAllSites() {
  sitePilots.clear();
  await removeAllSites();
  try {
    const reply = await nativeRequest('untrustAllSites');
    if (reply?.allSites !== false) throw fault('worker.desktopUnexpected');
  } catch (error) {
    // Chrome's side is off either way; the app keeps its setting until it hears.
    const { key, params } = await withChromeGrant({ key: 'worker.allSitesStillOnInApp', params: {} });
    throw Object.assign(fault(key, params), { cause: error });
  }
  const { key, params } = await withChromeGrant({ key: 'worker.allSitesOff', params: {} });
  return { enabled: false, ...say(key, params) };
}

// The desktop's status. When the app no longer allows all websites (turned off there, or an app from
// before it), SecondHand turns them off in Chrome too, before anything else is asked. So the app hears of
// sites Chrome took back while it was closed (#142).
async function desktopStatus() {
  const status = await nativeRequest('status');
  if (status?.allSites !== true && (await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] })).length) await removeAllSites();
  await forgetRevoked();
  await noteUpdate(status?.extension);
  return status;
}

// Updating itself (#85). Each status says which extension build the app ships and whether the copy it
// prepared for Chrome has it. When that build is newer than this one, SecondHand reloads once nothing is
// under way, and only if the files Chrome would load on a reload are that build: a copy that didn't
// change is never reloaded again. Otherwise the side panel shows the steps to update by hand.
const BUILD_FORMAT = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/;
const COPY_STATES = Object.freeze(['ready', 'failed', 'absent']);
// { build, state }: 'due' (reload when nothing is under way), 'failed' (the app couldn't refresh its
// copy), or 'elsewhere' (Chrome runs files the app doesn't update). Null when there is no newer build.
let selfUpdate = null;
// Clicks under way: every request a click sends carries confirmed.
let clicksUnderway = 0;
// Dates, then the number after the dot, as numbers: 2026-10-03.10 is newer than 2026-10-03.9.
function newerBuild(candidate, running) {
  const [next, current] = [candidate, running].map(build => BUILD_FORMAT.exec(build).slice(1).map(Number));
  const at = next.findIndex((part, index) => part !== current[index]);
  return at >= 0 && next[at] > current[at];
}
// The build in the files Chrome would load on a reload, read from disk; null when they can't be read
// (the folder was moved or deleted), so SecondHand doesn't reload from it.
async function diskBuild() {
  let source;
  try { source = await (await fetch(chrome.runtime.getURL('background.js'), { cache: 'no-store' })).text(); }
  catch { return null; }
  return /^const BUILD = '([^']+)';$/m.exec(source)?.[1] ?? null;
}
async function noteUpdate(shipped) {
  // An app from before #85 says nothing about the extension.
  if (shipped === undefined) { selfUpdate = null; return; }
  if (!shipped || typeof shipped !== 'object' || !BUILD_FORMAT.test(shipped.build) || !COPY_STATES.includes(shipped.copy)) throw fault('worker.desktopUnexpected');
  if (!newerBuild(shipped.build, BUILD)) { selfUpdate = null; return; }
  selfUpdate = { build: shipped.build, state: shipped.copy === 'failed' ? 'failed' : await diskBuild() === shipped.build ? 'due' : 'elsewhere' };
}
// Nothing under way: no click, no Autofill left on, no site fill, and no plan waiting for its fill.
// Approval prompts belong to a click or a fill. Nor anything the applicant is still working through (#142):
// a reload would wipe a tab's need-you list, Save offers and held details, and they last until the tab moves on or closes.
const showsNeedYou = result => ['done', 'waiting'].includes(result?.state) && Array.isArray(result.needYou) && result.needYou.length > 0;
// Laya's best guesses wait for the applicant to check them too (#185).
const showsLayaGuesses = result => Array.isArray(result?.layaGuesses) && result.layaGuesses.length > 0;
function reloadWhenIdle() {
  if (selfUpdate?.state !== 'due' || clicksUnderway || autopilots.size || sitePilots.size || siteRuns.size || sitePlans.size || savables.size || rememberables.size || heldDetails.size ||
    [...results.values()].some(result => showsNeedYou(result) || showsLayaGuesses(result))) return;
  selfUpdate = null;
  chrome.runtime.reload();
}

// tabId -> ids of embedded frames whose page has a form SecondHand can help with, so the top page shows
// its card for a form inside an iframe. Yes or no only; never what a form asks. Memory only: a tab is here from
// its page load, and after Chrome restarts the worker it isn't until the worker asks the tab's frames (#157).
const formFrames = new Map();
// tabId -> the worker asking the tab's frames. Reports that come meanwhile wait for its one answer.
const formChecks = new Map();
// Each embedded frame Chrome places on a site that is on says whether its page has a form. One without
// SecondHand's script yet reports when it loads, and one SecondHand was turned off for answers nothing.
async function askFormFrames(tabId, top) {
  const frames = new Set();
  for (const frame of await enabledSiteFrames(tabId, top)) {
    if (frame.frameId === 0) continue;
    let reply;
    try { reply = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:helps' }, frameTarget(frame.frameId, frame.documentId)); }
    catch (error) { if (NO_RECEIVER.includes(error.message)) continue; throw error; }
    if (reply === undefined) continue;
    if (typeof reply?.helps !== 'boolean') throw fault(FRAME_ERROR);
    if (reply.helps) frames.add(frame.frameId);
  }
  return frames;
}
// Whether the answer still holds: false when the tab loaded another page, closed, or was turned off meanwhile.
function knowFormFrames(tabId, top) {
  if (!formChecks.has(tabId)) {
    const check = askFormFrames(tabId, top).then(frames => {
      const current = formChecks.get(tabId) === check;
      if (current) { formFrames.set(tabId, frames); formChecks.delete(tabId); }
      return current;
    }, error => {
      if (formChecks.get(tabId) === check) formChecks.delete(tabId);
      throw error;
    });
    formChecks.set(tabId, check);
  }
  return formChecks.get(tabId);
}
async function formReport(sender, helps) {
  const tabId = sender.tab.id;
  const top = siteOrigin(sender.tab.url), own = siteOrigin(sender.url);
  if (!top || !own || !(await siteEnabled(top)) || !(await siteEnabled(own))) return undefined;
  // The top page's card may be out of date for a tab the worker had to ask about: it is told either way.
  const asked = !formFrames.has(tabId);
  // A report that waited while the page moved on was the old page's.
  if (asked && !(await knowFormFrames(tabId, top))) return { frames: false };
  const frames = formFrames.get(tabId);
  const before = frames.size > 0;
  if (sender.frameId > 0) { if (helps) frames.add(sender.frameId); else frames.delete(sender.frameId); }
  const now = frames.size > 0;
  if (sender.frameId > 0 && (now !== before || asked)) {
    // A top page that hasn't loaded yet asks when it does.
    try { await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:formFrames', helps: now }, { frameId: 0 }); }
    catch (error) { if (!NO_RECEIVER.includes(error.message)) throw error; }
  }
  return { frames: now };
}

// Where each frame is, as Chrome says (#137). The worker has every frame it can reach send it one message, and
// Chrome gives each message's sender: the frame, its document, and its address. Nothing a page says about itself
// places a frame. nonce -> { tabId, heard: Map(frameId -> { documentId, url }) }
const frameChecks = new Map();
// Runs in each frame, so Chrome serializes it and it must stand alone.
function announceFrame(nonce) { return chrome.runtime.sendMessage({ type: 'secondhand:frame', nonce }); }
function frameHeard(nonce, sender) {
  const check = frameChecks.get(nonce);
  if (!check || check.tabId !== sender.tab.id || check.heard.has(sender.frameId)) return false;
  check.heard.set(sender.frameId, { documentId: sender.documentId, url: sender.url });
  return true;
}
// Chrome supplies frame ids only after access has been granted. Never message an origin just because it
// appeared in the top document. Each frame that is on, with the document and address Chrome gave for it.
async function enabledSiteFrames(tabId, origin) {
  const nonce = crypto.randomUUID();
  const heard = new Map();
  frameChecks.set(nonce, { tabId, heard });
  let frames;
  try { frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: announceFrame, args: [nonce] }); }
  finally { frameChecks.delete(nonce); }
  if (!Array.isArray(frames)) throw fault(FRAME_ERROR);
  const placed = frames.map(frame => {
    const where = heard.get(frame.frameId);
    // A frame Chrome reached but didn't place is never written to.
    if (!Number.isInteger(frame.frameId) || frame.frameId < 0 || frame.frameId > 999999 || typeof frame.documentId !== 'string' || where?.documentId !== frame.documentId) throw fault(FRAME_ERROR);
    return { frameId: frame.frameId, documentId: frame.documentId, url: where.url, origin: siteOrigin(where.url) };
  });
  if (!placed.some(frame => frame.frameId === 0 && frame.origin === origin)) throw fault(FRAME_ERROR);
  const enabled = [];
  for (const frame of placed) if (frame.origin && await siteEnabled(frame.origin)) enabled.push(frame);
  return enabled;
}

const siteResult = (state, message, extra = {}) => ({ state, filled: 0, guessed: 0, needYou: [], ...message, pageKey: 'general', ...extra });
// A result's count of Laya's best guesses on screen, and each one's id and label for the side panel to list (#185). Nothing when there are none.
const layaGuessResult = (count, list) => count || list.length ? { layaGuessed: count, layaGuesses: list } : {};
const filledSummary = (filled, needYou) => needYou.length ? { key: 'result.filledNeedYou', params: { count: filled, needYou: needYou.length } } : { key: 'result.filled', params: { count: filled } };

// Runs in the page, so Chrome serializes it and it must stand alone. Counts the questions
// SecondHand filled (the site engine marks them) that are on screen now: a multi-page form
// hides its other pages. Also reports whether the page shows a Next button. Counts only.
function tallyPage() {
  const query = selector => {
    const found = [], roots = [document];
    for (let index = 0; index < roots.length; index++) {
      found.push(...roots[index].querySelectorAll(selector));
      for (const node of roots[index].querySelectorAll('*')) if (node.shadowRoot?.mode === 'open') roots.push(node.shadowRoot);
    }
    return found;
  };
  const shown = element => {
    for (let node = element; node; node = node.parentElement || node.getRootNode()?.host) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const counted = new Set();
  // Laya's best guesses (#185) are counted apart from the other guesses.
  const tally = { rule: 0, guess: 0, layaGuess: 0, next: false };
  for (const element of query('[data-secondhand-filled]')) {
    if (!shown(element)) continue;
    // A radio or checkbox group is one question, marked on every option, native or div-based (Google Forms).
    const group = ['radio', 'checkbox'].includes(element.getAttribute('role')) ? element.closest('[role="radiogroup"], [role="group"], [role="list"]') : null;
    const question = ['radio', 'checkbox'].includes(element.type) && element.name
      ? `${element.type}|${element.form ? Array.from(document.forms).indexOf(element.form) : -1}|${element.name}` : group || element;
    if (counted.has(question)) continue;
    counted.add(question);
    const kind = element.getAttribute('data-secondhand-filled');
    if (kind === 'guess') tally.guess++; else if (kind === 'laya-guess') tally.layaGuess++; else tally.rule++;
  }
  tally.next = query('button, input[type="button"], input[type="submit"], [role="button"]')
    .some(control => shown(control) && /^next\b/i.test((control.textContent || control.value || '').trim()));
  return tally;
}
async function tallySite(tabId, frames) {
  try {
    const frameIds = frames.map(frame => frame.frameId);
    const injections = await chrome.scripting.executeScript({ target: { tabId, frameIds }, func: tallyPage });
    if (!Array.isArray(injections) || injections.length !== frameIds.length || new Set(injections.map(item => item.frameId)).size !== frameIds.length) throw fault(FRAME_ERROR);
    const total = { rule: 0, guess: 0, layaGuess: 0, next: false };
    const count = value => Number.isInteger(value) && value >= 0;
    for (const { frameId, result: tally } of injections) {
      if (!frameIds.includes(frameId) || !count(tally?.rule) || !count(tally.guess) || !count(tally.layaGuess) || typeof tally.next !== 'boolean') throw fault(FRAME_ERROR);
      total.rule += tally.rule; total.guess += tally.guess; total.layaGuess += tally.layaGuess; total.next ||= tally.next;
    }
    return total;
  } catch { throw fault(FRAME_ERROR); }
}
// A summary that says when the suggestions came from Laya.
const withLaya = (summary, laya) => laya ? { key: 'result.suggestedByLaya', params: { summary } } : summary;
const withReason = (summary, reason) => reason ? { key: 'result.withReason', params: { summary, reason } } : summary;
// A summary that says how many questions wait for Fill sensitive details (#176).
const withHeld = (summary, held) => held ? { key: 'result.withHeld', params: { summary, count: held } } : summary;
// A summary that says how many answers came from the applicant's custom answers (#186).
const withCustom = (summary, custom) => custom ? { key: 'result.fromCustom', params: { summary, count: custom } } : summary;
// A summary that says how many answers are Laya's best guesses, for the applicant to check (#185).
const withLayaGuesses = (summary, layaGuessed) => layaGuessed ? { key: 'result.layaGuessed', params: { summary, count: layaGuessed } } : summary;
// A click's reasons as one, each said once.
const reasons = (...list) => list.filter((reason, index) => reason && list.findIndex(other => other?.key === reason.key) === index)
  .reduce((all, next) => all ? joined(all, next) : next, null);
// `held`: how many of the need-you questions wait for Fill sensitive details. Their saved answers matched, so a page
// with nothing else filled doesn't say that nothing matched.
// `guessed`: how many of the filled questions have the dashed mark of an AI's suggestion (or a rule's answer to check).
// The summary calls them suggested, so they can't be taken for Laya's best guesses (#189).
// `layaGuessed`: how many of the filled questions have Laya's best guess (#185). `custom`: how many came from custom answers (#186).
function siteSummary(filled, guessed, needYou, next, laya, reason = null, held = 0, layaGuessed = 0, custom = 0) {
  let summary;
  if (filled) {
    const key = guessed ? (needYou.length ? 'result.siteFilledSuggestedNeedYou' : 'result.siteFilledSuggested') : needYou.length ? 'result.siteFilledNeedYou' : 'result.siteFilled';
    summary = { key, params: { count: filled, ...(guessed ? { suggested: guessed } : {}), ...(needYou.length ? { needYou: needYou.length } : {}) } };
  } else if (needYou.length) summary = { key: held ? 'result.siteNeedYou' : 'result.nothingMatchesNeedYou', params: { count: needYou.length } };
  else summary = { key: next ? 'result.nothingToFillNext' : 'result.nothingToFill', params: {} };
  const shown = withReason(withHeld(withLayaGuesses(withLaya(withCustom(summary, custom), laya), layaGuessed), held), reason);
  return say(shown.key, shown.params);
}

// The general engine's plan for the page: field ids, keys, and labels only.
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
// An embedded frame is messaged only in the document Chrome placed it in: once that document is gone, Chrome
// delivers nothing, so answers for one site never reach a page that has since loaded in its frame.
const frameTarget = (frameId, documentId) => documentId === undefined ? { frameId } : { frameId, documentId };
async function planGeneral(tabId, frameId = 0, prefix = false, documentId = undefined) {
  try {
    const message = { type: 'secondhand:generic:plan' };
    const plan = prefix && frameId === 0 ? await topSiteMessage(tabId, message) : await chrome.tabs.sendMessage(tabId, message, frameTarget(frameId, documentId));
    if (!plan || typeof plan.token !== 'string' || typeof plan.lang !== 'string' || !Array.isArray(plan.matched) || !Array.isArray(plan.unmatched) ||
      plan.unmatched.some(field => typeof field?.id !== 'string' || !FIELD_ID.test(field.id) || typeof field.label !== 'string' || typeof field.type !== 'string' ||
        !strings(field.options) || typeof field.required !== 'boolean')) throw fault('worker.pageCheckUnsafe');
    if (prefix) {
      const ids = [...plan.matched, ...plan.unmatched].map(field => field?.id);
      if (!plan.token || ids.some(id => typeof id !== 'string' || !FIELD_ID.test(id)) || new Set(ids).size !== ids.length ||
        plan.matched.some(field => !plannedKey(field.key) || (field.label !== undefined && typeof field.label !== 'string') || (field.partial !== undefined && field.partial !== true))) throw fault(FRAME_ERROR);
    }
    return plan;
  } catch (error) {
    if (!prefix || error.code === 'site-not-ready') throw error;
    throw fault(FRAME_ERROR);
  }
}
// A question the rules answered in part (#184) still needs the applicant, and is never filled again.
const ruleAssignments = plan => plan.matched.filter(field => !field.partial).map(field => ({ id: field.id, key: field.key, guessed: false }));

// Chrome's on-device AI runs only in extension pages, so the widget asks for the questions
// the rules left open and sends back its guesses with Autofill. Labels and options only.
// Each frame keeps its own address, the one its answers are asked for in: the tab's for the top frame.
async function siteFramePlans(tabId, url, stopForPending = false) {
  try {
    const origin = siteOrigin(url);
    const embedded = await siteFrames(tabId, origin);
    const top = { frameId: 0, url, plan: await planGeneral(tabId, 0, true) };
    const pending = embedded.filter(frame => !frame.enabled);
    if (stopForPending && !top.plan.matched.length && !top.plan.unmatched.length && pending.length) return { frames: [top], pending };
    const enabled = await enabledSiteFrames(tabId, origin);
    const frames = [top, ...await Promise.all(enabled.filter(frame => frame.frameId !== 0).map(async ({ frameId, documentId, url: frameUrl }) =>
      ({ frameId, documentId, url: frameUrl, plan: await planGeneral(tabId, frameId, true, documentId) })))];
    return { frames, pending };
  } catch (error) {
    if (error.code === 'site-not-ready') throw error;
    throw fault(FRAME_ERROR);
  }
}
async function planSite(tabId) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  // A new plan for the page: questions the last click held back go with the last plan (#176).
  heldDetails.delete(tabId);
  const { frames } = await siteFramePlans(tabId, tab.url);
  // Whether Laya will answer this click's open questions. When it will, the widget leaves Chrome's AI off.
  const { boxes, choices } = layaQuestions(frames, true);
  const laya = boxes.length || choices.length ? await layaReady() : null;
  sitePlans.set(tabId, { url: tab.url, frames, laya });
  return { unmatched: frames.flatMap(({ frameId, plan }) => plan.unmatched.filter(guessable).map(({ id, label, type, options, required }) => ({ id: `f${frameId}:${id}`, label, type, options, required }))),
    allowedKeys: AI_KEYS, laya: laya === true };
}
// Chrome's AI never sees a question only the applicant answers (consent, signatures, codes, security
// questions, user names, SSN…), so a guess for one names a field outside what it was asked, and is refused.
const guessable = field => !SecondHandGeneric.unsafeQuestion(field);
// Guesses name fields of the plan the AI saw; a fresh plan would give the fields other ids.
function guessAssignments(stored, url, guesses) {
  if (stored?.url !== url) throw fault('worker.pageChangedAutofill');
  const open = new Set(stored.frames.flatMap(({ frameId, plan }) => plan.unmatched.filter(guessable).map(field => `f${frameId}:${field.id}`)));
  const entries = plainEntries(guesses);
  // With Laya ready the widget never runs Chrome's AI, so it has no guesses to send.
  if (!entries || (stored.laya === true && entries.length) || entries.some(([id, key]) => !SITE_FIELD_ID.test(id) || !open.has(id) || !AI_KEYS.includes(key))) throw fault('worker.aiMatchesUnusable');
  return stored.frames.map(({ frameId, documentId, url: frameUrl, plan }) => ({ frameId, documentId, url: frameUrl, plan, planned: [...ruleAssignments(plan),
    ...entries.filter(([id]) => id.startsWith(`f${frameId}:`)).map(([id, key]) => ({ id: id.split(':')[1], key, guessed: true }))] }));
}

const plainEntries = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null;
const utf8Length = text => { let bytes = 0; for (const char of text) { const code = char.codePointAt(0); bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; } return bytes; };
const knownLayaState = state => { if (!LAYA_STATES.includes(state)) throw fault('worker.desktopUnexpected'); return state; };
// Laya's state as the desktop's status reports it. A desktop app from before Laya reports none.
const layaState = status => status?.laya === undefined ? 'unavailable' : knownLayaState(status.laya?.state);
// Whether Laya can answer in this click, once the desktop has readied its model: the first load
// after idle takes seconds, and that time must not come out of the click's Laya budget.
async function layaReady() {
  try { return knownLayaState((await nativeRequest('warmLaya'))?.state) === 'ready'; }
  catch (error) {
    if (error.code === 'offline') return false;
    throw error;
  }
}
// Chrome's Translator and LanguageDetector in this worker, for Laya's questions. It keeps one translator
// per language pair; the words it translated are forgotten after each click.
const questionTranslation = SecondHandTranslation.create(globalThis);
// The open questions Laya may see, in page order: text boxes to match and choice questions to answer.
// Questions only the applicant answers (consent, signatures, SSN…) and any past the bridge's limits stay need-you.
function layaQuestions(frames, prefix) {
  const boxes = [], choices = [];
  for (const { frameId, plan } of frames) for (const field of plan.unmatched) {
    const kind = SecondHandGeneric.layaQuestion(field);
    if (!kind) continue;
    const { label, type, options } = field;
    (kind === 'text' ? boxes : choices).push({ id: prefix ? `f${frameId}:${field.id}` : field.id, label, type, options: [...options] });
  }
  return { boxes, choices };
}
// One click's time for Laya. Only time spent waiting on Laya counts, never the applicant's time in
// an approval prompt. `use(ask)` asks with the milliseconds left, or asks nothing once they are spent.
function layaBudget() {
  let left = LAYA.budgetMs;
  return {
    async use(ask) {
      const budgetMs = Math.floor(left);
      if (budgetMs < 1) return undefined;
      const started = Date.now();
      try { return await ask(budgetMs); } finally { left -= Date.now() - started; }
    }
  };
}
// As many questions as one request may carry: the bridge's count, within the native message size.
function layaPayload(type, url, list, questions, max, budgetMs) {
  const payload = { url: safeUrl(url), [list]: [], budgetMs };
  for (const question of questions.slice(0, max)) {
    payload[list].push(question);
    // The request as nativeRequest sends it; its id is a 36-character UUID.
    if (utf8Length(JSON.stringify({ id: '0'.repeat(36), type, ...payload })) > LAYA.bytes) { payload[list].pop(); break; }
  }
  return payload;
}
// One Laya request. Null when Laya isn't ready or the desktop app is closed: the click goes on without Laya.
async function askLaya(type, payload) {
  try { return await nativeRequest(type, payload); }
  catch (error) {
    if (error.code === LAYA_NOT_READY || error.code === 'offline') return null;
    throw error;
  }
}
// [id, savedFieldKey] pairs for text boxes (#39). Any id outside the request or any key a guess may not use refuses them all.
async function layaSuggestions(url, boxes, budgetMs) {
  const payload = layaPayload('suggestFields', url, 'fields', boxes, LAYA.fields, budgetMs);
  const reply = await askLaya('suggestFields', payload);
  if (reply === null) return null;
  const sent = new Set(payload.fields.map(field => field.id));
  const entries = plainEntries(reply?.suggestions);
  if (!entries || entries.some(([id, key]) => !sent.has(id) || !AI_KEYS.includes(key))) throw fault('worker.layaUnusable');
  return entries;
}
// [id, optionText] pairs for choice questions (#42), with the access receipt they were made under, and Laya's best
// guesses (#185): [id, optionText] pairs for single-choice questions it has no sure answer for, never on Iowa's portal.
const LAYA_GUESS_TYPES = Object.freeze(['radio', 'select']);
async function layaAnswers(url, choices, budgetMs) {
  const payload = layaPayload('answerFields', url, 'questions', choices, LAYA.questions, budgetMs);
  const reply = await askLaya('answerFields', payload);
  if (reply === null) return null;
  const sent = new Map(payload.questions.map(question => [question.id, question]));
  const asked = ([id, option]) => sent.has(id) && typeof option === 'string' && sent.get(id).options.includes(option);
  const entries = plainEntries(reply?.answers);
  if (!entries || !entries.every(asked)) throw fault('worker.layaUnusable');
  // A desktop app from before #185 sends no guesses.
  const guesses = reply.guesses === undefined ? [] : plainEntries(reply.guesses);
  if (!guesses || guesses.some(entry => !asked(entry) || !LAYA_GUESS_TYPES.includes(sent.get(entry[0]).type) || Object.hasOwn(reply.answers, entry[0])) ||
    (guesses.length && SecondHandIowa.isSupportedUrl(url))) throw fault('worker.layaUnusable');
  return { entries, guesses, revision: receiptRevision(reply), reason: desktopReason(reply) };
}

// The sites a click's answers go to, in page order, each with its frames (#137). A frame's site is its own
// address as Chrome gave it (the tab's for the top frame and on Iowa's portal), never the page around it, so
// every request for a site's answers names that site and its approval covers that site's frames only.
function answerSites(frames) {
  const sites = new Map();
  for (const { frameId, url } of frames) {
    // An embedded frame without the address Chrome gave for it is never filled under another's.
    if (typeof url !== 'string') throw fault(FRAME_ERROR);
    const origin = new URL(url).origin;
    if (!sites.has(origin)) sites.set(origin, { url, frameIds: new Set(), keys: [], values: null, reason: null, held: [] });
    sites.get(origin).frameIds.add(frameId);
  }
  return [...sites.values()];
}
// The sensitive details the app held back from a site's request (#176): fields the request named, each once and with no
// answer beside it. Iowa's portal holds nothing back.
function heldBack(response, site) {
  if (response.held === undefined) return [];
  const { held } = response;
  if (SecondHandIowa.isSupportedUrl(site.url) || !Array.isArray(held) || !held.length || new Set(held).size !== held.length ||
    held.some(field => !site.keys.includes(field) || Object.hasOwn(response.values, field))) throw fault('worker.desktopUnexpected');
  return held;
}

// One fill message to the plan a frame holds, and its reply checked: every id it filled, rejected or skipped is one it was
// given. On an approved site (`prefix`), a failure other than a missing page or a page that changed is the frame's.
async function fillFrame(tabId, { frameId, documentId }, message, prefix) {
  try {
    const result = prefix && frameId === 0 ? await topSiteMessage(tabId, message) : await chrome.tabs.sendMessage(tabId, message, frameTarget(frameId, documentId));
    const assigned = new Set(message.assignments.map(item => item.id));
    const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && assigned.has(id)) && new Set(ids).size === ids.length;
    // The page changed while its choices settled: the fill starts over from a new click.
    if (result?.pageChanged === true) throw Object.assign(fault('worker.pageChangedAutofill'), { code: 'page-changed' });
    if (!result?.ok || !validIds(result.filled) || !validIds(result.rejected) || (result.skipped !== undefined && !validIds(result.skipped)) ||
      (result.partial !== undefined && (!validIds(result.partial) || result.partial.some(id => !result.filled.includes(id))))) throw fault('worker.pageUnsafe');
    return result;
  } catch (error) {
    if (!prefix || error.code === 'site-not-ready' || error.code === 'page-changed') throw error;
    throw fault(FRAME_ERROR);
  }
}

// Explicit saved custom answers take precedence over model guesses. Only unmatched question
// metadata reaches the app; it returns answers for exact saved labels/aliases, never its catalog.
// One about a sensitive subject the app holds back for Fill sensitive details (#186): the reply names its question, which
// isn't asked about again in this click, and `held` keeps each frame's held questions by their words, type and choices.
const questionOf = ({ label, type, options }) => JSON.stringify([label, type, options]);
async function fillCustomFrames(tabId, url, frames, guard) {
  const eligible = field => typeof SecondHandGeneric.canCustom === 'function' && SecondHandGeneric.canCustom(field) &&
    field.label.length <= 120 && field.options.length <= 30 && field.options.every(option => option.length <= 120);
  const held = new Map(frames.map(frame => [frame.frameId, new Set()]));
  if (!frames.some(frame => frame.plan.unmatched.some(eligible))) return { frames, filled: 0, held };
  const desktop = await desktopStatus(); guard();
  if (!desktop?.unlocked || desktop.customFieldsAvailable !== true) return { frames, filled: 0, held };
  let filled = 0;
  const updated = [];
  for (const frame of frames) {
    let plan = frame.plan, changed = false;
    const waiting = held.get(frame.frameId);
    for (let pass = 0; pass < MAX_GENERAL_PASSES; pass++) {
      const fields = [];
      const requestUrl = safeUrl(frame.url || url);
      for (const { id, label, type, options } of plan.unmatched.filter(field => eligible(field) && !waiting.has(questionOf(field)))) {
        fields.push({ id, label, type, options });
        if (utf8Length(JSON.stringify({ id: '0'.repeat(36), type: 'getCustomFields', url: requestUrl, fields })) > 48 * 1024) { fields.pop(); break; }
        if (fields.length === 40) break;
      }
      if (!fields.length) break;
      let values = null;
      try {
        const response = await nativeRequest('getCustomFields', { url: requestUrl, fields }); guard();
        const entries = plainEntries(response?.values);
        const ids = new Set(fields.map(field => field.id));
        if (!entries || entries.some(([id, value]) => !ids.has(id) || typeof value !== 'string' || !value || value.length > 1000)) throw fault('worker.desktopUnexpected');
        const heldIds = response.held === undefined ? [] : response.held;
        if (!Array.isArray(heldIds) || (response.held !== undefined && !heldIds.length) || new Set(heldIds).size !== heldIds.length ||
          heldIds.some(id => !ids.has(id) || Object.hasOwn(response.values, id))) throw fault('worker.desktopUnexpected');
        for (const id of heldIds) waiting.add(questionOf(fields.find(field => field.id === id)));
        if (!entries.length) break;
        const revision = receiptRevision(response);
        values = Object.fromEntries(entries);
        await checkAccess(revision); guard();
        const current = await activeSite(tabId); guard();
        if (current.tab.url !== url) throw fault('worker.pageChangedAutofill');
        await requireSite(siteOrigin(frame.url || url)); guard();
        const result = await fillFrame(tabId, frame, { type: 'secondhand:generic:fill', token: plan.token,
          assignments: entries.map(([id]) => ({ id, custom: true })), values }, true);
        guard();
        if (!result.filled.length) break;
        changed = true; filled += result.filled.length;
        plan = await planGeneral(tabId, frame.frameId, true, frame.documentId); guard();
        if (result.rejected.length) break;
      } finally { values = null; }
    }
    updated.push(changed ? { ...frame, plan, planned: ruleAssignments(plan) } : frame);
  }
  return { frames: updated, filled, held };
}

// Fills from a general-engine plan: for each site in the page, one desktop request for the keys planned
// first in its frames (the rules' matches and any AI guesses), then up to four fill passes so questions
// revealed by an answer are filled too. Each pass plans the page again. Never continues, submits, or navigates.
// Laya is asked unless this click already found it not ready (`laya: false`). All of its requests
// share the click's time budget (#90): every site's text boxes first, then choice questions with what is left.
// A text box's candidates are short saved-field descriptions, while a choice question's each carry the
// whole facts sheet, so the boxes take a fraction of the time and a long checklist can't starve them;
// the desktop then decides the choice questions with the fewest options first. Its text-box matches
// join each site's one request for saved values.
async function fillPlan(tabId, url, frames, { prefix = false, guard = () => {}, laya = null } = {}) {
  let revision = null;
  let sites = [];
  try {
    const custom = prefix ? await fillCustomFrames(tabId, url, frames, guard) : { frames, filled: 0, held: new Map() };
    guard();
    // A question whose custom answer the app holds back waits for Fill sensitive details: no AI guesses it (#186).
    const waitsForCustom = (frameId, field) => Boolean(custom.held.get(frameId)?.has(questionOf(field)));
    const initial = custom.frames.map(frame => {
      const planned = frame.planned || ruleAssignments(frame.plan);
      const waiting = new Set(frame.plan.unmatched.filter(field => waitsForCustom(frame.frameId, field)).map(field => field.id));
      return { ...frame, url: frame.frameId === 0 ? url : frame.url, planned: planned.filter(item => !waiting.has(item.id)) };
    });
    sites = answerSites(initial);
    const siteOf = frameId => sites.find(site => site.frameIds.has(frameId));
    const place = id => prefix ? [Number(id.slice(1, id.indexOf(':'))), id.slice(id.indexOf(':') + 1)] : [0, id];
    const forLaya = list => list.map(frame => ({ ...frame, plan: { ...frame.plan, unmatched: frame.plan.unmatched.filter(field => !waitsForCustom(frame.frameId, field)) } }));
    const open = laya === false ? { boxes: [], choices: [] } : layaQuestions(forLaya(initial), prefix);
    // Laya's sure answers and matches, and apart from them its best guesses (#185).
    const fromLaya = new Set(), fromLayaGuess = new Set();
    const addLaya = (id, answer) => {
      const [frameId, own] = place(id);
      const frame = initial.find(candidate => candidate.frameId === frameId);
      frame.planned = [...frame.planned, { id: own, ...answer, guessed: true }];
      (answer.layaGuess ? fromLayaGuess : fromLaya).add(`${frameId}|${own}`);
    };
    // Every receipt in a click must agree: an Always allow in a later prompt outdates the earlier ones,
    // and outdated answers are never filled.
    const receipt = value => {
      if (revision !== null && value !== revision) throw fault('worker.accessChanged');
      revision = value;
    };
    // Once Laya says it isn't ready, it isn't asked again in this click. Unless the widget's plan
    // already readied it, it is readied now, before the click's budget starts.
    let layaOn = laya !== false;
    if (laya === null && (open.boxes.length || open.choices.length)) {
      layaOn = await layaReady();
      guard();
    }
    // Laya reads English: each frame's questions in another language are translated by Chrome on this
    // computer first, and those it can't read stay with the applicant, with the reason (#84). A translated
    // question then meets Laya's question rule as a written one does (an English SSN question, or one too
    // long, stays with the applicant).
    const english = layaOn && (open.boxes.length || open.choices.length)
      ? await questionTranslation.forLaya(forLaya(initial).map(frame => ({ ...layaQuestions([frame], prefix), declared: languageTag(frame.plan.lang) })))
      : { boxes: [], choices: [], mapAnswers: entries => entries, reason: null };
    guard();
    const prepared = { ...english, boxes: english.boxes.filter(box => SecondHandGeneric.layaQuestion(box) === 'text'),
      choices: english.choices.filter(question => SecondHandGeneric.layaQuestion(question) === 'choice') };
    const onSite = (site, questions) => questions.filter(question => site.frameIds.has(place(question.id)[0]));
    const budget = layaBudget();
    // null: Laya isn't ready; undefined: the budget was spent before this request.
    if (layaOn) for (const site of sites) {
      const boxes = onSite(site, prepared.boxes);
      if (!boxes.length) continue;
      const suggestions = await budget.use(budgetMs => layaSuggestions(site.url, boxes, budgetMs));
      guard();
      if (suggestions === null) { layaOn = false; break; }
      if (suggestions) for (const [id, key] of suggestions) addLaya(id, { key });
    }
    const answers = [];
    if (layaOn) for (const site of sites) {
      const choices = onSite(site, prepared.choices);
      if (!choices.length) continue;
      const reply = await budget.use(budgetMs => layaAnswers(site.url, choices, budgetMs));
      guard();
      if (reply === null) break;
      if (reply) answers.push(reply);
    }
    for (const site of sites) {
      site.keys = [...new Set(SecondHandGeneric.requestKeys(initial.filter(frame => site.frameIds.has(frame.frameId))
        .flatMap(frame => frame.planned.filter(item => item.key !== undefined).map(item => item.key))))];
      if (site.keys.some(key => !plannedKey(key))) throw fault('worker.fieldRequestFailed');
    }
    let unlocked = false;
    for (const site of sites) {
      if (!site.keys.length) continue;
      if (!unlocked) {
        const desktop = await desktopStatus();
        if (!desktop?.unlocked) throw fault('worker.unlockToAutofill');
        unlocked = true;
      }
      const response = await nativeRequest('getFields', { url: safeUrl(site.url), fields: site.keys });
      if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw fault('worker.noProfileFields');
      guard();
      receipt(receiptRevision(response));
      site.reason = desktopReason(response);
      site.held = heldBack(response, site);
      site.values = SecondHandGeneric.deriveValues(response.values);
    }
    // The answers came before getFields: an Always allow in its prompt outdates their receipt.
    // Without answers to fill, their receipt doesn't matter.
    for (const reply of answers) {
      if (!reply.entries.length && !reply.guesses.length) continue;
      receipt(reply.revision);
      for (const [id, option] of prepared.mapAnswers(reply.entries)) addLaya(id, { option });
      for (const [id, option] of prepared.mapAnswers(reply.guesses)) addLaya(id, { option, layaGuess: true });
    }
    let filled = custom.filled, placedByLaya = 0;
    // The questions Laya's best guesses went to, each with its own words, for the side panel to list (#185).
    // `rememberable`: the open questions the side panel may offer to remember (#186).
    const needYou = [], savable = [], held = [], layaGuesses = [], rememberable = [];
    for (const frame of initial) {
      const { frameId, documentId } = frame;
      // A frame gets only its own site's saved values.
      const { url: siteUrl, keys, values, held: heldFields } = siteOf(frameId);
      let { plan, planned } = frame;
      const refused = new Map(); // Refused answers stay local to this frame.
      if (revision !== null) for (let pass = 1; ; pass++) {
        // Laya's answers are the question's own option text; everything else is a saved value.
        const assignments = planned.filter(item => item.option !== undefined || (values && !refused.has(item.key) && typeof values[item.key] === 'string' && values[item.key]));
        if (!assignments.length) break;
        guard();
        await checkAccess(revision);
        guard();
        const current = await chrome.tabs.get(tabId);
        guard();
        if (current.url !== url || !current.active) throw fault('worker.pageChangedAutofill');
        const placing = Object.fromEntries(assignments.filter(item => item.key !== undefined).map(({ key }) => [key, values[key]]));
        const result = await fillFrame(tabId, frame, { type: 'secondhand:generic:fill', token: plan.token, assignments, values: placing }, prefix);
        for (const { id, key } of assignments) if (result.rejected.includes(id)) refused.set(key ?? `option:${id}`, id);
        const placed = assignments.filter(({ id }) => result.filled.includes(id) && !result.rejected.includes(id));
        if (!placed.length) break;
        filled += placed.length;
        placedByLaya += placed.filter(({ id }) => fromLaya.has(`${frameId}|${id}`)).length;
        for (const { id } of placed.filter(item => fromLayaGuess.has(`${frameId}|${item.id}`))) {
          const label = frame.plan.unmatched.find(field => field.id === id).label;
          layaGuesses.push({ id: prefix ? `f${frameId}:${id}` : id, label: label.trim().slice(0, LABEL_LIMIT) });
        }
        plan = await planGeneral(tabId, frameId, prefix, documentId);
        planned = ruleAssignments(plan);
        if (pass === MAX_GENERAL_PASSES) break;
      }
      const missing = [...plan.unmatched, ...plan.matched].map(field => field.id);
      for (const [key, id] of refused) if (!missing.includes(id) && !plan.matched.some(field => field.key === key)) missing.push(id);
      needYou.push(...missing.map(id => prefix ? `f${frameId}:${id}` : id));
      // A question the side panel lists, in the plan the click left on the page.
      const kept = field => ({ id: prefix ? `f${frameId}:${field.id}` : field.id, frameId, documentId, planId: field.id, token: plan.token, key: field.key,
        label: typeof field.label === 'string' ? field.label.trim().slice(0, LABEL_LIMIT) : '' });
      // Questions the rules matched to a saved field whose answer the app held back (#176): they wait for Fill sensitive
      // details, each with the held fields it needs.
      const waiting = new Set();
      for (const field of plan.matched.filter(field => !field.partial)) {
        const fields = SecondHandGeneric.requestKeys([field.key]).filter(key => heldFields.includes(key));
        if (!fields.length) continue;
        waiting.add(field.id);
        held.push({ ...kept(field), url: siteUrl, fields });
      }
      // Questions the rules matched to a saved field with no saved answer: the side panel offers to save the applicant's own (#98).
      for (const field of plan.matched) {
        if (waiting.has(field.id) || !SecondHandGeneric.SAVE_KEYS.includes(field.key) || !keys.includes(field.key) || (typeof values?.[field.key] === 'string' && values[field.key])) continue;
        savable.push(kept(field));
      }
      // Open questions whose custom answer the app held back (#186): they wait for Fill sensitive details, each with its question.
      // The others a custom answer may fill: the side panel offers to remember the applicant's own answer.
      for (const field of prefix ? plan.unmatched : []) {
        const question = { label: field.label, type: field.type, options: [...field.options] };
        if (waitsForCustom(frameId, field)) held.push({ ...kept(field), url: siteUrl, question });
        else if (SecondHandGeneric.canRemember(field)) rememberable.push({ ...kept(field), url: siteUrl, question, timeBound: SecondHandGeneric.timeBound(field) });
      }
    }
    // Why the desktop left answers out, from every site's replies, each reason said once.
    return { filled, needYou, savable, held, rememberable, custom: custom.filled, laya: placedByLaya, layaGuesses, reason: reasons(prepared.reason, ...answers.map(reply => reply.reason), ...sites.map(site => site.reason)) };
  } finally {
    for (const site of sites) site.values = null;
    questionTranslation.forget();
  }
}

// One click on an approved site, with the plan the AI saw when the widget sends guesses.
async function fillSiteOnce(tabId, url, guesses, { guard = () => {}, automatic = false } = {}) {
  try {
    const stored = sitePlans.get(tabId);
    sitePlans.delete(tabId);
    // The click plans the page again: questions the last one held back go with the last plan.
    heldDetails.delete(tabId);
    let frames, pending, laya;
    if (guesses === undefined) {
      ({ frames, pending } = await siteFramePlans(tabId, url, true));
      // The widget's plan in this click already found Laya not ready: it isn't asked again.
      laya = stored?.url === url && stored.laya === false ? false : null;
    } else {
      frames = guessAssignments(stored, url, guesses);
      laya = stored.laya;
      try {
        pending = (await siteFrames(tabId, siteOrigin(url))).filter(frame => !frame.enabled);
        // Each frame the AI saw must still hold the document it saw there.
        const enabled = await enabledSiteFrames(tabId, siteOrigin(url));
        if (frames.some(frame => !enabled.some(item => item.frameId === frame.frameId && (frame.frameId === 0 || item.documentId === frame.documentId)))) throw fault(FRAME_ERROR);
      } catch (error) {
        if (error.code === 'site-not-ready') throw error;
        throw fault(FRAME_ERROR);
      }
    }
    const top = frames.find(frame => frame.frameId === 0).plan;
    if (!top.matched.length && !top.unmatched.length && pending.length) {
      const hosts = pending.map(frame => new URL(frame.origin).hostname).join(', ');
      return siteResult('waiting', say('worker.formInsideFrames', { hosts }));
    }
    const { needYou, savable, held, rememberable, custom, laya: suggested, layaGuesses, reason } = await fillPlan(tabId, url, frames, { prefix: true, laya: automatic ? false : laya, guard });
    guard();
    keepSavable(tabId, url, siteOrigin(url), savable);
    keepHeld(tabId, url, siteOrigin(url), held, reason);
    keepRememberable(tabId, url, siteOrigin(url), rememberable);
    const tally = await tallySite(tabId, frames);
    const filled = tally.rule + tally.guess + tally.layaGuess;
    return siteResult('done', siteSummary(filled, tally.guess, needYou, tally.next, suggested, reason, held.length, tally.layaGuess, custom),
      { filled, guessed: tally.guess, needYou, ...(suggested ? { laya: suggested } : {}), ...(held.length ? { held: held.length } : {}), ...(custom ? { custom } : {}),
        ...layaGuessResult(tally.layaGuess, layaGuesses) });
  } catch (error) {
    const { state, ...message } = failed(error);
    return siteResult(state, message);
  }
}

// One fill on an Iowa page the Iowa adapter hasn't verified. Iowa's portal needs no site approval.
async function fillIowaGeneral(tabId, state, plan, guard, laya = null) {
  const { pageKey } = state.page;
  if (pageKey === 'iowa-household-screening-rules') laya = false;
  try {
    const { filled, needYou, savable, laya: suggested, reason } = await fillPlan(tabId, state.url, [{ frameId: 0, plan }], { guard, laya });
    keepSavable(tabId, state.url, '', savable);
    return { state: 'done', filled, needYou, ...say('result.thenTodo', { summary: withReason(withLaya(filledSummary(filled, needYou), suggested), reason), todo: { key: GENERAL_TODO, params: {} } }),
      todo: english(GENERAL_TODO), todoKey: GENERAL_TODO, todoParams: {}, pageKey, ...(suggested ? { laya: suggested } : {}) };
  } catch (error) {
    return { ...failed(error), filled: 0, needYou: [], pageKey };
  }
}

async function fillSite(tabId, guesses) {
  sitePilots.delete(tabId); // A one-page fill replaces any previous continuous run.
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  if (!siteRuns.has(tabId)) siteRuns.set(tabId, fillSiteOnce(tabId, tab.url, guesses).then(result => remember(tabId, result)).finally(() => siteRuns.delete(tabId)));
  return siteRuns.get(tabId);
}

const SITE_NEXT_REASONS = new Set(['ready', 'missing', 'unknown', 'review', 'protected', 'no-next', 'errors', 'changed', 'unsupported', 'frames']);
function currentSitePilot(tabId, pilot) {
  if (sitePilots.get(tabId) !== pilot) throw fault('worker.pilotStopped');
}
function stopSitePilot(tabId, pilot, result) {
  if (sitePilots.get(tabId) !== pilot) return results.get(tabId) || result;
  sitePilots.delete(tabId);
  return remember(tabId, { ...result, autoContinue: false });
}
async function siteNavigation(tabId) {
  const state = await topSiteMessage(tabId, { type: 'secondhand:generic:navigation' });
  if (!state || typeof state.canAdvance !== 'boolean' || !SITE_NEXT_REASONS.has(state.reason) || typeof state.step !== 'string' ||
    (!state.canAdvance && state.reason === 'ready') ||
    (state.canAdvance && (state.reason !== 'ready' || !state.step || typeof state.token !== 'string' || !state.token))) throw fault('worker.pageCheckUnsafe');
  return state;
}
function sitePilotStep(tabId) {
  const pilot = sitePilots.get(tabId);
  if (!pilot) return Promise.resolve(results.get(tabId) || null);
  if (pilot.running) return pilot.running;
  const guard = () => currentSitePilot(tabId, pilot);
  pilot.running = (async () => {
    let prior = results.get(tabId) || siteResult('waiting', say('worker.siteContinuing'));
    try {
      const { tab, origin } = await activeSite(tabId); guard();
      if (origin !== pilot.origin) return stopSitePilot(tabId, pilot, siteResult('stopped', say('worker.siteOriginChanged')));
      await requireSite(origin); guard();
      const before = await siteNavigation(tabId); guard();
      // The next page loaded after this step read the address, so it answered for a page this step doesn't hold. Its own
      // load event found this step running, and gets a step of its own once this one ends.
      if ((await chrome.tabs.get(tabId)).url !== tab.url) return prior;
      guard();
      if (['protected', 'review', 'errors', 'frames'].includes(before.reason)) return stopSitePilot(tabId, pilot, siteResult('waiting', say(`worker.siteNext.${before.reason}`)));
      if (pilot.awaiting && (!before.step || pilot.attempted.has(before.step))) {
        if (Date.now() - pilot.awaiting < 15000) return prior;
        return stopSitePilot(tabId, pilot, siteResult('waiting', say('worker.siteNext.changed')));
      }
      pilot.awaiting = null;
      if (++pilot.steps > MAX_STEPS) return stopSitePilot(tabId, pilot, siteResult('stopped', say('worker.stoppedAfterSteps', { steps: MAX_STEPS })));
      // This mode uses explicit saved values only. Laya/Chrome guesses remain in one-page Autofill.
      const filled = await fillSiteOnce(tabId, tab.url, undefined, { automatic: true, guard }); guard();
      if (filled.state !== 'done' || filled.guessed || filled.layaGuessed || filled.held) return stopSitePilot(tabId, pilot, filled);
      const navigation = await siteNavigation(tabId); guard();
      if (!navigation.canAdvance) return stopSitePilot(tabId, pilot, { ...filled, state: 'waiting', ...say(`worker.siteNext.${navigation.reason}`) });
      if (pilot.attempted.has(navigation.step)) return stopSitePilot(tabId, pilot, { ...filled, state: 'waiting', ...say('worker.siteNext.changed') });
      const receipt = await nativeRequest('authorizeSiteNavigation', { url: safeUrl(tab.url) }); guard();
      const revision = receiptRevision(receipt);
      await checkAccess(revision); guard();
      const current = await activeSite(tabId); guard();
      if (current.tab.url !== tab.url || current.origin !== pilot.origin) throw fault('worker.pageChangedAutofill');
      await requireSite(origin); guard();
      pilot.attempted.add(navigation.step); // Record before sending: a lost response never retries Next.
      pilot.awaiting = Date.now();
      prior = remember(tabId, { ...filled, state: 'continuing', autoContinue: true, ...say('worker.siteContinuing') });
      let advanced;
      try { advanced = await topSiteMessage(tabId, { type: 'secondhand:generic:advance', token: navigation.token }); }
      catch (error) {
        guard();
        const moved = await chrome.tabs.get(tabId); guard();
        if (moved.status === 'loading' || moved.url !== tab.url) return prior;
        throw error;
      }
      guard();
      if (advanced?.ok !== true || advanced.advanced !== true) return stopSitePilot(tabId, pilot, { ...filled, state: 'waiting', ...say('worker.siteNext.changed') });
      return prior;
    } catch (error) {
      if (sitePilots.get(tabId) !== pilot) return results.get(tabId) || prior;
      if (error.code === 'site-not-ready' && pilot.awaiting && Date.now() - pilot.awaiting < 15000) return prior;
      return stopSitePilot(tabId, pilot, siteResult(failed(error).state, failed(error)));
    }
  })().finally(() => {
    pilot.running = null;
    if (pilot.loaded && sitePilots.get(tabId) === pilot) { pilot.loaded = false; void sitePilotStep(tabId); }
  });
  return pilot.running;
}
async function startSitePilot(tabId) {
  if (sitePilots.has(tabId)) return sitePilotStep(tabId);
  if (siteRuns.has(tabId)) throw fault('worker.siteFillBusy');
  // Install the pending run before the first await, so Stop/tab changes revoke startup too.
  const pilot = { origin: null, steps: 0, attempted: new Set(), running: null, awaiting: null, loaded: false };
  sitePilots.set(tabId, pilot);
  pilot.running = (async () => {
    const { origin } = await activeSite(tabId); currentSitePilot(tabId, pilot);
    await requireSite(origin); currentSitePilot(tabId, pilot);
    pilot.origin = origin;
  })().then(() => {
    pilot.running = null;
    return sitePilotStep(tabId);
  }).catch(error => {
    if (sitePilots.get(tabId) !== pilot) return results.get(tabId) || siteResult('stopped', say('worker.pilotStopped'));
    sitePilots.delete(tabId);
    throw error;
  });
  return pilot.running;
}

// The side panel routes by the tab's current page; a widget acts only as what it was loaded on.
async function pageState(tabId, route) {
  const state = await currentPageState(tabId, route);
  if (route !== undefined) return state;
  // Only the side panel (no route) opens the question list the widget asked for, and gets the questions it may save
  // and those whose answers wait for Fill sensitive details.
  const shown = questionViews.delete(tabId) ? { ...state, showQuestions: true } : state;
  if (state.site && !(state.site.enabled && state.site.ready)) return shown;
  const savable = await savableState(tabId);
  const held = await heldState(tabId);
  const rememberable = await rememberableState(tabId);
  return { ...shown, ...(savable.length ? { savable } : {}), ...(held.length ? { held } : {}), ...(rememberable.length ? { rememberable } : {}) };
}

// Save to My information (#98). The last Autofill's questions with no saved answer, kept for the tab.
function keepSavable(tabId, url, origin, items) {
  if (items.length) savables.set(tabId, { url, origin, items: new Map(items.map(item => [item.id, item])) });
  else savables.delete(tabId);
}
// The frame a kept question (a Save offer or a held detail) is in, with its address as Chrome gives it (#137): on a
// site, only while the site (and that embedded form) is on. Null once an embedded form's frame holds another document:
// its questions went with the page they were on.
async function keptFrame(tabId, kept, { frameId, documentId }) {
  if (!kept.origin) {
    await activePortal(tabId);
    return { frameId: 0, url: kept.url };
  }
  await requireSite(kept.origin);
  if (frameId === 0) return { frameId: 0, url: kept.url };
  const frame = (await enabledSiteFrames(tabId, kept.origin)).find(candidate => candidate.frameId === frameId);
  if (!frame) throw fault('worker.turnOnFrameFirst');
  return frame.documentId === documentId ? frame : null;
}
function savableMessage(tabId, kept, frame, message) {
  if (frame.frameId !== 0) return chrome.tabs.sendMessage(tabId, message, frameTarget(frame.frameId, frame.documentId));
  return kept.origin ? topSiteMessage(tabId, message) : chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}
// Each kept question's id and label, and whether its box holds an answer now. The page says which listed
// boxes are answered, by id; nothing they hold is read here.
async function savableState(tabId) {
  const kept = savables.get(tabId);
  if (!kept) return [];
  if ((await chrome.tabs.get(tabId)).url !== kept.url || (kept.origin && !(await siteEnabled(kept.origin)))) { savables.delete(tabId); return []; }
  const groups = new Map();
  for (const item of kept.items.values()) {
    const group = `${item.frameId}|${item.token}`;
    groups.set(group, [...(groups.get(group) || []), item]);
  }
  const answered = new Set();
  for (const items of groups.values()) {
    const frame = await keptFrame(tabId, kept, items[0]);
    if (!frame) { for (const item of items) kept.items.delete(item.id); continue; }
    const reply = await savableMessage(tabId, kept, frame, { type: 'secondhand:generic:answered', token: items[0].token, ids: items.map(item => item.planId) });
    if (!Array.isArray(reply?.answered) || reply.answered.some(id => typeof id !== 'string')) throw fault('worker.pageCheckUnsafe');
    for (const item of items) if (reply.answered.includes(item.planId)) answered.add(item.id);
  }
  if (!kept.items.size) savables.delete(tabId);
  return [...kept.items.values()].map(({ id, label }) => ({ id, label, answered: answered.has(id) }));
}
// After the applicant's Save click in the side panel: that one box's answer is read, then the desktop app
// saves it after its own confirmation, in the name of the site whose page holds the box. The answer goes
// only to the app, and is not kept.
async function saveAnswer(tabId, id) {
  const kept = savables.get(tabId);
  const item = kept?.items.get(id);
  if (!item || (await chrome.tabs.get(tabId)).url !== kept.url) throw fault('worker.answerGone');
  const frame = await keptFrame(tabId, kept, item);
  if (!frame) throw fault('worker.answerGone');
  const read = await savableMessage(tabId, kept, frame, { type: 'secondhand:generic:read', token: item.token, id: item.planId, key: item.key });
  if (read?.empty === true) throw fault('worker.answerFirst');
  if (read?.unreadable === true) throw fault('worker.answerUnreadable');
  if (read?.repeated === true) throw fault('worker.answerRepeated');
  if (typeof read?.value !== 'string' || !read.value.trim() || read.value.length > 200) throw fault('worker.answerGone');
  let reply;
  try { reply = await nativeRequest('saveFields', { url: safeUrl(frame.url), fields: { [item.key]: read.value } }); }
  catch (error) { throw error.code !== 'offline' && /cancelled/i.test(error.message) ? fault('worker.saveCancelled') : error; }
  if (!Array.isArray(reply?.saved) || !reply.saved.includes(item.key)) throw fault('worker.desktopUnexpected');
  kept.items.delete(id);
  if (!kept.items.size) savables.delete(tabId);
  return { saved: true };
}

// Remember for next time (#186). The last Autofill's open questions a custom answer may fill, kept for the tab.
function keepRememberable(tabId, url, origin, items) {
  if (items.length) rememberables.set(tabId, { url, origin, items: new Map(items.map(item => [item.id, item])) });
  else rememberables.delete(tabId);
}
// Each kept question's id, label, whether its answer changes over time, and whether its box holds an answer now. The page
// says which listed boxes are answered, by id; nothing they hold is read here.
async function rememberableState(tabId) {
  const kept = rememberables.get(tabId);
  if (!kept) return [];
  if ((await chrome.tabs.get(tabId)).url !== kept.url || !(await siteEnabled(kept.origin))) { rememberables.delete(tabId); return []; }
  const groups = new Map();
  for (const item of kept.items.values()) groups.set(`${item.frameId}|${item.token}`, [...(groups.get(`${item.frameId}|${item.token}`) || []), item]);
  const answered = new Set();
  for (const items of groups.values()) {
    const frame = await keptFrame(tabId, kept, items[0]);
    if (!frame) { for (const item of items) kept.items.delete(item.id); continue; }
    const reply = await savableMessage(tabId, kept, frame, { type: 'secondhand:generic:answered', token: items[0].token, ids: items.map(item => item.planId) });
    if (!Array.isArray(reply?.answered) || reply.answered.some(id => typeof id !== 'string')) throw fault('worker.pageCheckUnsafe');
    for (const item of items) if (reply.answered.includes(item.planId)) answered.add(item.id);
  }
  if (!kept.items.size) rememberables.delete(tabId);
  return [...kept.items.values()].map(({ id, label, timeBound }) => ({ id, label, timeBound, answered: answered.has(id) }));
}
// After the applicant's Remember click in the side panel: each chosen box's answer is read, then the desktop app keeps them as
// custom answers after its own confirmation, one request for each site, in the name of the site whose page holds the boxes.
// The answers go only to the app, and are not kept.
const MAX_REMEMBER = 20;
async function rememberAnswers(tabId, ids) {
  const kept = rememberables.get(tabId);
  const items = Array.isArray(ids) ? ids.map(id => typeof id === 'string' ? kept?.items.get(id) : undefined) : [];
  if (!items.length || items.length > MAX_REMEMBER || items.some(item => !item) || new Set(items).size !== items.length || (await chrome.tabs.get(tabId)).url !== kept.url) throw fault('worker.answerGone');
  const sites = new Map();
  for (const item of items) {
    const frame = await keptFrame(tabId, kept, item);
    if (!frame) throw fault('worker.answerGone');
    const read = await savableMessage(tabId, kept, frame, { type: 'secondhand:generic:readOpen', token: item.token, id: item.planId });
    if (read?.empty === true) throw fault('worker.rememberEmpty');
    if (read?.unreadable === true) throw fault('worker.rememberUnreadable');
    if (read?.repeated === true) throw fault('worker.rememberRepeated');
    const choices = item.question.options;
    if (typeof read?.value !== 'string' || !read.value.trim() || read.value.length > 1000 || (choices.length && !choices.includes(read.value))) throw fault('worker.answerGone');
    const origin = new URL(frame.url).origin;
    if (!sites.has(origin)) sites.set(origin, { url: frame.url, answers: [] });
    sites.get(origin).answers.push({ item, answer: { ...item.question, options: [...choices], answer: read.value } });
  }
  let remembered = 0;
  for (const { url, answers } of sites.values()) {
    let reply;
    try { reply = await nativeRequest('rememberAnswers', { url: safeUrl(url), answers: answers.map(entry => entry.answer) }); }
    catch (error) { throw error.code !== 'offline' && /cancelled/i.test(error.message) ? fault('worker.rememberCancelled') : error; }
    if (reply?.remembered !== answers.length) throw fault('worker.desktopUnexpected');
    for (const { item } of answers) kept.items.delete(item.id);
    remembered += answers.length;
  }
  if (!kept.items.size) rememberables.delete(tabId);
  return { remembered };
}

// Fill sensitive details (#176). The last Autofill's held questions, kept for the tab.
function keepHeld(tabId, url, origin, items, reason) {
  if (items.length) heldDetails.set(tabId, { url, origin, reason, items: new Map(items.map(item => [item.id, item])) });
  else heldDetails.delete(tabId);
}
// The held questions still on the page as the click left it: those in an embedded form that moved on to another page go.
async function heldOnPage(tabId) {
  const kept = heldDetails.get(tabId);
  if (!kept) return null;
  if ((await chrome.tabs.get(tabId)).url !== kept.url || !(await siteEnabled(kept.origin))) { heldDetails.delete(tabId); return null; }
  const documents = new Map([...kept.items.values()].map(item => [`${item.frameId}|${item.documentId}`, item]));
  for (const item of documents.values()) {
    if (await keptFrame(tabId, kept, item)) continue;
    for (const [id, other] of kept.items) if (other.frameId === item.frameId && other.documentId === item.documentId) kept.items.delete(id);
  }
  if (!kept.items.size) { heldDetails.delete(tabId); return null; }
  return kept;
}
// Each held question's id and label, for the side panel.
async function heldState(tabId) {
  const kept = await heldOnPage(tabId);
  return kept ? [...kept.items.values()].map(({ id, label }) => ({ id, label })) : [];
}
// After the applicant's Fill sensitive details click in the side panel: for each site whose answers the app held back, in
// page order, one getFields for those fields alone with `sensitive: true`, which shows the app's sensitive prompt in that
// site's name. What it allows fills those questions only, in the plan the click left on the page. A Cancel leaves
// everything already filled in place and the questions still held. The tab's result then counts what filled and what waits.
async function fillHeld(tabId) {
  const kept = await heldOnPage(tabId);
  if (!kept) throw fault('worker.heldGone');
  // What filled, and of that what was answered only in part and still needs the applicant (#184).
  const placed = new Set(), inPart = new Set();
  // The held custom answers (#186), which the tab's result counts apart.
  const custom = new Set([...kept.items.values()].filter(item => item.question).map(item => item.id));
  let reason = null;
  try {
    for (const url of new Set([...kept.items.values()].map(item => item.url))) {
      const items = [...kept.items.values()].filter(item => item.url === url);
      reason = reasons(reason, await fillHeldSite(tabId, kept, url, items, placed, inPart));
      // The app answered for this site: its questions no longer wait, whether or not each had a saved answer.
      for (const item of items) kept.items.delete(item.id);
    }
  } finally {
    if (!kept.items.size) heldDetails.delete(tabId);
    heldChanged(tabId, kept, placed, inPart, reason, [...placed].filter(id => custom.has(id)).length);
  }
  return results.get(tabId);
}
// One site's held questions: the app's sensitive prompt, then each frame's questions filled under the receipt it gave.
// Why the app left answers out, when it did.
// Saved fields come from getFields; custom answers about a sensitive subject (#186) from getCustomFields, for each frame's questions.
async function fillHeldSite(tabId, kept, url, items, placed, inPart) {
  const asked = async (type, payload) => {
    try { return await nativeRequest(type, { url: safeUrl(url), ...payload, sensitive: true }); }
    catch (error) { throw error.code !== 'offline' && /cancelled/i.test(error.message) ? fault('worker.heldCancelled') : error; }
  };
  const frames = new Map();
  for (const item of items) frames.set(`${item.frameId}|${item.token}`, [...(frames.get(`${item.frameId}|${item.token}`) || []), item]);
  const fields = [...new Set(items.filter(item => item.fields).flatMap(item => item.fields))];
  let values = {}, reason = null, revision = null;
  const receipt = response => {
    const value = receiptRevision(response);
    if (revision !== null && value !== revision) throw fault('worker.accessChanged');
    revision = value;
  };
  try {
    if (fields.length) {
      const response = await asked('getFields', { fields });
      if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values) || response.held !== undefined) throw fault('worker.desktopUnexpected');
      receipt(response);
      reason = desktopReason(response);
      values = SecondHandGeneric.deriveValues(response.values);
    }
    // Each frame's custom answers, by question id.
    const custom = new Map();
    for (const [group, questions] of frames) {
      const open = questions.filter(item => item.question);
      if (!open.length) continue;
      const response = await asked('getCustomFields', { fields: open.map(({ planId, question }) => ({ id: planId, ...question })) });
      const entries = plainEntries(response?.values);
      if (!entries || response.held !== undefined || entries.some(([id, value]) => !open.some(item => item.planId === id) || typeof value !== 'string' || !value || value.length > 1000)) throw fault('worker.desktopUnexpected');
      if (entries.length) receipt(response);
      custom.set(group, Object.fromEntries(entries));
    }
    for (const [group, questions] of frames) {
      const answers = custom.get(group) || {};
      const assignments = questions.flatMap(({ planId, key, question }) => question ? (Object.hasOwn(answers, planId) ? [{ id: planId, custom: true }] : [])
        : typeof values[key] === 'string' && values[key] ? [{ id: planId, key, guessed: false }] : []);
      if (!assignments.length) continue;
      await checkAccess(revision);
      const current = await chrome.tabs.get(tabId);
      if (current.url !== kept.url || !current.active) throw fault('worker.pageChangedAutofill');
      const result = await fillFrame(tabId, questions[0], { type: 'secondhand:generic:fill', token: questions[0].token, assignments,
        values: Object.fromEntries(assignments.map(item => item.custom ? [item.id, answers[item.id]] : [item.key, values[item.key]])) }, true);
      for (const { id, planId } of questions) {
        if (!result.filled.includes(planId) || result.rejected.includes(planId)) continue;
        placed.add(id);
        if (result.partial?.includes(planId)) inPart.add(id);
      }
    }
  } finally { values = null; }
  return reason;
}
// The tab's result after Fill sensitive details: the questions it filled count as filled and leave need-you, unless answered
// only in part, and those still held are said. Only the result of the click that held them back changes.
function heldChanged(tabId, kept, placed, inPart, reason, placedCustom) {
  const result = results.get(tabId);
  if (result?.state !== 'done' || result.pageKey !== 'general' || !result.held) return;
  const filled = result.filled + placed.size;
  const needYou = result.needYou.filter(id => !placed.has(id) || inPart.has(id));
  const held = kept.items.size;
  const custom = (result.custom || 0) + placedCustom;
  const { layaGuessed = 0, layaGuesses = [] } = result;
  remember(tabId, siteResult('done', siteSummary(filled, result.guessed, needYou, false, result.laya, reasons(kept.reason, reason), held, layaGuessed, custom),
    { filled, guessed: result.guessed, needYou, ...(result.laya ? { laya: result.laya } : {}), ...(held ? { held } : {}), ...(custom ? { custom } : {}), ...layaGuessResult(layaGuessed, layaGuesses) }));
}
async function currentPageState(tabId, route) {
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) return iowaPageState(tabId);
  const origin = route === 'iowa' ? '' : siteOrigin(tab.url);
  if (!origin) throw fault('worker.openIowaPortal');
  const enabled = await siteEnabled(origin);
  if (enabled && sitePilots.has(tabId) && !sitePilots.get(tabId).running) void sitePilotStep(tabId);
  if (!enabled) sitePilots.delete(tabId);
  const result = results.get(tabId);
  return { page: { kind: 'general', pageKey: 'general' }, result: enabled && result?.pageKey === 'general' ? result : null, autopilot: sitePilots.has(tabId),
    site: { origin, enabled, ...(enabled ? await siteReadiness(tab, origin) : { frames: [], ready: false }) }, ...(enabled ? summaryLine(tabId, tab.url) : {}) };
}

async function autofill(tabId, route, guesses) {
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) {
    if (guesses !== undefined) throw fault('worker.iowaRulesOnly');
    return startAutopilot(tabId);
  }
  if (route !== 'iowa' && siteOrigin(tab.url)) return fillSite(tabId, guesses);
  throw fault('worker.openIowaPortal');
}

async function focusField(tabId, key, route) {
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) {
    if (!FIELD_ID.test(key)) throw fault('worker.fieldNotOnPage');
    await activePortal(tabId);
    // Iowa's own keys go to the Iowa adapter; the general engine's field ids ("sh-…") to the engine.
    if (KEY.test(key)) return chrome.tabs.sendMessage(tabId, { type: 'secondhand:focusField', key }, { frameId: 0 });
    const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:focus', id: key }, { frameId: 0 });
    return { focused: result?.focused === true };
  }
  if (route === 'iowa') throw fault('worker.openIowaPortal');
  const { origin } = await activeSite(tabId);
  await requireSite(origin);
  if (!SITE_FIELD_ID.test(key)) throw fault('worker.fieldNotOnPage');
  const [prefix, id] = key.split(':');
  const frameId = Number(prefix.slice(1));
  if (!(await enabledSiteFrames(tabId, origin)).some(frame => frame.frameId === frameId)) throw fault('worker.turnOnFrameFirst');
  const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:focus', id }, { frameId });
  return { focused: result?.focused === true };
}

// Every question on the page, for the applicant to read in their language: labels and ids only,
// never values, and nothing reaches the desktop. Each id works with focusField above.
const QUESTION_LIMIT = 200;
const LABEL_LIMIT = 300;
const languageTag = value => typeof value === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,4}$/.test(value) ? value : '';
function listedQuestions(reply, prefix) {
  if (!reply || !Array.isArray(reply.questions) || reply.questions.some(item => typeof item?.id !== 'string' || !FIELD_ID.test(item.id) || typeof item.label !== 'string')) {
    throw fault('worker.questionsUnreadable');
  }
  return reply.questions.filter(item => item.label.trim()).map(item => ({ id: `${prefix}${item.id}`, label: item.label.trim().slice(0, LABEL_LIMIT) }));
}
async function pageQuestions(tabId, route) {
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) {
    const { page } = await readPage(tabId, false);
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:questions' }, { frameId: 0 });
    const general = listedQuestions(reply, '');
    if (!Array.isArray(reply.instructions) || reply.instructions.some(text => typeof text !== 'string')) throw fault('worker.questionsUnreadable');
    // Iowa's info screens are read as text; SecondHand's own checklist labels carry their catalog keys.
    const checklist = (Array.isArray(page.checklist) ? page.checklist : []).filter(item => typeof item?.key === 'string' && typeof item.label === 'string');
    return { lang: languageTag(reply.lang), pending: 0, questions: [
      ...reply.instructions.filter(text => text.trim()).map(text => ({ id: '', label: text.trim().slice(0, LABEL_LIMIT) })),
      ...checklist.map(item => ({ id: item.key, ...adapterSays(item.label, 'label') })),
      ...general
    ].slice(0, QUESTION_LIMIT) };
  }
  if (route === 'iowa') throw fault('worker.openIowaPortal');
  const { origin } = await activeSite(tabId);
  await requireSite(origin);
  const pending = (await siteFrames(tabId, origin)).filter(frame => !frame.enabled).length;
  const message = { type: 'secondhand:generic:questions' };
  const frames = await Promise.all((await enabledSiteFrames(tabId, origin)).map(async ({ frameId }) => {
    const reply = frameId === 0 ? await topSiteMessage(tabId, message) : await chrome.tabs.sendMessage(tabId, message, { frameId });
    return { lang: languageTag(reply?.lang), questions: listedQuestions(reply, `f${frameId}:`) };
  }));
  // The form's language is the one its biggest part declares; the panel checks it against the text.
  const main = frames.reduce((best, frame) => frame.questions.length > best.questions.length ? frame : best, frames[0]);
  return { lang: main.lang, pending, questions: frames.flatMap(frame => frame.questions).slice(0, QUESTION_LIMIT) };
}

// "What this page says": a page's own words for the side panel's summary, never form values, and the
// key points the panel wrote for them. Nothing here reaches the desktop.
function readOf(reply, iowa) {
  const valid = reply && typeof reply.text === 'string' && reply.text.length <= PAGE_TEXT_LIMIT &&
    (!iowa || (reply.pageKey === '' ? !reply.text : SecondHandIowa.INFO_PAGE_KEYS.includes(reply.pageKey)));
  if (!valid) throw fault('worker.pageTextUnreadable');
  return { pageKey: iowa ? reply.pageKey : 'general', lang: languageTag(reply.lang), text: reply.text.trim(), unread: false };
}
// The same words at the same address keep their key points; changed words are read afresh.
function keepRead(tabId, url, read) {
  const reads = pageReads.get(tabId) || new Map();
  const kept = reads.get(url);
  const entry = kept && !kept.unread && !read.unread && kept.text === read.text && kept.lang === read.lang ? kept : { id: crypto.randomUUID(), url, ...read, summary: null };
  reads.delete(url);
  reads.set(url, entry);
  while (reads.size > KEPT_PAGES) reads.delete(reads.keys().next().value);
  pageReads.set(tabId, reads);
}
function forgetReads(tabId, which) {
  const reads = pageReads.get(tabId);
  if (!reads) return;
  for (const [url, entry] of reads) if (which(entry)) reads.delete(url);
  if (!reads.size) pageReads.delete(tabId);
}
// The page on screen first, then the others, latest first.
function listedReads(tabId, url, which) {
  const entries = [...(pageReads.get(tabId)?.values() || [])].filter(which).reverse();
  return { pages: [...entries.filter(entry => entry.url === url), ...entries.filter(entry => entry.url !== url)]
    .map(({ id, url: address, pageKey, lang, text, unread, summary }) => ({ id, pageKey, lang, current: address === url, text, unread, summary })) };
}
// Autofill moves past Iowa's information-only screens at once, so each one's words are kept before
// Continue. A screen that can't be read is kept as unread, so the side panel says so.
async function keepIowaScreen(tabId, url, pageKey) {
  let read;
  try { read = readOf(await chrome.tabs.sendMessage(tabId, { type: 'secondhand:pageText' }, { frameId: 0 }), true); }
  catch { read = null; }
  keepRead(tabId, url, read?.text && read.pageKey === pageKey ? read : { pageKey, lang: '', text: '', unread: true });
}
const isIowaRead = entry => SecondHandIowa.isSupportedUrl(entry.url);
async function iowaPageText(tabId) {
  const tab = await activePortal(tabId);
  await inject(tabId);
  const read = readOf(await chrome.tabs.sendMessage(tabId, { type: 'secondhand:pageText' }, { frameId: 0 }), true);
  if ((await activePortal(tabId)).url !== tab.url) throw fault('worker.pageLoading');
  if (read.text) keepRead(tabId, tab.url, read);
  return listedReads(tabId, tab.url, isIowaRead);
}
// A site's own words first, then each embedded form that is on: whole lines while they fit.
async function sitePageText(tabId) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  const message = { type: 'secondhand:generic:pageText' };
  const frames = (await enabledSiteFrames(tabId, origin)).sort((a, b) => a.frameId - b.frameId);
  const reads = await Promise.all(frames.map(async ({ frameId }) => readOf(frameId === 0 ? await topSiteMessage(tabId, message) : await chrome.tabs.sendMessage(tabId, message, { frameId }), false)));
  let text = '';
  for (const line of reads.flatMap(read => read.text ? read.text.split('\n') : [])) {
    const joined = text ? `${text}\n${line}` : line;
    if (joined.length > PAGE_TEXT_LIMIT) break;
    text = joined;
  }
  if (!text) return { pages: [] };
  keepRead(tabId, tab.url, { pageKey: 'general', lang: reads[0].lang, text, unread: false });
  return listedReads(tabId, tab.url, entry => entry.url === tab.url);
}
async function pageText(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (SecondHandIowa.isSupportedUrl(tab.url)) return iowaPageText(tabId);
  if (siteOrigin(tab.url)) return sitePageText(tabId);
  throw fault('worker.openIowaPortal');
}
// The side panel's key points for words it read: at most five short lines, in a language SecondHand speaks.
function keepSummary(tabId, id, summary) {
  const valid = summary && typeof summary === 'object' && SecondHandStrings.LANGUAGES.includes(summary.language) && typeof summary.english === 'boolean' &&
    Array.isArray(summary.points) && summary.points.length <= 5 && summary.points.every(point => typeof point === 'string' && point.trim() && point.length <= 400);
  if (!valid) throw fault('worker.requestFailed');
  const entry = [...(pageReads.get(tabId)?.values() || [])].find(item => item.id === id);
  // Points for words that have since changed are not kept: the new words get their own.
  if (!entry) return { kept: false };
  entry.summary = { language: summary.language, points: [...summary.points], english: summary.english };
  return { kept: true };
}
// The widget can't size its own frame, so its tab's content script fits the frame to the
// widget's measured size, taller while it shows a line.
const cardWidth = width => Number.isInteger(width) && width > 0 && width <= 1000; // CSS pixels; the page caps it
const CARD_SIZES = ['width', 'height', 'narrowWidth', 'narrowHeight'];
const cardSize = message => CARD_SIZES.every(key => message[key] === undefined || cardWidth(message[key]));
async function widgetSize(tabId, line, message) {
  const size = Object.fromEntries(CARD_SIZES.filter(key => message[key] !== undefined).map(key => [key, message[key]]));
  const reply = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:widgetSize', line, ...size }, { frameId: 0 });
  if (reply?.sized !== true) throw fault('worker.requestFailed');
  return { sized: true };
}
// The widget's one line: the first key point of the page on screen.
function summaryLine(tabId, url) {
  const summary = pageReads.get(tabId)?.get(url)?.summary;
  return summary?.points.length ? { summary: { language: summary.language, point: summary.points[0], english: summary.english } } : {};
}

// Unlock with Touch ID (#99). The desktop's status says whether it's ready or off; an app from before
// it says nothing. Asked from a click in the side panel, the app shows its own Touch ID prompt and
// answers whether it unlocked, or why not. No password ever passes through Chrome.
const TOUCH_ID_STATES = Object.freeze(['ready', 'off']);
const TOUCH_ID_REFUSALS = Object.freeze(['off', 'cancelled']);
const knownTouchId = state => { if (!TOUCH_ID_STATES.includes(state)) throw fault('worker.desktopUnexpected'); return state; };
async function unlockWithTouchId() {
  const reply = await nativeRequest('unlockWithTouchId');
  const keys = reply && typeof reply === 'object' ? Object.keys(reply).length : 0;
  if (reply?.unlocked === true && keys === 1) return { unlocked: true };
  if (reply?.unlocked === false && keys === 2 && TOUCH_ID_REFUSALS.includes(reply.reason)) return { unlocked: false, reason: reply.reason };
  throw fault('worker.desktopUnexpected');
}

// Brings the desktop app forward, or has the native host start it when it isn't running.
async function openApp() {
  const reply = await nativeRequest('openApp');
  if (!['shown', 'launched'].includes(reply?.opened)) throw fault('worker.desktopUnexpected');
  return { opened: reply.opened };
}

// An error reply carries the same English, key, and parameters as a result.
function errorReply(error) {
  const text = typeof error?.message === 'string' ? error.message : '';
  if (error?.messageKey) return { ok: false, error: text, errorKey: error.messageKey, errorParams: error.messageParams };
  if (text) return { ok: false, error: text, errorKey: 'detail', errorParams: { detail: text } };
  return { ok: false, error: english('worker.requestFailed'), errorKey: 'worker.requestFailed', errorParams: {} };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || Array.isArray(message)) return;
  // Only our own extension pages reach the vault: the side panel, and the launcher
  // iframe inside an Iowa tab or a site the user turned on (bound to that tab).
  // Content scripts and page postMessages never do.
  const panel = sender.url === chrome.runtime.getURL('panel.html') && !sender.tab;
  const frame = sender.url === chrome.runtime.getURL('panel.html?surface=launcher') && sender.frameId > 0 && Number.isInteger(sender.tab?.id);
  const route = !frame ? undefined : SecondHandIowa.isSupportedUrl(sender.tab.url) ? 'iowa' : siteOrigin(sender.tab.url) ? 'site' : '';
  const launcher = Boolean(route);
  // A site page's own content script says whether its frame has a form SecondHand can help with.
  // Only that yes or no travels, to the page's top frame; nothing reaches the desktop. A report the
  // worker couldn't count is answered with the error (#178).
  if (!panel && !frame && message.type === 'secondhand:generic:form' && typeof message.helps === 'boolean' && Number.isInteger(sender.tab?.id) &&
    Number.isInteger(sender.frameId) && sender.frameId >= 0 && typeof sender.url === 'string' && !sender.url.startsWith(chrome.runtime.getURL(''))) {
    formReport(sender, message.helps).then(respond, error => respond(errorReply(error)));
    return true;
  }
  // A frame answering the worker's check of where each frame is: Chrome's sender says, never the message.
  if (!panel && !frame && message.type === 'secondhand:frame' && typeof message.nonce === 'string' && Number.isInteger(sender.tab?.id) &&
    Number.isInteger(sender.frameId) && sender.frameId >= 0 && typeof sender.documentId === 'string' && typeof sender.url === 'string' && !sender.url.startsWith(chrome.runtime.getURL(''))) {
    if (frameHeard(message.nonce, sender)) respond(true);
    return;
  }
  if (!panel && !launcher) return;
  if (message.type === 'ui:ping') { respond({ ok: true, data: { build: BUILD } }); return; }
  if (launcher && message.type === 'ui:openPanel' && message.confirmed === true) {
    const tabId = sender.tab.id;
    if (message.questions === true) questionViews.add(tabId);
    // Keep this synchronous: Chrome requires the originating trusted user gesture.
    chrome.sidePanel.open({ tabId }).then(() => respond({ ok: true, data: { opened: true } }),
      () => { questionViews.delete(tabId); respond(errorReply(fault('worker.useToolbarIcon'))); });
    return true;
  }
  const tabId = launcher ? sender.tab.id : message.tabId;
  let run;
  if (message.type === 'ui:showApp' && message.confirmed === true) run = () => nativeRequest('showApp');
  else if (message.type === 'ui:openApp' && message.confirmed === true) run = openApp;
  else if (panel && message.type === 'ui:desktopStatus') {
    run = async () => {
      const desktop = await desktopStatus().then(data => ({ connected: true, unlocked: Boolean(data?.unlocked), laya: layaState(data),
        ...(data?.touchId === undefined ? {} : { touchId: knownTouchId(data.touchId) }),
        ...(selfUpdate?.state === 'failed' || selfUpdate?.state === 'elsewhere' ? { update: selfUpdate.state } : {}) }),
        error => { if (error.code === 'offline') return { connected: false, unlocked: false, laya: 'unavailable' }; throw error; });
      return { ...desktop, allSites: await allSitesOn() };
    };
  } else if (panel && message.type === 'ui:unlockWithTouchId' && message.confirmed === true) run = unlockWithTouchId;
  else if (panel && message.type === 'ui:enableAllSites' && message.confirmed === true) run = () => enableAllSites(tabId);
  else if (panel && message.type === 'ui:disableAllSites' && message.confirmed === true) run = disableAllSites;
  else if (!Number.isInteger(tabId)) return;
  else if (message.type === 'ui:pageState') run = () => pageState(tabId, route);
  else if (message.type === 'ui:autofill' && message.confirmed === true) run = () => autofill(tabId, route, message.guesses);
  else if (panel && message.type === 'ui:fillAndContinue' && message.confirmed === true) run = () => startSitePilot(tabId);
  else if (message.type === 'ui:plan' && message.confirmed === true) run = () => planSite(tabId);
  else if (message.type === 'ui:stop' && message.confirmed === true) run = () => stop(tabId);
  else if (message.type === 'ui:focusField' && typeof message.key === 'string' && (FIELD_ID.test(message.key) || SITE_FIELD_ID.test(message.key))) {
    run = () => focusField(tabId, message.key, route);
  } else if (panel && message.type === 'ui:enableSite' && message.confirmed === true) run = () => enableSite(tabId);
  else if (panel && message.type === 'ui:enableFrames' && message.confirmed === true) run = () => enableFrames(tabId);
  else if (panel && message.type === 'ui:disableSite' && message.confirmed === true) run = () => disableSite(tabId);
  else if (message.type === 'ui:questions') run = () => pageQuestions(tabId, route);
  else if (panel && message.type === 'ui:pageText') run = () => pageText(tabId);
  else if (panel && message.type === 'ui:keepSummary' && typeof message.id === 'string') run = async () => keepSummary(tabId, message.id, message.summary);
  else if (panel && message.type === 'ui:saveAnswer' && message.confirmed === true && typeof message.id === 'string') run = () => saveAnswer(tabId, message.id);
  else if (panel && message.type === 'ui:fillHeld' && message.confirmed === true) run = () => fillHeld(tabId);
  else if (panel && message.type === 'ui:rememberAnswers' && message.confirmed === true) run = () => rememberAnswers(tabId, message.ids);
  else if (launcher && message.type === 'ui:widgetSize' && typeof message.line === 'boolean' && cardSize(message)) run = () => widgetSize(tabId, message.line, message);
  else return;
  // A click holds off an update until it settles; after any request, a waiting update may reload.
  const action = message.confirmed === true;
  if (action) clicksUnderway++;
  // A widget on another site is honored only while that site is turned on.
  const work = route === 'site' ? requireSite(siteOrigin(sender.tab.url)).then(run) : run();
  work.then(data => respond({ ok: true, data }), error => respond(errorReply(error)))
    .finally(() => { if (action) clicksUnderway--; reloadWhenIdle(); });
  return true;
});
chrome.tabs.onActivated?.addListener(info => {
  for (const [tabId, pilot] of sitePilots) if (tabId !== info.tabId) stopSitePilot(tabId, pilot, siteResult('stopped', say('worker.stoppedTabChanged')));
  for (const tabId of autopilots.keys()) if (tabId !== info.tabId) stopAutopilot(tabId, { state: 'stopped', filled: 0, needYou: [], ...say('worker.stoppedTabChanged'), pageKey: results.get(tabId)?.pageKey || '' });
});
chrome.tabs.onRemoved?.addListener(tabId => { results.delete(tabId); autopilots.delete(tabId); sitePilots.delete(tabId); generalPages.delete(tabId); sitePlans.delete(tabId); questionViews.delete(tabId); pageReads.delete(tabId); formFrames.delete(tabId); formChecks.delete(tabId); savables.delete(tabId); rememberables.delete(tabId); heldDetails.delete(tabId); });
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (change.status === 'loading') {
    results.delete(tabId);
    // A new page starts over: its frames report as they load.
    formFrames.set(tabId, new Set());
    formChecks.delete(tabId);
    savables.delete(tabId);
    rememberables.delete(tabId);
    heldDetails.delete(tabId);
    generalPages.delete(tabId);
    sitePlans.delete(tabId);
    questionViews.delete(tabId);
    // Chrome omits other sites' URLs without the tabs permission, so re-read the tab: anything that
    // is not Iowa's portal (or unreadable) ends autofill and forgets the Iowa screens kept for the summary.
    if (autopilots.has(tabId) || [...(pageReads.get(tabId)?.values() || [])].some(isIowaRead)) {
      const leftIowa = () => { autopilots.delete(tabId); forgetReads(tabId, isIowaRead); };
      chrome.tabs.get(tabId).then(tab => { if (!SecondHandIowa.isSupportedUrl(tab.url)) leftIowa(); }, leftIowa);
    }
  }
  if (change.status === 'complete' && autopilots.has(tabId)) void step(tabId);
  if (change.status === 'complete' && sitePilots.has(tabId)) {
    // A page that finishes loading while a step runs gets a step of its own after it: that step read the page before.
    if (sitePilots.get(tabId).running) sitePilots.get(tabId).loaded = true;
    void sitePilotStep(tabId);
  }
});
// Site registrations made by an older version name its older script list; an update brings them current.
async function refreshSiteScripts() {
  const stale = (await chrome.scripting.getRegisteredContentScripts()).filter(script => /^(site|frame)-/.test(script.id) &&
    JSON.stringify(script.js) !== JSON.stringify(SITE_FILES.js));
  if (stale.length) await chrome.scripting.updateContentScripts(stale.map(script => ({ id: script.id, js: [...SITE_FILES.js] })));
}
chrome.runtime.onInstalled?.addListener(details => { if (details.reason === 'update') void refreshSiteScripts(); });
chrome.permissions?.onRemoved?.addListener(() => { sitePilots.clear(); forgetRevoked().catch(error => { if (!appClosed(error)) throw error; }); });
// Chrome's native panel persists alongside navigation; it never opens itself.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
