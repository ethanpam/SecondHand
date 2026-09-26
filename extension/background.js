'use strict';
importScripts('address-policy.js', 'iowa-adapter.js');
const HOST = 'org.secondhand.bridge';
const scans = new Map();
const pages = new Map();
const missingProfile = new Map(); // Field keys only, never answers.
let busy = false;
let busyTab = null;
let actionEpoch = 0;
let lastResult = null; // Fixed messages and counts only. Never profile values.
let assistance = null; // Token and workflow metadata only, cleared on restart/stop.

function nativeRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let settled = false, port, timer;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* already disconnected */ }
      if (error) reject(new Error(error)); else resolve(data);
    };
    try {
      port = chrome.runtime.connectNative(HOST);
      timer = setTimeout(() => finish('Desktop approval timed out. Reopen SecondHand and try again.'), 115000);
      port.onMessage.addListener(message => {
        if (!message || message.id !== id) return finish('Unexpected desktop response. Nothing further was done.');
        if (message.ok !== true) return finish(typeof message.error === 'string' ? message.error.slice(0, 240) : 'The desktop declined this request.');
        finish(null, message.data);
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        finish('Cannot reach SecondHand. Prepare or refresh the Chrome extension in the desktop app, and keep SecondHand unlocked.');
      });
      port.postMessage({ id, type, ...payload });
    } catch { finish('Cannot reach SecondHand. Check the desktop app and extension connection.'); }
  });
}
function safeUrl(raw) { const url = new URL(raw); return url.origin + url.pathname; }
function automaticState(tabId) {
  if (!assistance || assistance.tabId !== tabId) return { enabled: false, paused: false, reason: '', expiresAt: null };
  return { enabled: assistance.enabled, paused: assistance.paused, waitingForInfo: Boolean(assistance.waitingForInfo), reason: assistance.reason, expiresAt: assistance.expiresAt };
}
function status(tabId) { return { busy, lastResult, missingProfileFields: [...(missingProfile.get(tabId) || [])], extensionId: chrome.runtime.id, automatic: automaticState(tabId) }; }
function pause(reason, waitingForInfo = false) {
  if (assistance) { assistance.paused = true; assistance.waitingForInfo = waitingForInfo; assistance.reason = reason; }
  lastResult = { message: reason };
}
async function stopAutomatic(reason = 'Guided autofill stopped.') {
  const epoch = ++actionEpoch;
  const previous = assistance;
  assistance = null;
  if (previous?.token) {
    await nativeRequest('endAssistedSession', { url: previous.url, assistanceToken: previous.token }).catch(() => {});
  }
  if (epoch === actionEpoch) lastResult = { message: reason };
}
function stillCurrent(epoch) { if (epoch !== actionEpoch) throw new Error('This action was stopped. No further fields will be filled or pages advanced.'); }
function invalidateAssistance(token) {
  if (!assistance || assistance.token !== token) return;
  const url = assistance.url;
  assistance.token = null;
  assistance.expiresAt = null;
  // Resume must ask for fresh desktop consent after a lost/revoked grant.
  // Ending the old token is best effort and cannot hold the UI open indefinitely.
  void nativeRequest('endAssistedSession', { url, assistanceToken: token }).catch(() => {});
}
function requireAssistance(tabId, token) {
  if (!token || !assistance || assistance.tabId !== tabId || assistance.token !== token ||
      !Number.isFinite(Date.parse(assistance.expiresAt)) || Date.parse(assistance.expiresAt) <= Date.now()) {
    if (token) invalidateAssistance(token);
    throw new Error('Your guided approval ended or expired. Start again to approve a new session.');
  }
}
async function activePortal(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.id !== tabId || !tab.active || !SecondHandIowa.isSupportedUrl(tab.url)) throw new Error('Open the official Iowa portal in the active tab, then try again.');
  return tab;
}
async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['address-policy.js', 'iowa-adapter.js', 'content.js'] });
}
function rememberScan(tabId, scan, url) {
  const allowed = Object.keys(SecondHandIowa.definitions);
  if (!scan || typeof scan.token !== 'string' || !Array.isArray(scan.fields) || scan.fields.some(field => !allowed.includes(field.key))) throw new Error('The page preview was invalid. Reload Iowa’s page.');
  scans.set(tabId, { token: scan.token, url, fields: scan.fields.map(field => field.key), expires: Date.now() + 120000 });
}
async function scanTab(tabId) {
  if (busy) throw new Error('Finish the current desktop approval first.');
  const tab = await activePortal(tabId);
  await inject(tabId);
  const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:scan' }, { frameId: 0 });
  const current = await activePortal(tabId);
  if (current.url !== tab.url) throw new Error('The page changed while scanning. Try again.');
  rememberScan(tabId, result, tab.url);
  lastResult = null;
  return result;
}
async function readPage(tabId) {
  const tab = await activePortal(tabId);
  await inject(tabId);
  const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:pageState' }, { frameId: 0 });
  const current = await activePortal(tabId);
  if (current.url !== tab.url || !result?.page || !result.scan) throw new Error('The page changed. Wait for it to finish loading.');
  rememberScan(tabId, result.scan, tab.url);
  const state = { ...result, url: tab.url };
  pages.set(tabId, state);
  return state;
}
function takeScan(tabId, token, requested) {
  const scan = scans.get(tabId);
  scans.delete(tabId);
  if (!scan || scan.token !== token || scan.expires < Date.now() || !Array.isArray(requested) || !requested.length || requested.length > Object.keys(SecondHandIowa.definitions).length || new Set(requested).size !== requested.length || requested.some(field => !scan.fields.includes(field))) throw new Error('The preview expired or changed. Scan the page again.');
  return scan;
}
async function performFill(tabId, token, requested, epoch, sessionToken) {
  const scan = takeScan(tabId, token, requested);
  const tab = await activePortal(tabId);
  stillCurrent(epoch);
  if (tab.url !== scan.url) throw new Error('The portal moved to another page. Scan again.');
  if (sessionToken) requireAssistance(tabId, sessionToken);
  lastResult = { message: sessionToken ? 'Filling approved fields…' : 'Waiting for approval in the desktop app.' };
  let values;
  try {
    try {
      const response = await nativeRequest('getFields', { url: safeUrl(scan.url), fields: requested, ...(sessionToken ? { assistanceToken: sessionToken } : {}) });
      values = response?.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('The desktop did not return supported profile fields.');
    } catch (error) {
      if (sessionToken) invalidateAssistance(sessionToken);
      throw error;
    }
    stillCurrent(epoch);
    const current = await activePortal(tabId);
    if (current.url !== scan.url) throw new Error('The page changed during approval. Nothing was filled.');
    stillCurrent(epoch);
    if (sessionToken) requireAssistance(tabId, sessionToken);
    const missing = missingProfile.get(tabId) || new Set();
    for (const key of requested) {
      if (typeof values[key] !== 'string' || !values[key].trim()) missing.add(key);
      else missing.delete(key);
    }
    missingProfile.set(tabId, missing);
    const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:fill', token, fields: requested, values }, { frameId: 0 });
    if (!result?.ok) throw new Error(result?.error || 'The page could not be filled. Scan again.');
    let tracking = 'No application was submitted.';
    if (result.filledCount > 0) {
      try { await nativeRequest('recordProgress', { url: safeUrl(scan.url), filledCount: result.filledCount }); }
      catch { tracking = 'Update your local application tracker manually; its progress could not be recorded.'; }
    }
    lastResult = { message: `${result.filledCount} field(s) filled; ${result.skippedCount} skipped. Review every answer in Iowa’s form. ${tracking}`, ...result };
    return lastResult;
  } finally { values = null; }
}
function pageSignature(state) { return `${safeUrl(state.url)}|${state.page.pageKey || 'unknown'}`; }
async function nextPage(tabId, epoch, automatic) {
  stillCurrent(epoch);
  const state = await readPage(tabId);
  stillCurrent(epoch);
  if (!state.page.canAdvance || !state.nextToken) {
    const reason = state.page.reason || 'Complete the remaining questions and review this page yourself before continuing.';
    if (automatic) pause(reason, state.page.kind === 'fillable' && state.scan.recognizedPage && (state.page.requiredRemaining > 0 || state.page.manualRemaining > 0));
    return { ...(lastResult || {}), advanced: false, message: reason };
  }
  let sessionToken;
  if (automatic) {
    sessionToken = assistance?.token;
    requireAssistance(tabId, sessionToken);
    try {
      const checked = await nativeRequest('checkAssistedSession', { url: safeUrl(state.url), assistanceToken: sessionToken });
      if (checked?.active !== true) throw new Error('Your desktop approval is no longer active. Unlock SecondHand and start again.');
    } catch (error) {
      invalidateAssistance(sessionToken);
      throw error;
    }
    stillCurrent(epoch);
    requireAssistance(tabId, sessionToken);
  } else {
    const desktop = await nativeRequest('status');
    stillCurrent(epoch);
    if (!desktop?.unlocked) throw new Error('Unlock SecondHand before continuing to the next page.');
  }
  const current = await activePortal(tabId);
  stillCurrent(epoch);
  if (automatic) requireAssistance(tabId, sessionToken);
  if (current.url !== state.url) throw new Error('The page changed before navigation. Review the current step.');
  const signature = pageSignature(state);
  if (automatic && assistance?.visited.has(signature)) { pause('This step was already advanced. Review Iowa’s messages, then choose Resume to try again.'); return { advanced: false, message: assistance.reason }; }
  // One navigation attempt. Never retry a click when its response is uncertain.
  if (automatic && assistance) { assistance.visited.add(signature); assistance.steps++; }
  const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:next', token: state.nextToken, authorized: true }, { frameId: 0 });
  stillCurrent(epoch);
  if (!result?.advanced) {
    const reason = result?.reason || 'The page changed or still needs your input. Review it before continuing.';
    if (automatic) pause(reason);
    return { advanced: false, message: reason };
  }
  scans.delete(tabId); pages.delete(tabId);
  lastResult = { message: 'Selected Save and Continue. Waiting for Iowa’s next step.', advanced: true };
  return lastResult;
}
async function fillTab(tabId, token, requested, advance = false) {
  if (busy) throw new Error('A request is already in progress.');
  if (assistance?.enabled && !assistance.paused) throw new Error('Pause guided autofill before filling individual fields.');
  busy = true; busyTab = tabId;
  const epoch = actionEpoch;
  try {
    const result = await performFill(tabId, token, requested, epoch);
    return advance ? await nextPage(tabId, epoch, false) : result;
  } catch (error) {
    lastResult = { message: error.message || 'The action failed. Review the page before trying again.', error: true };
    throw error;
  } finally { busy = false; busyTab = null; }
}
async function startAutomatic(tabId) {
  if (busy) throw new Error('Finish the current desktop approval first.');
  busy = true; busyTab = tabId;
  let epoch = actionEpoch;
  try {
    const tab = await activePortal(tabId);
    stillCurrent(epoch);
    const state = await readPage(tabId);
    stillCurrent(epoch);
    if (state.page.kind === 'blocked' || state.page.kind === 'unsupported') throw new Error(state.page.reason || 'Complete this step yourself. Guided filling can start on a supported applicant page.');
    if (assistance?.tabId === tabId && assistance.token && Date.parse(assistance.expiresAt) > Date.now()) {
      const previousToken = assistance.token;
      try {
        const valid = await nativeRequest('checkAssistedSession', { url: safeUrl(tab.url), assistanceToken: previousToken });
        if (valid?.active !== true) invalidateAssistance(previousToken);
      } catch { invalidateAssistance(previousToken); }
      stillCurrent(epoch);
    }
    if (assistance?.tabId === tabId && assistance.token && Date.parse(assistance.expiresAt) > Date.now()) {
      assistance.enabled = true; assistance.paused = false; assistance.waitingForInfo = false; assistance.reason = '';
      assistance.attempted.clear();
      assistance.visited.delete(pageSignature(state));
    } else {
      if (assistance) {
        const replacementEpoch = epoch + 1;
        await stopAutomatic();
        stillCurrent(replacementEpoch);
        epoch = replacementEpoch;
      }
      lastResult = { message: 'Approve a 15-minute guided session in the desktop app. You can stop it at any time.' };
      const fields = Object.keys(SecondHandIowa.definitions);
      const grant = await nativeRequest('startAssistedSession', { url: safeUrl(tab.url), fields });
      if (!grant || !/^[a-f0-9]{64}$/.test(grant.assistanceToken || '') || !Number.isFinite(Date.parse(grant.expiresAt)) || !Array.isArray(grant.fields) || grant.fields.some(field => !fields.includes(field))) throw new Error('Invalid desktop approval. Start again.');
      if (epoch !== actionEpoch) {
        await nativeRequest('endAssistedSession', { url: safeUrl(tab.url), assistanceToken: grant.assistanceToken }).catch(() => {});
        throw new Error('Guided autofill was stopped before approval completed.');
      }
      const current = await activePortal(tabId).catch(() => null);
      if (epoch !== actionEpoch || !current || current.url !== tab.url) {
        await nativeRequest('endAssistedSession', { url: safeUrl(tab.url), assistanceToken: grant.assistanceToken }).catch(() => {});
        throw new Error('The active page changed during approval. Start again on Iowa’s page.');
      }
      missingProfile.delete(tabId);
      assistance = { tabId, token: grant.assistanceToken, expiresAt: grant.expiresAt, fields: grant.fields, url: safeUrl(tab.url), enabled: true, paused: false, waitingForInfo: false, reason: '', visited: new Set(), attempted: new Set(), attemptedPage: '', steps: 0 };
    }
    lastResult = { message: 'Guided autofill is ready. It pauses when a step needs your input.' };
  } catch (error) {
    // Native failures already contain public desktop messages. Bound and clean
    // them before retaining UI status so polling cannot restore the obsolete
    // approval prompt. A canceled request must not overwrite a newer action.
    const message = typeof error?.message === 'string' ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240) : '';
    const safeMessage = message || 'Guided assistance could not start. Check SecondHand and try again.';
    if (epoch === actionEpoch) lastResult = { message: safeMessage, error: true };
    throw new Error(safeMessage);
  } finally { busy = false; busyTab = null; }
  await runAutomatic(tabId);
  return status(tabId);
}
async function runAutomatic(tabId) {
  if (busy || !assistance || assistance.tabId !== tabId || !assistance.enabled || assistance.paused) return;
  if (Date.parse(assistance.expiresAt) <= Date.now()) { await stopAutomatic('Your guided approval expired. Start again to approve a new session.'); return; }
  if (assistance.steps >= 12) { pause('The session reached its page limit. Review your application before starting another session.'); return; }
  busy = true; busyTab = tabId;
  const epoch = actionEpoch;
  try {
    let state = await readPage(tabId);
    stillCurrent(epoch);
    // A recognized page can have manual questions while its safe fields are filled.
    if (!['fillable', 'manual'].includes(state.page.kind) || !state.scan.recognizedPage) { pause(state.page.reason || 'Complete this step yourself, then resume on a supported page.'); return; }
    if (assistance.visited.has(pageSignature(state))) { pause('Iowa stayed on the same step. Review its messages and choose Resume when ready.'); return; }
    const signature = pageSignature(state);
    if (assistance.attemptedPage !== signature) { assistance.attempted.clear(); assistance.attemptedPage = signature; }
    // Choices can reveal more verified fields. Each pass gets a fresh preview,
    // uses the existing grant, and never retries an unanswered field in a loop.
    for (let pass = 0; pass < 4; pass++) {
      const fields = state.scan.fields.map(field => field.key).filter(field => assistance.fields.includes(field) && !assistance.attempted.has(field));
      if (!fields.length) break;
      fields.forEach(field => assistance.attempted.add(field));
      await performFill(tabId, state.scan.token, fields, epoch, assistance.token);
      stillCurrent(epoch);
      state = await readPage(tabId);
      stillCurrent(epoch);
      if (pageSignature(state) !== signature || !state.scan.recognizedPage || state.page.kind !== 'fillable') throw new Error('The page changed while filling. Review the current step before resuming.');
    }
    stillCurrent(epoch);
    await nextPage(tabId, epoch, true);
  } catch (error) {
    if (epoch === actionEpoch) pause(error.message || 'Guided autofill paused. Review this page before resuming.');
  } finally { busy = false; busyTab = null; }
}
async function pageState(tabId) {
  if (busy) {
    const cached = pages.get(tabId);
    return { page: cached?.page || { kind: 'manual', reason: 'Finish the current desktop approval first.', canAdvance: false }, scan: cached?.scan || { fields: [], ambiguous: [] }, ...status(tabId) };
  }
  if (assistance?.tabId === tabId && assistance.token && Date.parse(assistance.expiresAt) <= Date.now()) await stopAutomatic('Your guided approval expired. Start again to approve a new session.');
  const state = await readPage(tabId);
  if (assistance?.tabId === tabId && assistance.waitingForInfo && assistance.token && state.scan.recognizedPage && state.page.kind === 'fillable' && pageSignature(state) === assistance.attemptedPage &&
      (state.page.canAdvance || state.scan.fields.some(field => assistance.fields.includes(field.key) && !assistance.attempted.has(field.key)))) {
    assistance.paused = false; assistance.waitingForInfo = false;
  }
  const result = { page: state.page, scan: state.scan, ...status(tabId) };
  // Polling can continue a previously approved session; it can never create one.
  if (assistance?.tabId === tabId && assistance.enabled && !assistance.paused) void runAutomatic(tabId);
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || Array.isArray(message)) return;
  const popup = sender.url === chrome.runtime.getURL('popup.html') && !sender.tab;
  const panel = sender.url === chrome.runtime.getURL('panel.html') && !sender.tab;
  const launcher = sender.url === chrome.runtime.getURL('panel.html?surface=launcher') && sender.frameId > 0 && Number.isInteger(sender.tab?.id) && SecondHandIowa.isSupportedUrl(sender.tab.url);
  if (launcher) {
    if (message.type !== 'ui:openPanel' || message.confirmed !== true || (message.tabId !== undefined && message.tabId !== sender.tab.id)) return;
    // Keep this synchronous: Chrome requires the originating trusted user gesture.
    const opening = chrome.sidePanel.open({ tabId: sender.tab.id });
    opening.then(() => respond({ ok: true, data: { opened: true } }), () => respond({ ok: false, error: 'Use the SecondHand toolbar icon to open the browser side panel.' }));
    return true;
  }
  // Only our extension-origin UI can start a session or request applicant data.
  // Content scripts and page postMessages never have a native bridge entry point.
  if (!popup && !panel) return;
  const tabId = message.tabId;
  let work;
  if (message.type === 'ui:status') work = Promise.resolve(status(tabId));
  else if (message.type === 'ui:auto' && message.enabled === false) work = (!assistance || assistance.tabId === tabId || busyTab === tabId) ? stopAutomatic().then(() => status(tabId)) : Promise.reject(new Error('Open the tab running guided autofill to stop it.'));
  else if (!Number.isInteger(tabId)) return;
  else if (message.type === 'ui:pageState') work = pageState(tabId);
  else if (message.type === 'ui:scan') work = scanTab(tabId);
  else if (message.type === 'ui:fill' && message.confirmed === true) work = fillTab(tabId, message.token, message.fields);
  else if (message.type === 'ui:fillAndNext' && message.confirmed === true) work = fillTab(tabId, message.token, message.fields, true);
  else if (message.type === 'ui:auto' && message.enabled === true && message.confirmed === true) work = startAutomatic(tabId);
  else if (message.type === 'ui:desktopStatus') work = activePortal(tabId).then(() => nativeRequest('status')).then(data => ({ connected: true, unlocked: Boolean(data?.unlocked) }));
  else if (message.type === 'ui:focusField' && typeof message.key === 'string' && /^[A-Za-z][A-Za-z0-9]{0,59}$/.test(message.key)) work = activePortal(tabId).then(() => chrome.tabs.sendMessage(tabId, { type: 'secondhand:focusField', key: message.key }, { frameId: 0 }));
  else if (message.type === 'ui:panel' && typeof message.collapsed === 'boolean') work = activePortal(tabId).then(() => inject(tabId)).then(() => chrome.tabs.sendMessage(tabId, { type: 'secondhand:panel', collapsed: message.collapsed }, { frameId: 0 }));
  else return;
  work.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || 'SecondHand could not complete the request.' }));
  return true;
});
chrome.tabs.onActivated?.addListener(info => {
  if ((assistance && info.tabId !== assistance.tabId) || (busy && info.tabId !== busyTab)) void stopAutomatic('Guided autofill stopped because the active tab changed.');
});
chrome.tabs.onRemoved?.addListener(tabId => {
  scans.delete(tabId); pages.delete(tabId); missingProfile.delete(tabId);
  if (assistance?.tabId === tabId || busyTab === tabId) void stopAutomatic('The application tab was closed.');
});
// Chrome's native panel persists alongside navigation; it never opens itself.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (change.status === 'loading') { scans.delete(tabId); pages.delete(tabId); }
  if (change.url && !SecondHandIowa.isSupportedUrl(change.url) && (assistance?.tabId === tabId || busyTab === tabId)) void stopAutomatic('Guided autofill stopped because this tab left Iowa’s application.');
});
