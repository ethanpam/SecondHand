'use strict';
importScripts('iowa-adapter.js');
const HOST = 'org.secondhand.bridge';
const scans = new Map();
let busy = false;
let lastResult = null; // Counts and fixed UI messages only. Never profile values.

function nativeRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let settled = false;
    let port;
    let timer;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* already disconnected */ }
      if (error) reject(new Error(error)); else resolve(data);
    };
    try {
      port = chrome.runtime.connectNative(HOST);
      timer = setTimeout(() => finish('Desktop approval timed out. Reopen SecondHand and scan again.'), 115000);
      port.onMessage.addListener(message => {
        if (!message || message.id !== id) return finish('Unexpected desktop response. No further action was taken.');
        if (message.ok !== true) return finish(typeof message.error === 'string' ? message.error.slice(0, 240) : 'The desktop declined this request.');
        finish(null, message.data);
      });
      port.onDisconnect.addListener(() => {
        // Consume lastError without echoing OS paths or native-host diagnostics.
        void chrome.runtime.lastError;
        finish('Cannot reach SecondHand. In the desktop app, open Chrome extension and prepare or refresh its files. Follow the setup steps, then keep the app open and your vault unlocked.');
      });
      port.postMessage({ id, type, ...payload });
    } catch { finish('Cannot reach SecondHand. Check the desktop app and extension connection.'); }
  });
}

async function activePortal(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active || !SecondHandIowa.isSupportedUrl(tab.url)) throw new Error('Open the official Iowa portal in the active tab, then scan again.');
  return tab;
}

async function scanTab(tabId) {
  if (busy) throw new Error('A fill request is already waiting for desktop approval.');
  const tab = await activePortal(tabId);
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['iowa-adapter.js', 'content.js'] });
  const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:scan' }, { frameId: 0 });
  const current = await activePortal(tabId);
  if (!result || current.url !== tab.url) throw new Error('The page changed while scanning. Try scanning again.');
  scans.clear();
  scans.set(tabId, { token: result.token, url: tab.url, fields: result.fields.map(field => field.key), expires: Date.now() + 120000 });
  lastResult = null;
  return result;
}

async function fillTab(tabId, token, requested) {
  if (busy) throw new Error('A fill request is already in progress.');
  const scan = scans.get(tabId);
  scans.delete(tabId);
  if (!scan || scan.token !== token || scan.expires < Date.now() || !Array.isArray(requested) || !requested.length || requested.length > 13 || new Set(requested).size !== requested.length || requested.some(field => !scan.fields.includes(field))) throw new Error('The preview expired or changed. Scan the page again.');
  const tab = await activePortal(tabId);
  if (tab.url !== scan.url) throw new Error('The portal moved to another page. Scan again.');
  busy = true;
  lastResult = { message: 'Waiting for approval in the desktop app.' };
  let values;
  try {
    // Strip query and fragment so local history never captures session parameters.
    const url = new URL(scan.url);
    const safeUrl = url.origin + url.pathname;
    const response = await nativeRequest('getFields', { url: safeUrl, fields: requested });
    values = response?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('The desktop did not return supported profile fields.');
    const current = await activePortal(tabId);
    if (current.url !== scan.url) throw new Error('The page changed during approval. Nothing was filled.');
    const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:fill', token, fields: requested, values }, { frameId: 0 });
    if (!result?.ok) throw new Error(result?.error || 'The page could not be filled. Scan again.');
    let tracking = 'No application was submitted.';
    if (result.filledCount > 0) {
      try { await nativeRequest('recordProgress', { url: safeUrl, filledCount: result.filledCount }); }
      catch { tracking = 'Fields were filled, but local progress could not be recorded. Update the desktop tracker manually.'; }
    }
    lastResult = { message: `${result.filledCount} field(s) filled; ${result.skippedCount} skipped. Review every answer in Iowa’s form. ${tracking}`, ...result };
    return lastResult;
  } catch (error) {
    lastResult = { message: error.message || 'The fill request failed. Scan again before another attempt.', error: true };
    throw error;
  } finally {
    values = null;
    busy = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // A website/content script must not be able to request fields from the vault.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') || sender.tab || !message || typeof message !== 'object') return;
  let work;
  if (message.type === 'ui:status') work = Promise.resolve({ busy, lastResult, extensionId: chrome.runtime.id });
  else if (message.type === 'ui:scan' && Number.isInteger(message.tabId)) work = scanTab(message.tabId);
  else if (message.type === 'ui:fill' && Number.isInteger(message.tabId) && message.confirmed === true) work = fillTab(message.tabId, message.token, message.fields);
  else return;
  work.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || 'SecondHand could not complete the request.' }));
  return true;
});
