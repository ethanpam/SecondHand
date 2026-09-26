'use strict';
importScripts('iowa-adapter.js');
const HOST = 'org.secondhand.bridge';
const results = new Map(); // tabId -> last autofill result: counts, keys, and fixed messages only. Never answers.
// tabId -> { steps, handled, running }. Memory only: a page can never turn autofill on,
// and if Chrome restarts this worker, autofill is off and the widget shows Autofill again.
const autopilots = new Map();
const MAX_STEPS = 15;

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
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['iowa-adapter.js', 'content.js'] });
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
    if (error.code === 'offline') return { state: 'offline', filled: 0, needYou: [], message: 'Open the SecondHand app, then click Autofill again.', pageKey };
    if (/Unlock/.test(error.message)) return { state: 'locked', filled: 0, needYou: [], message: 'Unlock SecondHand to autofill.', pageKey };
    const message = /cancelled/i.test(error.message) ? 'Cancelled. Nothing was filled.' : error.message || 'Autofill failed. Fill this page yourself.';
    return { state: 'error', filled: 0, needYou: [], message, pageKey };
  } finally { values = null; }
}

function stopAutopilot(tabId, result) {
  autopilots.delete(tabId);
  return remember(tabId, result);
}

// One autopilot step per page: continue an info screen, fill a known form, or
// wait with the page's instruction. Unknown pages end autofill.
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

async function pageState(tabId) {
  if (autopilots.has(tabId) && !autopilots.get(tabId).running) await step(tabId);
  const state = await readPage(tabId);
  const result = results.get(tabId);
  return { page: state.page, scan: state.scan, result: result && result.pageKey === state.page.pageKey ? result : null, autopilot: autopilots.has(tabId) };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || Array.isArray(message)) return;
  // Only our own extension pages reach the vault: the side panel, and the
  // launcher iframe inside an Iowa tab (bound to that tab). Content scripts and
  // page postMessages never do.
  const panel = sender.url === chrome.runtime.getURL('panel.html') && !sender.tab;
  const launcher = sender.url === chrome.runtime.getURL('panel.html?surface=launcher') && sender.frameId > 0 &&
    Number.isInteger(sender.tab?.id) && SecondHandIowa.isSupportedUrl(sender.tab.url);
  if (!panel && !launcher) return;
  if (launcher && message.type === 'ui:openPanel' && message.confirmed === true) {
    // Keep this synchronous: Chrome requires the originating trusted user gesture.
    chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => respond({ ok: true, data: { opened: true } }),
      () => respond({ ok: false, error: 'Use the SecondHand toolbar icon to open the side panel.' }));
    return true;
  }
  const tabId = launcher ? sender.tab.id : message.tabId;
  let work;
  if (message.type === 'ui:showApp' && message.confirmed === true) work = nativeRequest('showApp');
  else if (panel && message.type === 'ui:desktopStatus') {
    work = nativeRequest('status').then(data => ({ connected: true, unlocked: Boolean(data?.unlocked) }),
      error => { if (error.code === 'offline') return { connected: false, unlocked: false }; throw error; });
  } else if (!Number.isInteger(tabId)) return;
  else if (message.type === 'ui:pageState') work = pageState(tabId);
  else if (message.type === 'ui:autofill' && message.confirmed === true) work = startAutopilot(tabId);
  else if (message.type === 'ui:stop' && message.confirmed === true) work = stop(tabId);
  else if (message.type === 'ui:focusField' && typeof message.key === 'string' && /^[A-Za-z][A-Za-z0-9]{0,59}$/.test(message.key)) {
    work = activePortal(tabId).then(() => chrome.tabs.sendMessage(tabId, { type: 'secondhand:focusField', key: message.key }, { frameId: 0 }));
  } else return;
  work.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || 'SecondHand could not complete the request.' }));
  return true;
});
chrome.tabs.onRemoved?.addListener(tabId => { results.delete(tabId); autopilots.delete(tabId); });
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (change.status === 'loading') {
    results.delete(tabId);
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
