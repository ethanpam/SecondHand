(function () {
  'use strict';
  const adapter = globalThis.SecondHandIowa;
  if (window !== window.top || !adapter?.isSupportedUrl(location.href) || globalThis.secondHandContentInstalled) return;
  globalThis.secondHandContentInstalled = true;

  let pending = null;
  let navigation = null;
  let revision = 0;
  let panelHost = null;
  let panelFrame = null;
  function sizePanel() {
    if (!panelHost || !panelFrame) return;
    panelHost.style.setProperty('width', 'min(244px, calc(100vw - 24px))', 'important');
    panelHost.style.setProperty('height', '62px', 'important');
  }

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
    if (!adapter.isSupportedUrl(location.href)) {
      pending = null;
      navigation = null;
      panelHost?.remove();
      return;
    }
    if (!document.body || panelHost?.isConnected) return;
    if (!panelHost) {
      panelHost = document.createElement('div');
      panelHost.setAttribute('data-secondhand-assistant', '');
      for (const [property, value] of Object.entries({
        all: 'initial', position: 'fixed', right: '12px', bottom: '16px', display: 'block',
        'z-index': '2147483647', margin: '0', padding: '0', border: '0',
        'border-radius': '14px', 'box-shadow': '0 12px 42px #17342235',
        'color-scheme': 'light', isolation: 'isolate'
      })) panelHost.style.setProperty(property, value, 'important');
      const shadow = panelHost.attachShadow({ mode: 'closed' });
      panelFrame = document.createElement('iframe');
      panelFrame.src = chrome.runtime.getURL('panel.html?surface=launcher');
      panelFrame.title = 'Open SecondHand in Chrome’s sidebar';
      panelFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      panelFrame.referrerPolicy = 'no-referrer';
      for (const [property, value] of Object.entries({ width: '100%', height: '100%', display: 'block', border: '0', margin: '0', padding: '0', 'border-radius': '14px', background: 'transparent' })) panelFrame.style.setProperty(property, value, 'important');
      shadow.append(panelFrame);
    }
    sizePanel();
    document.body.append(panelHost);
  }

  function scanMetadata(scan, token) {
    return { token, supported: scan.supported, recognizedPage: scan.recognizedPage,
      fields: scan.fields, ambiguous: scan.ambiguous, skipped: scan.skipped };
  }

  function preview(fresh = false) {
    const scan = adapter.scan(document, location.href);
    const reusable = !fresh && pending && pending.url === location.href && pending.expires > Date.now() &&
      pending.revision === revision && pending.bindings.length === scan.bindings.length &&
      scan.bindings.every((binding, index) => binding.key === pending.bindings[index].key &&
        binding.element === pending.bindings[index].element && binding.element.value === pending.values[index]);
    if (!reusable) {
      pending = { token: crypto.randomUUID(), url: location.href, bindings: scan.bindings,
        values: scan.bindings.map(binding => binding.element.value), revision, expires: Date.now() + 120000 };
    }
    return scanMetadata(scan, pending.token);
  }

  function pageState() {
    const page = typeof adapter.probePage === 'function' ? adapter.probePage(document, location.href) :
      { kind: 'unsupported', pageKey: 'unverified', heading: '', reason: 'This page needs manual completion.', canAdvance: false, fields: [], requiredRemaining: 0, manualRemaining: 0 };
    const scan = preview();
    const snapshot = typeof adapter.captureNavigation === 'function' ? adapter.captureNavigation(document, location.href) : null;
    navigation = snapshot ? { token: crypto.randomUUID(), snapshot, url: location.href, expires: Date.now() + 15000 } : null;
    return { page, scan, nextToken: navigation?.token || null };
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
      if (message.type === 'secondhand:scan') {
        navigation = null;
        respond(withOwnPanelHidden(() => preview(true)));
      } else if (message.type === 'secondhand:pageState') {
        respond(withOwnPanelHidden(pageState));
      } else if (message.type === 'secondhand:focusField' && typeof message.key === 'string' && typeof adapter.focusField === 'function') {
        const focused = withOwnPanelHidden(() => adapter.focusField(document, location.href, message.key));
        respond({ focused: Boolean(focused) });
      } else if (message.type === 'secondhand:next') {
        const original = navigation;
        navigation = null; // One authorized worker request, one navigation attempt.
        if (message.authorized !== true || !original || message.token !== original.token || original.url !== location.href || original.expires < Date.now() || typeof adapter.advance !== 'function') {
          respond({ advanced: false, reason: 'The page changed or its next step is not verified. Rescan and review the form.' });
          return;
        }
        pending = null;
        respond(withOwnPanelHidden(() => adapter.advance(document, location.href, original.snapshot)));
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
      }
    } catch {
      pending = null;
      navigation = null;
      respond({ ok: false, error: 'This page could not be checked safely. Review it manually, then rescan.' });
    }
  });
})();
