'use strict';
importScripts('address-policy.js', 'iowa-adapter.js', 'generic-adapter.js', 'strings.js');
if (typeof globalThis.SecondHandGeneric?.requestKeys !== 'function' || typeof globalThis.SecondHandGeneric.deriveValues !== 'function' || !Array.isArray(globalThis.SecondHandGeneric.GENERIC_KEYS) ||
  typeof globalThis.SecondHandGeneric.unsafeQuestion !== 'function') {
  throw new Error('SecondHand could not load generic-adapter.js. Reinstall the extension.');
}
if (typeof globalThis.SecondHandStrings?.english !== 'function' || typeof globalThis.SecondHandStrings.describeEnglish !== 'function') {
  throw new Error('SecondHand could not load strings.js. Reinstall the extension.');
}
// Must match BUILD in panel.js: change both together. The panel compares them to tell
// when Chrome is still running an older worker than the pages it loaded from disk.
const BUILD = '2026-09-27.1';
const HOST = 'org.secondhand.bridge';
const IOWA_ORIGIN = new URL(SecondHandIowa.PORTAL).origin;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,59}$/; // Iowa field keys and saved profile keys
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
const MAX_STEPS = 15;
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
const LAYA = Object.freeze({ textTypes: Object.freeze(['text', 'textarea', 'number', 'date', 'email', 'tel']), choiceTypes: Object.freeze(['radio', 'select', 'checkbox']),
  fields: 40, questions: 30, label: 200, options: 30, option: 100, bytes: 48 * 1024, budgetMs: 3000 });
const LAYA_NOT_READY = 'LAYA_NOT_READY';
const LAYA_STATES = Object.freeze(['off', 'unavailable', 'not-downloaded', 'downloading', 'ready', 'error']);

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
        // The desktop app's own wording travels as a detail.
        if (message.ok !== true) {
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
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['address-policy.js', 'iowa-adapter.js', 'generic-adapter.js', 'page-text.js', 'content.js'] });
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

// Desktop receipt revisions are authorization metadata, never profile values.
function receiptRevision(response) {
  if (!Number.isSafeInteger(response?.accessRevision) || response.accessRevision < 0) throw fault('worker.authorizationOutdated');
  return response.accessRevision;
}
async function checkAccess(revision) {
  const desktop = await nativeRequest('status');
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
    const desktop = await nativeRequest('status');
    currentPilot(tabId, pilot);
    if (!desktop?.unlocked) return { state: 'locked', filled: 0, needYou: [], ...say('worker.unlockToAutofill'), pageKey };
    const response = await nativeRequest('getFields', { url: safeUrl(url), fields: SecondHandIowa.profileRequest(pageKey) });
    currentPilot(tabId, pilot);
    const revision = receiptRevision(response);
    if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw fault('worker.noProfileFields');
    values = SecondHandIowa.pageValues(pageKey, response.values);
    let filled = 0;
    const attempted = pilot.attempted;
    for (let pass = 0; pass < 4; pass++) {
      currentPilot(tabId, pilot);
      if ((await activePortal(tabId)).url !== url) throw fault('worker.pageChangedAutofill');
      currentPilot(tabId, pilot);
      const fresh = pass === 0 ? state : await readPage(tabId);
      currentPilot(tabId, pilot);
      if (fresh.page.kind === 'blocked') break; // A household answer can reveal CAPTCHA.
      if (fresh.page.pageKey !== pageKey || !fresh.scan.recognizedPage) throw fault('worker.pageChangedAutofill');
      const keys = fresh.scan.fields.map(field => field.key).filter(key => !attempted.has(key) && typeof values[key] === 'string' && values[key]);
      fresh.scan.fields.forEach(field => attempted.add(field.key));
      if (!keys.length) break;
      await checkAccess(revision);
      currentPilot(tabId, pilot);
      if ((await activePortal(tabId)).url !== url) throw fault('worker.pageChangedAutofill');
      currentPilot(tabId, pilot);
      const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:fill', token: fresh.scan.token, fields: keys,
        values: Object.fromEntries(keys.map(key => [key, values[key]])) }, { frameId: 0 });
      currentPilot(tabId, pilot);
      if (!result?.ok) throw fault('worker.pageUnsafe');
      filled += result.filledCount;
      if (!result.filledCount) break;
    }
    values = null;
    const after = await readPage(tabId);
    currentPilot(tabId, pilot);
    if (after.url !== url || (after.page.pageKey !== pageKey && after.page.kind !== 'blocked')) throw fault('worker.pageChangedCheck');
    if (filled > 0) await nativeRequest('recordProgress', { url: safeUrl(url), filledCount: Math.min(filled, 100) }).catch(() => {});
    currentPilot(tabId, pilot);
    const missing = needYou(after.page);
    const summary = filled ? filledSummary(filled, missing)
      : missing.length ? { key: 'result.needYouNotSaved', params: { count: missing.length } } : { key: 'result.nothingNew', params: {} };
    // This receipt stays only in the worker. It never reaches a panel result.
    pilot.accessRevision = revision;
    const todo = after.page.todo ? adapterSays(after.page.todo, 'todo') : { todo: '' };
    const message = todo.todo ? say('result.thenTodo', { summary, todo: { key: todo.todoKey, params: todo.todoParams } }) : say(summary.key, summary.params);
    return { state: 'done', filled, needYou: missing, ...message, ...todo, pageKey: after.page.pageKey };
  } catch (error) {
    return { ...failed(error), filled: 0, needYou: [], pageKey };
  } finally { values = null; }
}

