'use strict';
importScripts('iowa-adapter.js', 'generic-adapter.js');
if (typeof globalThis.SecondHandGeneric?.requestKeys !== 'function' || typeof globalThis.SecondHandGeneric.deriveValues !== 'function' || !Array.isArray(globalThis.SecondHandGeneric.GENERIC_KEYS)) {
  throw new Error('SecondHand could not load generic-adapter.js. Reinstall the extension.');
}
// Must match BUILD in panel.js: change both together. The panel compares them to tell
// when Chrome is still running an older worker than the pages it loaded from disk.
const BUILD = '2026-09-26.2';
const HOST = 'org.secondhand.bridge';
const IOWA_ORIGIN = new URL(SecondHandIowa.PORTAL).origin;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,59}$/; // Iowa field keys and saved profile keys
const SITE_FIELD_ID = /^f\d{1,6}:[A-Za-z][A-Za-z0-9_-]{0,59}$/;
const FRAME_ERROR = "Part of this form couldn’t be filled safely. Fill it yourself.";
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/; // field ids from the site engine's plan
const results = new Map(); // tabId -> last autofill result: counts, keys, and fixed messages only. Never answers.
const siteRuns = new Map(); // tabId -> the fill running on an approved site, so two clicks share one request.
const sitePlans = new Map(); // tabId -> { url, frames } the widget's on-device AI saw. Field metadata only.
// tabId -> { steps, handled, running }. Memory only: a page can never turn autofill on,
// and if Chrome restarts this worker, autofill is off and the widget shows Autofill again.
const autopilots = new Map();
const MAX_STEPS = 15;
// tabId -> the Iowa page (origin + path) where the general engine found fields, until the tab navigates.
const generalPages = new Map();
const GENERAL_TODO = 'Check your answers, then click Continue.';
const MAX_GENERAL_PASSES = 4;
// Sensitive answers (identity, money, health, immigration) are placed only by a confident
// rule match, never by an AI guess.
const SENSITIVE_KEYS = Object.freeze(['ssn', 'birthDate', 'ageRange', 'totalMonthlyIncome', 'annualIncome', 'assetsOnHand', 'monthlyMedicalExpenses',
  'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare']);
const AI_KEYS = Object.freeze(SecondHandGeneric.GENERIC_KEYS.filter(key => !SENSITIVE_KEYS.includes(key)));

function nativeRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let settled = false, port, timer;
    const finish = (error, data, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* already disconnected */ }
      if (error) reject(Object.assign(new Error(error), code ? { code } : {})); else resolve(data);
    };
    try {
      port = chrome.runtime.connectNative(HOST);
      timer = setTimeout(() => finish('Desktop approval timed out. Click Autofill again.'), 115000);
      port.onMessage.addListener(message => {
        if (!message || message.id !== id) return finish('Unexpected desktop response. Nothing further was done.');
        if (message.ok !== true) return finish(typeof message.error === 'string' ? message.error.slice(0, 240) : 'The desktop declined this request.');
        finish(null, message.data);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finish('Cannot reach SecondHand. Open the app and prepare its Chrome extension.', undefined, 'offline');
      });
      port.postMessage({ id, type, ...payload });
    } catch { finish('Cannot reach SecondHand. Open the app and prepare its Chrome extension.', undefined, 'offline'); }
  });
}
function safeUrl(raw) { const url = new URL(raw); return url.origin + url.pathname; }
async function activePortal(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.id !== tabId || !tab.active || !SecondHandIowa.isSupportedUrl(tab.url)) throw new Error('Open the official Iowa portal in the active tab, then try again.');
  return tab;
}
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['iowa-adapter.js', 'generic-adapter.js', 'content.js'] });
}
async function readPage(tabId) {
  const tab = await activePortal(tabId);
  await inject(tabId);
  const state = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:pageState' }, { frameId: 0 });
  const current = await activePortal(tabId);
  if (current.url !== tab.url || !state?.page || !state.scan) throw new Error('The page changed. Wait for it to finish loading.');
  return { ...state, url: tab.url };
}
const needYou = page => (Array.isArray(page.checklist) ? page.checklist : [])
  .filter(item => (item.required && item.status === 'missing') || item.status === 'manual').map(item => item.key);
