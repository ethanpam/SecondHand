(function () {
  'use strict';
  if (globalThis.secondHandContentInstalled) return;
  globalThis.secondHandContentInstalled = true;
  let pending = null;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || window !== window.top) return;
    const adapter = globalThis.SecondHandIowa;
    if (!adapter?.isSupportedUrl(location.href)) return;
    if (message.type === 'secondhand:scan') {
      const scan = adapter.scan(document, location.href);
      const token = crypto.randomUUID();
      pending = { token, url: location.href, bindings: scan.bindings, expires: Date.now() + 120000 };
      respond({ token, supported: scan.supported, recognizedPage: scan.recognizedPage, fields: scan.fields, ambiguous: scan.ambiguous, skipped: scan.skipped });
    } else if (message.type === 'secondhand:fill') {
      const original = pending;
      pending = null; // One approval, one attempt. No automatic retry.
      if (!original || original.token !== message.token || original.url !== location.href || original.expires < Date.now() || !Array.isArray(message.fields) || !message.values || typeof message.values !== 'object') {
        respond({ ok: false, error: 'The page changed or the preview expired. Scan again.' });
        return;
      }
      const bindings = original.bindings.filter(binding => message.fields.includes(binding.key));
      const result = adapter.fill(document, location.href, bindings, message.values);
      respond({ ok: true, filledCount: result.filled.length, skippedCount: result.skipped.length });
    }
  });
})();