async function advanceVerified(tabId, state, pilot, filledResult, authorize = false) {
  const pageKey = state.page.pageKey;
  if (!['iowa-personal-information', 'iowa-select-address'].includes(pageKey) || !state.page.canAdvance || !state.nextToken) return filledResult;
  if (authorize || !Number.isSafeInteger(pilot.accessRevision)) {
    const response = await nativeRequest('getFields', { url: safeUrl(state.url), fields: [] });
    currentPilot(tabId, pilot);
    pilot.accessRevision = receiptRevision(response);
    if (!response?.values || Object.keys(response.values).length) throw fault('worker.invalidNavigation');
  }
  // Bind the snapshot before the final desktop/tab checks: an edit during those
  // checks invalidates the existing token instead of silently approving new data.
  const fresh = await readPage(tabId);
  currentPilot(tabId, pilot);
  if (fresh.url !== state.url || fresh.page.pageKey !== pageKey || !fresh.page.canAdvance || !fresh.nextToken) throw fault('worker.pageChangedReview');
  await checkAccess(pilot.accessRevision);
  currentPilot(tabId, pilot);
  if ((await activePortal(tabId)).url !== state.url) throw fault('worker.pageChangedBeforeNext');
  currentPilot(tabId, pilot);
  pilot.waiting = null; // one attempt, including uncertain navigation responses
  const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:next', token: fresh.nextToken, authorized: true }, { frameId: 0 });
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
    const signature = `${safeUrl(state.url)}|${page.pageKey}`;
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
          result = await fillPage(tabId, state, pilot);
          currentPilot(tabId, pilot);
          if (result.state === 'done' && page.pageKey === 'iowa-personal-information') {
            const fresh = await readPage(tabId); currentPilot(tabId, pilot);
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
        if (plan.matched.length || generalPages.get(tabId) === url) {
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
  const pilot = { steps: 0, handled: new Set(), running: null, waiting: null, accessRevision: null, attempted: new Set() };
  autopilots.set(tabId, pilot);
  try { await activePortal(tabId); currentPilot(tabId, pilot); return step(tabId); }
  catch (error) { return stopAutopilot(tabId, { ...failed(error), filled: 0, needYou: [], pageKey: results.get(tabId)?.pageKey || '' }, pilot); }
}
async function stop(tabId) {
  // Revoke first, before any asynchronous inspection, so a pending native reply
  // cannot fill or click while Stop is waiting for a page response.
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
function siteOrigin(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.port && url.origin !== IOWA_ORIGIN ? url.origin : '';
  } catch { return ''; }
}
const SITE_FILES = Object.freeze({ js: ['generic-adapter.js', 'page-text.js', 'generic-content.js'] });
const siteScript = origin => ({ id: `site-${new URL(origin).hostname}`, matches: [`${origin}/*`],
  js: [...SITE_FILES.js], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true });
const frameScriptPrefix = origin => `frame-${new URL(origin).hostname}--`;
const frameScript = (topOrigin, origin) => ({ ...siteScript(origin), id: `${frameScriptPrefix(topOrigin)}${new URL(origin).hostname}` });
async function siteEnabled(origin) {
  const [scripts, allowed] = await Promise.all([chrome.scripting.getRegisteredContentScripts(),
    chrome.permissions.contains({ origins: [`${origin}/*`] })]);
  return scripts.some(script => script.matches.includes(`${origin}/*`)) && allowed;
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
    await chrome.permissions.remove({ origins });
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
async function topSiteMessage(tabId, message) {
  try { return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }); }
  catch (error) {
    if (error.message === 'Could not establish connection. Receiving end does not exist.' || error.message === 'Receiving end does not exist.') {
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

async function removeAccess(origins) {
  const patterns = origins.map(origin => `${origin}/*`);
  const removed = await chrome.permissions.remove({ origins: patterns });
  const kept = await Promise.all(patterns.map(origin => chrome.permissions.contains({ origins: [origin] })));
  if (!removed || kept.some(Boolean)) throw fault('worker.chromeKeptAccess');
}

async function enableFrames(tabId) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  const pending = (await siteFrames(tabId, origin)).filter(frame => !frame.enabled).map(frame => frame.origin);
  for (const frameOrigin of pending) {
    if (!(await chrome.permissions.contains({ origins: [`${frameOrigin}/*`] }))) throw fault('worker.chromeNotAllowedFrames');
  }
  // Obtain every approval before registering any of the new scripts.
  try {
    for (const frameOrigin of pending) {
      const trust = await nativeRequest('trustSite', { url: frameOrigin });
      if (trust?.trusted !== true || trust.origin !== frameOrigin) throw fault('worker.appDidNotApproveFrames');
    }
    const current = await chrome.tabs.get(tabId);
    if (current.url !== tab.url || !current.active) throw fault('worker.pageChangedTryAgain');
  } catch (error) {
    if (pending.length) await removeAccess(pending);
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
  const { origin } = await activeSite(tabId);
  // Registrations survive worker/extension restarts and identify which frames
  // this site enabled, even when no content script can answer in the open tab.
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const owned = scripts.filter(script => script.id === siteScript(origin).id || script.id.startsWith(frameScriptPrefix(origin)));
  if (owned.length) await chrome.scripting.unregisterContentScripts({ ids: owned.map(script => script.id) });
  const remaining = await chrome.scripting.getRegisteredContentScripts();
  const frameOrigins = owned.flatMap(script => script.matches.map(pattern => siteOrigin(pattern.slice(0, -2)))).filter(Boolean);
  const unused = frameOrigins.filter(value => !remaining.some(script => script.matches.includes(`${value}/*`)));
  await removeAccess([...new Set([origin, ...unused])]);
  results.delete(tabId);
  sitePlans.delete(tabId);
  forgetReads(tabId, entry => siteOrigin(entry.url) === origin);
  return { enabled: false, origin };
}

// Chrome supplies frame ids only after access has been granted. Never message
// an origin just because it appeared in the top document or in these results.
async function enabledSiteFrames(tabId, origin) {
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.origin });
  if (!Array.isArray(frames) || !frames.some(frame => frame.frameId === 0 && frame.result === origin)) throw fault(FRAME_ERROR);
  const enabled = [];
  for (const frame of frames) {
    if (!Number.isInteger(frame.frameId) || frame.frameId < 0 || frame.frameId > 999999) throw fault(FRAME_ERROR);
    const frameOrigin = siteOrigin(frame.result);
    if (frameOrigin && await siteEnabled(frameOrigin)) enabled.push({ frameId: frame.frameId, origin: frameOrigin });
  }
  return enabled;
}

const siteResult = (state, message, extra = {}) => ({ state, filled: 0, guessed: 0, needYou: [], ...message, pageKey: 'general', ...extra });
const filledSummary = (filled, needYou) => needYou.length ? { key: 'result.filledNeedYou', params: { count: filled, needYou: needYou.length } } : { key: 'result.filled', params: { count: filled } };

// Runs in the page, so Chrome serializes it and it must stand alone. Counts the questions
// SecondHand filled (the site engine marks them) that are on screen now: a multi-page form
// hides its other pages. Also reports whether the page shows a Next button. Counts only.
function tallyPage() {
  const shown = element => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const counted = new Set();
  const tally = { rule: 0, guess: 0, next: false };
  for (const element of document.querySelectorAll('[data-secondhand-filled]')) {
    if (!shown(element)) continue;
    // A radio or checkbox group is one question, marked on every option, native or div-based (Google Forms).
    const group = ['radio', 'checkbox'].includes(element.getAttribute('role')) ? element.closest('[role="radiogroup"], [role="group"], [role="list"]') : null;
    const question = ['radio', 'checkbox'].includes(element.type) && element.name
      ? `${element.type}|${element.form ? Array.from(document.forms).indexOf(element.form) : -1}|${element.name}` : group || element;
    if (counted.has(question)) continue;
    counted.add(question);
    if (element.getAttribute('data-secondhand-filled') === 'guess') tally.guess++; else tally.rule++;
  }
  tally.next = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'))
    .some(control => shown(control) && /^next\b/i.test((control.textContent || control.value || '').trim()));
  return tally;
}
async function tallySite(tabId, frames) {
  try {
    const frameIds = frames.map(frame => frame.frameId);
    const injections = await chrome.scripting.executeScript({ target: { tabId, frameIds }, func: tallyPage });
    if (!Array.isArray(injections) || injections.length !== frameIds.length || new Set(injections.map(item => item.frameId)).size !== frameIds.length) throw fault(FRAME_ERROR);
    const total = { rule: 0, guess: 0, next: false };
    for (const { frameId, result: tally } of injections) {
      if (!frameIds.includes(frameId) || !Number.isInteger(tally?.rule) || tally.rule < 0 || !Number.isInteger(tally.guess) || tally.guess < 0 || typeof tally.next !== 'boolean') throw fault(FRAME_ERROR);
      total.rule += tally.rule; total.guess += tally.guess; total.next ||= tally.next;
    }
    return total;
  } catch { throw fault(FRAME_ERROR); }
}
// A summary that says when Laya suggested the guesses.
const withLaya = (summary, laya) => laya ? { key: 'result.suggestedByLaya', params: { summary } } : summary;
function siteSummary(filled, guessed, needYou, next, laya) {
  let summary;
  if (filled) {
    const key = guessed ? (needYou.length ? 'result.siteFilledGuessedNeedYou' : 'result.siteFilledGuessed') : needYou.length ? 'result.siteFilledNeedYou' : 'result.siteFilled';
    summary = { key, params: { count: filled, ...(guessed ? { guessed } : {}), ...(needYou.length ? { needYou: needYou.length } : {}) } };
  } else if (needYou.length) summary = { key: 'result.nothingMatchesNeedYou', params: { count: needYou.length } };
  else summary = { key: next ? 'result.nothingToFillNext' : 'result.nothingToFill', params: {} };
  const shown = withLaya(summary, laya);
  return say(shown.key, shown.params);
}

// The general engine's plan for the page: field ids, keys, and labels only.
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
async function planGeneral(tabId, frameId = 0, prefix = false) {
  try {
    const message = { type: 'secondhand:generic:plan' };
    const plan = prefix && frameId === 0 ? await topSiteMessage(tabId, message) : await chrome.tabs.sendMessage(tabId, message, { frameId });
    if (!plan || typeof plan.token !== 'string' || !Array.isArray(plan.matched) || !Array.isArray(plan.unmatched) ||
      plan.unmatched.some(field => typeof field?.id !== 'string' || !FIELD_ID.test(field.id) || typeof field.label !== 'string' || typeof field.type !== 'string' ||
        !strings(field.options) || typeof field.required !== 'boolean')) throw fault('worker.pageCheckUnsafe');
    if (prefix) {
      const ids = [...plan.matched, ...plan.unmatched].map(field => field?.id);
      if (!plan.token || ids.some(id => typeof id !== 'string' || !FIELD_ID.test(id)) || new Set(ids).size !== ids.length ||
        plan.matched.some(field => typeof field.key !== 'string' || !KEY.test(field.key))) throw fault(FRAME_ERROR);
    }
    return plan;
  } catch (error) {
    if (!prefix || error.code === 'site-not-ready') throw error;
    throw fault(FRAME_ERROR);
  }
}
const ruleAssignments = plan => plan.matched.map(field => ({ id: field.id, key: field.key, guessed: false }));

// Chrome's on-device AI runs only in extension pages, so the widget asks for the questions
// the rules left open and sends back its guesses with Autofill. Labels and options only.
async function siteFramePlans(tabId, url, stopForPending = false) {
  try {
    const origin = siteOrigin(url);
    const embedded = await siteFrames(tabId, origin);
    const top = { frameId: 0, plan: await planGeneral(tabId, 0, true) };
    const pending = embedded.filter(frame => !frame.enabled);
    if (stopForPending && !top.plan.matched.length && !top.plan.unmatched.length && pending.length) return { frames: [top], pending };
    const enabled = await enabledSiteFrames(tabId, origin);
    const frames = [top, ...await Promise.all(enabled.filter(frame => frame.frameId !== 0).map(async ({ frameId }) => ({ frameId, plan: await planGeneral(tabId, frameId, true) })))];
    return { frames, pending };
  } catch (error) {
    if (error.code === 'site-not-ready') throw error;
    throw fault(FRAME_ERROR);
  }
}
async function planSite(tabId) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  const { frames } = await siteFramePlans(tabId, tab.url);
  // Whether Laya will answer this click's open questions. When it will, the widget leaves Chrome's AI off.
  const { boxes, choices } = layaQuestions(frames, true);
  const laya = boxes.length || choices.length ? await layaReady() : null;
  sitePlans.set(tabId, { url: tab.url, frames, laya });
  return { unmatched: frames.flatMap(({ frameId, plan }) => plan.unmatched.map(({ id, label, type, options, required }) => ({ id: `f${frameId}:${id}`, label, type, options, required }))),
    allowedKeys: AI_KEYS, laya: laya === true };
}
// Guesses name fields of the plan the AI saw; a fresh plan would give the fields other ids.
function guessAssignments(stored, url, guesses) {
  if (stored?.url !== url) throw fault('worker.pageChangedAutofill');
  const open = new Set(stored.frames.flatMap(({ frameId, plan }) => plan.unmatched.map(field => `f${frameId}:${field.id}`)));
  const entries = plainEntries(guesses);
  // With Laya ready the widget never runs Chrome's AI, so it has no guesses to send.
  if (!entries || (stored.laya === true && entries.length) || entries.some(([id, key]) => !SITE_FIELD_ID.test(id) || !open.has(id) || !AI_KEYS.includes(key))) throw fault('worker.aiMatchesUnusable');
  return stored.frames.map(({ frameId, plan }) => ({ frameId, plan, planned: [...ruleAssignments(plan),
    ...entries.filter(([id]) => id.startsWith(`f${frameId}:`)).map(([id, key]) => ({ id: id.split(':')[1], key, guessed: true }))] }));
}

const plainEntries = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null;
const layaText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
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
// The open questions Laya may see, in page order: text boxes to match and choice questions to answer.
// Questions only the applicant answers (consent, signatures, SSN…) and any past the bridge's limits stay need-you.
function layaQuestions(frames, prefix) {
  const boxes = [], choices = [];
  for (const { frameId, plan } of frames) for (const field of plan.unmatched) {
    const { label, type, options } = field;
    if (!layaText(label, LAYA.label) || options.length > LAYA.options || options.some(option => !layaText(option, LAYA.option)) ||
      new Set(options).size !== options.length || SecondHandGeneric.unsafeQuestion(field)) continue;
    const question = { id: prefix ? `f${frameId}:${field.id}` : field.id, label, type, options: [...options] };
    if (LAYA.textTypes.includes(type)) boxes.push(question);
    else if (LAYA.choiceTypes.includes(type) && options.length) choices.push(question);
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
// [id, optionText] pairs for choice questions (#42), with the access receipt they were made under.
async function layaAnswers(url, choices, budgetMs) {
  const payload = layaPayload('answerFields', url, 'questions', choices, LAYA.questions, budgetMs);
  const reply = await askLaya('answerFields', payload);
  if (reply === null) return null;
  const sent = new Map(payload.questions.map(question => [question.id, question.options]));
  const entries = plainEntries(reply?.answers);
  if (!entries || entries.some(([id, option]) => !sent.has(id) || typeof option !== 'string' || !sent.get(id).includes(option))) throw fault('worker.layaUnusable');
  return { entries, revision: receiptRevision(reply) };
}

// Fills from a general-engine plan: one desktop request for the keys planned first (the rules'
// matches and any AI guesses), then up to four fill passes so questions revealed by an answer are
// filled too. Each pass plans the page again. Never continues, submits, or navigates.
// Laya is asked unless this click already found it not ready (`laya: false`). Both of its requests
// share the click's time budget: choice questions first (about 3 candidates each), then text boxes
// (about 20 each) with what is left, so the cheaper questions aren't starved. Its text-box matches
// join the one request for saved values.
async function fillPlan(tabId, url, frames, { prefix = false, guard = () => {}, laya = null } = {}) {
  let revision = null;
  let values = null;
  try {
    const initial = frames.map(frame => ({ ...frame, planned: frame.planned || ruleAssignments(frame.plan) }));
    const open = laya === false ? { boxes: [], choices: [] } : layaQuestions(initial, prefix);
    const fromLaya = new Set();
    const addLaya = (id, answer) => {
      const [frameId, own] = prefix ? [Number(id.slice(1, id.indexOf(':'))), id.slice(id.indexOf(':') + 1)] : [0, id];
      const frame = initial.find(candidate => candidate.frameId === frameId);
      frame.planned = [...frame.planned, { id: own, ...answer, guessed: true }];
      fromLaya.add(`${frameId}|${own}`);
    };
    // Once Laya says it isn't ready, it isn't asked again in this click. Unless the widget's plan
    // already readied it, it is readied now, before the click's budget starts.
    let layaOn = laya !== false;
    if (laya === null && (open.boxes.length || open.choices.length)) {
      layaOn = await layaReady();
      guard();
    }
    const budget = layaBudget();
    // null: Laya isn't ready; undefined: the budget was spent before this request.
    let answers;
    if (layaOn && open.choices.length) {
      answers = await budget.use(budgetMs => layaAnswers(url, open.choices, budgetMs));
      guard();
      if (answers === null) layaOn = false;
    }
    if (layaOn && open.boxes.length) {
      const suggestions = await budget.use(budgetMs => layaSuggestions(url, open.boxes, budgetMs));
      guard();
      if (suggestions) for (const [id, key] of suggestions) addLaya(id, { key });
    }
    const keys = [...new Set(SecondHandGeneric.requestKeys(initial.flatMap(frame => frame.planned.filter(item => item.key !== undefined).map(item => item.key))))];
    if (keys.some(key => typeof key !== 'string' || !KEY.test(key))) throw fault('worker.fieldRequestFailed');
    if (keys.length) {
      const desktop = await nativeRequest('status');
      if (!desktop?.unlocked) throw fault('worker.unlockToAutofill');
      const response = await nativeRequest('getFields', { url: safeUrl(url), fields: keys });
      if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw fault('worker.noProfileFields');
      guard();
      revision = receiptRevision(response);
      values = SecondHandGeneric.deriveValues(response.values);
    }
    // The answers came before getFields: an Always allow in its prompt outdates their receipt, and
    // outdated answers are never filled. Without answers to fill, their receipt doesn't matter.
    if (answers?.entries.length) {
      if (revision !== null && answers.revision !== revision) throw fault('worker.accessChanged');
      revision = answers.revision;
      for (const [id, option] of answers.entries) addLaya(id, { option });
    }
    let filled = 0, placedByLaya = 0;
    const needYou = [];
    for (const frame of initial) {
      const { frameId } = frame;
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
        let result;
        try {
          const message = { type: 'secondhand:generic:fill', token: plan.token, assignments, values: placing };
          result = prefix && frameId === 0 ? await topSiteMessage(tabId, message) : await chrome.tabs.sendMessage(tabId, message, { frameId });
          const assigned = new Set(assignments.map(item => item.id));
          const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && assigned.has(id)) && new Set(ids).size === ids.length;
          if (!result?.ok || !validIds(result.filled) || !validIds(result.rejected) || (result.skipped !== undefined && !validIds(result.skipped))) throw fault('worker.pageUnsafe');
        } catch (error) {
          if (!prefix || error.code === 'site-not-ready') throw error;
          throw fault(FRAME_ERROR);
        }
        for (const { id, key } of assignments) if (result.rejected.includes(id)) refused.set(key ?? `option:${id}`, id);
        const placed = assignments.filter(({ id }) => result.filled.includes(id) && !result.rejected.includes(id));
        if (!placed.length) break;
        filled += placed.length;
        placedByLaya += placed.filter(({ id }) => fromLaya.has(`${frameId}|${id}`)).length;
        plan = await planGeneral(tabId, frameId, prefix);
        planned = ruleAssignments(plan);
        if (pass === MAX_GENERAL_PASSES) break;
      }
      const missing = [...plan.unmatched, ...plan.matched].map(field => field.id);
      for (const [key, id] of refused) if (!missing.includes(id) && !plan.matched.some(field => field.key === key)) missing.push(id);
      needYou.push(...missing.map(id => prefix ? `f${frameId}:${id}` : id));
    }
    return { filled, needYou, laya: placedByLaya };
  } finally { values = null; }
}

// One click on an approved site, with the plan the AI saw when the widget sends guesses.
async function fillSiteOnce(tabId, url, guesses) {
  try {
    const stored = sitePlans.get(tabId);
    sitePlans.delete(tabId);
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
        const enabled = await enabledSiteFrames(tabId, siteOrigin(url));
        if (frames.some(frame => !enabled.some(item => item.frameId === frame.frameId))) throw fault(FRAME_ERROR);
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
    const { needYou, laya: suggested } = await fillPlan(tabId, url, frames, { prefix: true, laya });
    const tally = await tallySite(tabId, frames);
    const filled = tally.rule + tally.guess;
    return siteResult('done', siteSummary(filled, tally.guess, needYou, tally.next, suggested), { filled, guessed: tally.guess, needYou, ...(suggested ? { laya: suggested } : {}) });
  } catch (error) {
    const { state, ...message } = failed(error);
    return siteResult(state, message);
  }
}

// One fill on an Iowa page the Iowa adapter hasn't verified. Iowa's portal needs no site approval.
async function fillIowaGeneral(tabId, state, plan, guard, laya = null) {
  const { pageKey } = state.page;
  try {
    const { filled, needYou, laya: suggested } = await fillPlan(tabId, state.url, [{ frameId: 0, plan }], { guard, laya });
    return { state: 'done', filled, needYou, ...say('result.thenTodo', { summary: withLaya(filledSummary(filled, needYou), suggested), todo: { key: GENERAL_TODO, params: {} } }),
      todo: english(GENERAL_TODO), todoKey: GENERAL_TODO, todoParams: {}, pageKey, ...(suggested ? { laya: suggested } : {}) };
  } catch (error) {
    return { ...failed(error), filled: 0, needYou: [], pageKey };
  }
}

async function fillSite(tabId, guesses) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  if (!siteRuns.has(tabId)) siteRuns.set(tabId, fillSiteOnce(tabId, tab.url, guesses).then(result => remember(tabId, result)).finally(() => siteRuns.delete(tabId)));
  return siteRuns.get(tabId);
}

