/* Conservative, fail-closed primary-applicant adapter. No network or storage. */
(function (root) {
  'use strict';
  const PORTAL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
  const normal = value => String(value || '').replace(/\s+/g, ' ').trim().replace(/\s*\*\s*$/, '').replace(/:$/, '').trim().toLowerCase();
  const definitions = Object.freeze({
    firstName: { label: 'First name', id: 'firstName', names: ['first name'] },
    middleName: { label: 'Middle name', id: 'middleName', names: ['middle name'] },
    lastName: { label: 'Last name', id: 'lastName', names: ['last name'] },
    homePhone: { label: 'Home phone number', id: 'phoneNumber', names: ['home phone number (999)999-9999'] },
    mobilePhone: { label: 'Mobile phone number', id: 'otherPhoneNumber', names: ['mobile phone number (999)999-9999'] },
    addressLine1: { label: 'Home street address', id: 'addressLine1', names: ['home address line 1'], address: true },
    addressLine2: { label: 'Home apartment / unit', id: 'addressLine2', names: ['home address line 2'], address: true },
    city: { label: 'Home city', id: 'city', names: ['city'], address: true },
    state: { label: 'Home state', id: 'state', names: ['state'], address: true },
    zip: { label: 'Home ZIP code', id: 'zipcode', names: ['zip code (99999)'], address: true }
  });
  const pageHeadings = new Set(['enter personal information']);
  const safeSections = new Set([...pageHeadings, "applicant's information", 'contact information', 'address information']);
  const unsafe = /\b(signature|sign here|signing|certification|certify|attestation|attest|password|captcha|verification|security code|one time|username|user name|other people|other members|household members|family members|spouse|child|children|representative|employer|mailing address|mailing information)\b/i;

  function isSupportedUrl(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && url.hostname === 'hhsservices.iowa.gov' && !url.port && !url.username && !url.password &&
        (url.pathname === '/apspssp/ssp.portal' || url.pathname.startsWith('/apspssp/ssp.portal/')) && !/%|\\/.test(url.pathname);
    } catch { return false; }
  }

  function rendered(element, doc) {
    const win = doc.defaultView;
    if (!win || !element.isConnected) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    const rect = element.getBoundingClientRect();
    return Boolean(element.getClientRects().length && rect.width > 0 && rect.height > 0);
  }

  function inViewport(element, doc) {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= doc.defaultView.innerWidth && rect.bottom <= doc.defaultView.innerHeight;
  }

  function visible(element, doc) {
    if (!rendered(element, doc) || !inViewport(element, doc)) return false;
    const win = doc.defaultView;
    const rect = element.getBoundingClientRect();
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

  function scrollToField(element, doc) {
    if (!rendered(element, doc)) return false;
    if (!visible(element, doc) && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
    return visible(element, doc);
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
    return { safe: true, home: Boolean(element.closest('#personalInformation #homeAddrDiv')) };
  }

  function identifyPage(doc) {
    const main = doc.querySelector('main, [role="main"], #MainContentContainer') || doc.body;
    if (!main || !doc.querySelector('form#personalInformation[action="enterPersonalInfo"]')) return false;
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
    for (const element of doc.querySelectorAll('form#personalInformation input, form#personalInformation select')) {
      const names = namesFor(element, doc);
      const identity = `${element.id} ${element.name} ${names.join(' ')}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
      const type = element.type?.toLowerCase() || 'text';
      const group = sectionInfo(element);
      const canInspect = rendered(element, doc) && (!inViewport(element, doc) || visible(element, doc));
      if (!canInspect || element.matches(':disabled') || element.readOnly || !group.safe || unsafe.test(identity) || !['text', 'select-one'].includes(type)) { result.skipped++; continue; }
      const matches = Object.entries(definitions).filter(([, definition]) => names.length > 0 && names.every(name => definition.names.includes(name)));
      if (matches.length !== 1) { result.skipped++; continue; }
      const [key, definition] = matches[0];
      if (element.id !== definition.id || element.name !== definition.id) { result.skipped++; continue; }
      if (definition.address && !group.home) { result.skipped++; continue; }
      if ((key === 'state') !== (element.tagName === 'SELECT')) { result.skipped++; continue; }
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
    if (key === 'homePhone' || key === 'mobilePhone') {
      let digits = value.replace(/[()\s.-]/g, '');
      if (/^\+?1\d{10}$/.test(digits)) digits = digits.replace(/^\+?1/, '');
      if (!/^\d{10}$/.test(digits)) return null;
      value = `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (key === 'zip' && !/^\d{5}$/.test(value)) return null;
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
      if (!scrollToField(element, doc) || doc.location.href !== rawUrl ||
          !scan(doc, rawUrl).bindings.some(item => item.key === key && item.element === element)) { skipped.push(key); continue; }
      const prototype = element.tagName === 'SELECT' ? doc.defaultView.HTMLSelectElement.prototype : doc.defaultView.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(element, value);
      // Filling never clicks a button. Advancing is a separate user command.
      element.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
      element.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
      if (element.value === value) filled.push(key); else skipped.push(key);
    }
    return { filled, skipped };
  }
  const navigationSnapshots = new WeakMap();
  const knownPersonalControls = new Set([
    ...Object.values(definitions).map(definition => definition.id), 'suffix', 'maidenName',
    'hasHome1', 'hasHome2', 'sameAddress1', 'sameAddress2', 'mailingAddressLine1',
    'mailingAddressLine2', 'mailingCity', 'mailingState', 'mailingZipcode', 'applicant1',
    'applicant2', 'medicaid', 'snap', 'tanf', 'helpPayMedBill1', 'helpPayMedBill2', 'bestTime'
  ]);

  function currentControls(form, doc) {
    return Array.from(form.querySelectorAll('input, select, textarea')).filter(element =>
      element.type !== 'hidden' && rendered(element, doc) && !element.matches(':disabled'));
  }

  function mandatory(element) {
    if (['firstName', 'lastName', 'addressLine1', 'city', 'state', 'zipcode'].includes(element.id)) return true;
    if (element.required || element.getAttribute('aria-required') === 'true') return true;
    if (Array.from(element.labels || []).some(label => /\*/.test(label.textContent))) return true;
    if (!['checkbox', 'radio'].includes(element.type)) return false;
    const legend = element.closest('fieldset')?.querySelector('legend');
    return Boolean(legend && /\*/.test(legend.textContent));
  }

  function personalIssues(form, doc) {
    const controls = currentControls(form, doc);
    const radioGroups = new Map();
    let requiredRemaining = 0, manualRemaining = 0;
    if (Array.from(form.elements).some(element => !form.contains(element))) manualRemaining++;
    for (const id of ['firstName', 'lastName', 'hasHome1', 'hasHome2', 'applicant1', 'applicant2']) {
      if (form.querySelectorAll(`[id="${id}"]`).length !== 1) manualRemaining++;
    }
    for (const control of controls) {
      if (!knownPersonalControls.has(control.id) || control.tagName === 'TEXTAREA') { manualRemaining++; continue; }
      const expectedName = ({ hasHome1: 'hasHome', hasHome2: 'hasHome', sameAddress1: 'sameAddress', sameAddress2: 'sameAddress', applicant1: 'applicant', applicant2: 'applicant', medicaid: 'programs', snap: 'programs', tanf: 'programs', helpPayMedBill1: 'helpPayMedBill', helpPayMedBill2: 'helpPayMedBill', bestTime: 'bestTimeToCall' })[control.id] || control.id;
      const expectedType = ['hasHome1', 'hasHome2', 'sameAddress1', 'sameAddress2', 'applicant1', 'applicant2', 'helpPayMedBill1', 'helpPayMedBill2'].includes(control.id) ? 'radio' : ['snap', 'medicaid', 'tanf'].includes(control.id) ? 'checkbox' : ['state', 'mailingState', 'suffix'].includes(control.id) ? 'select-one' : 'text';
      if (control.name !== expectedName || control.type !== expectedType) { manualRemaining++; continue; }
      if (control.type === 'radio') {
        if (!control.name) { manualRemaining++; continue; }
        if (!radioGroups.has(control.name)) radioGroups.set(control.name, []);
        radioGroups.get(control.name).push(control);
      } else if (control.type === 'checkbox') {
        // Program choice is a manually answered group. No agreement is checked here.
        if (!['snap', 'medicaid', 'tanf'].includes(control.id) || control.name !== 'programs') manualRemaining++;
      } else {
        if (mandatory(control) && !String(control.value || '').trim()) requiredRemaining++;
        else if (control.getAttribute('aria-invalid') === 'true' || (control.willValidate && !control.validity.valid)) manualRemaining++;
      }
    }
    for (const group of radioGroups.values()) if (!group.some(control => control.checked)) manualRemaining++;
    const programs = controls.filter(control => control.type === 'checkbox' && control.name === 'programs');
    if (programs.length && !programs.some(control => control.checked)) manualRemaining++;
    if (Array.from(form.querySelectorAll('[role="alert"], .error, .errors, .errorMessage')).some(element => rendered(element, doc) && element.textContent.trim())) manualRemaining++;
    return { requiredRemaining, manualRemaining };
  }

  function navigationButton(doc, rawUrl) {
    if (!isSupportedUrl(rawUrl) || !identifyPage(doc)) return null;
    const forms = doc.querySelectorAll('form#personalInformation[action="enterPersonalInfo"]');
    if (forms.length !== 1) return null;
    const form = forms[0];
    // Even a familiar relative action must resolve to the observed Iowa endpoint.
    if (form.action !== `${PORTAL}/applyForBenefits/enterPersonalInfo` || form.method.toLowerCase() !== 'post' || form.hasAttribute('onsubmit') || form.hasAttribute('target')) return null;
    const buttons = Array.from(form.querySelectorAll('button')).filter(button => normal(button.textContent) === 'save and continue');
    if (buttons.length !== 1) return null;
    const button = buttons[0];
    if (button.type !== 'button' || !button.classList.contains('saveAndContinueButton') || button.getAttribute('onclick')?.trim() !== "submitAction('#personalInformation');" ||
        !rendered(button, doc) || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true' ||
        button.hasAttribute('formaction') || button.hasAttribute('formtarget') || button.hasAttribute('formnovalidate') ||
        (button.getAttribute('form') && button.getAttribute('form') !== form.id)) return null;
    return { form, button };
  }

  function probePage(doc, rawUrl) {
    const result = { kind: 'unsupported', pageKey: 'unsupported', heading: 'Unsupported website', reason: 'Open the official Iowa benefits portal.', canAdvance: false, fields: [], requiredRemaining: 0, manualRemaining: 0 };
    if (!isSupportedUrl(rawUrl)) return result;
    result.kind = 'manual'; result.pageKey = 'iowa-manual'; result.heading = 'Iowa benefits application';
    result.reason = 'Complete this step in Iowa’s form. SecondHand has not verified its controls.';
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3')).filter(element => rendered(element, doc)).map(element => normal(element.textContent));
    if (Array.from(doc.querySelectorAll('input[type="password"], [name="captchaAnswer"], #securityCode, #termChkbox, [aria-modal="true"]')).some(element => rendered(element, doc)) ||
        headings.some(heading => /\b(signature|certification|attestation|review and submit|submit application|confirmation|terms and conditions)\b/.test(heading))) {
      return { ...result, kind: 'blocked', pageKey: 'iowa-protected-step', heading: 'Finish this step yourself', reason: 'Account access, verification, consent, signatures, and final submission must be completed directly in Iowa’s portal.' };
    }
    if (!identifyPage(doc)) {
      if (headings.includes('household application information')) { result.pageKey = 'iowa-program-intent'; result.heading = 'Household Application Information'; result.reason = 'Choose the household’s application intent and complete verification in Iowa’s form.'; }
      else if (headings.includes('assisting organization or person')) { result.pageKey = 'iowa-assistance'; result.heading = 'Assisting Organization or Person'; result.reason = 'Answer who is helping with the application yourself. These fields do not describe the applicant.'; }
      else if (headings.includes("let's get started")) { result.kind = 'blocked'; result.pageKey = 'iowa-consent'; result.heading = 'Let’s get started'; result.reason = 'Review and complete Iowa’s data-use consent yourself.'; }
      else {
        const informational = [
          ['welcome', 'iowa-home', 'Welcome', 'Choose Apply for Assistance in Iowa’s portal to begin.'],
          ['before you start...', 'iowa-before-start', 'Before You Start', 'Read Iowa’s preparation information, then continue in the portal.'],
          ['important information when applying and what to expect.', 'iowa-information', 'Important application information', 'Read Iowa’s application instructions, then continue in the portal.'],
          ['instructions', 'iowa-instructions', 'Instructions', 'Read how Iowa’s form works, then continue in the portal.'],
          ['about you', 'iowa-about-you', 'About you', 'Continue in Iowa’s portal to the applicant questions.']
        ].find(([heading]) => headings.includes(heading));
        if (informational) [, result.pageKey, result.heading, result.reason] = informational;
      }
      return result;
    }
    const scanResult = scan(doc, rawUrl);
    const form = doc.querySelector('form#personalInformation[action="enterPersonalInfo"]');
    const issues = personalIssues(form, doc);
    const next = navigationButton(doc, rawUrl);
    return { ...result, ...issues, kind: 'fillable', pageKey: 'iowa-personal-information', heading: 'Enter Personal Information', fields: scanResult.fields,
      canAdvance: Boolean(next && issues.requiredRemaining === 0 && issues.manualRemaining === 0 && scanResult.ambiguous.length === 0),
      reason: issues.manualRemaining ? 'Answer the remaining questions and correct any errors in Iowa’s form, then check again.' : issues.requiredRemaining ? 'Complete the required applicant fields before continuing.' : next ? 'Review all answers. Next saves this page to Iowa and opens the following step; it does not submit the application.' : 'The expected Next button was not found safely. Continue directly in Iowa’s form.' };
  }

  function controlState(form) {
    return Array.from(form.querySelectorAll('input, select, textarea')).filter(element => element.type !== 'hidden').map(element => ({ element,
      value: element.value, checked: element.checked, disabled: element.disabled, readOnly: element.readOnly, required: element.required,
      id: element.id, name: element.name, type: element.type, ariaInvalid: element.getAttribute('aria-invalid'), ariaRequired: element.getAttribute('aria-required'),
      rendered: rendered(element, form.ownerDocument), labels: namesFor(element, form.ownerDocument).join('|') }));
  }

  function sameControlState(before, form) {
    const after = controlState(form);
    return before.length === after.length && before.every((state, index) => Object.keys(state).every(key => state[key] === after[index][key]));
  }

  function captureNavigation(doc, rawUrl) {
    if (doc.location.href !== rawUrl || !probePage(doc, rawUrl).canAdvance) return null;
    const next = navigationButton(doc, rawUrl);
    if (!next) return null;
    // The public token has no enumerable data. DOM refs and answers stay private
    // in this isolated world's memory and are never included in a page probe.
    const token = Object.freeze({});
    navigationSnapshots.set(token, { doc, url: rawUrl, ...next, controls: controlState(next.form), expires: Date.now() + 120000,
      buttonType: next.button.type, onclick: next.button.getAttribute('onclick') });
    return token;
  }

  function advance(doc, rawUrl, token) {
    const original = token && navigationSnapshots.get(token);
    if (token) navigationSnapshots.delete(token);
    const fail = reason => ({ advanced: false, reason });
    if (!original || original.doc !== doc || original.url !== rawUrl || doc.location.href !== rawUrl || original.expires < Date.now()) return fail('The page changed or the Next preview expired. Check this page again.');
    const page = probePage(doc, rawUrl), next = navigationButton(doc, rawUrl);
    if (!page.canAdvance || !next || next.form !== original.form || next.button !== original.button ||
        next.button.type !== original.buttonType || next.button.getAttribute('onclick') !== original.onclick || !sameControlState(original.controls, next.form)) return fail('The page or an answer changed. Review it and check again before Next.');
    if (!scrollToField(next.button, doc) || doc.location.href !== rawUrl || !probePage(doc, rawUrl).canAdvance || !sameControlState(original.controls, next.form)) return fail('The Next button is not safely accessible. Continue in Iowa’s form.');
    try { next.button.click(); }
    catch { return fail('Iowa’s Next control could not be activated. Check the page before trying again.'); }
    return { advanced: true, reason: 'Next was clicked once. Check the following page for required questions or errors.' };
  }

  const api = Object.freeze({ PORTAL, definitions, isSupportedUrl, rendered, visible, scan, fill, formatValue, probePage, captureNavigation, advance });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandIowa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
