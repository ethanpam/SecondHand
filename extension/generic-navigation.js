/* Ordinary Next on general sites. All DOM/value snapshots stay in this document.
   The worker separately authorizes each click and owns the per-run attempt ledger. */
(function (root) {
  'use strict';
  if (root.SecondHandNavigation) return;
  const NEXT = /^(?:next(?: step| page)?|continue|save\s*(?:and|&)\s*(?:continue|next))\s*[›»→]?$/i;
  const PROTECTED = /\b(?:submit|submission|finish|finali[sz]e|place order|purchase|pay(?:ment)?|checkout|signature|signing|sign (?:here|your|this|application|and)|consent|certif\w*|attest\w*|agree\w*|authoriz\w*|terms|review|confirmation|delete account)\b/i;
  const CHALLENGE = /password|captcha|one.?time|verification|security.?code|\botp\b|\bmfa\b|\b2fa\b|\bcc-/i;
  const BUTTONS = 'button,input[type="submit"],input[type="button"],[role="button"],a[href]';
  const CONTROLS = 'input,select,textarea,[contenteditable],[role="combobox"],[role="listbox"],[role="radio"],[role="checkbox"],[role="switch"],[role="textbox"]';
  const NON_DISCLOSURE = 'input,select,textarea,option,[contenteditable],[role="textbox"],[role="combobox"],script,style,template,noscript';
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  let preview = null;
  const engine = () => root.SecondHandGeneric;
  const all = (doc, selector) => engine().deepQueryAll(doc, selector);
  const visible = node => engine().isRendered(node);
  const name = node => clean(node.getAttribute('aria-label') || node.textContent || node.value);
  const inside = (scope, node) => {
    for (let current = node; current; current = current.parentElement || current.getRootNode()?.host) if (current === scope) return true;
    return false;
  };
  const nestedIn = (node, selector) => {
    for (let current = node; current; current = current.parentElement || current.getRootNode()?.host) if (current.matches?.(selector)) return true;
    return false;
  };
  // Bind visible question/disclosure text too, without reading answers in controls.
  // A consent sentence can sit in a plain div/span, not just a heading or button.
  function localText(doc, inScope) {
    return all(doc, '*').filter(node => inScope(node) && !nestedIn(node, NON_DISCLOSURE) && visible(node))
      .map(node => Array.from(node.childNodes).filter(child => child.nodeType === 3).map(child => child.textContent).join(' ')).map(clean).filter(Boolean).join(' ');
  }
  const actionText = destination => decodeURIComponent(destination.pathname + ' ' + destination.search)
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-z0-9]+/gi, ' ');
  const digest = text => { let n = 2166136261; for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619); return (n >>> 0).toString(16); };
  const status = (reason, step = '') => ({ canAdvance: false, reason, step });
  function inspect(doc) {
    if (!engine()?.navigationFields || !doc?.location || doc.location.protocol !== 'https:' || doc.location.hostname === 'hhsservices.iowa.gov') return status('unsupported');
    const url = doc.location.href;
    const buttons = all(doc, BUTTONS).filter(visible);
    const candidates = buttons.filter(node => NEXT.test(name(node)));
    const proposed = candidates.length === 1 ? candidates[0] : null;
    const scope = proposed?.form || proposed?.closest('form,main,[role="main"]') || doc.querySelector('main,[role="main"]') || doc.body;
    const inScope = node => inside(scope, node) || Boolean(scope.tagName === 'FORM' && node.form === scope);
    const headings = all(doc, 'h1,h2,[role="heading"][aria-level="1"],[role="heading"][aria-level="2"]').filter(node => visible(node) && (inScope(node) || node.tagName === 'H1')).map(node => clean(node.textContent));
    const context = scope.tagName === 'FORM' ? scope.closest('main,[role="main"]') || scope.parentElement || scope : scope;
    const inContext = node => {
      if (inScope(node)) return scope.tagName === 'FORM' || !nestedIn(node, 'footer,nav,[role="navigation"]');
      return inside(context, node) && !nestedIn(node, 'form,footer,nav,[role="navigation"]');
    };
    const stepText = localText(doc, inContext);
    if (stepText.length > 64000) return status('unsupported');
    if (PROTECTED.test(stepText) || headings.some(text => PROTECTED.test(text)) || buttons.some(node => inScope(node) && node.tagName !== 'A' && PROTECTED.test(name(node)) && !NEXT.test(name(node)))) return status('protected');
    if (all(doc, '[role="dialog"],[aria-modal="true"],dialog[open]').some(visible)) return status('review');
    if (all(doc, '[role="alert"],[aria-invalid="true"],.error,.validation-error,[data-error]').some(node => visible(node) && (node.getAttribute('aria-invalid') === 'true' || clean(node.textContent)))) return status('errors');
    // A cross-origin or custom embedded form cannot be proved complete by this document.
    if (all(doc, 'iframe').some(node => inScope(node) && visible(node) && !String(node.src).startsWith('chrome-extension:'))) return status('frames');
    const controls = all(doc, CONTROLS).filter(inScope);
    if (controls.length > 200) return status('unsupported');
    const shown = controls.filter(visible);
    if (shown.some(node => CHALLENGE.test(`${node.type || ''} ${node.id} ${node.getAttribute('name') || ''} ${node.getAttribute('autocomplete') || ''} ${node.getAttribute('aria-label') || ''}`) || node.type === 'file')) return status('protected');
    if (all(doc, '[data-secondhand-filled="guess"],[data-secondhand-filled="laya-guess"]').some(node => inScope(node) && visible(node))) return status('review');
    const fields = engine().navigationFields(doc).filter(field => field.elements.some(inScope));
    if (!Array.isArray(fields) || fields.length > 200) return status('unsupported');
    if (fields.some(field => !field.safe)) return status('protected');
    if (fields.some(field => !field.supported)) return status('unknown');
    const covered = new Set(fields.flatMap(field => field.elements));
    if (shown.some(node => !node.disabled && !node.readOnly && node.type !== 'hidden' && !covered.has(node) && !['submit', 'button', 'reset'].includes(node.type))) return status('unknown');
    const layout = JSON.stringify([doc.location.origin + doc.location.pathname, headings, stepText, fields.map(field => field.elements.map(node => [node.tagName, node.getAttribute('type'), node.getAttribute('aria-label'), node.getAttribute('role')])), candidates.map(node => [node.tagName, name(node)])]);
    const step = digest(layout);
    if (fields.some(field => field.required && !field.answered) || shown.some(node => !node.disabled && node.willValidate && !node.validity.valid)) return status('missing', step);
    if (candidates.length !== 1) return status('no-next', step);
    const next = candidates[0];
    if (next.disabled || next.getAttribute('aria-disabled') === 'true') return status('no-next', step);
    const form = next.form || next.closest('form');
    const target = next.getAttribute('formtarget') || next.getAttribute('target') || form?.getAttribute('target');
    if (target && target.toLowerCase() !== '_self') return status('unsupported', step);
    try {
      const destination = new URL(next.getAttribute('formaction') || (next.tagName === 'A' ? next.getAttribute('href') : null) || form?.getAttribute('action') || url, doc.baseURI);
      if (destination.origin !== doc.location.origin || destination.username || destination.password || PROTECTED.test(actionText(destination))) return status('protected', step);
    } catch { return status('unsupported', step); }
    // A Next belonging to a different/search form is not the application Next.
    if (form && fields.some(field => field.elements.some(node => node.form && node.form !== form))) return status('unknown', step);
    if (!fields.length) return status('unknown', step);
    const nodes = [...controls, next];
    const fingerprint = JSON.stringify([url, layout, form?.getAttribute('action'), form?.getAttribute('method'), next.outerHTML,
      controls.map(node => [node.outerHTML, node.value, node.checked, node.selectedIndex, node.textContent])]);
    if (fingerprint.length > 512000) return status('unsupported', step);
    return { canAdvance: true, reason: 'ready', step, nodes, fingerprint, next, url };
  }
  function snapshot(doc) {
    const current = inspect(doc);
    preview = null;
    if (!current.canAdvance) return current;
    const token = root.crypto.randomUUID();
    preview = { ...current, doc, token, expires: Date.now() + 120000 };
    return { canAdvance: true, reason: 'ready', step: current.step, token };
  }
  function advance(doc, token) {
    const saved = preview;
    preview = null; // An attempted click consumes the preview, including a refusal.
    if (!saved || saved.doc !== doc || saved.token !== token || Date.now() > saved.expires) return { ok: false, reason: 'changed' };
    const current = inspect(doc);
    if (!current.canAdvance || current.url !== saved.url || current.fingerprint !== saved.fingerprint || current.nodes.length !== saved.nodes.length || current.nodes.some((node, index) => node !== saved.nodes[index])) return { ok: false, reason: 'changed' };
    current.next.click();
    return { ok: true, advanced: true };
  }
  const api = Object.freeze({ snapshot, advance });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SecondHandNavigation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
