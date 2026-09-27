(function () {
  'use strict';
  // Runs only on https sites the user turned on. The widget and the worker do the
  // deciding; this script plans, fills, and focuses fields, and answers with field
  // metadata only. Values arrive for one fill and are never sent back.
  const engine = globalThis.SecondHandGeneric;
  if (location.protocol !== 'https:' || !engine || globalThis.secondHandGenericInstalled) return;
  globalThis.secondHandGenericInstalled = true;

  let panelHost = null;
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

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

  function ensurePanel() {
    if (window !== window.top || !document.body) return;
    if (!panelHost) {
      panelHost = document.createElement('div');
      panelHost.setAttribute('data-secondhand-assistant', '');
      panelHost.setAttribute('data-secondhand-size', 'full');
      for (const [property, value] of Object.entries({
        all: 'initial', position: 'fixed', right: '12px', bottom: '16px', display: 'block',
        width: 'min(272px, calc(100vw - 24px))', height: '70px',
        'z-index': '2147483647', margin: '0', padding: '0', border: '0',
        'border-radius': '14px', 'box-shadow': '0 12px 42px #17342235',
        'color-scheme': 'light', isolation: 'isolate'
      })) panelHost.style.setProperty(property, value, 'important');
      const shadow = panelHost.attachShadow({ mode: 'closed' });
      const frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL('panel.html?surface=launcher');
      frame.title = 'SecondHand autofill';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.setAttribute('allow', 'language-model; language-detector'); // lets the widget use Chrome's on-device AI and language detector
      frame.referrerPolicy = 'no-referrer';
      for (const [property, value] of Object.entries({ width: '100%', height: '100%', display: 'block', border: '0', margin: '0', padding: '0', 'border-radius': '14px', background: 'transparent' })) frame.style.setProperty(property, value, 'important');
      shadow.append(frame);
    }
    if (!panelHost.isConnected) document.body.append(panelHost);
  }

  // Rebuilt field by field so nothing but labels and ids ever leaves the page.
  const text = value => { if (typeof value !== 'string') throw new Error('Invalid plan.'); return value; };
  function planMetadata(plan) {
    if (!plan || !Array.isArray(plan.matched) || !Array.isArray(plan.unmatched)) throw new Error('Invalid plan.');
    return {
      token: text(plan.token),
      matched: plan.matched.map(field => ({ id: text(field.id), key: text(field.key), confidence: text(field.confidence) })),
      unmatched: plan.unmatched.map(field => ({ id: text(field.id), label: typeof field.label === 'string' ? field.label : '',
        type: typeof field.type === 'string' ? field.type : '', options: strings(field.options), required: field.required === true }))
    };
  }

  if (window === window.top) {
    ensurePanel();
    document.addEventListener('DOMContentLoaded', ensurePanel, { once: true });
    // Pages that rebuild their body (single-page forms) get the widget back.
    const watch = setInterval(ensurePanel, 1000);
    window.addEventListener('pagehide', () => clearInterval(watch), { once: true });
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
    try {
      if (message.type === 'secondhand:generic:frames' && window === window.top) {
        const origins = new Set();
        for (const frame of document.querySelectorAll('iframe[src]')) {
          if (![...frame.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) continue;
          let visible = true;
          for (let node = frame; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') { visible = false; break; }
          }
          if (!visible) continue;
          // iframe.src is resolved against the document's base URL by the browser.
          const url = new URL(frame.src);
          if (url.protocol === 'https:' && url.origin !== location.origin) origins.add(url.origin);
        }
        respond({ origins: [...origins] });
      } else if (message.type === 'secondhand:generic:plan') {
        respond(planMetadata(withOwnPanelHidden(() => engine.plan(document))));
      } else if (message.type === 'secondhand:generic:fill') {
        if (typeof message.token !== 'string' || !Array.isArray(message.assignments) || !message.values || typeof message.values !== 'object' || Array.isArray(message.values)) {
          respond({ ok: false, error: 'The fill request was malformed. Nothing was filled.' });
          return;
        }
        const result = withOwnPanelHidden(() => engine.fillFields(document, message.token, message.assignments, message.values));
        const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string');
        const settledResult = result => {
          if (!result || !validIds(result.filled) || !validIds(result.skipped) || !validIds(result.rejected)) return null;
          return { ok: result.ok === true, filled: strings(result.filled), skipped: strings(result.skipped), rejected: strings(result.rejected) };
        };
        // Some pages (Google Forms) confirm a chosen option a moment after the click: answer once it settles.
        engine.settle(document, message.token, result).then(
          settled => {
            const formatted = settledResult(settled);
            if (formatted) respond(formatted);
            else respond({ ok: false, error: 'Invalid fill result.' });
          },
          () => respond({ ok: false, error: 'This page could not be checked safely. Review it manually.' }));
        return true;
      } else if (message.type === 'secondhand:generic:questions') {
        // Every question's label for the applicant's translated list, and the language this document declares.
        const listed = withOwnPanelHidden(() => engine.questions(document));
        respond({ lang: document.documentElement.lang || '', questions: listed.map(({ id, label }) => ({ id, label })) });
      } else if (message.type === 'secondhand:widgetSize' && typeof message.line === 'boolean' && window === window.top) {
        // One row taller while the widget shows a line of the page's key points.
        if (panelHost) panelHost.style.setProperty('height', message.line ? '86px' : '70px', 'important');
        respond({ sized: Boolean(panelHost) });
      } else if (message.type === 'secondhand:generic:pageText') {
        // This frame's own words for the side panel's summary, and the language it declares. Never form values.
        const reader = globalThis.SecondHandPageText;
        if (!reader) { respond({ ok: false, error: 'SecondHand could not load its page reader. Reload the page.' }); return; }
        respond({ lang: document.documentElement.lang || '', text: reader.read(document) });
      } else if (message.type === 'secondhand:generic:focus' && typeof message.id === 'string') {
        respond({ focused: Boolean(withOwnPanelHidden(() => engine.focusField(document, message.id))) });
      }
    } catch {
      respond({ ok: false, error: 'This page could not be checked safely. Review it manually.' });
    }
  });
})();