// The side panel routes by the tab's current page; a widget acts only as what it was loaded on.
async function pageState(tabId, route) {
  const state = await currentPageState(tabId, route);
  // Only the side panel (no route) opens the question list the widget asked for.
  return route === undefined && questionViews.delete(tabId) ? { ...state, showQuestions: true } : state;
}
async function currentPageState(tabId, route) {
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) return iowaPageState(tabId);
  const origin = route === 'iowa' ? '' : siteOrigin(tab.url);
  if (!origin) throw fault('worker.openIowaPortal');
  const enabled = await siteEnabled(origin);
  const result = results.get(tabId);
  return { page: { kind: 'general', pageKey: 'general' }, result: enabled && result?.pageKey === 'general' ? result : null, autopilot: false,
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
// widget's measured width, one row taller while it shows a line.
const cardWidth = width => Number.isInteger(width) && width > 0 && width <= 1000; // CSS pixels; the page caps it
async function widgetSize(tabId, line, width) {
  const reply = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:widgetSize', line, ...(width === undefined ? {} : { width }) }, { frameId: 0 });
  if (reply?.sized !== true) throw fault('worker.requestFailed');
  return { sized: true };
}
// The widget's one line: the first key point of the page on screen.
function summaryLine(tabId, url) {
  const summary = pageReads.get(tabId)?.get(url)?.summary;
  return summary?.points.length ? { summary: { language: summary.language, point: summary.points[0], english: summary.english } } : {};
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
  else if (panel && message.type === 'ui:desktopStatus') {
    run = () => nativeRequest('status').then(data => ({ connected: true, unlocked: Boolean(data?.unlocked), laya: layaState(data) }),
      error => { if (error.code === 'offline') return { connected: false, unlocked: false, laya: 'unavailable' }; throw error; });
  } else if (!Number.isInteger(tabId)) return;
  else if (message.type === 'ui:pageState') run = () => pageState(tabId, route);
  else if (message.type === 'ui:autofill' && message.confirmed === true) run = () => autofill(tabId, route, message.guesses);
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
  else if (launcher && message.type === 'ui:widgetSize' && typeof message.line === 'boolean' && (message.width === undefined || cardWidth(message.width))) run = () => widgetSize(tabId, message.line, message.width);
  else return;
  // A widget on another site is honored only while that site is turned on.
  const work = route === 'site' ? requireSite(siteOrigin(sender.tab.url)).then(run) : run();
  work.then(data => respond({ ok: true, data }), error => respond(errorReply(error)));
  return true;
});
chrome.tabs.onActivated?.addListener(info => {
  for (const tabId of autopilots.keys()) if (tabId !== info.tabId) stopAutopilot(tabId, { state: 'stopped', filled: 0, needYou: [], ...say('worker.stoppedTabChanged'), pageKey: results.get(tabId)?.pageKey || '' });
});
chrome.tabs.onRemoved?.addListener(tabId => { results.delete(tabId); autopilots.delete(tabId); generalPages.delete(tabId); sitePlans.delete(tabId); questionViews.delete(tabId); pageReads.delete(tabId); });
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (change.status === 'loading') {
    results.delete(tabId);
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
});
// Site registrations made by an older version name its older script list; an update brings them current.
async function refreshSiteScripts() {
  const stale = (await chrome.scripting.getRegisteredContentScripts()).filter(script => /^(site|frame)-/.test(script.id) &&
    JSON.stringify(script.js) !== JSON.stringify(SITE_FILES.js));
  if (stale.length) await chrome.scripting.updateContentScripts(stale.map(script => ({ id: script.id, js: [...SITE_FILES.js] })));
}
chrome.runtime.onInstalled?.addListener(details => { if (details.reason === 'update') void refreshSiteScripts(); });
// Chrome's native panel persists alongside navigation; it never opens itself.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
