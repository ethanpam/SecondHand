(function () {
  'use strict';
  // Runs only on https sites that are on: one the user turned on by itself, or every site with
  // SecondHand on all websites. The widget and the worker do the deciding; this script plans,
  // fills, and focuses fields, and answers with field metadata only. Values arrive for one fill
  // and are never sent back. The card shows only while the page, or a form embedded in it, has a
  // form SecondHand can help with.
  const engine = globalThis.SecondHandGeneric;
  // One copy per frame, even when two registrations match the page.
  if (location.protocol !== 'https:' || !engine || globalThis.secondHandGenericInstalled) return;
  globalThis.secondHandGenericInstalled = true;
  const topFrame = window === window.top;

  let panelHost = null;
  // Whether this frame's page has a form SecondHand can help with, and on the top page, whether a form
  // embedded in it does. After a page change, the check waits a moment so a burst of changes is one check.
  let helps = false;
  let framesHelp = false;
  let checkTimer = null;
  const CHECK_MS = 500;
  // SecondHand was turned off for this page: its card is gone and nothing more is answered.
  let off = false;
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  // The widget's frame is as wide as the widget measured itself, never past 272px or the screen.
  const fits = width => Number.isInteger(width) && width > 0 && width <= 1000;
  const tall = height => Number.isInteger(height) && height >= 46 && height <= 150;
  const frameWidth = width => `min(${width || 272}px, 272px, calc(100vw - 24px))`;
  const SIZES = ['width', 'height', 'narrowWidth', 'narrowHeight'];
  let line = false; // the widget shows a line to read, above its row
  let card = {}; // the widget's measured size; empty until it measures
  let pill = false; // the reader hid the widget: its frame is the logo alone
  // The frame is as wide and as tall as the widget measured itself: 46px for its row alone, up to 150px with
  // all it can hold. A page under 640px wide keeps the widget as narrow as its buttons, or the least wider
  // that shows its whole line, and gives the line more rows instead, so the widget covers little more of the
  // page than it does without a line. A widget the reader
  // hid is the round logo alone.
  function fitHost() {
    const size = line && card.narrowWidth && innerWidth < 640 ? { width: card.narrowWidth, height: card.narrowHeight } : card;
    panelHost.setAttribute('data-secondhand-size', pill ? 'pill' : 'full');
    panelHost.style.setProperty('border-radius', pill ? '50%' : '12px', 'important');
    panelHost.style.setProperty('width', pill ? '46px' : frameWidth(size.width), 'important');
    panelHost.style.setProperty('height', pill ? '46px' : `${size.height || (line ? 86 : 46)}px`, 'important');
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
    if (!topFrame || !document.body) return;
    if (!panelHost) {
      panelHost = document.createElement('div');
      panelHost.setAttribute('data-secondhand-assistant', '');
      panelHost.setAttribute('data-secondhand-size', 'full');
      for (const [property, value] of Object.entries({
        all: 'initial', position: 'fixed', right: '12px', bottom: '16px', display: 'block',
        width: frameWidth(0), height: '46px',
        'z-index': '2147483647', margin: '0', padding: '0', border: '0',
        'border-radius': '12px', 'box-shadow': '0 2px 3px #202c2010, 0 8px 24px -8px #202c2030',
        'color-scheme': 'light', isolation: 'isolate'
      })) panelHost.style.setProperty(property, value, 'important');
      const shadow = panelHost.attachShadow({ mode: 'closed' });
      const frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL('panel.html?surface=launcher');
      frame.title = 'SecondHand autofill';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.setAttribute('allow', 'language-model; language-detector'); // lets the widget use Chrome's on-device AI and language detector
      frame.referrerPolicy = 'no-referrer';
      for (const [property, value] of Object.entries({ width: '100%', height: '100%', display: 'block', border: '0', margin: '0', padding: '0', 'border-radius': '12px', background: 'transparent' })) frame.style.setProperty(property, value, 'important');
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
      // The language this frame declares: with Chrome's detector, it decides how its questions are read to Laya.
      lang: document.documentElement.lang || '',
      // A matched question's own label lets the side panel name it when its saved answer is missing.
      matched: plan.matched.map(field => ({ id: text(field.id), key: text(field.key), confidence: text(field.confidence), ...(typeof field.label === 'string' ? { label: field.label } : {}) })),
      unmatched: plan.unmatched.map(field => ({ id: text(field.id), label: typeof field.label === 'string' ? field.label : '',
        type: typeof field.type === 'string' ? field.type : '', options: strings(field.options), required: field.required === true }))
    };
  }

  // Rebuilt so only the answer itself, or why there is none, leaves the page.
  function savedAnswer(read) {
    if (read && typeof read.value === 'string') return { value: read.value };
    if (read?.empty === true) return { empty: true };
    if (read?.unreadable === true) return { unreadable: true };
    if (read?.repeated === true) return { repeated: true };
    return { readable: false };
  }

  function placeCard() {
    if (!topFrame || off) return;
    if (helps || framesHelp) ensurePanel();
    else panelHost?.remove();
  }
  // The top page places its card; an embedded frame tells the worker, which tells the top page.
  function check() {
    checkTimer = null;
    if (off) return;
    const now = engine.offers(document) === true;
    const changed = now !== helps;
    helps = now;
    if (topFrame) placeCard();
    else if (changed) chrome.runtime.sendMessage({ type: 'secondhand:generic:form', helps });
  }
  function stop() {
    clearTimeout(checkTimer);
    clearInterval(watch);
    observer.disconnect();
  }

  check();
  // A form embedded before this page loaded was reported to the worker already.
  if (topFrame) chrome.runtime.sendMessage({ type: 'secondhand:generic:form', helps }).then(reply => { framesHelp = reply?.frames === true; placeCard(); });
  document.addEventListener('DOMContentLoaded', check, { once: true });
  // Forms that load late or change: check again once the page settles. SecondHand's own card doesn't count.
  const observer = new MutationObserver(records => {
    if (off || checkTimer || records.every(record => panelHost && (record.target === panelHost || panelHost.contains(record.target)))) return;
    checkTimer = setTimeout(check, CHECK_MS);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  // Pages that rebuild their body (single-page forms) get the widget back.
  const watch = topFrame ? setInterval(placeCard, 1000) : null;
  if (topFrame) window.addEventListener('resize', () => { if (panelHost) fitHost(); });
  window.addEventListener('pagehide', () => {
    stop();
    if (!topFrame && helps && !off) chrome.runtime.sendMessage({ type: 'secondhand:generic:form', helps: false });
  }, { once: true });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (off || sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
    if (message.type === 'secondhand:generic:off') {
      off = true;
      stop();
      panelHost?.remove();
      panelHost = null;
      return;
    }
    if (message.type === 'secondhand:generic:formFrames' && typeof message.helps === 'boolean' && topFrame) {
      framesHelp = message.helps;
      placeCard();
      return;
    }
    try {
      if (message.type === 'secondhand:generic:frames' && topFrame) {
        const origins = new Set();
        for (const frame of document.querySelectorAll('iframe[src]')) {
          if (![...frame.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) continue;
          let visible = true;
          for (let node = frame; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') { visible = false; break; }
          }
          if (!visible) continue;
          // iframe.src is resolved against the document's base URL by the browser. An address that
          // doesn't parse comes back as written: nothing loads there, so it can't hold a form. This is
          // URL.canParse, which Chrome has only from version 120; SecondHand supports Chrome 116.
          let url;
          try { url = new URL(frame.src); } catch { continue; }
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
          return { ok: result.ok === true, ...(result.pageChanged === true ? { pageChanged: true } : {}),
            filled: strings(result.filled), skipped: strings(result.skipped), rejected: strings(result.rejected) };
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
      } else if (message.type === 'secondhand:widgetSize' && typeof message.line === 'boolean' && SIZES.every(key => message[key] === undefined || (/height$/i.test(key) ? tall : fits)(message[key])) &&
        (message.pill === undefined || message.pill === true) && topFrame) {
        line = message.line;
        card = Object.fromEntries(SIZES.filter(key => message[key] !== undefined).map(key => [key, message[key]]));
        pill = message.pill === true;
        if (panelHost) fitHost();
        respond({ sized: Boolean(panelHost) });
      } else if (message.type === 'secondhand:generic:pageText') {
        // This frame's own words for the side panel's summary, and the language it declares. Never form values.
        const reader = globalThis.SecondHandPageText;
        if (!reader) { respond({ ok: false, error: 'SecondHand could not load its page reader. Reload the page.' }); return; }
        respond({ lang: document.documentElement.lang || '', text: reader.read(document) });
      } else if (message.type === 'secondhand:generic:answered') {
        // Save to My information: which of the listed boxes hold an answer now. Ids only, never what they hold.
        if (typeof message.token !== 'string' || !Array.isArray(message.ids) || message.ids.some(id => typeof id !== 'string')) throw new Error('Invalid request.');
        respond({ answered: strings(engine.answeredIds(document, message.token, message.ids)) });
      } else if (message.type === 'secondhand:generic:read') {
        // After the applicant's Save click in the side panel: one listed box's answer, in the profile's format.
        if (typeof message.token !== 'string' || typeof message.id !== 'string' || typeof message.key !== 'string') throw new Error('Invalid request.');
        respond(savedAnswer(engine.readAnswer(document, message.token, message.id, message.key)));
      } else if (message.type === 'secondhand:generic:focus' && typeof message.id === 'string') {
        respond({ focused: Boolean(withOwnPanelHidden(() => engine.focusField(document, message.id))) });
      }
    } catch {
      respond({ ok: false, error: 'This page could not be checked safely. Review it manually.' });
    }
  });
})();
