'use strict';
importScripts('iowa-adapter.js', 'generic-adapter.js');
if (typeof globalThis.SecondHandGeneric?.requestKeys !== 'function' || typeof globalThis.SecondHandGeneric.deriveValues !== 'function') {
  throw new Error('SecondHand could not load generic-adapter.js. Reinstall the extension.');
}
const HOST = 'org.secondhand.bridge';
const IOWA_ORIGIN = new URL(SecondHandIowa.PORTAL).origin;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,59}$/; // Iowa field keys and saved profile keys
const SITE_FIELD_ID = /^f\d{1,6}:[A-Za-z][A-Za-z0-9_-]{0,59}$/;
const FRAME_ERROR = "Part of this form couldn’t be filled safely. Fill it yourself.";
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/; // field ids from the site engine's plan
const results = new Map(); // tabId -> last autofill result: counts, keys, and fixed messages only. Never answers.
const siteRuns = new Map(); // tabId -> the fill running on an approved site, so two clicks share one request.
// tabId -> { steps, handled, running }. Memory only: a page can never turn autofill on,
// and if Chrome restarts this worker, autofill is off and the widget shows Autofill again.
const autopilots = new Map();
const MAX_STEPS = 15;
// tabId -> the Iowa page (origin + path) where the general engine found fields, until the tab navigates.
const generalPages = new Map();
const GENERAL_TODO = 'Check your answers, then click Continue.';

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
async function siteEnabled(origin) {
  const [scripts, allowed] = await Promise.all([chrome.scripting.getRegisteredContentScripts({ ids: [siteScript(origin).id] }),
    chrome.permissions.contains({ origins: [`${origin}/*`] })]);
  return scripts.length === 1 && allowed;
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

// Discover embedded origins through the approved top document, without reaching
// into an iframe before Chrome and the desktop have approved its origin.
async function siteFrames(tabId, origin) {
  const reply = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:frames' }, { frameId: 0 });
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
    const script = siteScript(frameOrigin);
    if ((await chrome.scripting.getRegisteredContentScripts({ ids: [script.id] })).length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  }
  if (pending.length) await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: siteScript(origin).js });
  return { enabled: true, origin };
}

async function disableSite(tabId) {
  const { origin } = await activeSite(tabId);
  const frames = await siteEnabled(origin) ? await siteFrames(tabId, origin) : [];
  const origins = [origin, ...frames.filter(frame => frame.enabled).map(frame => frame.origin)];
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: origins.map(value => siteScript(value).id) });
  if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: scripts.map(script => script.id) });
  await removeAccess(origins);
  results.delete(tabId);
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

const siteResult = (state, message, extra = {}) => ({ state, filled: 0, guessed: [], needYou: [], message, pageKey: 'general', ...extra });
const filledSummary = (filled, needYou) => `Filled ${filled}${needYou.length ? ` · ${needYou.length} need you` : ''}.`;

// The general engine's plan for the page: field ids, keys, and labels only.
async function planGeneral(tabId) {
  const plan = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:plan' }, { frameId: 0 });
  if (!plan || typeof plan.token !== 'string' || !Array.isArray(plan.matched) || !Array.isArray(plan.unmatched)) throw new Error('This page couldn’t be checked safely. Fill it yourself.');
  return plan;
}

// One fill from a general-engine plan: one desktop request for the matched keys, then fill.
// Never continues, submits, or navigates.
async function fillPlan(tabId, url, plan) {
  let values = null;
  try {
    const keys = plan.matched.length ? [...new Set(SecondHandGeneric.requestKeys(plan.matched.map(field => field.key)))] : [];
    if (keys.some(key => typeof key !== 'string' || !KEY.test(key))) throw new Error('SecondHand could not prepare the field request.');
    let filled = [];
    if (keys.length) {
      const desktop = await nativeRequest('status');
      if (!desktop?.unlocked) throw new Error('Unlock SecondHand to autofill.');
      const response = await nativeRequest('getFields', { url: safeUrl(url), fields: keys });
      if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw new Error('The desktop did not return supported profile fields.');
      values = SecondHandGeneric.deriveValues(response.values);
      const current = await chrome.tabs.get(tabId);
      if (current.url !== url || !current.active) throw new Error('The page changed. Click Autofill again.');
      const assignments = plan.matched.filter(field => typeof values[field.key] === 'string' && values[field.key])
        .map(field => ({ id: field.id, key: field.key, guessed: false }));
      if (assignments.length) {
        // Only the values being placed go to the page.
        const placing = Object.fromEntries(assignments.map(({ key }) => [key, values[key]]));
        values = null;
        const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:fill', token: plan.token, assignments, values: placing }, { frameId: 0 });
        if (!result?.ok || !Array.isArray(result.filled)) throw new Error('This page couldn’t be filled safely. Fill it yourself.');
        filled = result.filled;
      }
    }
    const needYou = [...plan.unmatched.map(field => field.id), ...plan.matched.map(field => field.id).filter(id => !filled.includes(id))];
    return { filled: filled.length, needYou };
  } finally { values = null; }
}

