'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const strings = globalThis.SecondHandStrings;
  const translation = globalThis.SecondHandTranslation;
  const summary = globalThis.SecondHandSummary;
  // Must match BUILD in background.js: change both together. Chrome loads these pages
  // from disk right away but keeps running the old worker until SecondHand is reloaded.
  const BUILD = '2026-09-27.1';
  // The applicant's language: the choice saved in this extension's storage, else the browser's.
  let language = strings.language();
  const t = (key, params = {}) => strings.text(language, key, params);
  const fixedText = (value, length = 360) => typeof value === 'string' ? value.slice(0, length) : '';
  // A message is { key, params } from the catalog, or { text } as it arrived from an older worker.
  // Only text from outside the catalog is cut to length.
  const words = (message, length) => message?.key ? t(message.key, message.params || {}) : fixedText(message?.text, length);
  const fromResult = result => ({ key: result?.messageKey, params: result?.messageParams, text: result?.message });
  const hasMessage = result => Boolean(result?.message || result?.messageKey);
  // An error as the applicant reads it: its catalog key, or its own words passed on as a detail.
  const problem = (error, fallback = 'panel.assistantUnavailable') => error?.messageKey ? { key: error.messageKey, params: error.messageParams }
    : fixedText(error?.message) ? { key: 'detail', params: { detail: fixedText(error.message) } } : { key: fallback };
  const keyedError = (key, params = {}) => Object.assign(new Error(strings.english(key, params)), { messageKey: key, messageParams: params });
  const trusted = callback => event => { if (event.isTrusted) return callback(event); };
  const outdatedError = () => Object.assign(keyedError('panel.outdated'), { outdated: true });
  const send = async payload => {
    const response = await chrome.runtime.sendMessage(payload);
    // An outdated worker ignores messages it doesn't know, so Chrome resolves with no response.
    if (response === undefined) throw outdatedError();
    if (!response?.ok) {
      if (response?.errorKey) throw Object.assign(new Error(fixedText(response.error)), { messageKey: response.errorKey, messageParams: response.errorParams || {} });
      if (fixedText(response?.error)) throw new Error(fixedText(response.error));
      throw keyedError('panel.assistantUnavailable');
    }
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
  const languageName = code => new Intl.DisplayNames([language], { type: 'language' }).of(code);
  // Each question's own words; SecondHand's labels come from its catalog instead.
  const pageWords = items => items.filter(item => !item.labelKey).map(item => item.label);

  // Every fixed word on either surface comes from the catalog.
  function applyStatic() {
    document.documentElement.lang = language;
    document.documentElement.dir = strings.direction(language);
    for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
    for (const element of document.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
    for (const element of document.querySelectorAll('[data-i18n-aria-label]')) element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
  // A choice made on the other surface reaches this one through the extension's shared storage.
  function followLanguage(relabel) {
    window.addEventListener('storage', event => {
      if (event.key !== strings.STORAGE_KEY) return;
      language = strings.language();
      relabel();
    });
  }

  applyStatic();
  if (location.search === '?surface=launcher' && !location.hash) { widget(); return; }
  if (location.search || location.hash) return;
  sidePanel();

  // The on-page widget. The worker binds every request to this iframe's own tab.
  function widget() {
    document.body.classList.add('launcher-surface');
    $('launcher').hidden = false;
    const service = translation.create();
    let known = false;
    let autopilot = false;
    let site = null;
    let result = null;
    let note = null;
    let working = false;
    let outdated = false;
    let ai = { note: null, reason: '' };
    let cursor = 0;
    let pollTimer;
    // The page's language, checked once per page: the widget offers the translated view when it differs.
    let pageLanguage = '';
    let languageChecked = false;
    let languageTrouble = null;
    // The frame the page's content script was last asked for: a row taller for a message,
    // and as wide as the widget (0 until it has measured itself).
    let frame = { line: false, width: 0 };
    const AI_TIMEOUT_MS = 8000;
    // An outdated worker keeps its reload steps on screen and is not polled again.
    const trouble = error => { if (error.outdated) outdated = true; return problem(error); };

    function statusText() {
      if (outdated) return t('panel.outdated');
      if (working) return t('widget.working');
      if (note) return words(note, 120);
      if (!result) return languageTrouble ? t('widget.languageCheckFailed') : site ? t('widget.siteReady', { host: hostOf(site.origin) }) : t('widget.iowaReady');
      // Other sites: the need-you link carries the count, so it isn't repeated here.
      if (result.state === 'done' && result.pageKey === 'general') {
        const filled = Number(result.filled) || 0;
        const guessed = Number(result.guessed) || 0;
        const summary = filled > 0 ? (guessed > 0 ? t('widget.filledGuessed', { count: filled, guessed }) : t('widget.filled', { count: filled }))
          : fieldKeys(result.needYou).length ? t('widget.nothingMatches') : words(fromResult(result), 120);
        const notes = [ai.note ? words(ai.note) : '', Number(result.laya) > 0 ? t('widget.suggestedByLaya') : ''].filter(Boolean);
        return notes.length ? [summary.replace(/\.$/, ''), ...notes].join(' · ') : summary;
      }
      if (result.state === 'done') {
        const todo = words({ key: result.todoKey, params: result.todoParams, text: result.todo }, 90);
        return [t('widget.filled', { count: Number(result.filled) || 0 }), todo].filter(Boolean).join(' · ');
      }
      return words(fromResult(result), 120);
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
      // Answers still to give show as a yellow link that finds each one in the form.
      const needYou = ['done', 'waiting'].includes(result?.state) ? fieldKeys(result.needYou) : [];
      $('need-you').hidden = outdated || !needYou.length;
      $('need-you').textContent = t('widget.needYou', { count: needYou.length });
      $('widget-text').textContent = statusText();
      $('autofill').title = site ? t('widget.autofillSiteTitle') : t('widget.autofillIowaTitle');
      const details = [hasMessage(result) ? words(fromResult(result)) : '', ai.note ? words(ai.note) : '', ai.reason, fixedText(languageTrouble?.message, 160)];
      $('widget-text').title = outdated ? t('panel.outdated') : fixedText(details.filter(Boolean).join(' '), 240);
      // The status is always read to screen readers, but shown as a line only when the reader
      // must act and the need-you link doesn't already say so: a problem, an unlock or CAPTCHA
      // step, a fill that found nothing, or an outdated extension. The Autofill button's title
      // keeps the Iowa address disclosure.
      const waiting = ['waiting', 'done'].includes(result?.state) && !needYou.length;
      const unfinished = waiting && (result.state === 'waiting' || Boolean(result.todo || result.todoKey) || !(Number(result.filled) > 0));
      const message = outdated || Boolean(note) || ['error', 'offline'].includes(result?.state) || unfinished;
      $('widget-text').classList.toggle('visually-hidden', !message);
      $('translate-offer').hidden = outdated || message || !known || !pageLanguage || pageLanguage === language;
      // The widget is as wide as what it shows, up to 272px (see panel.css). An outdated worker
      // is not asked for anything more; its steps fill the frame the widget already has.
      const room = message || !$('translate-offer').hidden;
      const width = outdated || $('widget').hidden ? frame.width : Math.ceil($('widget').getBoundingClientRect().width);
      if (!outdated && (room !== frame.line || width !== frame.width)) fitFrame(room, width);
    }
    // The widget can't size its own frame: the worker asks this tab's content script for it.
    async function fitFrame(line, width) {
      frame = { line, width };
      try { await send({ type: 'ui:widgetSize', line, ...(width ? { width } : {}) }); }
      catch (error) { note = trouble(error); render(); }
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
          note = null;
        } catch (error) { note = trouble(error); }
        render();
        if (known && !outdated && !languageChecked) checkLanguage();
      }
      if (!outdated) pollTimer = setTimeout(poll, 1500);
    }

    // Is this page in the applicant's language? Chrome's detector reads the page's own question words
    // (or the page's declared language when the detector isn't ready). Nothing is asked without
    // Chrome's translator: then there is no translated view to offer.
    async function checkLanguage() {
      if (!service.supported()) return;
      languageChecked = true;
      let reply;
      try { reply = await send({ type: 'ui:questions' }); }
      catch (error) { note = trouble(error); render(); return; }
      const items = Array.isArray(reply?.questions) ? reply.questions.filter(item => typeof item?.label === 'string') : [];
      try { pageLanguage = await service.pageLanguage(pageWords(items), reply?.lang); }
      catch (error) { languageTrouble = error; }
      render();
    }

    // Chrome's on-device AI runs only in extension pages like this one, not in the worker, and
    // only when the desktop's Laya isn't ready. It sees the labels and options of the questions
    // the rules left open, never values, and gets one try per click within its time limit.
    async function aiGuesses(plan) {
      const fields = (Array.isArray(plan?.unmatched) ? plan.unmatched : []).filter(field => typeof field?.label === 'string' && field.label.trim());
      if (!fields.length) return { status: 'mapped', mapping: {} };
      try { return await SecondHandAI.mapWithChromeAI(fields, { allowedKeys: plan.allowedKeys, timeoutMs: AI_TIMEOUT_MS }); }
      catch (error) { return { status: 'error', reason: error.message }; }
    }

    $('autofill').addEventListener('click', trusted(async () => {
      if (working || outdated) return;
      working = true; note = null; ai = { note: null, reason: '' }; render();
      try {
        const request = { type: 'ui:autofill', confirmed: true };
        // Iowa's form is filled by its own rules; other sites also get an AI's guesses. When Laya is
        // ready it answers in the worker for the plan it just made, and Chrome's AI stays off.
        if (site) {
          const plan = await send({ type: 'ui:plan', confirmed: true });
          if (plan?.laya === true) request.guesses = {};
          else {
            const answer = await aiGuesses(plan);
            if (answer?.status !== 'mapped') ai = { note: { key: 'widget.aiUnavailable' }, reason: fixedText(answer?.reason, 160) };
            else if (Object.keys(answer.mapping).length) request.guesses = answer.mapping;
          }
        }
        result = await send(request);
        cursor = 0;
        autopilot = continuing(result);
      } catch (error) { const shown = trouble(error); result = { state: 'error', message: error.message, messageKey: shown.key, messageParams: shown.params }; autopilot = false; }
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
        note = focused?.focused ? null : { key: site ? 'widget.findInForm' : 'widget.findInIowa' };
      } catch (error) { note = trouble(error); }
      render();
    }));
    $('unlock').addEventListener('click', trusted(async () => {
      try {
        await send({ type: 'ui:showApp', confirmed: true });
        result = { state: 'waiting', messageKey: 'desktop.unlockThenAutofill', messageParams: {} };
      } catch (error) { note = trouble(error); }
      render();
    }));
    // The logo, like the pill, opens the side panel. Send immediately inside the trusted click:
    // Chrome needs the user gesture to open the panel.
    for (const id of ['details', 'pill']) {
      $(id).addEventListener('click', trusted(() => {
        send({ type: 'ui:openPanel', confirmed: true }).catch(error => { note = trouble(error); render(); });
      }));
    }
    // The offer opens the side panel straight on the page's questions.
    $('translate-offer').addEventListener('click', trusted(() => {
      send({ type: 'ui:openPanel', confirmed: true, questions: true }).catch(error => { note = trouble(error); render(); });
    }));
    followLanguage(() => { applyStatic(); render(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    window.addEventListener('pagehide', () => clearTimeout(pollTimer), { once: true });
    render();
    checkBuild().catch(error => { note = trouble(error); render(); }).then(poll);
  }

  // Chrome's side panel: desktop status, one Autofill button, the checklist, and the page's
  // questions in the applicant's language.
  function sidePanel() {
    $('sidepanel').hidden = false;
    const service = translation.create();
    let target = null;
    let fillable = false;
    let autopilot = false;
    let site = null;
    let page = null;
    let contextRevision = 0;
    let checklistSignature = '';
    let working = false;
    let pollPromise = null;
    let pollTimer;
    let refreshAgain = false;
    let stopped = false;
    let status = { message: { key: 'panel.checkingTab' }, error: false };
    let desktopLine = null;
    // Whether Laya, the desktop's local AI, is ready: shown only while the desktop app answers.
    let layaLine = null;
    const LAYA_LINES = { ready: 'desktop.layaReady', off: 'desktop.layaOff', downloading: 'desktop.layaDownloading',
      'not-downloaded': 'desktop.layaNotReady', error: 'desktop.layaNotReady', unavailable: 'desktop.layaNotReady' };
    // The question list for the page on screen: the worker's items, and Chrome's translations of their words.
    let questions = null;
    let translated = new Map();
    let questionNote = null;
    let needsDownload = false;
    let questionBusy = false;
    let questionRun = 0;
    // "What this page says": the pages the worker read for this tab, with the key points written for
    // them; a note under the section; and whether Chrome's model waits for a click to download.
    const summaries = summary.create();
    let summaryPages = null;
    let summaryNote = null;
    let summaryDownload = false;
    let summaryBusy = false;
    let summaryStarted = false;
    let summaryRun = 0;
    const SCREENS = { 'iowa-before-start': 'summary.iowaBeforeStart', 'iowa-information': 'summary.iowaInformation', 'iowa-instructions': 'summary.iowaInstructions' };
    const STATUS = { complete: 'checklist.complete', missing: 'checklist.missing', optional: 'checklist.optional', manual: 'checklist.manual' };
    const MARKS = { complete: '✓', manual: '!', missing: '○', optional: '○' };
    const show = (message, error = false) => { status = { message, error }; renderStatus(); };
    function renderStatus() {
      $('status').textContent = words(status.message, 650);
      $('status').classList.toggle('error', status.error);
    }
    function renderDesktop() {
      if (desktopLine) $('desktop-status').textContent = words(desktopLine);
      $('laya-status').hidden = !layaLine;
      $('laya-status').textContent = layaLine ? words(layaLine) : '';
    }
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
      $('iowa-policy').hidden = !target || Boolean(site);
      const pending = site?.enabled && site.ready ? site.frames.filter(frame => !frame.enabled) : [];
      $('frames-enable').hidden = !target || !pending.length;
      $('frames-enable').disabled = working;
      $('frames-enable').textContent = t('panel.framesEnableHosts', { hosts: pending.map(frame => hostOf(frame.origin)).join(', ') });
      $('site-enable').hidden = !off;
      $('site-enable').disabled = working;
      $('site-disable').hidden = !(target && site?.enabled);
      $('site-disable').disabled = working;
      $('panel-autofill').hidden = off;
      $('panel-autofill').textContent = t(autopilot ? 'panel.stopAutofill' : 'panel.autofill');
      $('panel-autofill').disabled = !target || (!fillable && !autopilot) || working;
      document.querySelectorAll('.checklist-item').forEach(button => { button.disabled = working || !target; });
      renderQuestionControls();
      renderSummary();
    }
    function clearPage() {
      fillable = false; autopilot = false; site = null; page = null; checklistSignature = '';
      $('page-checklist').replaceChildren();
      $('checklist-section').hidden = true;
      resetQuestions();
      resetSummary();
    }
    function invalidateTarget() {
      if (stopped) return;
      contextRevision++; working = false; target = null;
      clearPage(); controls();
      show({ key: 'panel.checkingTab' });
    }
    function renderChecklist(page) {
      const entries = Array.isArray(page.checklist) ? page.checklist.filter(item => item && fieldKeys([item.key]).length && typeof item.label === 'string' && Object.hasOwn(STATUS, item.status)).slice(0, 80) : [];
      const signature = JSON.stringify([language, entries]);
      if (signature === checklistSignature) return;
      checklistSignature = signature;
      $('page-checklist').replaceChildren();
      for (const item of entries) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = `checklist-item ${item.status}`; button.dataset.key = item.key;
        const mark = document.createElement('span'); mark.className = 'checklist-mark'; mark.setAttribute('aria-hidden', 'true');
        mark.textContent = MARKS[item.status];
        const copy = document.createElement('span'); copy.className = 'checklist-copy';
        const text = words({ key: item.labelKey, params: item.labelParams, text: item.label }, 100);
        const label = document.createElement('span'); label.className = 'checklist-label'; label.textContent = text;
        const detail = document.createElement('span'); detail.className = 'checklist-detail'; detail.textContent = t(STATUS[item.status]);
        copy.append(label, detail);
        button.setAttribute('aria-label', t('checklist.rowLabel', { label: text, status: t(STATUS[item.status]) }));
        button.append(mark, copy);
        button.addEventListener('click', trusted(() => { if (!button.disabled) focusField(item.key); }));
        $('page-checklist').append(button);
      }
      const done = entries.filter(item => item.status === 'complete').length;
      $('checklist-summary').textContent = t('checklist.summary', { done, total: entries.length });
      $('checklist-section').hidden = !entries.length;
    }
    function render(state) {
      if (!state || typeof state !== 'object') throw keyedError('panel.pageUnreadable');
      page = state.page || {};
      site = siteOf(state);
      fillable = site ? site.enabled && site.ready : page.kind === 'fillable' || page.kind === 'info' || Boolean(page.todo);
      autopilot = Boolean(state.autopilot);
      renderChecklist(page);
      const result = state.result;
      const loading = target?.status === 'loading';
      if (site?.enabled && !site.ready) show({ key: loading ? 'panel.waitingLoad' : 'panel.reloadToRead' });
      else if (hasMessage(result)) show(fromResult(result), result.state === 'error' || result.state === 'offline');
      else if (site && !site.enabled) show({ key: 'panel.siteOff', params: { host: hostOf(site.origin) } });
      else if (site) show({ key: 'panel.siteHint' });
      else if (fillable) show({ key: 'panel.iowaHint' });
      else if (page.reason) show({ key: page.reasonKey, params: page.reasonParams, text: page.reason });
      else show({ key: 'panel.nothingToFill' });
      controls();
      // The widget's language offer opened this panel: show the questions without another click.
      if (state.showQuestions === true) showQuestions(false);
      startSummary();
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
            show({ key: 'panel.openIowa' });
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
          if (revision === contextRevision) { clearPage(); controls(); show(problem(error), true); }
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
        desktopLine = { key: !desktop?.connected ? 'desktop.notRunning' : desktop.unlocked ? 'desktop.unlocked' : 'desktop.locked' };
        layaLine = desktop?.connected && Object.hasOwn(LAYA_LINES, desktop.laya) ? { key: LAYA_LINES[desktop.laya] } : null;
        $('desktop-action').hidden = !desktop?.connected || desktop.unlocked;
        $('desktop-status').parentElement.classList.toggle('error', !ready);
      } catch (error) {
        desktopLine = problem(error);
        layaLine = null;
        $('desktop-action').hidden = true;
        $('desktop-status').parentElement.classList.add('error');
      }
      renderDesktop();
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
        if (revision === contextRevision) show(problem(error), true);
        return null;
      } finally {
        if (revision === contextRevision) { working = false; controls(); }
        schedulePoll();
      }
    }
    async function focusField(key) {
      const result = await act({ type: 'ui:focusField', key });
      if (result && !result.focused) show({ key: 'panel.fieldOffScreen' });
    }

    // The page's questions in the applicant's language. SecondHand's own labels come from its
    // catalog; the page's words from Chrome's translator on this computer. They are shown here
    // only: nothing translated is ever sent toward the page or written into a field.
    function resetQuestions() {
      questionRun++;
      questions = null; translated = new Map(); questionNote = null; needsDownload = false; questionBusy = false;
      service.forget();
      renderQuestionList();
    }
    function renderQuestionControls() {
      const readable = Boolean(target) && fillable;
      const supported = service.supported();
      $('questions-show').hidden = !(readable && supported && (language !== 'en' || questions)) || questionBusy;
      $('questions-show').disabled = working || questionBusy;
      $('questions-show').textContent = needsDownload ? t('translate.download', { language: languageName(language) }) : t(questions ? 'questions.refresh' : 'questions.show');
      // Without Chrome's translator the feature is hidden behind one plain line.
      const note = readable && !supported && language !== 'en' ? { message: { key: 'translate.missing' }, error: false } : readable ? questionNote : null;
      $('questions-note').hidden = !note;
      $('questions-note').textContent = note ? words(note.message) : '';
      $('questions-note').classList.toggle('error', Boolean(note?.error));
      $('questions').hidden = !readable || !questions;
    }
    function renderQuestionList() {
      $('questions-list').replaceChildren(...(questions?.items || []).map(questionRow));
      $('questions-summary').textContent = questions ? t('questions.count', { count: questions.items.filter(item => item.id).length }) : '';
      $('questions-pending').hidden = !questions?.pending;
      renderQuestionControls();
    }
    function questionRow(item) {
      // A question finds its place in the form; words from an information screen are only read.
      const row = document.createElement(item.id ? 'button' : 'div');
      row.className = item.id ? 'checklist-item question' : 'checklist-item question info';
      if (item.id) {
        row.type = 'button';
        row.disabled = working || !target;
        row.addEventListener('click', trusted(() => { if (!row.disabled) focusField(item.id); }));
      }
      // SecondHand's own label is simply shown in the applicant's language; a translation of the
      // page's words keeps the original underneath, to match it with the form.
      const own = item.labelKey ? t(item.labelKey, item.labelParams || {}) : translated.get(item.label);
      const copy = document.createElement('span'); copy.className = 'checklist-copy';
      const label = document.createElement('span'); label.className = 'checklist-label'; label.textContent = fixedText(own || item.label, 400);
      const original = document.createElement('span'); original.className = 'checklist-detail'; original.textContent = !item.labelKey && own && own !== item.label ? fixedText(item.label, 400) : '';
      original.hidden = !original.textContent;
      copy.append(label, original);
      row.append(copy);
      return row;
    }
    function listedItems(reply) {
      const valid = reply && Array.isArray(reply.questions) && reply.questions.every(item => typeof item?.id === 'string' && typeof item.label === 'string');
      if (!valid) throw keyedError('worker.questionsUnreadable');
      return reply.questions;
    }
    async function showQuestions(click) {
      if (questionBusy || !target || !service.supported()) return;
      const run = ++questionRun;
      const revision = contextRevision;
      const chosen = language;
      const current = () => run === questionRun && revision === contextRevision && chosen === language && !stopped;
      const say = (message, error = false) => { if (current()) { questionNote = { message, error }; renderQuestionControls(); } };
      questionBusy = true; needsDownload = false;
      say({ key: 'questions.reading' });
      try {
        const reply = await act({ type: 'ui:questions' });
        if (!current()) return;
        // act() already put any error in the status line.
        if (!reply) { questionNote = null; return; }
        const items = listedItems(reply);
        questions = { items, pending: Number(reply.pending) || 0 };
        translated = new Map();
        renderQuestionList();
        const texts = pageWords(items);
        // SecondHand's own labels are already in the applicant's language.
        if (!texts.length) {
          if (items.length) { questionNote = null; renderQuestionControls(); } else say({ key: 'questions.none' });
          return;
        }
        const source = await service.pageLanguage(texts, reply.lang);
        if (!current()) return;
        if (!source) return say({ key: 'questions.unknownLanguage' });
        if (source === chosen) return say({ key: 'questions.sameLanguage', params: { language: languageName(chosen) } });
        const names = { source: languageName(source), target: languageName(chosen) };
        const availability = await service.availability(source, chosen);
        if (!current()) return;
        if (availability === 'unavailable') return say({ key: 'translate.unavailable', params: names });
        // Chrome downloads a language only from the applicant's click.
        if (availability !== 'available' && !click) {
          needsDownload = true;
          return say({ key: 'translate.needsDownload', params: { language: names.target } });
        }
        const downloading = percent => say({ key: 'translate.downloading', params: { language: names.target, percent } });
        if (availability === 'available') say({ key: 'translate.translating' }); else downloading(0);
        const translator = await service.translator(source, chosen, {
          onProgress: loaded => downloading(Math.round(loaded * 100)),
          onStall: () => say({ key: 'translate.stalled', params: { language: names.target, source: names.source } }, true)
        });
        if (!current()) return;
        say({ key: 'translate.translating' });
        const results = await service.translate(translator, source, chosen, texts);
        if (!current()) return;
        translated = results;
        renderQuestionList();
        say({ key: 'translate.done' });
      } catch (error) {
        say({ key: 'translate.failed', params: { detail: fixedText(error.message, 200) } }, true);
      } finally {
        if (run === questionRun) { questionBusy = false; renderQuestionControls(); }
      }
    }

    // What this page says: up to five key points Chrome's Summarizer writes on this computer from the
    // page's own words (Iowa's information-only screens, or a site that is on). They are labelled as
    // automatic, kept by the worker for the tab, and never sent toward the page.
    function summarizable() {
      return Boolean(target && page) && (site ? site.enabled && site.ready : supportedUrl(target.url));
    }
    function resetSummary() {
      summaryRun++;
      summaryPages = null; summaryNote = null; summaryDownload = false; summaryBusy = false; summaryStarted = false;
      renderSummary();
    }
    function startSummary() { if (!summaryStarted && summarizable()) summarize(false); }
    function renderSummary() {
      const readable = summarizable();
      // Without Chrome's Summarizer the section is hidden behind one plain line.
      const note = !readable ? null : summaries.supported() ? summaryNote : { message: { key: 'summary.missing' }, error: false };
      $('summary-note').hidden = !note;
      $('summary-note').textContent = note ? words(note.message) : '';
      $('summary-note').classList.toggle('error', Boolean(note?.error));
      $('summary-get').hidden = !readable || !summaryDownload || summaryBusy;
      $('summary-get').disabled = working || summaryBusy;
      const shown = readable && summaryPages ? summaryPages.filter(item => item.unread || item.summary?.language === language) : [];
      $('summary').hidden = !shown.length;
      $('summary-title').textContent = t(shown.some(item => item.current) ? 'summary.title' : 'summary.earlier');
      $('summary-list').replaceChildren(...shown.map(summaryGroup));
      $('summary-english').hidden = !shown.some(item => item.summary?.english);
    }
    function summaryGroup(item) {
      const group = document.createElement('div'); group.className = 'summary-group';
      // Iowa's screens are named, so points kept from an earlier one are not taken for this page's.
      if (Object.hasOwn(SCREENS, item.pageKey)) {
        const name = document.createElement('h3'); name.textContent = t(SCREENS[item.pageKey]);
        group.append(name);
      }
      if (item.unread || !item.summary.points.length) {
        const empty = document.createElement('p'); empty.className = 'summary-empty';
        empty.textContent = t(item.unread ? 'summary.unread' : 'summary.nothing');
        group.append(empty);
      } else {
        const list = document.createElement('ul');
        // Points can be in English inside a right-to-left panel: each reads in its own direction.
        for (const point of item.summary.points) { const entry = document.createElement('li'); entry.dir = 'auto'; entry.textContent = fixedText(point, 400); list.append(entry); }
        group.append(list);
      }
      return group;
    }
    function listedPages(reply) {
      const written = value => value === null || (value && strings.LANGUAGES.includes(value.language) && typeof value.english === 'boolean' &&
        Array.isArray(value.points) && value.points.every(point => typeof point === 'string'));
      const valid = reply && Array.isArray(reply.pages) && reply.pages.every(item => item && typeof item.id === 'string' && typeof item.pageKey === 'string' &&
        typeof item.lang === 'string' && typeof item.text === 'string' && typeof item.current === 'boolean' && typeof item.unread === 'boolean' && written(item.summary));
      if (!valid) throw keyedError('worker.pageTextUnreadable');
      return reply.pages;
    }
    // Points Chrome wrote in English, in the applicant's language when Chrome's translator is ready;
    // otherwise they stay in English and the section says so.
    async function inLanguage(points, chosen) {
      if (!points.length) return { points, english: false };
      if (!service.supported() || await service.availability('en', chosen) !== 'available') return { points, english: true };
      const translated = await service.translate(await service.translator('en', chosen), 'en', chosen, points);
      return { points: points.map(point => translated.get(point)), english: false };
    }
    async function summarize(click) {
      if (summaryBusy || !summarizable() || !summaries.supported()) return;
      const run = ++summaryRun;
      const revision = contextRevision;
      const chosen = language;
      const tabId = target.id;
      const current = () => run === summaryRun && revision === contextRevision && chosen === language && !stopped;
      const say = (message, error = false) => { if (current()) { summaryNote = message ? { message, error } : null; renderSummary(); } };
      summaryStarted = true; summaryBusy = true; summaryDownload = false;
      renderSummary();
      let untranslated = null;
      try {
        const pages = listedPages(await send({ type: 'ui:pageText', tabId }));
        if (!current()) return;
        summaryPages = pages;
        renderSummary();
        for (const item of pages.filter(entry => !entry.unread && entry.summary?.language !== chosen)) {
          const input = translation.primary(item.lang);
          const output = await summaries.outputLanguage(chosen, input);
          const availability = await summaries.availability(output, input);
          if (!current()) return;
          if (availability === 'unavailable') return say({ key: 'summary.unavailable' });
          // Chrome downloads its model only from the applicant's click.
          if (availability !== 'available' && !click) { summaryDownload = true; return say({ key: 'summary.needsDownload' }); }
          const downloading = percent => say({ key: 'summary.downloading', params: { percent } });
          if (availability === 'available') say({ key: 'summary.reading' }); else downloading(0);
          const summarizer = await summaries.summarizer(output, input, {
            onProgress: loaded => downloading(Math.round(loaded * 100)),
            onStall: () => say({ key: 'summary.stalled' }, true)
          });
          if (!current()) return;
          say({ key: 'summary.reading' });
          const points = await summaries.points(summarizer, item.text);
          // A translation that fails leaves the points in English, and the note says why.
          const shown = output === chosen ? { points, english: false } : await inLanguage(points, chosen).catch(error => { untranslated = error; return { points, english: true }; });
          item.summary = { language: chosen, ...shown };
          // Kept for the tab even if the applicant moved on: the worker matches them to these words.
          await send({ type: 'ui:keepSummary', tabId, id: item.id, summary: item.summary });
          if (!current()) return;
          renderSummary();
        }
        say(untranslated ? { key: 'summary.translateFailed', params: { detail: fixedText(untranslated.message, 200) } } : null, Boolean(untranslated));
      } catch (error) {
        say(error.messageKey ? problem(error) : { key: 'summary.failed', params: { detail: fixedText(error.message, 200) } }, true);
      } finally {
        if (run === summaryRun) { summaryBusy = false; renderSummary(); }
      }
    }

    $('panel-autofill').addEventListener('click', trusted(async () => {
      if ($('panel-autofill').disabled) return;
      const stopping = autopilot;
      const result = await act(stopping ? { type: 'ui:stop', confirmed: true } : { type: 'ui:autofill', confirmed: true }, { key: stopping ? 'panel.stopping' : 'panel.filling' });
      if (result) autopilot = !stopping && continuing(result);
      if (hasMessage(result)) show(fromResult(result), result.state === 'error' || result.state === 'offline');
      controls();
      if (!stopping) await desktopStatus();
      await refresh();
    }));
    $('site-enable').addEventListener('click', trusted(async () => {
      if ($('site-enable').disabled || !target || !site) return;
      let granted;
      // Ask before anything is awaited: Chrome only shows its prompt inside the user's click.
      try { granted = await chrome.permissions.request({ origins: [`${site.origin}/*`] }); }
      catch (error) { show(problem(error, 'panel.chromeCouldntAskSite'), true); return; }
      if (!granted) { show({ key: 'panel.chromeDeclinedSite' }, true); return; }
      const result = await act({ type: 'ui:enableSite', confirmed: true }, { key: 'panel.approveSite' });
      await refresh();
      if (result?.enabled) show({ key: 'panel.siteOn', params: { host: hostOf(result.origin) } });
    }));
    $('frames-enable').addEventListener('click', trusted(async () => {
      if ($('frames-enable').disabled || !target || !site?.enabled) return;
      const pending = site.frames.filter(frame => !frame.enabled);
      if (!pending.length) return;
      let granted;
      // Keep the Chrome request in this trusted click, before any awaited work.
      try { granted = await chrome.permissions.request({ origins: pending.map(frame => `${frame.origin}/*`) }); }
      catch (error) { show(problem(error, 'panel.chromeCouldntAskFrames'), true); return; }
      if (!granted) { show({ key: 'panel.chromeDeclinedFrames' }, true); return; }
      const result = await act({ type: 'ui:enableFrames', confirmed: true }, { key: 'panel.approveFrames' });
      await refresh();
      if (result?.enabled) show({ key: 'panel.framesOn' });
    }));
    $('site-disable').addEventListener('click', trusted(async () => {
      if ($('site-disable').disabled) return;
      const result = await act({ type: 'ui:disableSite', confirmed: true }, { key: 'panel.turningOff' });
      await refresh();
      if (result && !result.enabled) show({ key: 'panel.siteOffDone' });
    }));
    $('desktop-action').addEventListener('click', trusted(async () => {
      try { await send({ type: 'ui:showApp', confirmed: true }); desktopLine = { key: 'desktop.unlockThenAutofill' }; }
      catch (error) { desktopLine = problem(error); }
      renderDesktop();
    }));
    $('questions-show').addEventListener('click', trusted(() => { if (!$('questions-show').disabled) showQuestions(true); }));
    $('summary-get').addEventListener('click', trusted(() => { if (!$('summary-get').disabled) summarize(true); }));
    // The choice is saved in this extension's storage; the widget follows through the storage event.
    function relabel() {
      applyStatic();
      $('language').value = language;
      if (page) renderChecklist(page);
      renderStatus();
      renderDesktop();
      resetQuestions();
      resetSummary();
      controls();
      startSummary();
    }
    $('language').value = language;
    $('language').addEventListener('change', () => {
      strings.setLanguage($('language').value);
      language = strings.language();
      relabel();
    });
    followLanguage(relabel);
    // An outdated worker stops the panel with its reload steps on screen.
    async function start() {
      try { await checkBuild(); } catch (error) {
        if (error.outdated) {
          stopped = true; target = null; clearPage(); controls(); show(problem(error), true);
          $('desktop-status').parentElement.hidden = true;
          return;
        }
        show(problem(error), true);
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
