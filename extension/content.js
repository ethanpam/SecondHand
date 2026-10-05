(function () {
  'use strict';
  const adapter = globalThis.SecondHandIowa;
  // Fills Iowa pages the adapter hasn't verified. Loaded just before this script.
  const engine = globalThis.SecondHandGeneric;
  if (window !== window.top || !adapter?.isSupportedUrl(location.href) || globalThis.secondHandContentInstalled) return;
  globalThis.secondHandContentInstalled = true;

  let pending = null;
  let navigation = null;
  let revision = 0;
  let panelHost = null;
  let panelFrame = null;
  let generalUrl = ''; // the unverified page where the general engine found fields
  let messageRow = false; // the widget shows a line to read above its row
  let cardWidth = 0; // the widget's measured width; 0 until it measures
  let cardHeight = 0; // and its measured height: 46px for its row alone, up to 130px with all it can hold
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  // The widget's frame is as wide as the widget measured itself, never past 272px or the screen.
  const fits = width => Number.isInteger(width) && width > 0 && width <= 1000;
  const tall = height => Number.isInteger(height) && height >= 46 && height <= 130;
  const frameWidth = width => `min(${width || 272}px, 272px, calc(100vw - 24px))`;

  function withOwnPanelHidden(work) {
    if (!panelHost) return work();
    const visibility = panelHost.style.getPropertyValue('visibility');
    const priority = panelHost.style.getPropertyPriority('visibility');
    panelHost.style.setProperty('visibility', 'hidden', 'important');
    try { return work(); }
    finally {
      if (visibility) panelHost.style.setProperty('visibility', visibility, priority);
      else panelHost.style.removeProperty('visibility');
    }
  }

  // A full widget on application screens SecondHand knows; a small pill elsewhere.
  function sizePanel() {
    let full = false;
    try {
      const page = withOwnPanelHidden(() => adapter.probePage(document, location.href));
      full = page.kind === 'fillable' || page.kind === 'info' || Boolean(page.todo) || generalUrl === location.href;
    } catch { full = false; }
    panelHost.setAttribute('data-secondhand-size', full ? 'full' : 'pill');
    panelHost.style.setProperty('border-radius', full ? '12px' : '50%', 'important');
    panelHost.style.setProperty('width', full ? frameWidth(cardWidth) : '46px', 'important');
    panelHost.style.setProperty('height', full ? `${cardHeight || (messageRow ? 86 : 46)}px` : '46px', 'important');
  }

  function ensurePanel() {
    if (!adapter.isSupportedUrl(location.href)) {
      pending = null;
      navigation = null;
      panelHost?.remove();
      return;
    }
    if (!document.body) return;
    if (!panelHost) {
      panelHost = document.createElement('div');
      panelHost.setAttribute('data-secondhand-assistant', '');
      for (const [property, value] of Object.entries({
        all: 'initial', position: 'fixed', right: '12px', bottom: '16px', display: 'block',
        'z-index': '2147483647', margin: '0', padding: '0', border: '0',
        'border-radius': '12px', 'box-shadow': '0 2px 3px #202c2010, 0 8px 24px -8px #202c2030',
        'color-scheme': 'light', isolation: 'isolate'
      })) panelHost.style.setProperty(property, value, 'important');
      const shadow = panelHost.attachShadow({ mode: 'closed' });
      panelFrame = document.createElement('iframe');
      panelFrame.src = chrome.runtime.getURL('panel.html?surface=launcher');
      panelFrame.title = 'Open SecondHand in Chrome’s sidebar';
      panelFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      panelFrame.setAttribute('allow', 'language-detector'); // lets the widget check the page's language on this computer
      panelFrame.referrerPolicy = 'no-referrer';
      for (const [property, value] of Object.entries({ width: '100%', height: '100%', display: 'block', border: '0', margin: '0', padding: '0', 'border-radius': 'inherit', background: 'transparent' })) panelFrame.style.setProperty(property, value, 'important');
      shadow.append(panelFrame);
    }
    sizePanel();
    if (!panelHost.isConnected) document.body.append(panelHost);
  }

  function scanMetadata(scan, token) {
    return { token, supported: scan.supported, recognizedPage: scan.recognizedPage,
      fields: scan.fields, ambiguous: scan.ambiguous, skipped: scan.skipped };
  }

  function preview() {
    const scan = adapter.scan(document, location.href);
    const reusable = pending && pending.url === location.href && pending.expires > Date.now() &&
      pending.revision === revision && pending.bindings.length === scan.bindings.length &&
      scan.bindings.every((binding, index) => binding.key === pending.bindings[index].key &&
        binding.element === pending.bindings[index].element && binding.element.value === pending.values[index]);
    if (!reusable) {
      pending = { token: crypto.randomUUID(), url: location.href, bindings: scan.bindings,
        values: scan.bindings.map(binding => binding.element.value), revision, expires: Date.now() + 120000 };
    }
    return scanMetadata(scan, pending.token);
  }

  function pageState(navigationPreview = true) {
    const page = adapter.probePage(document, location.href), scan = preview();
    if (navigationPreview) {
      const snapshot = ['iowa-personal-information', 'iowa-select-address'].includes(page.pageKey) && page.canAdvance ? adapter.captureNavigation(document, location.href) : null;
      navigation = snapshot ? { token: crypto.randomUUID(), snapshot, url: location.href, expires: Date.now() + 15000 } : null;
    }
    return { page, scan, nextToken: navigationPreview ? navigation?.token || null : null };
  }

  // The general engine only runs where the Iowa adapter has neither a verified form nor an instruction.
  function unverified() {
    const page = adapter.probePage(document, location.href);
    return page.kind === 'manual' && !page.todo;
  }
  // Rebuilt field by field so nothing but labels and ids ever leaves the page.
  const planText = value => { if (typeof value !== 'string') throw new Error('Invalid plan.'); return value; };
  function planMetadata(plan) {
    if (!plan || !Array.isArray(plan.matched) || !Array.isArray(plan.unmatched)) throw new Error('Invalid plan.');
    return {
      token: planText(plan.token),
      // The language this page declares: with Chrome's detector, it decides how its questions are read to Laya.
      lang: document.documentElement.lang || '',
      matched: plan.matched.map(field => ({ id: planText(field.id), key: planText(field.key), confidence: planText(field.confidence), ...(typeof field.label === 'string' ? { label: field.label } : {}) })),
      unmatched: plan.unmatched.map(field => ({ id: planText(field.id), label: typeof field.label === 'string' ? field.label : '',
        type: typeof field.type === 'string' ? field.type : '', options: strings(field.options), required: field.required === true }))
    };
  }
  // For the applicant's translated question list: the page's declared language, the words on
  // Iowa's information-only screens, and on pages the adapter hasn't verified, the engine's labels.
  function questions() {
    return { lang: document.documentElement.lang || '', instructions: adapter.instructions(document, location.href),
      questions: engine && unverified() ? engine.questions(document).map(({ id, label }) => ({ id, label })) : [] };
  }
  // For the side panel's summary: the words of Iowa's information-only screens only, never form values.
  function pageText() {
    const reader = globalThis.SecondHandPageText;
    if (!reader) throw new Error('SecondHand could not load its page reader.');
    const pageKey = adapter.informationScreen(document, location.href);
    return { lang: document.documentElement.lang || '', pageKey, text: pageKey ? reader.read(document) : '' };
  }
  function general(message) {
    if (!engine) return { ok: false, error: 'SecondHand could not load its form engine. Reinstall the extension.' };
    if (!unverified()) return { ok: false, error: 'SecondHand fills this page with its Iowa rules.' };
    if (message.type === 'secondhand:generic:plan') {
      const plan = planMetadata(engine.plan(document));
      if (plan.matched.length) generalUrl = location.href;
      return plan;
    }
    if (typeof message.token !== 'string' || !Array.isArray(message.assignments) || !message.values || typeof message.values !== 'object' || Array.isArray(message.values)) {
      return { ok: false, error: 'The fill request was malformed. Nothing was filled.' };
    }
    const result = engine.fillFields(document, message.token, message.assignments, message.values);
    // A choice the page confirms a moment after the click is settled before answering.
    return engine.settle(document, message.token, result)
      .then(settled => ({ ok: settled?.ok === true, ...(settled?.pageChanged === true ? { pageChanged: true } : {}),
        filled: strings(settled?.filled), skipped: strings(settled?.skipped), rejected: strings(settled?.rejected) }));
  }

  // Save to My information on a page the general engine filled: which listed boxes hold an answer (ids
  // only), and after the applicant's click in the side panel, one box's answer in the profile's format.
  function saving(message) {
    if (!engine || !unverified()) return { ok: false, error: 'SecondHand fills this page with its Iowa rules.' };
    if (message.type === 'secondhand:generic:answered') {
      if (typeof message.token !== 'string' || !Array.isArray(message.ids) || message.ids.some(id => typeof id !== 'string')) throw new Error('Invalid request.');
      return { answered: strings(engine.answeredIds(document, message.token, message.ids)) };
    }
    if (typeof message.token !== 'string' || typeof message.id !== 'string' || typeof message.key !== 'string') throw new Error('Invalid request.');
    const read = engine.readAnswer(document, message.token, message.id, message.key);
    if (read && typeof read.value === 'string') return { value: read.value };
    if (read?.empty === true) return { empty: true };
    if (read?.unreadable === true) return { unreadable: true };
    return { readable: false };
  }

  ensurePanel();
  document.addEventListener('DOMContentLoaded', ensurePanel, { once: true });
  // Observe page changes only. The cross-origin panel DOM never enters this observer.
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target !== panelHost && !panelHost?.contains(record.target))) revision++;
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('input', () => { revision++; }, true);
  document.addEventListener('change', () => { revision++; }, true);
  window.addEventListener('popstate', ensurePanel);
  const watch = setInterval(ensurePanel, 1000);
  window.addEventListener('pagehide', () => { clearInterval(watch); observer.disconnect(); pending = null; navigation = null; }, { once: true });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || window !== window.top || !adapter.isSupportedUrl(location.href)) return;
    try {
      if (message.type === 'secondhand:pageState') {
        respond(withOwnPanelHidden(() => pageState(message.navigationPreview !== false)));
      } else if (message.type === 'secondhand:continue') {
        pending = null; navigation = null;
        respond(withOwnPanelHidden(() => adapter.continuePage(document, location.href)));
      } else if (message.type === 'secondhand:next') {
        const original = navigation; navigation = null; pending = null;
        if (message.authorized !== true || !original || original.token !== message.token || original.url !== location.href || original.expires < Date.now()) {
          respond({ advanced: false, reason: 'The page changed or its navigation preview expired. Check it again.' }); return;
        }
        respond(withOwnPanelHidden(() => adapter.advance(document, location.href, original.snapshot)));
      } else if (message.type === 'secondhand:focusField' && typeof message.key === 'string' && typeof adapter.focusField === 'function') {
        const focused = withOwnPanelHidden(() => adapter.focusField(document, location.href, message.key));
        respond({ focused: Boolean(focused) });
      } else if (message.type === 'secondhand:fill') {
        const original = pending;
        pending = null; // One approval, one attempt. No automatic retry.
        navigation = null;
        if (!original || original.token !== message.token || original.url !== location.href || original.expires < Date.now() || !Array.isArray(message.fields) || !message.values || typeof message.values !== 'object' || Array.isArray(message.values)) {
          respond({ ok: false, error: 'The page changed or the preview expired. Scan again.' });
          return;
        }
        const bindings = original.bindings.filter(binding => message.fields.includes(binding.key));
        const result = withOwnPanelHidden(() => adapter.fill(document, location.href, bindings, message.values));
        respond({ ok: true, filledCount: result.filled.length, skippedCount: result.skipped.length });
      } else if (message.type === 'secondhand:generic:plan' || message.type === 'secondhand:generic:fill') {
        const answer = withOwnPanelHidden(() => general(message));
        ensurePanel();
        if (typeof answer?.then !== 'function') { respond(answer); return; }
        answer.then(respond, () => respond({ ok: false, error: 'This page could not be checked safely. Review it manually, then rescan.' }));
        return true;
      } else if (message.type === 'secondhand:generic:answered' || message.type === 'secondhand:generic:read') {
        respond(withOwnPanelHidden(() => saving(message)));
      } else if (message.type === 'secondhand:questions') {
        respond(withOwnPanelHidden(questions));
      } else if (message.type === 'secondhand:pageText') {
        respond(withOwnPanelHidden(pageText));
      } else if (message.type === 'secondhand:widgetSize' && typeof message.line === 'boolean' && (message.width === undefined || fits(message.width)) &&
        (message.height === undefined || tall(message.height))) {
        messageRow = message.line;
        cardWidth = message.width || 0;
        cardHeight = message.height || 0;
        if (panelHost) sizePanel();
        respond({ sized: Boolean(panelHost) });
      } else if (message.type === 'secondhand:generic:focus' && typeof message.id === 'string' && engine) {
        respond({ focused: Boolean(withOwnPanelHidden(() => engine.focusField(document, message.id))) });
      }
    } catch {
      pending = null;
      navigation = null;
      respond({ ok: false, error: 'This page could not be checked safely. Review it manually, then rescan.' });
    }
  });
})();
