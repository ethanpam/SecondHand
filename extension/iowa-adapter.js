/* Conservative, fail-closed primary-applicant adapter. No network or storage. */
(function (root) {
  'use strict';
  const PORTAL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
  const normal = value => String(value || '').replace(/\s+/g, ' ').trim().replace(/\s*\*\s*$/, '').replace(/:$/, '').trim().toLowerCase();
  const definitions = Object.freeze({
    firstName: { label: 'First name', names: ['first name', 'applicant first name'] },
    middleName: { label: 'Middle name', names: ['middle name', 'applicant middle name'] },
    lastName: { label: 'Last name', names: ['last name', 'applicant last name'] },
    birthDate: { label: 'Date of birth', names: ['date of birth', 'birth date', 'date of birth (mm/dd/yyyy)'] },
    ssn: { label: 'Social Security number', names: ['social security number', 'social security number (ssn)'] },
    email: { label: 'Email address', names: ['email address', 'e-mail address'] },
    phone: { label: 'Phone number', names: ['phone number', 'telephone number', 'primary phone number'] },
    addressLine1: { label: 'Home street address', names: ['address line 1', 'street address', 'home address', 'residential address line 1'], address: true },
    addressLine2: { label: 'Home apartment / unit', names: ['address line 2', 'apartment number', 'apartment / unit', 'residential address line 2'], address: true },
    city: { label: 'Home city', names: ['city', 'city/town'], address: true },
    state: { label: 'Home state', names: ['state'], address: true },
    zip: { label: 'Home ZIP code', names: ['zip code', 'zip'], address: true },
    county: { label: 'Home county', names: ['county', 'county of residence'], address: true }
  });
  const pageHeadings = new Set(['enter personal information', 'primary applicant information']);
  const safeSections = new Set([...pageHeadings, 'personal information', 'applicant information', 'primary applicant', 'name', 'contact information', 'contact details', 'home address', 'residential address', 'physical address']);
  const homeSections = new Set(['home address', 'residential address', 'physical address']);
  const unsafe = /\b(signature|sign here|signing|certification|certify|attestation|attest|password|captcha|verification|security code|one time|username|user name|other people|other members|household members|family members|spouse|child|children|representative|employer|mailing address|mailing information)\b/i;

  function isSupportedUrl(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && url.hostname === 'hhsservices.iowa.gov' && !url.port && !url.username && !url.password &&
        (url.pathname === '/apspssp/ssp.portal' || url.pathname.startsWith('/apspssp/ssp.portal/')) && !/%|\\/.test(url.pathname);
    } catch { return false; }
  }

  function visible(element, doc) {
    const win = doc.defaultView;
    if (!win || !element.isConnected) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    const rect = element.getBoundingClientRect();
    if (!element.getClientRects().length || rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 || rect.right > win.innerWidth || rect.bottom > win.innerHeight) return false;
    for (let node = element.parentElement; node && node !== doc.body; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflow + style.overflowX + style.overflowY) && (rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom)) return false;
    }
    // A modal or overlay must not make a field eligible behind it.
    if (typeof doc.elementFromPoint === 'function') {
      const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!top || (top !== element && !element.contains(top))) return false;
    }
    return true;
  }

  function namesFor(element, doc) {
    const values = Array.from(element.labels || [], label => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('input, select, textarea, button').forEach(control => control.remove());
      return normal(copy.textContent);
    });
    const aria = normal(element.getAttribute('aria-label'));
    if (aria) values.push(aria);
    const ids = (element.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    if (ids.length) values.push(normal(ids.map(id => doc.getElementById(id)?.textContent || '').join(' ')));
    return [...new Set(values.filter(Boolean))];
  }

  function sectionInfo(element) {
    const names = [];
    let branch = element;
    for (let node = element.parentElement; node && node.tagName !== 'BODY'; node = node.parentElement) {
      const identity = `${node.id || ''} ${node.getAttribute('name') || ''} ${node.getAttribute('aria-label') || ''}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
      if (unsafe.test(identity)) return { safe: false, home: false };
      if (node.matches('fieldset, section, [role="group"], [role="region"]')) {
        const heading = Array.from(node.children).find(child => child.matches('legend, h1, h2, h3, h4, h5, h6'));
        const label = normal(node.getAttribute('aria-label') || heading?.textContent);
        // Unknown named groups could belong to another person.
        if (label && !safeSections.has(label)) return { safe: false, home: false };
        if (label) names.push(label);
      }
      // Legacy pages often use divs and sibling headings instead of fieldsets.
      // Respect the closest preceding heading at each ancestor level as well.
      const preceding = Array.from(node.children).slice(0, Array.from(node.children).indexOf(branch));
      const heading = preceding.reverse().find(child => child.matches('legend, h1, h2, h3, h4, h5, h6'));
      if (heading) {
        const label = normal(heading.textContent);
        if (!safeSections.has(label)) return { safe: false, home: false };
        names.push(label);
      }
      branch = node;
    }
    return { safe: true, home: names.some(name => homeSections.has(name)) };
  }

  function identifyPage(doc) {
    const main = doc.querySelector('main, [role="main"], #MainContentContainer') || doc.body;
    if (!main) return false;
    // Heading visibility is checked without viewport bounds: scrolling the page
    // may move its title out of view while a field remains visible.
    return Array.from(main.querySelectorAll('h1, h2, h3')).some(heading => {
      if (!pageHeadings.has(normal(heading.textContent))) return false;
      for (let node = heading; node && node.nodeType === 1; node = node.parentElement) {
        const style = doc.defaultView.getComputedStyle(node);
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    });
  }

  function scan(doc, rawUrl) {
    const result = { supported: isSupportedUrl(rawUrl), recognizedPage: false, fields: [], bindings: [], ambiguous: [], skipped: 0 };
    if (!result.supported || !identifyPage(doc)) return result;
    result.recognizedPage = true;
    const candidates = new Map();
    for (const element of doc.querySelectorAll('input, select, textarea')) {
      const names = namesFor(element, doc);
      const identity = `${element.id} ${element.name} ${names.join(' ')}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
      const type = element.type?.toLowerCase() || 'text';
      const group = sectionInfo(element);
      if (!visible(element, doc) || element.matches(':disabled') || element.readOnly || !group.safe || unsafe.test(identity) || !['text', 'email', 'tel', 'date', 'select-one'].includes(type)) { result.skipped++; continue; }
      const matches = Object.entries(definitions).filter(([, definition]) => names.length > 0 && names.every(name => definition.names.includes(name)));
      if (matches.length !== 1) { result.skipped++; continue; }
      const [key, definition] = matches[0];
      if (definition.address && !group.home) { result.skipped++; continue; }
      if (element.tagName === 'SELECT' && !['state', 'county'].includes(key)) { result.skipped++; continue; }
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(element);
    }
    for (const [key, elements] of candidates) {
      if (elements.length !== 1) { result.ambiguous.push(definitions[key].label); continue; }
      const element = elements[0];
      if (String(element.value || '').trim()) { result.skipped++; continue; }
      result.fields.push({ key, label: definitions[key].label });
      result.bindings.push({ key, element });
    }
    return result;
  }

  function formatValue(key, raw, element) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 250 || /[\u0000-\u001f]/.test(raw)) return null;
    let value = raw.trim();
    if (key === 'birthDate') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(`${value}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
      if (element.type !== 'date') {
        const hint = `${element.placeholder || ''} ${namesFor(element, element.ownerDocument).join(' ')}`;
        if (!/mm\/dd\/yyyy/i.test(hint)) return null;
        value = `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
      }
    }
    if (element.tagName === 'SELECT') {
      const choices = Array.from(element.options).filter(option => !option.disabled && option.value && (normal(option.value) === normal(value) || normal(option.textContent) === normal(value) || (key === 'state' && ['ia', 'iowa'].includes(normal(value)) && ['ia', 'iowa'].includes(normal(option.textContent)))));
      return choices.length === 1 ? choices[0].value : null;
    }
    if (element.maxLength >= 0 && value.length > element.maxLength) return null;
    return value;
  }

  function fill(doc, rawUrl, originalBindings, values) {
    const filled = [], skipped = [];
    for (const binding of originalBindings) {
      const fresh = scan(doc, rawUrl);
      const { key, element } = binding;
      // Re-identify, re-check emptiness and element identity after desktop consent.
      if (doc.location.href !== rawUrl || !fresh.supported || !fresh.recognizedPage || !fresh.bindings.some(item => item.key === key && item.element === element) || !Object.prototype.hasOwnProperty.call(values, key)) { skipped.push(key); continue; }
      const value = formatValue(key, values[key], element);
      if (value === null) { skipped.push(key); continue; }
      const prototype = element.tagName === 'SELECT' ? doc.defaultView.HTMLSelectElement.prototype : doc.defaultView.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(element, value);
      // Let the portal validate as if a user had typed; never click, navigate, or submit.
      element.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
      element.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
      if (element.value === value) filled.push(key); else skipped.push(key);
    }
    return { filled, skipped };
  }
  const api = Object.freeze({ PORTAL, definitions, isSupportedUrl, visible, scan, fill, formatValue });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandIowa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