function remember(tabId, result) { results.set(tabId, result); return result; }
function failed(error) {
  if (error.code === 'offline') return { state: 'offline', message: 'Open the SecondHand app, then click Autofill again.' };
  if (/Unlock/.test(error.message)) return { state: 'locked', message: 'Unlock SecondHand to autofill.' };
  return { state: 'error', message: /cancelled/i.test(error.message) ? 'Cancelled. Nothing was filled.' : error.message || 'Autofill failed. Fill this page yourself.' };
}

// One desktop request for the page's saved fields, then up to four fill passes so
// answers that reveal conditional sections get their follow-ups.
async function fillPage(tabId, state) {
  const { url } = state;
  const pageKey = state.page.pageKey;
  let values = null;
  try {
    const desktop = await nativeRequest('status');
    if (!desktop?.unlocked) return { state: 'locked', filled: 0, needYou: [], message: 'Unlock SecondHand to autofill.', pageKey };
    const response = await nativeRequest('getFields', { url: safeUrl(url), fields: SecondHandIowa.profileRequest(pageKey) });
    if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw new Error('The desktop did not return supported profile fields.');
    values = SecondHandIowa.pageValues(pageKey, response.values);
    let filled = 0;
    const attempted = new Set();
    for (let pass = 0; pass < 4; pass++) {
      if ((await activePortal(tabId)).url !== url) throw new Error('The page changed. Click Autofill again.');
      const fresh = pass === 0 ? state : await readPage(tabId);
      const keys = fresh.scan.fields.map(field => field.key).filter(key => !attempted.has(key) && typeof values[key] === 'string' && values[key]);
      if (!keys.length) break;
      keys.forEach(key => attempted.add(key));
      const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:fill', token: fresh.scan.token, fields: keys,
        values: Object.fromEntries(keys.map(key => [key, values[key]])) }, { frameId: 0 });
      if (!result?.ok) throw new Error('This page couldn’t be filled safely. Fill it yourself.');
      filled += result.filledCount;
      if (!result.filledCount) break;
    }
    values = null;
    const after = await readPage(tabId);
    // The tracker is secondary: the page is already filled, so a failed update
    // must not turn a successful fill into an error.
    if (filled > 0) await nativeRequest('recordProgress', { url: safeUrl(url), filledCount: Math.min(filled, 100) }).catch(() => {});
    const missing = needYou(after.page);
    const summary = filled ? `Filled ${filled}${missing.length ? ` · ${missing.length} need you` : ''}.`
      : missing.length ? `${missing.length} need you. They aren’t in your saved profile.` : 'Nothing new to fill.';
    return { state: 'done', filled, needYou: missing, message: [summary, after.page.todo].filter(Boolean).join(' '), todo: after.page.todo || '', pageKey: after.page.pageKey };
  } catch (error) {
    return { ...failed(error), filled: 0, needYou: [], pageKey };
  } finally { values = null; }
}

function stopAutopilot(tabId, result) {
  autopilots.delete(tabId);
  return remember(tabId, result);
}

