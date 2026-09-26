'use strict';

(() => {
  const $ = id => document.getElementById(id);
  // Must match BUILD in background.js: change both together. Chrome loads these pages
  // from disk right away but keeps running the old worker until SecondHand is reloaded.
  const BUILD = '2026-09-26.2';
  const OUTDATED = 'SecondHand was updated. Open chrome://extensions and click the reload arrow on SecondHand, then reload this page.';
  const fixedText = (value, length = 360) => typeof value === 'string' ? value.slice(0, length) : '';
  const trusted = callback => event => { if (event.isTrusted) return callback(event); };
  const outdatedError = () => Object.assign(new Error(OUTDATED), { outdated: true });
  const send = async payload => {
    const response = await chrome.runtime.sendMessage(payload);
    // An outdated worker ignores messages it doesn't know, so Chrome resolves with no response.
    if (response === undefined) throw outdatedError();
    if (!response?.ok) throw new Error(fixedText(response?.error) || 'The assistant is unavailable. Reload the extension and this page.');
    return response.data;
  };
  // An older worker that still answers is caught by its build.
  const checkBuild = async () => { if ((await send({ type: 'ui:ping' }))?.build !== BUILD) throw outdatedError(); };
  const fieldKeys = value => Array.isArray(value) ? value.filter(key => typeof key === 'string' && (/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) || /^f\d{1,6}:[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(key))).slice(0, 80) : [];
  // Autofill keeps going only on Iowa; other sites get one fill per click.
  const continuing = result => result?.pageKey !== 'general' && !['stopped', 'locked', 'offline', 'error'].includes(result?.state);
  // The worker's metadata for a site other than Iowa: its origin and whether it is turned on.
  const siteOf = state => state?.site && typeof state.site.origin === 'string' ? { origin: state.site.origin, enabled: state.site.enabled === true, ready: state.site.ready !== false, frames: Array.isArray(state.site.frames) ? state.site.frames.filter(frame => frame && typeof frame.origin === 'string') : [] } : null;
  const hostOf = origin => fixedText(new URL(origin).hostname, 90);

  if (location.search === '?surface=launcher' && !location.hash) { widget(); return; }
  if (location.search || location.hash) return;
  sidePanel();

  // The on-page widget. The worker binds every request to this iframe's own tab.
  function widget() {
    document.body.classList.add('launcher-surface');
    $('launcher').hidden = false;
    let known = false;
    let autopilot = false;
    let site = null;
    let result = null;
    let note = '';
    let working = false;
    let outdated = false;
    let ai = { note: '', reason: '' };
    let cursor = 0;
    let pollTimer;
    const AI_TIMEOUT_MS = 8000;
    const AI_UNAVAILABLE = 'On-device AI unavailable. Rule matches only.';
    // An outdated worker keeps its reload steps on screen and is not polled again.
    const trouble = error => { if (error.outdated) outdated = true; return fixedText(error.message, 120); };

    function statusText() {
      if (outdated) return OUTDATED;
      if (working) return 'Working…';
      if (note) return note;
      if (!result) return site ? `${hostOf(site.origin)} · ready` : 'Iowa SNAP · ready';
      // Other sites: the need-you link carries the count, so it isn't repeated here.
      if (result.state === 'done' && result.pageKey === 'general') {
        const guessed = Number(result.guessed) > 0 ? ` · ${Number(result.guessed)} guessed` : '';
        const summary = Number(result.filled) > 0 ? `Filled ${Number(result.filled)}${guessed}`
          : fieldKeys(result.needYou).length ? 'Nothing here matches your saved profile.' : fixedText(result.message, 120);
        return ai.note ? `${summary.replace(/\.$/, '')} · ${ai.note}` : summary;
      }
      if (result.state === 'done') return [`Filled ${Number(result.filled) || 0}`, fixedText(result.todo, 90)].filter(Boolean).join(' · ');
      return fixedText(result.message, 120);
    }
    function render() {
      $('widget').hidden = !known && !autopilot && !outdated;
      $('widget').classList.toggle('outdated', outdated);
      $('pill').hidden = known || autopilot || outdated;
      const locked = result?.state === 'locked';
      $('stop').hidden = !autopilot;
      $('autofill').hidden = autopilot || locked;
      $('unlock').hidden = autopilot || !locked;
      $('autofill').disabled = working;
      const needYou = ['done', 'waiting'].includes(result?.state) ? fieldKeys(result.needYou) : [];
      $('need-you').hidden = outdated || !needYou.length;
      $('need-you').textContent = `${needYou.length} need you`;
      $('widget-text').textContent = statusText();
      $('widget-text').title = outdated ? OUTDATED : fixedText([result?.message, ai.note, ai.reason].filter(Boolean).join(' '), 240);
    }
    async function poll() {
      clearTimeout(pollTimer);
      if (outdated) return;
      if (!document.hidden && !working) {
        try {
          const state = await send({ type: 'ui:pageState' });
          const page = state?.page || {};
          site = siteOf(state);
          known = page.kind === 'fillable' || page.kind === 'info' || Boolean(page.todo) || Boolean(site?.enabled);
          autopilot = Boolean(state?.autopilot);
          // While autofill runs, the worker moves ahead between polls. Otherwise keep
          // this widget's own result and adopt the worker's only after a reload.
          if (autopilot || !result) result = state?.result || result;
          note = '';
        } catch (error) { note = trouble(error); }
        render();
      }
      if (!outdated) pollTimer = setTimeout(poll, 1500);
    }

    // Chrome's on-device AI runs only in extension pages like this one, not in the worker.
    // It sees the labels and options of the questions the rules left open, never values,
    // and gets one try per click within its time limit.
    async function aiGuesses() {
      const plan = await send({ type: 'ui:plan', confirmed: true });
      const fields = (Array.isArray(plan?.unmatched) ? plan.unmatched : []).filter(field => typeof field?.label === 'string' && field.label.trim());
      if (!fields.length) return { status: 'mapped', mapping: {} };
      try { return await SecondHandAI.mapWithChromeAI(fields, { allowedKeys: plan.allowedKeys, timeoutMs: AI_TIMEOUT_MS }); }
      catch (error) { return { status: 'error', reason: error.message }; }
    }

    $('autofill').addEventListener('click', trusted(async () => {
      if (working || outdated) return;
      working = true; note = ''; ai = { note: '', reason: '' }; render();
      try {
        const request = { type: 'ui:autofill', confirmed: true };
        // Iowa's form is filled by its own rules; other sites also get the AI's guesses.
        if (site) {
          const answer = await aiGuesses();
          if (answer?.status !== 'mapped') ai = { note: AI_UNAVAILABLE, reason: fixedText(answer?.reason, 160) };
          else if (Object.keys(answer.mapping).length) request.guesses = answer.mapping;
        }
        result = await send(request);
        cursor = 0;
        autopilot = continuing(result);
      } catch (error) { result = { state: 'error', message: trouble(error) }; autopilot = false; }
      finally { working = false; render(); }
    }));
    $('stop').addEventListener('click', trusted(async () => {
      try { result = await send({ type: 'ui:stop', confirmed: true }); autopilot = false; }
      catch (error) { note = trouble(error); }
      render();
    }));
    $('need-you').addEventListener('click', trusted(async () => {
      const needYou = fieldKeys(result?.needYou);
      if (!needYou.length) return;
      const key = needYou[cursor % needYou.length];
      cursor++;
      try {
        const focused = await send({ type: 'ui:focusField', key, confirmed: true });
        note = focused?.focused ? '' : site ? 'Find it in the form.' : 'Find it in Iowa’s form.';
      } catch (error) { note = trouble(error); }
      render();
    }));
    $('unlock').addEventListener('click', trusted(async () => {
      try {
        await send({ type: 'ui:showApp', confirmed: true });
        result = { state: 'waiting', message: 'Unlock SecondHand, then click Autofill.' };
      } catch (error) { note = trouble(error); }
      render();
    }));
    // Send immediately inside the trusted click: Chrome needs the user gesture to open the panel.
    for (const id of ['details', 'pill']) {
      $(id).addEventListener('click', trusted(() => {
        send({ type: 'ui:openPanel', confirmed: true }).catch(error => { note = trouble(error); render(); });
      }));
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    window.addEventListener('pagehide', () => clearTimeout(pollTimer), { once: true });
    render();
    checkBuild().catch(error => { note = trouble(error); render(); }).then(poll);
  }

  // Chrome's side panel: desktop status, one Autofill button, and the checklist.
  function sidePanel() {
    $('sidepanel').hidden = false;
    let target = null;
    let fillable = false;
    let autopilot = false;
    let site = null;
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
    // Any other https page can be turned on; the worker and the desktop check it again.
    function siteUrl(raw) {
      try {
        const url = new URL(raw);
        return url.protocol === 'https:' && Boolean(url.hostname) && url.origin !== 'https://hhsservices.iowa.gov' && !url.username && !url.password && !url.port;
      } catch { return false; }
    }
    function controls() {
      const off = Boolean(target && site && !site.enabled);
      const pending = site?.enabled && site.ready ? site.frames.filter(frame => !frame.enabled) : [];
      $('frames-enable').hidden = !target || !pending.length;
      $('frames-enable').disabled = working;
      $('frames-enable').textContent = `Also turn on the embedded form (${pending.map(frame => hostOf(frame.origin)).join(', ')})`;
      $('site-enable').hidden = !off;
      $('site-enable').disabled = working;
      $('site-disable').hidden = !(target && site?.enabled);
      $('site-disable').disabled = working;
      $('panel-autofill').hidden = off;
      $('panel-autofill').textContent = autopilot ? 'Stop autofill' : 'Autofill this page';
      $('panel-autofill').disabled = !target || (!fillable && !autopilot) || working;
      document.querySelectorAll('.checklist-item').forEach(button => { button.disabled = working || !target; });
    }
    function clearPage() {
      fillable = false; autopilot = false; site = null; checklistSignature = '';
      $('page-checklist').replaceChildren();
      $('checklist-section').hidden = true;
    }
    function invalidateTarget() {
      if (stopped) return;
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
      site = siteOf(state);
      fillable = site ? site.enabled && site.ready : page.kind === 'fillable' || page.kind === 'info' || Boolean(page.todo);
      autopilot = Boolean(state.autopilot);
      renderChecklist(page);
      const result = state.result;
      if (site?.enabled && !site.ready) show(target?.status === 'loading' ? 'Waiting for the page to finish loading…' : 'Reload this page so SecondHand can read it.');
      else if (result?.message) show(result.message, result.state === 'error' || result.state === 'offline');
      else if (site && !site.enabled) show(`SecondHand can fill forms on ${hostOf(site.origin)} after you turn it on here and approve it in the SecondHand app.`);
      else if (site) show('Click Autofill. SecondHand fills what it recognizes and lists what needs you. It never submits.');
      else if (fillable) show('Click Autofill. SecondHand fills what it can and tells you what it needs.');
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
          if (!tab || !Number.isInteger(tab.id) || (!supportedUrl(tab.url) && !siteUrl(tab.url))) {
            target = null; clearPage(); controls();
            show('Open Iowa’s SNAP application in this tab. Your checklist appears here automatically. On another food-assistance form, click the SecondHand toolbar icon.');
            return;
          }
          if (!target || target.id !== tab.id || target.url !== tab.url) {
            contextRevision++; revision = contextRevision;
            clearPage(); target = { id: tab.id, url: tab.url };
          }
          target.status = tab.status;
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
      const stopping = autopilot;
      const result = await act(stopping ? { type: 'ui:stop', confirmed: true } : { type: 'ui:autofill', confirmed: true }, stopping ? 'Stopping autofill…' : 'Filling your saved answers…');
      if (result) autopilot = !stopping && continuing(result);
      if (result?.message) show(result.message, result.state === 'error' || result.state === 'offline');
      controls();
      if (!stopping) await desktopStatus();
      await refresh();
    }));
    $('site-enable').addEventListener('click', trusted(async () => {
      if ($('site-enable').disabled || !target || !site) return;
      let granted;
      // Ask before anything is awaited: Chrome only shows its prompt inside the user's click.
      try { granted = await chrome.permissions.request({ origins: [`${site.origin}/*`] }); }
      catch (error) { show(fixedText(error.message) || 'Chrome couldn’t ask for access to this site.', true); return; }
      if (!granted) { show('Chrome didn’t allow SecondHand on this site. Nothing changed.', true); return; }
      const result = await act({ type: 'ui:enableSite', confirmed: true }, 'Approve this site in the SecondHand app…');
      await refresh();
      if (result?.enabled) show(`SecondHand is on for ${hostOf(result.origin)}. Click Autofill.`);
    }));
    $('frames-enable').addEventListener('click', trusted(async () => {
      if ($('frames-enable').disabled || !target || !site?.enabled) return;
      const pending = site.frames.filter(frame => !frame.enabled);
      if (!pending.length) return;
      let granted;
      // Keep the Chrome request in this trusted click, before any awaited work.
      try { granted = await chrome.permissions.request({ origins: pending.map(frame => `${frame.origin}/*`) }); }
      catch (error) { show(fixedText(error.message) || 'Chrome couldn’t ask for access to the embedded form.', true); return; }
      if (!granted) { show('Chrome didn’t allow SecondHand on the embedded form. Nothing changed.', true); return; }
      const result = await act({ type: 'ui:enableFrames', confirmed: true }, 'Approve the embedded form in the SecondHand app…');
      await refresh();
      if (result?.enabled) show('SecondHand is on for the embedded form. Click Autofill.');
    }));
    $('site-disable').addEventListener('click', trusted(async () => {
      if ($('site-disable').disabled) return;
      const result = await act({ type: 'ui:disableSite', confirmed: true }, 'Turning SecondHand off for this site…');
      await refresh();
      if (result && !result.enabled) show('SecondHand is off for this site. Reload the page to remove its button.');
    }));
    $('desktop-action').addEventListener('click', trusted(async () => {
      try { await send({ type: 'ui:showApp', confirmed: true }); $('desktop-status').textContent = 'Unlock SecondHand, then click Autofill.'; }
      catch (error) { $('desktop-status').textContent = error.message; }
    }));
    // An outdated worker stops the panel with its reload steps on screen.
    async function start() {
      try { await checkBuild(); } catch (error) {
        if (error.outdated) {
          stopped = true; target = null; clearPage(); controls(); show(OUTDATED, true);
          $('desktop-status').parentElement.hidden = true;
          return;
        }
        show(error.message, true);
      }
      refresh().then(desktopStatus);
      schedulePoll();
    }
    chrome.tabs.onActivated?.addListener(() => { invalidateTarget(); refresh(); });
    chrome.tabs.onUpdated?.addListener((tabId, change) => {
      if (target?.id === tabId && (change.url || change.status === 'loading')) { invalidateTarget(); refresh(); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !working && !stopped) { refresh(); desktopStatus(); } });
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); }, { once: true });
    start();
  }
})();