// One fill on an approved site.
async function fillSiteOnce(tabId, url) {
  let values = null;
  try {
    let plans;
    try {
      const origin = siteOrigin(url);
      const embedded = await siteFrames(tabId, origin);
      const readPlan = async frameId => {
        const plan = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:plan' }, { frameId });
        if (!plan || typeof plan.token !== 'string' || !plan.token || !Array.isArray(plan.matched) || !Array.isArray(plan.unmatched) ||
          [...plan.matched, ...plan.unmatched].some(field => !field || typeof field.id !== 'string' || !FIELD_ID.test(field.id)) ||
          plan.matched.some(field => typeof field.key !== 'string' || !KEY.test(field.key))) throw new Error(FRAME_ERROR);
        const ids = [...plan.matched, ...plan.unmatched].map(field => field.id);
        if (new Set(ids).size !== ids.length) throw new Error(FRAME_ERROR);
        return { frameId, plan };
      };
      const top = await readPlan(0);
      const pending = embedded.filter(frame => !frame.enabled);
      // This instruction must work before Chrome permits access to child frames.
      if (!top.plan.matched.length && !top.plan.unmatched.length && pending.length) {
        const hosts = pending.map(frame => new URL(frame.origin).hostname).join(', ');
        return siteResult('waiting', `This form is inside ${hosts}. Click “Also turn on the embedded form” in the SecondHand side panel.`);
      }
      const frames = await enabledSiteFrames(tabId, origin);
      plans = [top, ...await Promise.all(frames.filter(frame => frame.frameId !== 0).map(frame => readPlan(frame.frameId)))];
    } catch { throw new Error(FRAME_ERROR); }
    const keys = [...new Set(SecondHandGeneric.requestKeys(plans.flatMap(({ plan }) => plan.matched.map(field => field.key))))];
    if (keys.some(key => typeof key !== 'string' || !KEY.test(key))) throw new Error(FRAME_ERROR);
    const filled = new Set();
    if (keys.length) {
      const desktop = await nativeRequest('status');
      if (!desktop?.unlocked) throw new Error('Unlock SecondHand to autofill.');
      const response = await nativeRequest('getFields', { url: safeUrl(url), fields: keys });
      if (!response?.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw new Error('The desktop did not return supported profile fields.');
      values = SecondHandGeneric.deriveValues(response.values);
      const current = await chrome.tabs.get(tabId);
      if (current.url !== url || !current.active) throw new Error('The page changed. Click Autofill again.');
      for (const { frameId, plan } of plans) {
        const assignments = plan.matched.filter(field => typeof values[field.key] === 'string' && values[field.key])
          .map(field => ({ id: field.id, key: field.key, guessed: false }));
        if (!assignments.length) continue;
        try {
          const placing = Object.fromEntries(assignments.map(({ key }) => [key, values[key]]));
          const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:generic:fill', token: plan.token, assignments, values: placing }, { frameId });
          const assigned = new Set(assignments.map(field => field.id));
          const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && assigned.has(id)) && new Set(ids).size === ids.length;
          if (result?.ok !== true || !validIds(result.filled) || (result.rejected !== undefined && !validIds(result.rejected)) || (result.skipped !== undefined && !validIds(result.skipped))) throw new Error(FRAME_ERROR);
          for (const id of result.filled) if (!(result.rejected || []).includes(id)) filled.add(`f${frameId}:${id}`);
        } catch { throw new Error(FRAME_ERROR); }
      }
    }
    const needYou = plans.flatMap(({ frameId, plan }) => [...plan.unmatched, ...plan.matched].map(field => `f${frameId}:${field.id}`).filter(id => !filled.has(id)));
    return siteResult('done', `${filledSummary(filled.size, needYou)} Check your answers before you submit.`, { filled: filled.size, needYou });
  } catch (error) {
    const { state, message } = failed(error);
    return siteResult(state, message);
  } finally { values = null; }
}

// One fill on an Iowa page the Iowa adapter hasn't verified. Iowa's portal needs no site approval.
async function fillIowaGeneral(tabId, state, plan) {
  const { pageKey } = state.page;
  try {
    const { filled, needYou } = await fillPlan(tabId, state.url, plan);
    return { state: 'done', filled, needYou, message: `${filledSummary(filled, needYou)} ${GENERAL_TODO}`, todo: GENERAL_TODO, pageKey };
  } catch (error) {
    return { ...failed(error), filled: 0, needYou: [], pageKey };
  }
}

async function fillSite(tabId) {
  const { tab, origin } = await activeSite(tabId);
  await requireSite(origin);
  if (!siteRuns.has(tabId)) siteRuns.set(tabId, fillSiteOnce(tabId, tab.url).then(result => remember(tabId, result)).finally(() => siteRuns.delete(tabId)));
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
  return { page: { kind: 'general', pageKey: 'general' }, result: enabled && result?.pageKey === 'general' ? result : null, autopilot: false, site: { origin, enabled, frames: enabled ? await siteFrames(tabId, origin) : [] } };
}

async function autofill(tabId, route) {
  const tab = await chrome.tabs.get(tabId);
  if (route !== 'site' && SecondHandIowa.isSupportedUrl(tab.url)) return startAutopilot(tabId);
  if (route !== 'iowa' && siteOrigin(tab.url)) return fillSite(tabId);
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
  else if (message.type === 'ui:autofill' && message.confirmed === true) run = () => autofill(tabId, route);
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
chrome.tabs.onRemoved?.addListener(tabId => { results.delete(tabId); autopilots.delete(tabId); generalPages.delete(tabId); });
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (change.status === 'loading') {
    results.delete(tabId);
    generalPages.delete(tabId);
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