// One autopilot step per page: continue an info screen, fill a known form, or
// wait with the page's instruction. An unknown page gets one general-engine fill
// and waits for the applicant; with nothing the engine recognizes, autofill ends.
function step(tabId) {
  const pilot = autopilots.get(tabId);
  if (!pilot) return Promise.resolve(results.get(tabId) || null);
  if (pilot.running) return pilot.running;
  pilot.running = (async () => {
    let state;
    // A page that is still loading or not in front is retried on the next load or poll.
    try { state = await readPage(tabId); } catch { return results.get(tabId) || null; }
    const { page } = state;
    const signature = `${safeUrl(state.url)}|${page.pageKey}`;
    if (pilot.handled.has(signature)) return results.get(tabId) || null;
    pilot.handled.add(signature);
    if (++pilot.steps > MAX_STEPS) return stopAutopilot(tabId, { state: 'stopped', filled: 0, needYou: [], message: `Stopped after ${MAX_STEPS} steps. Check this page, then click Autofill to keep going.`, pageKey: page.pageKey });
    try {
      if (page.kind === 'info') {
        remember(tabId, { state: 'continuing', filled: 0, needYou: [], message: 'Continuing…', pageKey: page.pageKey });
        const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:continue' }, { frameId: 0 });
        if (!result?.continued) return remember(tabId, { state: 'waiting', filled: 0, needYou: [], message: result?.reason || 'Click Continue in Iowa’s form.', pageKey: page.pageKey });
        return results.get(tabId);
      }
      if (page.kind === 'fillable' && state.scan.recognizedPage) {
        const result = await fillPage(tabId, state);
        return result.state === 'done' ? remember(tabId, result) : stopAutopilot(tabId, result);
      }
      if (page.todo) return remember(tabId, { state: 'waiting', filled: 0, needYou: needYou(page), message: page.todo, pageKey: page.pageKey });
      if (page.kind === 'manual') {
        // Never clicks Continue here: the applicant checks the general engine's answers first.
        const plan = await planGeneral(tabId);
        const url = safeUrl(state.url);
        if (plan.matched.length || generalPages.get(tabId) === url) {
          generalPages.set(tabId, url);
          const result = await fillIowaGeneral(tabId, state, plan);
          return result.state === 'done' ? remember(tabId, result) : stopAutopilot(tabId, result);
        }
      }
      return stopAutopilot(tabId, { state: 'stopped', filled: 0, needYou: [], message: 'SecondHand doesn’t know this page yet. Fill it in, then continue.', pageKey: page.pageKey });
    } catch (error) {
      return stopAutopilot(tabId, { state: 'error', filled: 0, needYou: [], message: error.message || 'Autofill stopped. Continue in Iowa’s form.', pageKey: page.pageKey });
    }
  })().finally(() => { pilot.running = null; });
  return pilot.running;
}

async function startAutopilot(tabId) {
  await activePortal(tabId);
  autopilots.set(tabId, { steps: 0, handled: new Set(), running: null });
  return step(tabId);
}

async function stop(tabId) {
  const pageKey = await readPage(tabId).then(state => state.page.pageKey, () => results.get(tabId)?.pageKey || '');
  return stopAutopilot(tabId, { state: 'stopped', filled: 0, needYou: [], message: 'Autofill stopped.', pageKey });
}

async function iowaPageState(tabId) {
  if (autopilots.has(tabId) && !autopilots.get(tabId).running) await step(tabId);
  const state = await readPage(tabId);
  const result = results.get(tabId);
  // Once the general engine found fields on an unknown page, it waits for the applicant like any other step.
  const general = state.page.kind === 'manual' && !state.page.todo && generalPages.get(tabId) === safeUrl(state.url);
  const page = general ? { ...state.page, todo: GENERAL_TODO } : state.page;
  return { page, scan: state.scan, result: result && result.pageKey === state.page.pageKey ? result : null, autopilot: autopilots.has(tabId) };
}

