'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const strings = globalThis.SecondHandStrings;
  const translation = globalThis.SecondHandTranslation;
  const summary = globalThis.SecondHandSummary;
  // Must match BUILD in background.js: change both together. Chrome loads these pages
  // from disk right away but keeps running the old worker until SecondHand is reloaded.
  const BUILD = '2026-10-06.24';
  // The applicant's language: the choice saved in this extension's storage, else the browser's.
  let language = strings.language();
  const t = (key, params = {}) => strings.text(language, key, params);
  const fixedText = (value, length = 360) => typeof value === 'string' ? value.slice(0, length) : '';
  // A message is { key, params } from the catalog, or { text } as it arrived from an older worker.
  // Only text from outside the catalog is cut to length.
  // A message whose first part says nothing without its count (see ONLY_LEFT) leaves no space in front.
  const words = (message, length) => message?.key ? t(message.key, message.params || {}).trim() : fixedText(message?.text, length);
  const fromResult = result => ({ key: result?.messageKey, params: result?.messageParams, text: result?.message });
  const hasMessage = result => Boolean(result?.message || result?.messageKey);
  // A result's message with its count of what is left for the reader set to `left`, or without it when that is
  // 0: the side panel keeps the count current as the page changes, and the card's own link carries it. A
  // message from an older worker, words only, is left as it came.
  const LEFT_KEYS = { 'result.filledNeedYou': 'result.filled', 'result.siteFilledNeedYou': 'result.siteFilled', 'result.siteFilledSuggestedNeedYou': 'result.siteFilledSuggested' };
  // Messages that are only the count: without it, what else they say. A count of questions waiting beside held
  // sensitive details (#176) says nothing without its count; the held line after it says the rest.
  const ONLY_LEFT = { 'result.needYouNotSaved': { key: 'result.noSavedAnswers' }, 'result.nothingMatchesNeedYou': { key: 'result.nothingMatches' },
    'result.siteNeedYou': { key: 'detail', params: { detail: '' } } };
  function withLeft(message, left) {
    if (!message?.key) return message;
    const params = Object.fromEntries(Object.entries(message.params || {}).map(([name, value]) => [name, value?.key ? withLeft(value, left) : value]));
    if (Object.hasOwn(LEFT_KEYS, message.key)) {
      if (left > 0) return { key: message.key, params: { ...params, needYou: left } };
      const { needYou, ...rest } = params;
      return { key: LEFT_KEYS[message.key], params: rest };
    }
    if (Object.hasOwn(ONLY_LEFT, message.key)) return left > 0 ? { key: message.key, params: { ...params, count: left } } : { params: {}, ...ONLY_LEFT[message.key] };
    return { key: message.key, params };
  }
  // An error as the applicant reads it: its catalog key, or its own words passed on as a detail.
  const problem = (error, fallback = 'panel.assistantUnavailable') => error?.messageKey ? { key: error.messageKey, params: error.messageParams }
    : fixedText(error?.message) ? { key: 'detail', params: { detail: fixedText(error.message) } } : { key: fallback };
  const keyedError = (key, params = {}) => Object.assign(new Error(strings.english(key, params)), { messageKey: key, messageParams: params });
  // A lookup or request the reader didn't ask for, whose fallback is right on any computer (its system, the keyboard
  // shortcuts, the room an outdated card asks for), reports its failure where Chrome records SecondHand's errors
  // (chrome://extensions, Errors), not on screen: there it would push aside what the reader needs, with nothing for
  // them to do about it.
  const unshown = what => error => console.error(what, error);
  const trusted = callback => event => { if (event.isTrusted) return callback(event); };
  const outdatedError = (key = 'panel.outdated') => Object.assign(keyedError(key), { outdated: true });
  const ask = async payload => {
    let response;
    try { response = await chrome.runtime.sendMessage(payload); }
    catch (error) {
      // A frame left on a page when SecondHand reloaded (it updates itself) has no extension id, and
      // Chrome refuses its messages: only reloading the page brings the new SecondHand.
      if (!chrome.runtime?.id) throw outdatedError('panel.reloadPage');
      throw error;
    }
    // An outdated worker ignores messages it doesn't know, so Chrome resolves with no response.
    if (response === undefined) throw outdatedError();
    if (!response?.ok) {
      if (response?.errorKey) throw Object.assign(new Error(fixedText(response.error)), { messageKey: response.errorKey, messageParams: response.errorParams || {} });
      if (fixedText(response?.error)) throw new Error(fixedText(response.error));
      throw keyedError('panel.assistantUnavailable');
    }
    return response.data;
  };
  // What a surface does the moment the worker turns out to be outdated; the side panel sets it.
  let whenOutdated = () => {};
  const send = async payload => {
    try { return await ask(payload); }
    catch (error) { if (error.outdated) whenOutdated(error); throw error; }
  };
  // An older worker that still answers is caught by its build.
  const checkBuild = async () => { if ((await send({ type: 'ui:ping' }))?.build !== BUILD) throw outdatedError(); };
  const fieldKeys = value => Array.isArray(value) ? value.filter(key => typeof key === 'string' && (/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key) || /^f\d{1,6}:[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(key))).slice(0, 80) : [];
  // General sites continue only after their separate explicit Fill and continue action.
  const continuing = result => (result?.pageKey !== 'general' || result?.autoContinue === true) && !['stopped', 'locked', 'offline', 'error'].includes(result?.state);
  // The worker's metadata for a site other than Iowa: its origin and whether it is turned on.
  const siteOf = state => state?.site && typeof state.site.origin === 'string' ? { origin: state.site.origin, enabled: state.site.enabled === true, ready: state.site.ready !== false, frames: Array.isArray(state.site.frames) ? state.site.frames.filter(frame => frame && typeof frame.origin === 'string') : [] } : null;
  const hostOf = origin => fixedText(new URL(origin).hostname, 90);
  const languageName = code => new Intl.DisplayNames([language], { type: 'language' }).of(code);
  // Each question's own words; SecondHand's labels come from its catalog instead.
  const pageWords = items => items.filter(item => !item.labelKey).map(item => item.label);
  // When SecondHand didn't open: one line saying where to open it on this computer.
  const DIDNT_OPEN = { mac: 'desktop.didntOpenMac', win: 'desktop.didntOpenWindows' };
  const didntOpen = async () => ({ key: DIDNT_OPEN[(await chrome.runtime.getPlatformInfo()).os] || 'desktop.didntOpen' });
  // While Autofill waits for the app: what it waits for, and where to find the app's window, which can open
  // behind Chrome, on this computer.
  const FIND_WINDOW = { mac: 'widget.findWindowMac', win: 'widget.findWindowWindows' };
  let findWindow = 'widget.findWindow';
  chrome.runtime.getPlatformInfo?.().then(info => { findWindow = FIND_WINDOW[info?.os] || findWindow; },
    unshown('Chrome couldn’t name this computer’s system. Autofill’s waiting line says where the app’s window may be on any computer.'));
  const waitingForApp = () => ({ key: 'joined', params: { first: { key: 'widget.working' }, second: { key: findWindow } } });

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
  // How many times Autofill has been started on Iowa's form from this Chrome profile, counted up to 2, in the
  // extension pages' own storage like the language choice. Before the first start, the card says all of what
  // Autofill does; after it, only where it matters. Through the first run, the lines on its pages say all of what
  // Autofill waits for; once the reader has started it again, the short form (see BRIEF). Nothing about the
  // applicant is kept here.
  const STARTED_KEY = 'secondhand.autofillStarted';
  const starts = () => { try { return Number(localStorage.getItem(STARTED_KEY)) || 0; } catch { return 0; } };
  const startedBefore = () => starts() > 0;
  const usedBefore = () => starts() > 1;
  const noteStarted = () => { try { localStorage.setItem(STARTED_KEY, String(Math.min(starts() + 1, 2))); } catch { /* storage is a convenience here */ } };
  const followStarted = rerender => { window.addEventListener('storage', event => { if (event.key === STARTED_KEY) rerender(); }); };
  // The keyboard shortcuts Chrome gives SecondHand (chrome://extensions/shortcuts), by command: a button's tooltip
  // names the one set for it. Read once; `rerender` runs when they are known.
  // The manifest's command names.
  const COMMANDS = Object.freeze({ autofill: 'autofill', nextQuestion: 'next-question' });
  let shortcuts = {};
  function readShortcuts(rerender) {
    const reading = chrome.commands?.getAll?.();
    if (!reading) return;
    reading.then(list => {
      shortcuts = Object.fromEntries(list.filter(command => command.shortcut).map(command => [command.name, command.shortcut]));
      rerender();
    }, unshown('Chrome couldn’t list SecondHand’s keyboard shortcuts. No button names one.'));
  }
  // What Iowa's applicant page asks while answers are left: SecondHand clicks Save and Continue once nothing is.
  const CHECK_FIRST = 'iowa.missingAnswers';
  // A line's short form, for a reader who has seen it through a whole run (see usedBefore).
  const BRIEF = Object.freeze({ [CHECK_FIRST]: 'result.movesOn' });
  function briefly(message) {
    if (!message?.key || !usedBefore()) return message;
    if (Object.hasOwn(BRIEF, message.key)) return { key: BRIEF[message.key], params: {} };
    return { key: message.key, params: Object.fromEntries(Object.entries(message.params || {}).map(([name, value]) => [name, value?.key ? briefly(value) : value])) };
  }
  const withShortcut = (title, name) => [title, shortcuts[name] ? t('shortcut.keys', { keys: shortcuts[name] }) : ''].filter(Boolean).join(' ');

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
    // Which Iowa page the tab shows, as the worker read it.
    let pageKey = '';
    let autopilot = false;
    let site = null;
    let result = null;
    let note = null;
    let working = false;
    let outdated = false;
    // The reader hid the card: only the logo shows until they click it. The choice holds for this tab, in
    // the frame's session storage, so the card stays out of the way as the form goes from page to page.
    const HIDDEN_KEY = 'secondhand.cardHidden';
    let collapsed = (() => { try { return sessionStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } })();
    const rememberHidden = hidden => { try { if (hidden) sessionStorage.setItem(HIDDEN_KEY, '1'); else sessionStorage.removeItem(HIDDEN_KEY); } catch { /* the choice then lasts for this page */ } };
    // Why the widget is outdated: its worker is older than this page (panel.outdated), which Restart
    // fixes, or SecondHand reloaded and left this frame behind (panel.reloadPage). An outdated worker
    // is asked once for a frame with room for a line, in the oldest form of that request.
    let outdatedKey = 'panel.outdated';
    let roomAsked = false;
    // The page's content script said it can size this card's frame when asked directly, which an outdated card
    // needs: its worker can't (it is older than the card, or gone after SecondHand restarted).
    let pageSizes = false;
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.data?.type !== 'secondhand:cardHello' || pageSizes) return;
      pageSizes = true;
      render();
    });
    // What an outdated widget says: the whole of it, or the short form when its frame can't hold the whole.
    const OUTDATED_LINES = { 'panel.outdated': ['widget.outdatedLong', 'widget.outdated'], 'panel.reloadPage': ['panel.reloadPage', 'panel.reloadPageShort'] };
    let ai = { note: null, reason: '' };
    let cursor = 0;
    let pollTimer;
    // The page's language, checked once per page: the widget offers the translated view when it differs.
    let pageLanguage = '';
    let languageChecked = false;
    let languageTrouble = null;
    // The frame the page's content script was last asked for: whether it holds a line to read, the
    // widget's measured size (empty until it has measured itself), and whether it is only the logo.
    let frame = { line: false, size: {}, pill: false };
    const AI_TIMEOUT_MS = 8000;
    // An outdated worker keeps its notice on screen and is not polled again.
    const trouble = error => { if (error.outdated) { outdated = true; outdatedKey = error.messageKey; } return problem(error); };

    // Before Autofill on Iowa: all of what it does, until it has been started once from this Chrome. After that, only
    // where it matters: on the applicant page, that the address page after it may have SecondHand pick an address.
    const readyLine = () => !startedBefore() ? t('widget.iowaReady') : pageKey === 'iowa-personal-information' ? t('widget.addressNext') : '';
    function statusText() {
      if (outdated) return t((OUTDATED_LINES[outdatedKey] || OUTDATED_LINES['panel.outdated'])[0]);
      if (working) return words(waitingForApp());
      if (note) return words(note, 120);
      if (!result) return !site ? readyLine() : languageTrouble ? t('widget.languageCheckFailed') : t('widget.siteReady', { host: hostOf(site.origin) });
      // A locked or closed app is said as the side panel says it, beside the button that is the step.
      if (result.state === 'locked') return t('desktop.locked');
      if (result.state === 'offline') return t('desktop.notRunning');
      // What the worker reported, in the side panel's words, without the count of what is left: the link beside
      // it carries that. While Autofill is on, what Stop would do goes after it: on a page that waits for answers,
      // where SecondHand clicks Save and Continue once nothing is left and the reader leaves the box they typed
      // in, that Stop lets the reader check and continue themselves. A reader who has seen a whole run gets the
      // short form: on that page, still that Stop erases nothing; anywhere else, no note. Why Chrome's AI
      // guessed nothing stays in the tooltip. Household questions the household list left open (#180) wait in
      // the side panel, which lists them with Add your household: the card says so after the rest.
      const household = Array.isArray(result.household?.questions) ? result.household.questions.length : 0;
      const said = words(briefly(withLeft(fromResult(result), 0)), 240);
      const text = household ? `${said} ${t('widget.household', { count: household })}` : said;
      if (!autopilot) return text;
      const checking = result.todoKey === CHECK_FIRST;
      if (usedBefore() && !checking) return text;
      const stop = t(checking && !usedBefore() ? 'widget.stopToCheck' : 'widget.stopNote');
      return `${/[.!?…。]$/.test(text) ? text : `${text}.`} ${stop}`;
    }
    function render() {
      // There is a card for this page, unless the reader hid it. An outdated card keeps its steps on screen.
      const card = known || autopilot || outdated;
      // An outdated card can be hidden too, when the page's content script can be asked directly (see below).
      const pill = card && collapsed && (!outdated || pageSizes);
      $('widget').hidden = !card || pill;
      // An outdated card the page can size directly is drawn as any other card; one it can't keeps the compact
      // notice that fits the frame it already has.
      const direct = outdated && pageSizes;
      $('widget').classList.toggle('outdated', outdated && !direct);
      $('widget').classList.toggle('restartable', outdated && !direct && outdatedKey !== 'panel.reloadPage');
      $('pill').hidden = card && !pill;
      // A hidden card's logo says the word that shows the card again; the logo of a page with nothing to fill opens the side panel.
      $('pill').classList.toggle('labeled', pill);
      $('pill-label').hidden = !pill;
      // A hidden card that waits for the reader marks its logo with a dot and says so in the logo's name.
      const needYou = ['done', 'waiting'].includes(result?.state) ? fieldKeys(result.needYou) : [];
      const waiting = pill && (needYou.length > 0 || ['waiting', 'error', 'locked', 'offline'].includes(result?.state) || Boolean(note));
      // It says so in words too, not only with the dot.
      $('pill-label').textContent = t(waiting ? 'widget.showWaiting' : 'widget.show');
      $('pill').classList.toggle('waiting', waiting);
      // One name each, said once: the round logo's from its tooltip; a hidden card's from a label that starts with the
      // word it shows, and no tooltip to repeat it.
      if (pill) {
        $('pill').removeAttribute('title');
        $('pill').setAttribute('aria-label', t(waiting ? 'widget.showWaitingTitle' : 'widget.showTitle'));
      } else {
        $('pill').title = t('widget.pillTitle');
        $('pill').removeAttribute('aria-label');
      }
      // A locked app offers Unlock, and a closed one Open SecondHand, in Autofill's place.
      const locked = result?.state === 'locked';
      const closed = result?.state === 'offline';
      $('stop').hidden = outdated || !autopilot;
      $('autofill').hidden = outdated || autopilot || locked || closed;
      $('unlock').hidden = outdated || autopilot || !locked;
      $('open-app').hidden = outdated || autopilot || !closed;
      $('restart').hidden = !outdated || outdatedKey === 'panel.reloadPage';
      $('hide').hidden = outdated && !pageSizes;
      $('autofill').disabled = working;
      // Answers still to give show as a link that finds each one in the form.
      $('need-you').hidden = outdated || !needYou.length;
      $('need-you').textContent = t('widget.needYou', { count: needYou.length });
      $('need-you').title = withShortcut(t('widget.needYouTitle'), COMMANDS.nextQuestion);
      $('widget-text').textContent = statusText();
      $('autofill').title = withShortcut(site ? t('widget.autofillSiteTitle') : t('widget.autofillIowaTitle'), COMMANDS.autofill);
      $('stop').title = withShortcut(t('widget.stopTitle'), COMMANDS.autofill);
      const details = [hasMessage(result) ? words(fromResult(result)) : '', ai.note ? words(ai.note) : '', ai.reason, fixedText(languageTrouble?.message, 160)];
      $('widget-text').title = outdated ? statusText() : fixedText(details.filter(Boolean).join(' '), 240);
      // The status is always read to screen readers, and shown as a line whenever it says something the
      // buttons don't: on Iowa, what Autofill will do before it is clicked; then what it did and what it
      // waits for; a locked or closed app; a problem; an outdated extension. Another site's name before
      // Autofill is no news.
      const message = outdated || Boolean(note) || working || Boolean(result) || (known && !site && Boolean(readyLine()));
      $('widget-text').classList.toggle('visually-hidden', !message);
      // The translated view is offered whenever the page is in another language, before and after Autofill.
      $('translate-offer').hidden = outdated || Boolean(note) || working || !known || !pageLanguage || pageLanguage === language;
      // When the frame can't hold the whole notice, the short form says what to do. Letters overhang
      // their line by a pixel or so; a line cut off is 14px more.
      if (outdated && !direct && $('widget-text').scrollHeight - $('widget-text').clientHeight > 7) $('widget-text').textContent = t((OUTDATED_LINES[outdatedKey] || OUTDATED_LINES['panel.outdated'])[1]);
      // Screen readers hear the same words, from a region outside the card, so a card the reader hid still speaks.
      // A page with nothing for SecondHand to do has no card, and says nothing.
      const spoken = card ? $('widget-text').textContent : '';
      if ($('widget-status').textContent !== spoken) $('widget-status').textContent = spoken;
      if (outdated && !direct && outdatedKey !== 'panel.reloadPage' && !roomAsked) {
        roomAsked = true;
        send({ type: 'ui:widgetSize', line: true })
          .catch(unshown('SecondHand’s outdated worker couldn’t make room for the card’s notice. The card shows its short form when the whole doesn’t fit.'));
      }
      // The widget is as wide and as tall as what it shows, up to 272px by 166px (see panel.css). An outdated
      // worker is not asked for anything more; its notice fills the frame the widget already has.
      const room = message || !$('translate-offer').hidden;
      const size = outdated && !direct ? frame.size : pill ? measurePill() : $('widget').hidden ? frame.size : measure(message);
      if (!outdated && (room !== frame.line || JSON.stringify(size) !== JSON.stringify(frame.size) || pill !== frame.pill)) fitFrame(room, size, pill);
      // The worker can't size an outdated card's frame, so the page's content script is asked directly, in the same terms.
      if (direct && (room !== frame.line || JSON.stringify(size) !== JSON.stringify(frame.size) || pill !== frame.pill)) {
        frame = { line: room, size, pill };
        window.parent.postMessage({ type: 'secondhand:cardSize', line: room, ...size, ...(pill ? { pill } : {}) }, location.ancestorOrigins?.[0] || '*');
      }
    }
    // The widget's own size, not its frame's, so it can ask for a wider frame than it has. While a
    // line shows, also its size for a narrow page (see content.js): as wide as its buttons alone, or
    // the least wider that shows the whole line, and as tall as the line's rows then make it. Each
    // read lays the widget out at once, before anything is drawn.
    function measure(line) {
      const card = $('widget'), text = $('widget-text'), box = () => card.getBoundingClientRect();
      card.style.maxWidth = '272px';
      const size = { width: Math.ceil(box().width), height: Math.ceil(box().height) };
      if (line) {
        text.classList.add('visually-hidden');
        const buttons = Math.ceil(box().width);
        text.classList.remove('visually-hidden');
        for (let width = buttons; width > 0; width = Math.min(size.width, width + 24)) {
          card.style.width = `${width}px`;
          size.narrowWidth = width;
          size.narrowHeight = Math.ceil(box().height);
          // Letters overhang their line by a pixel or so; a line cut off is 16px more.
          if (width >= size.width || text.scrollHeight - text.clientHeight <= 7) break;
        }
      }
      for (const property of ['max-width', 'width']) card.style.removeProperty(property);
      // A size it could not measure is left out.
      return Object.fromEntries(Object.entries(size).filter(([, value]) => value > 0));
    }
    // A hidden card's frame: as wide as its logo and the word beside it.
    function measurePill() {
      const width = Math.ceil($('pill').getBoundingClientRect().width);
      return width > 0 ? { width } : {};
    }
    // The widget can't size its own frame: the worker asks this tab's content script for it.
    async function fitFrame(line, size, pill) {
      frame = { line, size, pill };
      try { await send({ type: 'ui:widgetSize', line, ...size, ...(pill ? { pill } : {}) }); }
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
          pageKey = typeof page.pageKey === 'string' ? page.pageKey : '';
          autopilot = Boolean(state?.autopilot);
          // While autofill runs, the worker moves ahead between polls. Otherwise keep
          // this widget's own result and adopt the worker's only after a reload, or while
          // questions wait for the side panel's Fill sensitive details, which changes it (#176).
          if (autopilot || !result || Number(result.held) > 0) result = state?.result || result;
          // The worker hands over the note a failed next-question shortcut left once: it shows until the next poll, as
          // a failed click's on the link does.
          note = state?.note ? fromResult(state.note) : null;
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
      if (!site) noteStarted();
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
    // The native host brings SecondHand forward or starts it; it opens locked.
    $('open-app').addEventListener('click', trusted(async () => {
      try {
        await send({ type: 'ui:openApp', confirmed: true });
        result = { state: 'waiting', messageKey: 'desktop.unlockThenAutofill', messageParams: {} };
      } catch (error) {
        if (error.outdated) note = trouble(error);
        else result = { state: 'error', messageKey: (await didntOpen()).key, messageParams: {} };
      }
      render();
    }));
    // The logo, like the pill, opens the side panel. Send immediately inside the trusted click:
    // Chrome needs the user gesture to open the panel. A pill that stands for a hidden card shows the card again.
    for (const id of ['details', 'pill']) {
      $(id).addEventListener('click', trusted(() => {
        if (id === 'pill' && collapsed) { collapsed = false; rememberHidden(false); render(); $('hide').focus(); return; }
        send({ type: 'ui:openPanel', confirmed: true }).catch(error => { note = trouble(error); render(); });
      }));
    }
    // Restart reloads SecondHand, which starts the worker that matches this page. This frame is then left
    // behind, like any page open during an update, so it says at once how to get SecondHand back here.
    $('restart').addEventListener('click', trusted(() => { outdatedKey = 'panel.reloadPage'; render(); chrome.runtime.reload(); }));
    // Hiding holds for this tab until the logo is clicked; nothing about the applicant is kept.
    $('hide').addEventListener('click', trusted(() => { collapsed = true; rememberHidden(true); render(); $('pill').focus(); }));
    // The offer opens the side panel straight on the page's questions.
    $('translate-offer').addEventListener('click', trusted(() => {
      send({ type: 'ui:openPanel', confirmed: true, questions: true }).catch(error => { note = trouble(error); render(); });
    }));
    followLanguage(() => { applyStatic(); render(); });
    followStarted(render);
    readShortcuts(render);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    window.addEventListener('pagehide', () => clearTimeout(pollTimer), { once: true });
    render();
    // The widget measures its own width for its frame: measure again whenever one of its fonts has loaded,
    // and fit the notice again when the frame itself changes.
    document.fonts?.addEventListener('loadingdone', render);
    window.addEventListener('resize', render);
    checkBuild().catch(error => { note = trouble(error); render(); }).then(poll);
  }

  // Chrome's side panel: desktop status, one Autofill button, the checklist, and the page's
  // questions in the applicant's language.
  function sidePanel() {
    $('sidepanel').hidden = false;
    const service = translation.create();
    let target = null;
    // No tab SecondHand can read has been found yet: Autofill isn't offered.
    let nowhere = true;
    let fillable = false;
    let autopilot = false;
    // Autofill has reported on this tab: its result is in the status line.
    let told = false;
    // Autofill has run on the page on screen: until then a required question is only not filled yet.
    let ran = false;
    // That run waits for answers, and clicks Save and Continue once nothing is left and the reader leaves the box (see CHECK_FIRST).
    let checkFirst = false;
    // The questions Autofill left for the reader, and which of them the link under the status goes to next.
    let left = [];
    let leftCursor = 0;
    // On a page with no checklist, those questions by name, as the worker read them from the page, and the
    // questions Autofill filled there.
    let named = [];
    let namedSignature = '';
    let filledNames = [];
    let filledSignature = '';
    let site = null;
    let page = null;
    // The questions the last Autofill on this page could have filled but had no saved answer for.
    let notSaved = [];
    // Save to My information (#98): those questions on a general-engine page, by id and their own words, and
    // whether the page holds an answer now. Never the answer itself: the worker reads it after the Save click.
    let savable = [];
    let savableSignature = '';
    // Fill sensitive details (#176): the questions whose saved answers the app held back until the applicant allows them,
    // by id and their own words. One button asks the app for all of them.
    let held = [];
    let heldSignature = '';
    // Add your household (#180): the household questions the last Autofill left open because of what the household list lacks
    // (no list saved, or a birth date missing on it), by id and their own words. One button opens the app on Your household.
    let household = null;
    let householdSignature = '';
    // Laya's best guesses (#185): the questions the last Autofill filled with one, by id and their own words, to find and check.
    let layaGuesses = [];
    let guessesSignature = '';
    // Remember for next time (#186): the open questions the last Autofill left that a custom answer may fill, by id and their own
    // words, whether their answer changes over time, and whether the page holds an answer now. Never the answer itself: the
    // worker reads it after the Remember click. `rememberChoices` keeps each row's checkbox as the applicant left it.
    let rememberable = [];
    let rememberSignature = '';
    const rememberChoices = new Map();
    let contextRevision = 0;
    let checklistSignature = '';
    let working = false;
    let pollPromise = null;
    let pollTimer;
    let refreshAgain = false;
    let stopped = false;
    let status = { message: { key: 'panel.checkingTab' }, error: false };
    // The last change to all websites, kept on screen until the tab changes or another action starts:
    // it can say how to remove the access Chrome keeps.
    let notice = null;
    // SecondHand on all websites, as the worker last said (null until it has).
    let allSites = null;
    let desktopLine = null;
    // What the desktop row's button does: open a closed app, bring a locked one forward to unlock, or
    // ask it for Touch ID when its status says Touch ID is ready (#99).
    let desktopAction = null;
    const ACTIONS = { open: 'desktop.open', unlock: 'panel.unlock', touchId: 'panel.unlockTouchId', restart: 'panel.restart' };
    // Why Touch ID didn't unlock, said as SecondHand comes forward for the password.
    const TOUCH_ID_LINES = { cancelled: 'desktop.touchIdDidntUnlock', off: 'desktop.unlockThenAutofill' };
    // While SecondHand opens, the panel checks about once a second for about 20 seconds.
    let opening = false;
    let desktopRun = 0;
    const OPEN_CHECKS = 20;
    const OPEN_CHECK_MS = 1000;
    // Why Laya, the desktop's local AI, isn't guessing: said only on a site that is on, where it would.
    let layaLine = null;
    // SecondHand updating itself (#85): the steps to do it by hand when the worker can't, as it last
    // said, and whether this is the first side panel since an update.
    let updateSteps = null;
    let updated = false;
    const UPDATE_STEPS = { failed: 'panel.updateFailed', elsewhere: 'panel.updateElsewhere' };
    // The build the side panel last ran, in this extension's own storage (as the language choice is).
    const BUILD_KEY = 'secondhand.build';
    const LAYA_LINES = { off: 'desktop.layaOff', downloading: 'desktop.layaDownloading',
      'not-downloaded': 'desktop.layaNotReady', error: 'desktop.layaNotReady', unavailable: 'desktop.layaNotReady' };
    // The question list for the page on screen: the worker's items, and Chrome's translations of their words.
    let questions = null;
    let translated = new Map();
    // The language Chrome's translator took the page's questions from.
    let translatedFrom = '';
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
    // An outdated worker ends the panel's work: its notice and Restart button stay, and nothing more is said or asked.
    let halted = false;
    // A message the card and the side panel share, as the side panel says it: its own buttons are below the line.
    const HERE = Object.freeze({ 'result.withHeld': 'result.withHeldBelow' });
    function here(message) {
      if (!message?.key) return message;
      const params = Object.fromEntries(Object.entries(message.params || {}).map(([name, value]) => [name, value?.key ? here(value) : value]));
      return { key: HERE[message.key] || message.key, params };
    }
    // A message, or null for nothing to say.
    const show = (message, error = false) => { if (halted) return; status = { message: here(message), error }; renderStatus(); };
    // A closed app is said once, by the desktop row and its Open SecondHand button, not again under Autofill.
    const reported = result => hasMessage(result) && result.state !== 'offline';
    function renderStatus() {
      const shown = notice || status;
      $('status').textContent = shown.message ? words(shown.message, 650) : '';
      $('status').classList.toggle('error', shown.error);
    }
    // On a tab SecondHand can't read: where to go, with a link to Iowa's application.
    let away = false;
    const elsewhere = () => { away = true; return { key: allSites ? 'panel.openForm' : 'panel.openIowa' }; };
    // The desktop row shows only while the app needs opening or unlocking, or can't be reached.
    function renderDesktop() {
      $('desktop-status').parentElement.hidden = !desktopLine;
      $('desktop-status').textContent = desktopLine ? words(desktopLine) : '';
      $('desktop-action').hidden = !desktopAction;
      $('desktop-action').textContent = desktopAction ? t(ACTIONS[desktopAction]) : '';
      const note = updateSteps ? { key: updateSteps } : updated ? { key: 'panel.updated' } : null;
      $('update-note').hidden = !note;
      $('update-note').textContent = note ? words(note) : '';
      $('update-note').classList.toggle('error', Boolean(updateSteps));
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
      // What Autofill will do on Iowa's form, said before it is clicked. Once it has run on this page, the status
      // line says what it did.
      $('iowa-policy').hidden = !target || Boolean(site) || autopilot || told;
      $('iowa-policy').textContent = t('panel.iowaPolicy');
      $('panel-autofill').title = withShortcut('', COMMANDS.autofill);
      $('panel-left').title = withShortcut('', COMMANDS.nextQuestion);
      // The keyboard shortcuts in words too: a tooltip shows only to a pointer, and at its own size.
      const keys = [[COMMANDS.autofill, 'shortcut.autofillLine'], [COMMANDS.nextQuestion, 'shortcut.nextLine']]
        .filter(([name]) => shortcuts[name]).map(([name, key]) => ({ key, params: { keys: shortcuts[name] } }));
      $('shortcuts-line').hidden = !keys.length;
      $('shortcuts-line').textContent = keys.length > 1 ? words({ key: 'joined', params: { first: keys[0], second: keys[1] } }) : keys.length ? words(keys[0]) : '';
      const pending = site?.enabled && site.ready ? site.frames.filter(frame => !frame.enabled) : [];
      $('frames-enable').hidden = !target || !pending.length;
      $('frames-enable').disabled = working;
      $('frames-enable').textContent = t('panel.framesEnableHosts', { hosts: pending.map(frame => hostOf(frame.origin)).join(', ') });
      $('site-enable').hidden = !off;
      $('site-enable').disabled = working;
      // A site turned on by itself can't be turned off inside all websites.
      $('site-disable').hidden = !(target && site?.enabled) || allSites === true;
      $('site-disable').disabled = working;
      $('all-sites-enable').hidden = allSites !== false || stopped;
      $('all-sites-enable').disabled = working;
      // What the link is for, and that turning it on fills nothing by itself.
      $('all-sites-note').hidden = $('all-sites-enable').hidden;
      $('all-sites-disable').hidden = allSites !== true || stopped;
      $('all-sites-disable').disabled = working;
      $('panel-autofill').hidden = off || nowhere;
      // Iowa's form is filled by its own rules: Laya only guesses on a site that is on.
      const laya = layaLine && site?.enabled ? words(layaLine) : '';
      $('laya-status').hidden = !laya;
      $('laya-status').textContent = laya;
      // On Iowa's form the button starts something that goes on by itself; elsewhere it fills this page once.
      $('panel-autofill').textContent = t(autopilot ? 'panel.stopAutofill' : site ? 'panel.autofill' : 'panel.autofillIowa');
      // While the app needs opening or unlocking, that button is the one to press: Autofill steps back to an outline.
      $('panel-autofill').classList.toggle('primary', !desktopAction);
      $('panel-autofill').classList.toggle('secondary', Boolean(desktopAction));
      // Where the questions left are listed by name, each row goes to its own.
      $('panel-left').hidden = !target || !left.length || named.length > 0;
      // While Autofill is on, what its button does now: on a page that waits for answers, that it lets the reader
      // check and continue themselves. A reader who has seen a whole run knows, but on that page still reads
      // that Stop erases nothing.
      $('stop-note').hidden = !target || !autopilot || (usedBefore() && !checkFirst);
      $('stop-note').textContent = t(checkFirst && !usedBefore() ? 'panel.stopToCheck' : 'panel.stopNote');
      $('panel-left').disabled = working;
      $('open-iowa').hidden = Boolean(target) || !away || halted;
      $('panel-left').textContent = t('panel.goToLeft', { count: left.length || 1 });
      $('panel-autofill').disabled = !target || (!fillable && !autopilot) || working;
      $('site-continue').hidden = !target || !site?.enabled || !site.ready || autopilot;
      $('site-continue').disabled = working || !fillable;
      $('site-continue-hint').hidden = !target || !site?.enabled || !site.ready;
      document.querySelectorAll('.checklist-item').forEach(button => { button.disabled = working || !target; });
      document.querySelectorAll('.save-row button').forEach(button => { button.disabled = working || !target; });
      $('held-fill').disabled = working || !target;
      $('household-open').disabled = working || !target;
      document.querySelectorAll('#remember-list input').forEach(box => { box.disabled = working || !target; });
      $('remember-save').disabled = working || !target || !rememberChecked().length;
      renderQuestionControls();
      renderSummary();
    }
    function clearPage() {
      fillable = false; autopilot = false; told = false; ran = false; checkFirst = false; left = []; leftCursor = 0; named = []; filledNames = []; site = null; page = null; notSaved = []; checklistSignature = '';
      savable = []; savableSignature = '';
      held = []; heldSignature = '';
      household = null; householdSignature = '';
      layaGuesses = []; guessesSignature = '';
      rememberable = []; rememberSignature = ''; rememberChoices.clear();
      $('remember-list').replaceChildren();
      $('remember-section').hidden = true;
      $('page-checklist').replaceChildren();
      $('checklist-section').hidden = true;
      $('save-list').replaceChildren();
      $('save-section').hidden = true;
      renderLeft();
      renderFilled();
      $('held-list').replaceChildren();
      $('held-section').hidden = true;
      $('household-list').replaceChildren();
      $('household-section').hidden = true;
      $('guesses-list').replaceChildren();
      $('guesses-section').hidden = true;
      resetQuestions();
      resetSummary();
    }
    function invalidateTarget() {
      if (stopped) return;
      contextRevision++; working = false; target = null; notice = null;
      clearPage(); controls();
      show({ key: 'panel.checkingTab' });
    }
    // The website's check mark, for a row that is done. panel.css draws the other rows' rings.
    function checkMark() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm5 12 4 4L19 6');
      svg.append(path);
      return svg;
    }
    function renderChecklist() {
      const entries = Array.isArray(page.checklist) ? page.checklist.filter(item => item && fieldKeys([item.key]).length && typeof item.label === 'string' && Object.hasOwn(STATUS, item.status)).slice(0, 80) : [];
      const signature = JSON.stringify([language, entries, notSaved, ran]);
      if (signature === checklistSignature) return;
      checklistSignature = signature;
      $('page-checklist').replaceChildren();
      for (const item of entries) {
        const button = document.createElement('button');
        // A required question waits for Autofill before it waits for the reader.
        const pending = item.status === 'missing' && !ran;
        button.type = 'button'; button.className = `checklist-item ${pending ? 'pending' : item.status}`; button.dataset.key = item.key;
        const mark = document.createElement('span'); mark.className = 'checklist-mark'; mark.setAttribute('aria-hidden', 'true');
        if (item.status === 'complete') mark.append(checkMark());
        const copy = document.createElement('span'); copy.className = 'checklist-copy';
        const text = words({ key: item.labelKey, params: item.labelParams, text: item.label }, 100);
        const label = document.createElement('span'); label.className = 'checklist-label'; label.textContent = text;
        const unsaved = ran && item.status !== 'complete' && notSaved.includes(item.key);
        const status = t(pending ? 'checklist.pending' : unsaved ? (item.status === 'optional' ? 'checklist.notSavedOptional' : 'checklist.notSaved') : STATUS[item.status]);
        const detail = document.createElement('span'); detail.className = 'checklist-detail'; detail.textContent = status;
        copy.append(label, detail);
        button.setAttribute('aria-label', t('checklist.rowLabel', { label: text, status }));
        button.append(mark, copy);
        button.addEventListener('click', trusted(() => { if (!button.disabled) focusField(item.key); }));
        $('page-checklist').append(button);
      }
      // Once Autofill has run, how many are left for the reader: the same count as the status line's and the widget's.
      const left = entries.filter(item => (item.required && item.status === 'missing') || item.status === 'manual').length;
      $('checklist-summary').textContent = !ran ? '' : left ? t('checklist.left', { count: left }) : t('checklist.noneLeft');
      $('checklist-note').hidden = !(ran && entries.some(item => item.status !== 'complete' && notSaved.includes(item.key)));
      $('checklist-section').hidden = !entries.length;
    }
    // A question in the page's own words, as the lists below show it: once Chrome's translator has put the page's
    // questions in the reader's language (Show questions in ...), that on top and the page's words under it, to
    // match it with the form.
    function questionWords(text, fallback = '') {
      const words = fixedText(text, 200).trim();
      const own = translated.get(text) || translated.get(words);
      const label = document.createElement('span'); label.className = 'checklist-label'; label.dir = 'auto'; label.textContent = own ? fixedText(own, 400) : words || fallback;
      if (!own || own === words) return [label];
      const original = document.createElement('span'); original.className = 'checklist-detail'; original.dir = 'auto'; original.textContent = words;
      // The page's words are in the language they were translated from, for a screen reader's voice.
      if (translatedFrom) original.lang = translatedFrom;
      return [label, original];
    }
    // Until then, in a language other than English, one line says the questions are the form's words, with the
    // question list's own button under it, which puts them in the reader's.
    const questionsOffered = () => Boolean(target) && fillable && service.supported() && (language !== 'en' || Boolean(questions)) && !questionBusy;
    const wordsHinted = () => Boolean(site) && language !== 'en' && !translated.size && questionsOffered() &&
      (named.length || held.length || layaGuesses.length || filledNames.length || savable.length || household?.questions.length || rememberable.length) > 0;
    function renderWordsHint() {
      $('words-hint').hidden = !wordsHinted();
      $('words-translate').textContent = needsDownload ? t('translate.download', { language: languageName(language) }) : t('questions.show');
      $('words-translate').disabled = working || questionBusy;
    }
    // A page with no checklist: one row per question Autofill left, in the page's own words. A row finds its question.
    function renderLeft() {
      const signature = JSON.stringify([language, named, translated.size]);
      if (signature !== namedSignature) {
        namedSignature = signature;
        $('left-list').replaceChildren(...named.map(item => {
          const button = document.createElement('button');
          button.type = 'button'; button.className = `checklist-item ${item.done ? 'complete' : 'missing'}`; button.dataset.leftKey = item.key;
          const mark = document.createElement('span'); mark.className = 'checklist-mark'; mark.setAttribute('aria-hidden', 'true');
          if (item.done) mark.append(checkMark());
          const copy = document.createElement('span'); copy.className = 'checklist-copy';
          const status = t(item.done ? 'checklist.complete' : item.held ? 'left.held' : 'checklist.missing');
          const detail = document.createElement('span'); detail.className = 'checklist-detail'; detail.textContent = status;
          const words = questionWords(item.label, t('left.unnamed'));
          copy.append(...words, detail);
          button.setAttribute('aria-label', t('checklist.rowLabel', { label: words[0].textContent, status }));
          button.append(mark, copy);
          button.addEventListener('click', trusted(() => { if (!button.disabled) focusField(item.key); }));
          return button;
        }));
        const open = named.filter(item => !item.done).length;
        $('left-summary').textContent = open ? t('checklist.left', { count: open }) : named.length ? t('checklist.noneLeft') : '';
      }
      $('left-section').hidden = !named.length;
    }
    // The questions Autofill filled on a page with no checklist, by name, with guesses marked. Folded away by default.
    function renderFilled() {
      const signature = JSON.stringify([language, filledNames, translated.size]);
      if (signature !== filledSignature) {
        filledSignature = signature;
        $('filled-list').replaceChildren(...filledNames.map(item => {
          const row = document.createElement('div');
          row.className = 'checklist-item info complete';
          const mark = document.createElement('span'); mark.className = 'checklist-mark'; mark.setAttribute('aria-hidden', 'true'); mark.append(checkMark());
          const copy = document.createElement('span'); copy.className = 'checklist-copy';
          const detail = document.createElement('span'); detail.className = 'checklist-detail'; detail.textContent = t(item.guessed ? 'filled.guessed' : 'checklist.complete');
          copy.append(...questionWords(item.label, t('left.unnamed')), detail);
          row.append(mark, copy);
          return row;
        }));
        $('filled-summary').textContent = filledNames.length ? t('questions.count', { count: filledNames.length }) : '';
      }
      $('filled-section').hidden = !filledNames.length;
    }
    // One row per question with no saved answer: its own words, then Save to My information once the page holds an answer.
    function renderSaves() {
      const signature = JSON.stringify([language, savable, translated.size]);
      if (signature === savableSignature) return;
      savableSignature = signature;
      $('save-list').replaceChildren(...savable.map(item => {
        const row = document.createElement('div');
        row.className = 'checklist-item save-row'; row.dataset.saveId = item.id;
        const copy = document.createElement('span'); copy.className = 'checklist-copy';
        copy.append(...questionWords(item.label));
        row.append(copy);
        if (item.answered) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'button secondary'; button.textContent = t('save.button');
          button.setAttribute('aria-label', t('save.buttonLabel', { label: fixedText(item.label, 200) }));
          button.disabled = working || !target;
          button.addEventListener('click', trusted(() => { if (!button.disabled) saveAnswer(item.id); }));
          row.append(button);
        } else {
          const detail = document.createElement('span'); detail.className = 'checklist-detail'; detail.textContent = t('save.answerFirst');
          copy.append(detail);
        }
        return row;
      }));
      $('save-section').hidden = !savable.length;
    }
    async function saveAnswer(id) {
      const result = await act({ type: 'ui:saveAnswer', id, confirmed: true }, { key: 'save.saving' });
      // Kept on screen like a change to all websites: until the tab changes or another action starts.
      if (result?.saved === true) { notice = { message: { key: 'save.saved' }, error: false }; renderStatus(); await refresh(); }
    }
    // One row per held question, in its own words. The section's one button fills them all.
    function renderHeld() {
      const signature = JSON.stringify([held, translated.size]);
      if (signature === heldSignature) return;
      heldSignature = signature;
      $('held-list').replaceChildren(...held.map(item => {
        const row = document.createElement('div');
        row.className = 'checklist-item'; row.dataset.heldId = item.id;
        const copy = document.createElement('span'); copy.className = 'checklist-copy';
        copy.append(...questionWords(item.label));
        row.append(copy);
        return row;
      }));
      $('held-section').hidden = !held.length;
    }
    // What the household list lacks and the questions it left open, as the worker gave them, or null (#180).
    function householdOf(value) {
      const questions = (Array.isArray(value?.questions) ? value.questions : []).filter(item => fieldKeys([item?.id]).length && typeof item.label === 'string')
        .slice(0, 40).map(({ id, label }) => ({ id, label }));
      if (!questions.length) return null;
      if (value.need === 'list') return { need: 'list', questions };
      const person = value.need === 'birthDate' && (value.person === 'you' || (Number.isInteger(value.person) && value.person >= 1 && value.person <= 20)) ? value.person : null;
      return person === null ? null : { need: 'birthDate', person, questions };
    }
    // The household questions in their own words, what the list lacks (the person to finish named as My information names them),
    // and one button: Add your household, or with a list saved, Open your household list.
    function renderHousehold() {
      const signature = JSON.stringify([language, household, translated.size]);
      if (signature === householdSignature) return;
      householdSignature = signature;
      $('household-section').hidden = !household;
      if (!household) { $('household-list').replaceChildren(); return; }
      const hint = household.need === 'list' ? { key: 'household.hintList' } : household.person === 'you' ? { key: 'household.hintYou' }
        : { key: 'household.hintPerson', params: { number: household.person } };
      $('household-hint').textContent = words(hint);
      const button = household.need === 'list' ? 'household.add' : 'household.open';
      $('household-open').textContent = t(button);
      $('household-list').replaceChildren(...household.questions.map(item => {
        const row = document.createElement('div');
        row.className = 'checklist-item'; row.dataset.householdId = item.id;
        const copy = document.createElement('span'); copy.className = 'checklist-copy';
        copy.append(...questionWords(item.label));
        row.append(copy);
        return row;
      }));
    }
    // One row per open question the page holds an answer for, in its own words, with a Remember for next time checkbox: checked
    // unless its answer changes over time, until the applicant changes it. The section's one button remembers the checked ones.
    function rememberChecked() { return rememberable.filter(item => rememberChoices.get(item.id) ?? !item.timeBound).map(item => item.id); }
    function renderRemember() {
      const signature = JSON.stringify([language, rememberable, translated.size]);
      if (signature === rememberSignature) return;
      rememberSignature = signature;
      $('remember-list').replaceChildren(...rememberable.map(item => {
        const row = document.createElement('div');
        row.className = 'checklist-item save-row'; row.dataset.rememberId = item.id;
        const copy = document.createElement('span'); copy.className = 'checklist-copy';
        copy.append(...questionWords(item.label));
        if (item.timeBound) {
          const detail = document.createElement('span'); detail.className = 'checklist-detail'; detail.textContent = t('remember.changes');
          copy.append(detail);
        }
        const check = document.createElement('label'); check.className = 'remember-check';
        const box = document.createElement('input'); box.type = 'checkbox';
        box.checked = rememberChoices.get(item.id) ?? !item.timeBound;
        box.disabled = working || !target;
        box.setAttribute('aria-label', t('remember.checkLabel', { label: copy.firstChild.textContent }));
        box.addEventListener('change', () => { rememberChoices.set(item.id, box.checked); controls(); });
        check.append(box, document.createTextNode(t('remember.check')));
        row.append(copy, check);
        return row;
      }));
      $('remember-section').hidden = !rememberable.length;
    }
    async function rememberAnswers() {
      const ids = rememberChecked();
      if (!ids.length) return;
      const result = await act({ type: 'ui:rememberAnswers', ids, confirmed: true }, { key: 'remember.saving' });
      // Kept on screen like a saved answer: until the tab changes or another action starts.
      if (Number.isInteger(result?.remembered) && result.remembered > 0) {
        notice = { message: { key: 'remember.saved', params: { count: result.remembered } }, error: false };
        renderStatus();
        await refresh();
      }
    }
    // One row per question Laya guessed, in its own words, with the dotted outline it has on the page. A row finds it there.
    function renderGuesses() {
      const signature = JSON.stringify([language, layaGuesses, translated.size]);
      if (signature === guessesSignature) return;
      guessesSignature = signature;
      $('guesses-list').replaceChildren(...layaGuesses.map(item => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'checklist-item'; button.dataset.guessId = item.id;
        button.disabled = working || !target;
        const mark = document.createElement('span'); mark.className = 'checklist-mark guess-mark'; mark.setAttribute('aria-hidden', 'true');
        const copy = document.createElement('span'); copy.className = 'checklist-copy';
        copy.append(...questionWords(item.label));
        button.setAttribute('aria-label', t('guesses.rowLabel', { label: copy.firstChild.textContent }));
        button.append(mark, copy);
        button.addEventListener('click', trusted(() => { if (!button.disabled) focusField(item.id); }));
        return button;
      }));
      $('guesses-section').hidden = !layaGuesses.length;
    }
    function render(state) {
      if (!state || typeof state !== 'object') throw keyedError('panel.pageUnreadable');
      page = state.page || {};
      site = siteOf(state);
      fillable = site ? site.enabled && site.ready : page.kind === 'fillable' || page.kind === 'info' || Boolean(page.todo);
      autopilot = Boolean(state.autopilot);
      const result = state.result;
      told = reported(result);
      ran = Boolean(result) && result.pageKey === page.pageKey && ['done', 'waiting', 'continuing'].includes(result.state);
      checkFirst = ran && result.todoKey === CHECK_FIRST;
      notSaved = fieldKeys(result?.notSaved);
      savable = (Array.isArray(state.savable) ? state.savable : []).filter(item => fieldKeys([item?.id]).length && typeof item.label === 'string' && typeof item.answered === 'boolean')
        .slice(0, 40).map(({ id, label, answered }) => ({ id, label, answered }));
      held = (Array.isArray(state.held) ? state.held : []).filter(item => fieldKeys([item?.id]).length && typeof item.label === 'string')
        .slice(0, 40).map(({ id, label }) => ({ id, label }));
      household = householdOf(result?.household);
      layaGuesses = (Array.isArray(result?.layaGuesses) ? result.layaGuesses : []).filter(item => fieldKeys([item?.id]).length && typeof item.label === 'string')
        .slice(0, 40).map(({ id, label }) => ({ id, label }));
      rememberable = (Array.isArray(state.rememberable) ? state.rememberable : []).filter(item => fieldKeys([item?.id]).length && typeof item.label === 'string' &&
        typeof item.timeBound === 'boolean' && item.answered === true).slice(0, 40).map(({ id, label, timeBound }) => ({ id, label, timeBound }));
      renderChecklist();
      renderSaves();
      // What is left for the reader: on a page with a checklist, its rows as they are now; elsewhere, what Autofill reported.
      const listed = Array.isArray(page.checklist) ? page.checklist.filter(item => item && fieldKeys([item.key]).length) : [];
      const open = !ran ? [] : listed.length ? listed.filter(item => (item.required && item.status === 'missing') || item.status === 'manual').map(item => item.key) : fieldKeys(result.needYou);
      if (open.join() !== left.join()) { left = open; leftCursor = 0; }
      // Only names for keys the result itself lists are read, and only where no checklist shows them already.
      const names = new Map((Array.isArray(result?.left) ? result.left : []).filter(item => typeof item?.key === 'string' && typeof item.label === 'string').map(item => [item.key, fixedText(item.label.trim(), 200)]));
      // The page says which of the questions it may save now hold an answer: those rows are done.
      const answered = new Set(savable.filter(item => item.answered).map(item => item.id));
      // A question held back for Fill sensitive details (#176) says so on its row.
      const waiting = new Set(held.map(item => item.id));
      named = ran && !listed.length ? left.map(key => ({ key, label: names.get(key) || '', done: answered.has(key), held: waiting.has(key) })) : [];
      renderLeft();
      filledNames = ran && !listed.length && Array.isArray(result.filledQuestions)
        ? result.filledQuestions.filter(item => typeof item?.label === 'string').slice(0, 80).map(item => ({ label: fixedText(item.label.trim(), 200), guessed: item.guessed === true })) : [];
      renderFilled();
      renderHeld();
      renderHousehold();
      renderGuesses();
      renderRemember();
      const loading = target?.status === 'loading';
      if (site?.enabled && !site.ready) show({ key: loading ? 'panel.waitingLoad' : 'panel.reloadToRead' });
      // What Autofill reported, with its count of what is left kept current as the reader answers.
      else if (reported(result)) show(briefly(withLeft(fromResult(result), ran ? (named.length ? named.filter(item => !item.done).length : left.length) : fieldKeys(result.needYou).length)), result.state === 'error');
      else if (site && !site.enabled) show({ key: 'panel.siteOff', params: { host: hostOf(site.origin) } });
      // An information-only page of Iowa's says there is nothing to fill before Autofill is clicked.
      else if (site || (fillable && page.kind !== 'info')) show(null);
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
            target = null; nowhere = true; clearPage();
            show(elsewhere());
            controls();
            return;
          }
          if (!target || target.id !== tab.id || target.url !== tab.url) {
            contextRevision++; revision = contextRevision;
            clearPage(); target = { id: tab.id, url: tab.url }; nowhere = false; away = false;
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
    // The desktop row for the status the worker read: closed, locked, or unlocked.
    function showDesktop(desktop) {
      if (halted) return;
      allSites = typeof desktop?.allSites === 'boolean' ? desktop.allSites : null;
      updateSteps = Object.hasOwn(UPDATE_STEPS, desktop?.update) ? UPDATE_STEPS[desktop.update] : null;
      desktopLine = !desktop?.connected ? { key: 'desktop.notRunning' } : desktop.unlocked ? null : { key: 'desktop.locked' };
      layaLine = desktop?.connected && Object.hasOwn(LAYA_LINES, desktop.laya) ? { key: LAYA_LINES[desktop.laya] } : null;
      desktopAction = !desktop?.connected ? 'open' : desktop.unlocked ? null : desktop.touchId === 'ready' ? 'touchId' : 'unlock';
      $('desktop-status').parentElement.classList.remove('error');
    }
    function desktopProblem(message) {
      if (halted) return;
      desktopLine = message; layaLine = null; desktopAction = null;
      $('desktop-status').parentElement.classList.add('error');
    }
    async function desktopStatus() {
      // While SecondHand opens, its own checks keep the row; a reply from before it started is dropped.
      if (opening) return;
      const run = ++desktopRun;
      try {
        const desktop = await send({ type: 'ui:desktopStatus' });
        if (run === desktopRun) showDesktop(desktop);
      } catch (error) { if (run === desktopRun) desktopProblem(problem(error)); }
      renderDesktop();
      if (stopped) return;
      if (!target) show(elsewhere());
      controls();
    }
    // Open SecondHand: the native host brings the app forward or starts it, then the panel waits for it
    // to answer and shows its usual row. If it never does, one plain line says where to open it.
    async function openApp() {
      opening = true; desktopRun++;
      desktopLine = { key: 'desktop.opening' }; layaLine = null; desktopAction = null;
      $('desktop-status').parentElement.classList.remove('error');
      renderDesktop();
      try {
        const desktop = await openedDesktop();
        if (desktop) showDesktop(desktop); else desktopProblem(await didntOpen());
      } catch (error) { desktopProblem(problem(error)); }
      finally { opening = false; renderDesktop(); }
    }
    // The desktop's status once it answers, or null when it didn't open.
    async function openedDesktop() {
      try { await send({ type: 'ui:openApp', confirmed: true }); }
      catch (error) { if (error.outdated) throw error; return null; }
      for (let check = 0; check < OPEN_CHECKS && !stopped; check++) {
        await new Promise(resolve => setTimeout(resolve, OPEN_CHECK_MS));
        const desktop = await send({ type: 'ui:desktopStatus' });
        if (desktop?.connected) return desktop;
      }
      return null;
    }
    // Unlock with Touch ID: the app shows macOS's prompt over Chrome. While it asks, the row keeps its
    // line (as while SecondHand opens). When it doesn't unlock, Unlock does what it always did: SecondHand
    // comes forward for the password, and the line says why.
    async function unlockWithTouchId() {
      opening = true; desktopRun++;
      desktopLine = { key: 'desktop.touchIdWaiting' }; desktopAction = null;
      renderDesktop();
      let reply;
      try { reply = await send({ type: 'ui:unlockWithTouchId', confirmed: true }); }
      catch (error) { desktopLine = problem(error); desktopAction = 'touchId'; renderDesktop(); return; }
      finally { opening = false; }
      if (reply.unlocked) { await desktopStatus(); return; }
      desktopAction = reply.reason === 'cancelled' ? 'touchId' : 'unlock';
      try { await send({ type: 'ui:showApp', confirmed: true }); desktopLine = { key: TOUCH_ID_LINES[reply.reason] }; }
      catch (error) { desktopLine = problem(error); }
      renderDesktop();
    }
    // Every action re-reads the active tab so a stale checklist can never act on another page.
    async function act(payload, waiting) {
      if (!target) return null;
      const selected = { ...target };
      const revision = contextRevision;
      working = true; notice = null; controls();
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
      questions = null; translated = new Map(); translatedFrom = ''; questionNote = null; needsDownload = false; questionBusy = false;
      service.forget();
      renderQuestionList();
    }
    function renderQuestionControls() {
      const readable = Boolean(target) && fillable;
      const supported = service.supported();
      // The line above the lists offers the same button, nearer what it is for.
      $('questions-show').hidden = !questionsOffered() || wordsHinted();
      $('questions-show').disabled = working || questionBusy;
      $('questions-show').textContent = needsDownload ? t('translate.download', { language: languageName(language) }) : t(questions ? 'questions.refresh' : 'questions.show');
      // Without Chrome's translator the feature is hidden behind one plain line.
      const note = readable && !supported && language !== 'en' ? { message: { key: 'translate.missing' }, error: false } : readable ? questionNote : null;
      $('questions-note').hidden = !note;
      $('questions-note').textContent = note ? words(note.message) : '';
      $('questions-note').classList.toggle('error', Boolean(note?.error));
      $('questions').hidden = !readable || !questions;
      renderWordsHint();
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
      // The question in the applicant's language (SecondHand's own label from its catalog, or Chrome's
      // translation of the page's words), with the English it stands for underneath, to match it with the form.
      const own = item.labelKey ? t(item.labelKey, item.labelParams || {}) : translated.get(item.label);
      const copy = document.createElement('span'); copy.className = 'checklist-copy';
      const label = document.createElement('span'); label.className = 'checklist-label'; label.textContent = fixedText(own || item.label, 400);
      const original = document.createElement('span'); original.className = 'checklist-detail'; original.textContent = own && own !== item.label ? fixedText(item.label, 400) : '';
      original.hidden = !original.textContent;
      // SecondHand's own label stands for English words of the form; a page's words are in the page's language.
      if (item.labelKey) original.lang = 'en';
      else if (translatedFrom) original.lang = translatedFrom;
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
        translatedFrom = source;
        renderQuestionList();
        renderLeft(); renderFilled(); renderSaves(); renderHeld(); renderHousehold(); renderGuesses(); renderRemember(); renderWordsHint();
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
      // Without Chrome's Summarizer the section stays hidden and nothing is said.
      const note = readable && summaries.supported() ? summaryNote : null;
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
          if (availability === 'unavailable') return say(null);
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
      if (!stopping && !site) noteStarted();
      const result = await act(stopping ? { type: 'ui:stop', confirmed: true } : { type: 'ui:autofill', confirmed: true }, stopping ? { key: 'panel.stopping' } : waitingForApp());
      if (result) autopilot = !stopping && continuing(result);
      if (reported(result)) show(briefly(fromResult(result)), result.state === 'error');
      controls();
      if (!stopping) await desktopStatus();
      await refresh();
    }));
    $('site-continue').addEventListener('click', trusted(async () => {
      if ($('site-continue').disabled || !site?.enabled || !site.ready) return;
      const result = await act({ type: 'ui:fillAndContinue', confirmed: true }, waitingForApp());
      if (result) autopilot = continuing(result);
      if (reported(result)) show(fromResult(result), result.state === 'error');
      controls();
      await desktopStatus();
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
    // All websites isn't bound to a page; the active tab, if any, gets SecondHand's scripts at once.
    async function allSitesAct(payload, waiting) {
      working = true; notice = null; controls(); show(waiting);
      try {
        if (pollPromise) await pollPromise;
        const [active] = payload.type === 'ui:enableAllSites' ? await chrome.tabs.query({ active: true, currentWindow: true }) : [];
        const result = await send({ ...payload, ...(Number.isInteger(active?.id) ? { tabId: active.id } : {}) });
        allSites = result?.enabled === true;
        return result;
      } catch (error) {
        notice = { message: problem(error), error: true };
        return null;
      } finally {
        working = false;
        await desktopStatus();
        await refresh();
        schedulePoll();
      }
    }
    $('all-sites-enable').addEventListener('click', trusted(async () => {
      if ($('all-sites-enable').disabled) return;
      let granted;
      // Ask before anything is awaited: Chrome only shows its prompt inside the user's click.
      try { granted = await chrome.permissions.request({ origins: ['https://*/*'] }); }
      catch (error) { show(problem(error, 'panel.chromeCouldntAskAllSites'), true); return; }
      if (!granted) { show({ key: 'panel.chromeDeclinedAllSites' }, true); return; }
      const result = await allSitesAct({ type: 'ui:enableAllSites', confirmed: true }, { key: 'panel.approveAllSites' });
      if (result?.enabled) show(fromResult(result));
    }));
    $('all-sites-disable').addEventListener('click', trusted(async () => {
      if ($('all-sites-disable').disabled) return;
      const result = await allSitesAct({ type: 'ui:disableAllSites', confirmed: true }, { key: 'panel.turningOffAllSites' });
      if (result) { notice = { message: fromResult(result), error: false }; renderStatus(); }
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
    // Fill sensitive details (#176): the app shows its sensitive prompt for the held questions. What it fills is the tab's
    // new result; a Cancel is said, and the questions stay listed.
    $('remember-save').addEventListener('click', trusted(() => { if (!$('remember-save').disabled) rememberAnswers(); }));
    $('held-fill').addEventListener('click', trusted(async () => {
      if ($('held-fill').disabled) return;
      const result = await act({ type: 'ui:fillHeld', confirmed: true }, { key: 'held.filling' });
      if (!result) return;
      show(fromResult(result));
      await refresh();
    }));
    // Add your household (#180): the app opens My information at Your household. The questions stay listed until the next Autofill.
    $('household-open').addEventListener('click', trusted(async () => {
      if ($('household-open').disabled) return;
      const result = await act({ type: 'ui:openHousehold', confirmed: true });
      if (result?.shown === true) { notice = { message: { key: 'household.opened' }, error: false }; renderStatus(); }
    }));
    $('site-disable').addEventListener('click', trusted(async () => {
      if ($('site-disable').disabled) return;
      const result = await act({ type: 'ui:disableSite', confirmed: true }, { key: 'panel.turningOff' });
      await refresh();
      if (result && !result.enabled) show({ key: 'panel.siteOffDone' });
    }));
    $('desktop-action').addEventListener('click', trusted(async () => {
      // Reloading SecondHand closes this side panel and starts the worker that matches it.
      if (desktopAction === 'restart') { chrome.runtime.reload(); return; }
      if (desktopAction === 'open') return openApp();
      if (desktopAction === 'touchId') return unlockWithTouchId();
      try { await send({ type: 'ui:showApp', confirmed: true }); desktopLine = { key: 'desktop.unlockThenAutofill' }; }
      catch (error) { desktopLine = problem(error); }
      renderDesktop();
    }));
    // Like the widget's link: each click goes to the next question left, then round again.
    $('panel-left').addEventListener('click', trusted(() => {
      if ($('panel-left').disabled || !left.length) return;
      focusField(left[leftCursor++ % left.length]);
    }));
    $('questions-show').addEventListener('click', trusted(() => { if (!$('questions-show').disabled) showQuestions(true); }));
    $('words-translate').addEventListener('click', trusted(() => { if (!$('words-translate').disabled) showQuestions(true); }));
    $('summary-get').addEventListener('click', trusted(() => { if (!$('summary-get').disabled) summarize(true); }));
    // The choice is saved in this extension's storage; the widget follows through the storage event.
    function relabel() {
      applyStatic();
      $('language').value = language;
      resetQuestions();
      if (page) { renderChecklist(); renderLeft(); renderFilled(); renderSaves(); renderHeld(); renderHousehold(); renderGuesses(); renderRemember(); }
      renderStatus();
      renderDesktop();
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
    followStarted(controls);
    readShortcuts(controls);
    function halt(error) {
      if (halted) return;
      show(null);
      halted = true; stopped = true; target = null; nowhere = true; notice = null; updateSteps = null; updated = false;
      clearTimeout(pollTimer); clearPage(); controls();
      desktopLine = problem(error); layaLine = null; desktopAction = error.messageKey === 'panel.outdated' ? 'restart' : null;
      $('desktop-status').parentElement.classList.remove('error');
      renderDesktop();
    }
    whenOutdated = halt;
    // The strip with Autofill and its status stays in view over the lists. The panel scrolls a row the
    // keyboard moves to clear of it, by the strip's own height, which changes with what it says.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(([entry]) => {
        const pinned = getComputedStyle(entry.target).position === 'sticky';
        $('sidepanel').style.scrollPaddingTop = pinned ? `${entry.target.offsetHeight + 12}px` : '';
      }).observe(document.querySelector('.actions'));
    }
    async function start() {
      try {
        await checkBuild();
        // Chrome runs this build in both the worker and the panel: a different one remembered means
        // SecondHand was updated since the last side panel. Said once; the first panel says nothing.
        const last = localStorage.getItem(BUILD_KEY);
        updated = last !== null && last !== BUILD;
        localStorage.setItem(BUILD_KEY, BUILD);
        renderDesktop();
      } catch (error) {
        if (error.outdated) { halt(error); return; }
        show(problem(error), true);
      }
      refresh().then(desktopStatus);
      schedulePoll();
    }
    chrome.tabs.onActivated?.addListener(() => { invalidateTarget(); refresh(); });
    // The page in this panel's tab changed. With no Iowa page or site on screen, the active tab may have just
    // opened one: look now rather than at the next poll.
    chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
      if (!change.url && change.status !== 'loading') return;
      if (target?.id === tabId) { invalidateTarget(); refresh(); }
      else if (!target && tab?.active) refresh();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !working && !stopped) { refresh(); desktopStatus(); } });
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(pollTimer); }, { once: true });
    start();
  }
})();
