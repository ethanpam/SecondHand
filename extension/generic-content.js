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
  let frameRevision = 0;
  let checkTimer = null;
  const CHECK_MS = 500;
  // SecondHand was turned off for this page: its card is gone and nothing more is answered.
  let off = false;
  let suspended = false; // A cached document resumes on pageshow; an off document never does.
  let restoring = false; // Wait for the worker to recheck site access after a cached page returns.
  let activation = 0;
  let watch = null;
  const observedRoots = new Set();
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  // The widget's frame is as wide as the widget measured itself, never past 272px or the screen.
  const fits = width => Number.isInteger(width) && width > 0 && width <= 1000;
  const tall = height => Number.isInteger(height) && height >= 46 && height <= 166;
  const frameWidth = width => `min(${width || 272}px, 272px, calc(100vw - 24px))`;
  const SIZES = ['width', 'height', 'narrowWidth', 'narrowHeight'];
  let line = false; // the widget shows a line to read, above its row
  let card = {}; // the widget's measured size; empty until it measures
  let pill = false; // the reader hid the widget: its frame is the logo and the word that shows it again
  // The frame is as wide and as tall as the widget measured itself: 46px for its row alone, up to 166px with
  // all it can hold. A page under 640px wide keeps the widget as narrow as its buttons, or the least wider
  // that shows its whole line, and gives the line more rows instead, so the widget covers little more of the
  // page than it does without a line. A widget the reader
  // hid is its logo and the word that shows it again, as wide as the widget measured them (the round logo alone
  // when it gave no width).
  function fitHost() {
    const size = line && card.narrowWidth && innerWidth < 640 ? { width: card.narrowWidth, height: card.narrowHeight } : card;
    const labeled = pill && fits(card.width);
    panelHost.setAttribute('data-secondhand-size', pill ? 'pill' : 'full');
    panelHost.style.setProperty('border-radius', pill ? (labeled ? '23px' : '50%') : '12px', 'important');
    panelHost.style.setProperty('width', pill ? (labeled ? frameWidth(card.width) : '46px') : frameWidth(size.width), 'important');
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

  let cardFrame = null;
  // A card whose worker can't size its frame (an older build than the card, or none after SecondHand restarted)
  // asks this script directly, in the same terms. Only the card's own frame is heard: a page's script can post a
  // message too, but never as that frame.
  const cardOrigin = topFrame ? chrome.runtime.getURL('').replace(/\/$/, '') : '';
  // The widget's own size for its frame, from the worker or from the card itself: whether it shows a line, its
  // measured width and height (and those a narrow page keeps), and whether the reader hid it to its logo.
  const sizeAsked = message => typeof message?.line === 'boolean' && SIZES.every(key => message[key] === undefined || (/height$/i.test(key) ? tall : fits)(message[key])) &&
    (message.pill === undefined || message.pill === true);
  function fitCard(message) {
    line = message.line;
    card = Object.fromEntries(SIZES.filter(key => message[key] !== undefined).map(key => [key, message[key]]));
    pill = message.pill === true;
    if (panelHost) fitHost();
  }
  if (topFrame) window.addEventListener('message', event => {
    if (!panelHost || !cardFrame || event.source !== cardFrame.contentWindow || event.origin !== cardOrigin) return;
    if (event.data?.type === 'secondhand:cardSize' && sizeAsked(event.data)) fitCard(event.data);
  });

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
      const frame = cardFrame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL('panel.html?surface=launcher');
      frame.title = 'SecondHand autofill';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.setAttribute('allow', 'language-model; language-detector'); // lets the widget use Chrome's on-device AI and language detector
      frame.referrerPolicy = 'no-referrer';
      // Tells the card it can ask this script to hide it, should its worker be unable to.
      frame.addEventListener('load', () => frame.contentWindow?.postMessage({ type: 'secondhand:cardHello' }, cardOrigin));
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
      // A matched question's own label lets the side panel name it when its saved answer is missing. One the rules answered
      // in part (#184) still needs the applicant.
      matched: plan.matched.map(field => ({ id: text(field.id), key: text(field.key), confidence: text(field.confidence), ...(typeof field.label === 'string' ? { label: field.label } : {}),
        ...(field.partial === true ? { partial: true } : {}) })),
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
    if (!topFrame || off || suspended || restoring) return;
    if (helps || framesHelp) ensurePanel();
    else panelHost?.remove();
  }
  // Tells the worker whether this frame's page has a form. A report the worker couldn't count rejects with
  // its error, which nothing here catches: Chrome reports it as uncaught (#178).
  const report = helps => chrome.runtime.sendMessage({ type: 'secondhand:generic:form', helps }).then(reply => {
    if (reply?.ok === false) throw Object.assign(new Error(reply.error), { messageKey: reply.errorKey, messageParams: reply.errorParams });
    return reply;
  });
  // The top page places its card; an embedded frame tells the worker, which tells the top page.
  function check() {
    checkTimer = null;
    if (off || suspended || restoring) return;
    observeRoots();
    const now = engine.offers(document) === true;
    const changed = now !== helps;
    helps = now;
    if (topFrame) placeCard();
    else if (changed) report(helps);
  }
  function stop() {
    clearTimeout(checkTimer);
    checkTimer = null;
    clearInterval(watch);
    watch = null;
    observer.disconnect();
    observedRoots.clear();
  }
  function turnOff() {
    off = true;
    restoring = false;
    activation++;
    stop();
    panelHost?.remove();
    panelHost = null;
  }
  // A reply for an earlier page activation must not restore stale embedded-form state.
  function refreshFrames() {
    const current = activation, framesAtRequest = frameRevision;
    report(helps).then(reply => {
      if (off || suspended || current !== activation) return;
      if (frameRevision === framesAtRequest) framesHelp = reply?.frames === true;
      placeCard();
    });
  }
  // Forms that load late or change: check again once the page settles. Text-node updates
  // count too; a framework can change a question without replacing its label element.
  const observer = new MutationObserver(records => {
    if (off || suspended || restoring || checkTimer || records.every(record => panelHost && (record.target === panelHost || panelHost.contains(record.target)))) return;
    checkTimer = setTimeout(check, CHECK_MS);
  });
  function observeRoots() {
    const roots = [document.documentElement, ...(engine.deepQueryAll?.(document, '*') || []).map(element => element.shadowRoot).filter(root => root?.mode === 'open')];
    let added = false;
    for (const root of roots) {
      if (!root || observedRoots.has(root)) continue;
      observedRoots.add(root); added = true;
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    return added;
  }
  function observe() {
    observeRoots();
    // attachShadow does not produce a document mutation. Discover a newly opened root
    // without patching the site's DOM APIs; cached/off pages stop this one timer.
    if (watch === null) watch = setInterval(() => { if (observeRoots()) check(); else placeCard(); }, 1000);
  }

  check();
  // A form embedded before this page loaded was reported to the worker already.
  if (topFrame) refreshFrames();
  document.addEventListener('DOMContentLoaded', check, { once: true });
  observe();
  if (topFrame) window.addEventListener('resize', () => { if (panelHost) fitHost(); });
  window.addEventListener('pagehide', () => {
    if (suspended) return;
    suspended = true;
    restoring = false;
    activation++;
    stop();
    panelHost?.remove();
    if (!topFrame && helps && !off) report(false);
    helps = false;
    framesHelp = false;
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted || !suspended || off) return;
    suspended = false;
    restoring = true;
    const current = ++activation, framesAtRequest = frameRevision;
    helps = engine.offers(document) === true;
    // The off broadcast may never have reached a frozen document. The worker returns
    // no report when either this frame or its top-level site is no longer approved.
    report(helps).then(reply => {
      if (off || suspended || current !== activation) return;
      if (typeof reply?.frames !== 'boolean') { turnOff(); return; }
      restoring = false;
      if (frameRevision === framesAtRequest) framesHelp = reply.frames;
      observe();
      check(); // Recheck changes made while the worker answered; one fresh frame report was already sent.
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (off || sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
    if (message.type === 'secondhand:generic:off') {
      turnOff();
      return;
    }
    if (suspended) return;
    if (message.type === 'secondhand:generic:formFrames' && typeof message.helps === 'boolean' && topFrame) {
      framesHelp = message.helps;
      frameRevision++;
      placeCard(); // While restoring, the metadata is retained but the card still waits for approval.
      return;
    }
    if (restoring) {
      // A worker checking all embedded forms may ask while this frame's approval reply waits.
      if (!topFrame && message.type === 'secondhand:generic:helps') respond({ helps });
      return;
    }
    // A restarted worker asks an embedded frame what it reported before (#157): yes or no only.
    if (message.type === 'secondhand:generic:helps' && !topFrame) {
      respond({ helps });
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
      } else if (message.type === 'secondhand:generic:navigation') {
        const navigation = globalThis.SecondHandNavigation;
        respond(navigation ? withOwnPanelHidden(() => navigation.snapshot(document)) : { canAdvance: false });
      } else if (message.type === 'secondhand:generic:advance') {
        const navigation = globalThis.SecondHandNavigation;
        respond(navigation && typeof message.token === 'string' ? withOwnPanelHidden(() => navigation.advance(document, message.token)) : { advanced: false });
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
          if (!result || !validIds(result.filled) || !validIds(result.skipped) || !validIds(result.rejected) || !validIds(result.partial)) return null;
          return { ok: result.ok === true, ...(result.pageChanged === true ? { pageChanged: true } : {}),
            filled: strings(result.filled), skipped: strings(result.skipped), rejected: strings(result.rejected), partial: strings(result.partial) };
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
      } else if (message.type === 'secondhand:widgetSize' && sizeAsked(message) && topFrame) {
        fitCard(message);
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
      } else if (message.type === 'secondhand:generic:readOpen') {
        // After the applicant's Remember for next time click in the side panel (#186): one open question's answer, as the page shows it.
        if (typeof message.token !== 'string' || typeof message.id !== 'string') throw new Error('Invalid request.');
        respond(savedAnswer(engine.readOpen(document, message.token, message.id)));
      } else if (message.type === 'secondhand:generic:focus' && typeof message.id === 'string') {
        respond({ focused: Boolean(withOwnPanelHidden(() => engine.focusField(document, message.id))) });
      }
    } catch {
      respond({ ok: false, error: 'This page could not be checked safely. Review it manually.' });
    }
  });
})();