// Other https sites the user turned on: Chrome access for the origin plus our
// registered content script. The desktop keeps its own trusted list and has the final say.
function siteOrigin(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.port && url.origin !== IOWA_ORIGIN ? url.origin : '';
  } catch { return ''; }
}
const siteScript = origin => ({ id: `site-${new URL(origin).hostname}`, matches: [`${origin}/*`],
  js: ['generic-adapter.js', 'generic-content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true });
const frameScriptPrefix = origin => `frame-${new URL(origin).hostname}--`;
const frameScript = (topOrigin, origin) => ({ ...siteScript(origin), id: `${frameScriptPrefix(topOrigin)}${new URL(origin).hostname}` });
async function siteEnabled(origin) {
  const [scripts, allowed] = await Promise.all([chrome.scripting.getRegisteredContentScripts(),
    chrome.permissions.contains({ origins: [`${origin}/*`] })]);
  return scripts.some(script => script.matches.includes(`${origin}/*`)) && allowed;
}
async function requireSite(origin) {
  if (!(await siteEnabled(origin))) throw new Error('Turn on SecondHand for this site in the side panel first.');
}
async function activeSite(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = siteOrigin(tab.url);
  if (tab.id !== tabId || !tab.active || !origin) throw new Error('Open the form in the active tab, then try again.');
  return { tab, origin };
}

async function enableSite(tabId) {
  const { tab, origin } = await activeSite(tabId);
  const origins = [`${origin}/*`];
  // The side panel asks Chrome inside the user's click; the worker only confirms it happened.
  if (!(await chrome.permissions.contains({ origins }))) throw new Error('Chrome hasn’t allowed SecondHand on this site. Click Turn on again and allow it.');
  try {
    const trust = await nativeRequest('trustSite', { url: safeUrl(tab.url) });
    if (trust?.trusted !== true || trust.origin !== origin) throw new Error('The SecondHand app did not approve this site.');
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
      const missing = new Error('Reload this page, then click Autofill.');
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
  if (!reply || !Array.isArray(reply.origins) || reply.origins.some(value => typeof value !== 'string')) throw new Error(FRAME_ERROR);
  const origins = [...new Set(reply.origins.map(siteOrigin).filter(value => value && value !== origin))];
  return Promise.all(origins.map(async origin => ({ origin, enabled: await siteEnabled(origin) })));
}

async function removeAccess(origins) {
  const patterns = origins.map(origin => `${origin}/*`);
  const removed = await chrome.permissions.remove({ origins: patterns });
  const kept = await Promise.all(patterns.map(origin => chrome.permissions.contains({ origins: [origin] })));
  if (!removed || kept.some(Boolean)) throw new Error('Chrome kept SecondHand’s access to this site. Remove it on Chrome’s extension page.');
}

async function enableFrames(tabId) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  const pending = (await siteFrames(tabId, origin)).filter(frame => !frame.enabled).map(frame => frame.origin);
  for (const frameOrigin of pending) {
    if (!(await chrome.permissions.contains({ origins: [`${frameOrigin}/*`] }))) throw new Error('Chrome hasn’t allowed SecondHand on the embedded form. Click Also turn on again and allow it.');
  }
  // Obtain every approval before registering any of the new scripts.
  try {
    for (const frameOrigin of pending) {
      const trust = await nativeRequest('trustSite', { url: frameOrigin });
      if (trust?.trusted !== true || trust.origin !== frameOrigin) throw new Error('The SecondHand app did not approve this embedded form.');
    }
    const current = await chrome.tabs.get(tabId);
    if (current.url !== tab.url || !current.active) throw new Error('The page changed. Try again.');
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
  return { enabled: false, origin };
}

// Chrome supplies frame ids only after access has been granted. Never message
// an origin just because it appeared in the top document or in these results.
async function enabledSiteFrames(tabId, origin) {
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.origin });
  if (!Array.isArray(frames) || !frames.some(frame => frame.frameId === 0 && frame.result === origin)) throw new Error(FRAME_ERROR);
  const enabled = [];
  for (const frame of frames) {
    if (!Number.isInteger(frame.frameId) || frame.frameId < 0 || frame.frameId > 999999) throw new Error(FRAME_ERROR);
    const frameOrigin = siteOrigin(frame.result);
    if (frameOrigin && await siteEnabled(frameOrigin)) enabled.push({ frameId: frame.frameId, origin: frameOrigin });
  }
  return enabled;
}

const siteResult = (state, message, extra = {}) => ({ state, filled: 0, guessed: 0, needYou: [], message, pageKey: 'general', ...extra });
const filledSummary = (filled, needYou) => `Filled ${filled}${needYou.length ? ` · ${needYou.length} need you` : ''}.`;

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
    if (!Array.isArray(injections) || injections.length !== frameIds.length || new Set(injections.map(item => item.frameId)).size !== frameIds.length) throw new Error(FRAME_ERROR);
    const total = { rule: 0, guess: 0, next: false };
    for (const { frameId, result: tally } of injections) {
      if (!frameIds.includes(frameId) || !Number.isInteger(tally?.rule) || tally.rule < 0 || !Number.isInteger(tally.guess) || tally.guess < 0 || typeof tally.next !== 'boolean') throw new Error(FRAME_ERROR);
      total.rule += tally.rule; total.guess += tally.guess; total.next ||= tally.next;
    }
    return total;
  } catch { throw new Error(FRAME_ERROR); }
}
function siteSummary(filled, guessed, needYou, next) {
  if (filled) return `Filled ${filled}${guessed ? ` · ${guessed} guessed` : ''}${needYou.length ? ` · ${needYou.length} need you` : ''}. Check your answers before you submit.`;
  if (needYou.length) return `Nothing here matches your saved profile. ${needYou.length} need you.`;
  return next ? 'Nothing to fill here. Click Next, then Autofill again.' : 'Nothing to fill here.';
}

