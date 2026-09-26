'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const fixedText = (value, length = 360) => typeof value === 'string' ? value.slice(0, length) : '';
  const trusted = callback => event => { if (event.isTrusted) return callback(event); };
  const send = async payload => {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.ok) throw new Error(fixedText(response?.error) || 'The assistant is unavailable. Reload the extension and this Iowa page.');
    return response.data;
  };
  const fieldKeys = value => Array.isArray(value) ? value.filter(key => typeof key === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key)).slice(0, 80) : [];

  if (location.search === '?surface=launcher' && !location.hash) { widget(); return; }
  if (location.search || location.hash) return;
  sidePanel();

  // The on-page widget. The worker binds every request to this iframe's own tab.
  function widget() {
    document.body.classList.add('launcher-surface');
    $('launcher').hidden = false;
    let fillable = false;
    let result = null;
    let note = '';
    let working = false;
    let cursor = 0;
    let pollTimer;

    function render() {
      $('widget').hidden = !fillable;
      $('pill').hidden = fillable;
      const locked = result?.state === 'locked';
      $('autofill').hidden = locked;
      $('unlock').hidden = !locked;
      $('autofill').disabled = working;
      const needYou = result?.state === 'done' ? fieldKeys(result.needYou) : [];
      $('need-you').hidden = !needYou.length;
      $('need-you').textContent = `${needYou.length} need you`;
      $('widget-text').textContent = working ? 'Filling…' : note || (result?.state === 'done' ? `Filled ${Number(result.filled) || 0}` : result ? fixedText(result.message, 120) : 'Iowa SNAP · ready');
    }
    async function poll() {
      clearTimeout(pollTimer);
      if (!document.hidden && !working) {
        try {
          const state = await send({ type: 'ui:pageState' });
          fillable = state?.page?.kind === 'fillable';
          // Adopt the worker's result only when this widget has none of its own,
          // e.g. after the iframe reloads on the same page.
          if (!result && state?.result) result = state.result;
        } catch (error) { note = fixedText(error.message, 120); }
        render();
      }
      pollTimer = setTimeout(poll, 1500);
    }

    $('autofill').addEventListener('click', trusted(async () => {
      if (working) return;
      working = true; note = ''; render();
      try { result = await send({ type: 'ui:autofill', confirmed: true }); cursor = 0; }
      catch (error) { result = { state: 'error', message: error.message }; }
      finally { working = false; render(); }
    }));
    $('need-you').addEventListener('click', trusted(async () => {
      const needYou = fieldKeys(result?.needYou);
      if (!needYou.length) return;
      const key = needYou[cursor % needYou.length];
      cursor++;
      try {
        const focused = await send({ type: 'ui:focusField', key, confirmed: true });
        note = focused?.focused ? '' : 'Find it in Iowa’s form.';
      } catch (error) { note = fixedText(error.message, 120); }
      render();
    }));
    $('unlock').addEventListener('click', trusted(async () => {
      try {
        await send({ type: 'ui:showApp', confirmed: true });
        result = { state: 'waiting', message: 'Unlock SecondHand, then click Autofill.' };
      } catch (error) { note = fixedText(error.message, 120); }
      render();
    }));
    // Send immediately inside the trusted click: Chrome needs the user gesture to open the panel.
    for (const id of ['details', 'pill']) {
      $(id).addEventListener('click', trusted(() => {
        send({ type: 'ui:openPanel', confirmed: true }).catch(error => { note = fixedText(error.message, 120); render(); });
      }));
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    window.addEventListener('pagehide', () => clearTimeout(pollTimer), { once: true });
    render();
    poll();
  }

  // Chrome's side panel: desktop status, one Autofill button, and the checklist.
  function sidePanel() {
    $('sidepanel').hidden = false;
    let target = null;
    let fillable = false;
    let contextRevision = 0;
    let checklistSignature = '';
    let working = false;
    let pollPromise = null;
    let pollTimer;
    let refreshAgain = false;
    let stopped = false;
    const STATUS = { complete: 'Done', missing: 'Needs you', optional: 'Optional', manual: 'Do it yourself' };
    const show = (text, error = false) => {
      $('status').textContent = fixedText(text, 650);
      $('status').classList.toggle('error', error);
    };
    function supportedUrl(raw) {
      try {
        const url = new URL(raw);
        return url.origin === 'https://hhsservices.iowa.gov' && !url.username && !url.password && !url.port &&
          (url.pathname === '/apspssp/ssp.portal' || url.pathname.startsWith('/apspssp/ssp.portal/')) && !/%|\\/.test(url.pathname);
      } catch { return false; }
    }
    function controls() {
      $('panel-autofill').disabled = !target || !fillable || working;
      document.querySelectorAll('.checklist-item').forEach(button => { button.disabled = working || !target; });
    }
    function clearPage() {
      fillable = false; checklistSignature = '';
      $('page-checklist').replaceChildren();
      $('checklist-section').hidden = true;
    }
    function invalidateTarget() {
      contextRevision++; working = false; target = null;
      clearPage(); controls();
      show('Checking the application in your active tab…');
    }
    function renderChecklist(page) {
      const entries = Array.isArray(page.checklist) ? page.checklist.filter(item => item && fieldKeys([item.key]).length && typeof item.label === 'string' && Object.hasOwn(STATUS, item.status)).slice(0, 80) : [];
      const signature = JSON.stringify(entries);
      if (signature === checklistSignature) return;
      checklistSignature = signature;
      $('page-checklist').replaceChildren();
      for (const item of entries) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = `checklist-item ${item.status}`; button.dataset.key = item.key;
        const mark = document.createElement('span'); mark.className = 'checklist-mark'; mark.setAttribute('aria-hidden', 'true');
        mark.textContent = item.status === 'complete' ? '✓' : item.status === 'manual' ? '!' : '○';
        const copy = document.createElement('span'); copy.className = 'checklist-copy';
        const label = document.createElement('span'); label.className = 'checklist-label'; label.textContent = fixedText(item.label, 100);
        const detail = document.createElement('span'); detail.className = 'checklist-detail'; detail.textContent = STATUS[item.status];
        copy.append(label, detail);
        button.setAttribute('aria-label', `${fixedText(item.label, 100)}: ${STATUS[item.status]}. Find it in Iowa’s form.`);
        button.append(mark, copy);
        button.addEventListener('click', trusted(() => { if (!button.disabled) focusField(item.key); }));
        $('page-checklist').append(button);
      }
      const done = entries.filter(item => item.status === 'complete').length;
      $('checklist-summary').textContent = `${done} of ${entries.length} done`;
      $('checklist-section').hidden = !entries.length;
    }
    function render(state) {
      if (!state || typeof state !== 'object') throw new Error('The page state could not be read. Reload Iowa’s page.');
      const page = state.page || {};
      fillable = page.kind === 'fillable';
      renderChecklist(page);
      const result = state.result;
      if (result?.message) show(result.message, result.state === 'error' || result.state === 'offline');
      else if (fillable) show('Click Autofill to fill your saved answers on this page.');
      else show(fixedText(page.reason) || 'Nothing to fill on this page. Continue in Iowa’s form.');
      controls();
    }
    async function refresh() {
      if (stopped) return;
      if (pollPromise) { refreshAgain = true; return pollPromise; }
      let revision = contextRevision;
      pollPromise = (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (revision !== contextRevision || stopped) return;
          if (!tab || !Number.isInteger(tab.id) || !supportedUrl(tab.url)) {
            target = null; clearPage(); controls();
            show('Open Iowa’s SNAP application in this tab. Your checklist appears here automatically.');
            return;
          }
          if (!target || target.id !== tab.id || target.url !== tab.url) {
            contextRevision++; revision = contextRevision;
            clearPage(); target = { id: tab.id, url: tab.url };
          }
          const state = await send({ type: 'ui:pageState', tabId: tab.id });
          if (revision === contextRevision && !stopped) render(state);
        } catch (error) {
          if (revision === contextRevision) { clearPage(); controls(); show(error.message, true); }
        } finally {
          pollPromise = null;
          if (refreshAgain && !stopped) { refreshAgain = false; queueMicrotask(refresh); }
        }
      })();
      return pollPromise;
    }
    function schedulePoll() {
      clearTimeout(pollTimer);
      if (stopped) return;
      pollTimer = setTimeout(async () => {
        if (!working && !document.hidden) await refresh();
        schedulePoll();
      }, 1500);
    }
    async function desktopStatus() {
      try {
        const desktop = await send({ type: 'ui:desktopStatus' });
        const ready = desktop?.connected && desktop.unlocked;
        $('desktop-status').textContent = !desktop?.connected ? 'SecondHand isn’t running. Open the app on this computer.' : desktop.unlocked ? 'SecondHand is unlocked.' : 'SecondHand is locked.';
        $('desktop-action').hidden = !desktop?.connected || desktop.unlocked;
        $('desktop-status').parentElement.classList.toggle('error', !ready);
      } catch (error) {
        $('desktop-status').textContent = error.message;
        $('desktop-action').hidden = true;
        $('desktop-status').parentElement.classList.add('error');
      }
    }
    // Every action re-reads the active tab so a stale checklist can never act on another page.
    async function act(payload, waiting) {
      if (!target) return null;
      const selected = { ...target };
      const revision = contextRevision;
      working = true; controls();
      try {
        if (pollPromise) await pollPromise;
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (revision !== contextRevision || active?.id !== selected.id || active.url !== selected.url) { invalidateTarget(); await refresh(); return null; }
        if (waiting) show(waiting);
        return await send({ ...payload, tabId: selected.id });
      } catch (error) {
        if (revision === contextRevision) show(error.message, true);
        return null;
      } finally {
        if (revision === contextRevision) { working = false; controls(); }
        schedulePoll();
      }
    }
    async function focusField(key) {
      const result = await act({ type: 'ui:focusField', key });
      if (result && !result.focused) show('That field isn’t on screen right now. Find it in Iowa’s form.');
    }

    $('panel-autofill').addEventListener('click', trusted(async () => {
      if ($('panel-autofill').disabled) return;
      const result = await act({ type: 'ui:autofill', confirmed: true }, 'Filling your saved answers…');
      if (result?.message) show(result.message, result.state === 'error' || result.state === 'offline');
      await desktopStatus();
      await refresh();
    }));
    $('desktop-action').addEventListener('click', trusted(async () => {
      try { await send({ type: 'ui:showApp', confirmed: true }); $('desktop-status').textContent = 'Unlock SecondHand, then click Autofill.'; }
      catch (error) { $('desktop-status').textContent = error.message; }
    }));
    chrome.tabs.onActivated?.addListener(() => { invalidateTarget(); refresh(); });
    chrome.tabs.onUpdated?.addListener((tabId, change) => {
      if (target?.id === tabId && (change.url || change.status === 'loading')) { invalidateTarget(); refresh(); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !working) { refresh(); desktopStatus(); } });
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); }, { once: true });
    refresh().then(desktopStatus);
    schedulePoll();
  }
})();