// The general engine's plan for the page: field ids, keys, and labels only.
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
async function planGeneral(tabId, frameId = 0, prefix = false) {
  try {
    const message = { type: 'secondhand:generic:plan' };
    const plan = prefix && frameId === 0 ? await topSiteMessage(tabId, message) : await chrome.tabs.sendMessage(tabId, message, { frameId });
    if (!plan || typeof plan.token !== 'string' || !Array.isArray(plan.matched) || !Array.isArray(plan.unmatched) ||
      plan.unmatched.some(field => typeof field?.id !== 'string' || !FIELD_ID.test(field.id) || typeof field.label !== 'string' || typeof field.type !== 'string' ||
        !strings(field.options) || typeof field.required !== 'boolean')) throw new Error('This page couldn’t be checked safely. Fill it yourself.');
    if (prefix) {
      const ids = [...plan.matched, ...plan.unmatched].map(field => field?.id);
      if (!plan.token || ids.some(id => typeof id !== 'string' || !FIELD_ID.test(id)) || new Set(ids).size !== ids.length ||
        plan.matched.some(field => typeof field.key !== 'string' || !KEY.test(field.key))) throw new Error(FRAME_ERROR);
    }
    return plan;
  } catch (error) {
    if (!prefix || error.code === 'site-not-ready') throw error;
    throw new Error(FRAME_ERROR);
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
    throw new Error(FRAME_ERROR);
  }
}
async function planSite(tabId) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  const { frames } = await siteFramePlans(tabId, tab.url);
  sitePlans.set(tabId, { url: tab.url, frames });
  return { unmatched: frames.flatMap(({ frameId, plan }) => plan.unmatched.map(({ id, label, type, options, required }) => ({ id: `f${frameId}:${id}`, label, type, options, required }))), allowedKeys: AI_KEYS };
}
// Guesses name fields of the plan the AI saw; a fresh plan would give the fields other ids.
function guessAssignments(stored, url, guesses) {
  if (stored?.url !== url) throw new Error('The page changed. Click Autofill again.');
  const open = new Set(stored.frames.flatMap(({ frameId, plan }) => plan.unmatched.map(field => `f${frameId}:${field.id}`)));
  const entries = guesses && typeof guesses === 'object' && !Array.isArray(guesses) ? Object.entries(guesses) : null;
  if (!entries || entries.some(([id, key]) => !SITE_FIELD_ID.test(id) || !open.has(id) || !AI_KEYS.includes(key))) throw new Error('SecondHand couldn’t use the on-device AI’s matches. Nothing was filled.');
  return stored.frames.map(({ frameId, plan }) => ({ frameId, plan, planned: [...ruleAssignments(plan),
    ...entries.filter(([id]) => id.startsWith(`f${frameId}:`)).map(([id, key]) => ({ id: id.split(':')[1], key, guessed: true }))] }));
}

// Fills from a general-engine plan: one desktop request for the keys planned first (the
// rules' matches and any AI guesses), then up to four fill passes so questions revealed by
// an answer are filled too. Each pass plans the page again. Never continues, submits, or navigates.
async function fillPlan(tabId, url, frames, prefix = false) {
  let values = null;
  try {
    const initial = frames.map(frame => ({ ...frame, planned: frame.planned || ruleAssignments(frame.plan) }));
    const keys = [...new Set(SecondHandGeneric.requestKeys(initial.flatMap(frame => frame.planned.map(item => item.key))))];
    if (keys.some(key => typeof key !== 'string' || !KEY.test(key))) throw new Error('SecondHand could not prepare the field request.');
    if (keys.length) {
      const desktop = await nativeRequest('status');
      if (!desktop?.unlocked) throw new Error('Unlock SecondHand to autofill.');
      const response = await nativeRequest('getFields', { url: safeUrl(url), fields: keys });
      if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw new Error('The desktop did not return supported profile fields.');
      values = SecondHandGeneric.deriveValues(response.values);
    }
    let filled = 0;
    const needYou = [];
    for (const frame of initial) {
      const { frameId } = frame;
      let { plan, planned } = frame;
      const refused = new Map(); // Refused keys stay local to this frame.
      if (values) for (let pass = 1; ; pass++) {
        const assignments = planned.filter(({ key }) => !refused.has(key) && typeof values[key] === 'string' && values[key]);
        if (!assignments.length) break;
        const current = await chrome.tabs.get(tabId);
        if (current.url !== url || !current.active) throw new Error('The page changed. Click Autofill again.');
        const placing = Object.fromEntries(assignments.map(({ key }) => [key, values[key]]));
        let result;
        try {
          const message = { type: 'secondhand:generic:fill', token: plan.token, assignments, values: placing };
          result = prefix && frameId === 0 ? await topSiteMessage(tabId, message) : await chrome.tabs.sendMessage(tabId, message, { frameId });
          const assigned = new Set(assignments.map(item => item.id));
          const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && assigned.has(id)) && new Set(ids).size === ids.length;
          if (!result?.ok || !validIds(result.filled) || !validIds(result.rejected) || (result.skipped !== undefined && !validIds(result.skipped))) throw new Error('This page couldn’t be filled safely. Fill it yourself.');
        } catch (error) {
          if (!prefix || error.code === 'site-not-ready') throw error;
          throw new Error(FRAME_ERROR);
        }
        for (const { id, key } of assignments) if (result.rejected.includes(id)) refused.set(key, id);
        const placed = assignments.filter(({ id }) => result.filled.includes(id) && !result.rejected.includes(id)).length;
        if (!placed) break;
        filled += placed;
        plan = await planGeneral(tabId, frameId, prefix);
        planned = ruleAssignments(plan);
        if (pass === MAX_GENERAL_PASSES) break;
      }
      const missing = [...plan.unmatched, ...plan.matched].map(field => field.id);
      for (const [key, id] of refused) if (!missing.includes(id) && !plan.matched.some(field => field.key === key)) missing.push(id);
      needYou.push(...missing.map(id => prefix ? `f${frameId}:${id}` : id));
    }
    return { filled, needYou };
  } finally { values = null; }
}

// One click on an approved site, with the plan the AI saw when the widget sends guesses.
async function fillSiteOnce(tabId, url, guesses) {
  try {
    const stored = sitePlans.get(tabId);
    sitePlans.delete(tabId);
    let frames, pending;
    if (guesses === undefined) ({ frames, pending } = await siteFramePlans(tabId, url, true));
    else {
      frames = guessAssignments(stored, url, guesses);
      try {
        pending = (await siteFrames(tabId, siteOrigin(url))).filter(frame => !frame.enabled);
        const enabled = await enabledSiteFrames(tabId, siteOrigin(url));
        if (frames.some(frame => !enabled.some(item => item.frameId === frame.frameId))) throw new Error(FRAME_ERROR);
      } catch (error) {
        if (error.code === 'site-not-ready') throw error;
        throw new Error(FRAME_ERROR);
      }
    }
    const top = frames.find(frame => frame.frameId === 0).plan;
    if (!top.matched.length && !top.unmatched.length && pending.length) {
      const hosts = pending.map(frame => new URL(frame.origin).hostname).join(', ');
      return siteResult('waiting', `This form is inside ${hosts}. Click “Also turn on the embedded form” in the SecondHand side panel.`);
    }
    const { needYou } = await fillPlan(tabId, url, frames, true);
    const tally = await tallySite(tabId, frames);
    const filled = tally.rule + tally.guess;
    return siteResult('done', siteSummary(filled, tally.guess, needYou, tally.next), { filled, guessed: tally.guess, needYou });
  } catch (error) {
    const { state, message } = failed(error);
    return siteResult(state, message);
  }
}

// One fill on an Iowa page the Iowa adapter hasn't verified. Iowa's portal needs no site approval.
async function fillIowaGeneral(tabId, state, plan) {
  const { pageKey } = state.page;
  try {
    const { filled, needYou } = await fillPlan(tabId, state.url, [{ frameId: 0, plan }]);
    return { state: 'done', filled, needYou, message: `${filledSummary(filled, needYou)} ${GENERAL_TODO}`, todo: GENERAL_TODO, pageKey };
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
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) return iowaPageState(tabId);
  const origin = route === 'iowa' ? '' : siteOrigin(tab.url);
  if (!origin) throw new Error('Open the official Iowa portal in the active tab, then try again.');
  const enabled = await siteEnabled(origin);
  const result = results.get(tabId);
  return { page: { kind: 'general', pageKey: 'general' }, result: enabled && result?.pageKey === 'general' ? result : null, autopilot: false, site: { origin, enabled, ...(enabled ? await siteReadiness(tab, origin) : { frames: [], ready: false }) } };
}

async function autofill(tabId, route, guesses) {
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) {
    if (guesses !== undefined) throw new Error('Iowa’s form is filled by its own rules only.');
    return startAutopilot(tabId);
  }
  if (route !== 'iowa' && siteOrigin(tab.url)) return fillSite(tabId, guesses);
  throw new Error('Open the official Iowa portal in the active tab, then try again.');
}

async function focusField(tabId, key, route) {
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) {
    if (!FIELD_ID.test(key)) throw new Error('That field isn’t on this page.');
    await activePortal(tabId);
    // Iowa's own keys go to the Iowa adapter; the general engine's field ids ("sh-…") to the engine.
    if (KEY.test(key)) return chrome.tabs.sendMessage(tabId, { type: 'secondhand:focusField', key }, { frameId: 0 });
    const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:focus', id: key }, { frameId: 0 });
    return { focused: result?.focused === true };
  }
  if (route === 'iowa') throw new Error('Open the official Iowa portal in the active tab, then try again.');
  const { origin } = await activeSite(tabId);
  await requireSite(origin);
  if (!SITE_FIELD_ID.test(key)) throw new Error('That field isn’t on this page.');
  const [prefix, id] = key.split(':');
  const frameId = Number(prefix.slice(1));
  if (!(await enabledSiteFrames(tabId, origin)).some(frame => frame.frameId === frameId)) throw new Error('Turn on SecondHand for this embedded form first.');
  const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:focus', id }, { frameId });
  return { focused: result?.focused === true };
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
    // Keep this synchronous: Chrome requires the originating trusted user gesture.
    chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => respond({ ok: true, data: { opened: true } }),
      () => respond({ ok: false, error: 'Use the SecondHand toolbar icon to open the side panel.' }));
    return true;
  }
  const tabId = launcher ? sender.tab.id : message.tabId;
  let run;
  if (message.type === 'ui:showApp' && message.confirmed === true) run = () => nativeRequest('showApp');
  else if (panel && message.type === 'ui:desktopStatus') {
    run = () => nativeRequest('status').then(data => ({ connected: true, unlocked: Boolean(data?.unlocked) }),
      error => { if (error.code === 'offline') return { connected: false, unlocked: false }; throw error; });
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
  else return;
  // A widget on another site is honored only while that site is turned on.
  const work = route === 'site' ? requireSite(siteOrigin(sender.tab.url)).then(run) : run();
  work.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || 'SecondHand could not complete the request.' }));
  return true;
});
chrome.tabs.onRemoved?.addListener(tabId => { results.delete(tabId); autopilots.delete(tabId); generalPages.delete(tabId); sitePlans.delete(tabId); });
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (change.status === 'loading') {
    results.delete(tabId);
    generalPages.delete(tabId);
    sitePlans.delete(tabId);
    // Chrome omits other sites' URLs without the tabs permission, so re-read the
    // tab: anything that is not Iowa's portal (or unreadable) ends autofill.
    if (autopilots.has(tabId)) {
      chrome.tabs.get(tabId).then(tab => { if (!SecondHandIowa.isSupportedUrl(tab.url)) autopilots.delete(tabId); }, () => autopilots.delete(tabId));
    }
  }
  if (change.status === 'complete' && autopilots.has(tabId)) void step(tabId);
});
// Chrome's native panel persists alongside navigation; it never opens itself.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
