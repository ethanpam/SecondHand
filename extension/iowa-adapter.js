/* Conservative, fail-closed primary-applicant adapter. No network or storage. */
(function (root) {
  'use strict';
  const PORTAL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
  const normal = value => String(value || '').replace(/\s+/g, ' ').trim().replace(/\s*\*\s*$/, '').replace(/:$/, '').trim().toLowerCase();
  const questions = Object.freeze({
    home: 'Do you have a home address?', same: 'Is your mailing address the same as your home address?',
    applicant: 'Are you applying for benefits?', programs: 'What benefits are you applying for?',
    medical: 'Do you need help paying for medical bills from the last three calendar months? If you answer yes and you fall into a category that allows for retroactive approval, we will determine if you are eligible for coverage during those months.'
  });
  const radio = (label, id, noId, name, question, handler, container) => ({ label, id, noId, name, type: 'radio', question, handler, container });
  const definitions = Object.freeze({
    firstName: { label: 'First name', id: 'firstName', names: ['first name'] },
    middleName: { label: 'Middle name', id: 'middleName', names: ['middle name'] },
    lastName: { label: 'Last name', id: 'lastName', names: ['last name'] },
    suffix: { label: 'Suffix', id: 'suffix', names: ['suffix'], type: 'select-one' },
    maidenName: { label: 'Maiden name', id: 'maidenName', names: ['maiden name'] },
    homePhone: { label: 'Home phone number', id: 'phoneNumber', names: ['home phone number (999)999-9999'] },
    mobilePhone: { label: 'Mobile phone number', id: 'otherPhoneNumber', names: ['mobile phone number (999)999-9999'] },
    hasHomeAddress: radio('Do you have a home address?', 'hasHome1', 'hasHome2', 'hasHome', questions.home, 'hideShowHome'),
    addressLine1: { label: 'Home street address', id: 'addressLine1', names: ['home address line 1'], container: 'homeAddrDiv' },
    addressLine2: { label: 'Home apartment / unit', id: 'addressLine2', names: ['home address line 2'], container: 'homeAddrDiv' },
    city: { label: 'Home city', id: 'city', names: ['city'], container: 'homeAddrDiv' },
    state: { label: 'Home state', id: 'state', names: ['state'], container: 'homeAddrDiv', type: 'select-one' },
    zip: { label: 'Home ZIP code', id: 'zipcode', names: ['zip code (99999)'], container: 'homeAddrDiv' },
    mailingSameAsHome: radio('Is your mailing address the same as home?', 'sameAddress1', 'sameAddress2', 'sameAddress', questions.same, 'sameAddressCheck', 'homeAddrDiv'),
    mailingAddressLine1: { label: 'Mailing street address', id: 'mailingAddressLine1', names: ['mailing address line 1'], container: 'sameAdd' },
    mailingAddressLine2: { label: 'Mailing apartment / unit', id: 'mailingAddressLine2', names: ['mailing address line 2'], container: 'sameAdd' },
    mailingCity: { label: 'Mailing city', id: 'mailingCity', names: ['mailing city'], container: 'sameAdd' },
    mailingState: { label: 'Mailing state', id: 'mailingState', names: ['mailing state'], container: 'sameAdd', type: 'select-one' },
    mailingZip: { label: 'Mailing ZIP code', id: 'mailingZipcode', names: ['mailing zip code (99999)'], container: 'sameAdd' },
    isApplicant: radio('Are you applying for benefits?', 'applicant1', 'applicant2', 'applicant', questions.applicant, 'checkForApplicant'),
    programMedicaid: { label: 'Health coverage (Medicaid / CHIP)', id: 'medicaid', name: 'programs', names: ["health coverage (medicaid or children's health insurance program - chip)"], type: 'checkbox', choiceValue: 'MC', onclick: 'showHideFA()', question: questions.programs, container: 'progSelection' },
    programSnap: { label: 'SNAP', id: 'snap', name: 'programs', names: ['supplemental nutritional assistance program(snap)'], type: 'checkbox', choiceValue: 'FS', onclick: 'showHideBestTimetoCall()', question: questions.programs, container: 'progSelection' },
    programFip: { label: 'FIP or Refugee Cash Assistance', id: 'tanf', name: 'programs', names: ['family investment program (fip) or refugee cash assistance (rca)'], type: 'checkbox', choiceValue: 'CW', onclick: 'showHideBestTimetoCall()', question: questions.programs, container: 'progSelection' },
    helpPayMedicalBills: radio('Help with medical bills from the last three months?', 'helpPayMedBill1', 'helpPayMedBill2', 'helpPayMedBill', questions.medical, null, 'faDiv'),
    bestContactTime: { label: 'Best time to call', id: 'bestTime', name: 'bestTimeToCall', names: ['best time to call? (30 character limit)'], container: 'bstTime', maxLength: 30 }
  });
  const forms = Object.freeze({
    personal: 'form#personalInformation[action="enterPersonalInfo"]',
    household: 'form#householdApplicationForm[action="selectHouseholdInfo"]'
  });
  // Household Application Information, recorded live 2026-09-26. Choosing an
  // answer runs toggleCaptcha(), which reveals Iowa's CAPTCHA.
  const householdDefinitions = Object.freeze({
    householdApplyProg: { label: 'Is anyone applying for SNAP, FIP, or health coverage?', id: 'householdApplyProgYes', noId: 'householdApplyProgNo',
      name: 'householdApplyProg', type: 'radio', form: 'household', optionHandlers: ['toggleCaptcha();', 'toggleCaptcha();'],
      optionNames: ['yes. at least one person is applying for snap, fip/rca, or help paying for health coverage.', 'no. you will answer fewer questions but you will not get help paying for health coverage.'] }
  });
  const pageForms = Object.freeze({
    personal: { form: forms.personal, headings: ['enter personal information'], definitions },
    household: { form: forms.household, headings: ['household application information'], definitions: householdDefinitions }
  });
  // Information-only screens and the exact Continue handler recorded for each.
  const infoScreens = Object.freeze({
    'before you start...': { pageKey: 'iowa-before-start', heading: 'Before You Start', onclick: "submitUrlLink('letsGetStarted');return false;" },
    'important information when applying and what to expect.': { pageKey: 'iowa-information', heading: 'Important application information', onclick: "submitUrlLink('instructions');return false;" },
    instructions: { pageKey: 'iowa-instructions', heading: 'Instructions', onclick: "submitUrlLink('aboutYou');return false;" }
  });
  const programKeys = ['programSnap', 'programFip', 'programMedicaid'];
  const safeSections = new Set(['enter personal information', 'household application information', "applicant's information", 'contact information', 'address information', 'program information', ...Object.values(questions).map(normal)]);
  const definitionFor = key => definitions[key] || householdDefinitions[key];
  const unsafe = /\b(signature|sign here|signing|certification|certify|attestation|attest|password|captcha|verification|security code|one time|username|user name|other people|other members|household members|family members|spouse|child|representative|employer)\b/i;

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
    if (!main) return null;
    for (const [id, page] of Object.entries(pageForms)) {
      if (!doc.querySelector(page.form)) continue;
      // Heading visibility is checked without viewport bounds: scrolling the page
      // may move its title out of view while a field remains visible.
      const titled = Array.from(main.querySelectorAll('h1, h2, h3')).some(heading => {
        if (!page.headings.includes(normal(heading.textContent))) return false;
        for (let node = heading; node && node.nodeType === 1; node = node.parentElement) {
          const style = doc.defaultView.getComputedStyle(node);
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
      });
      if (titled) return id;
    }
    return null;
  }

  function matchingControls(doc, definition) {
    const form = doc.querySelector(forms[definition.form || 'personal']);
    if (!form) return [];
    const ids = definition.noId ? [definition.id, definition.noId] : [definition.id];
    const controls = ids.map(id => Array.from(doc.querySelectorAll(`[id="${id}"]`)));
    if (controls.some(matches => matches.length !== 1 || !form.contains(matches[0]))) return [];
    const elements = controls.map(matches => matches[0]);
    if (elements.some((element, index) => {
      const names = namesFor(element, doc);
      const expected = definition.type === 'radio' ? [definition.optionNames?.[index] ?? (index === 0 ? 'yes' : 'no')] : definition.names;
      const onclick = definition.type === 'radio' ? (definition.optionHandlers?.[index] ?? (definition.handler ? `${definition.handler}('${index === 0 ? 'Yes' : 'No'}');` : null)) : (definition.onclick || null);
      return element.name !== (definition.name || definition.id) || element.type !== (definition.type || 'text') ||
        !names.length || !names.every(name => expected.includes(name)) || !sectionInfo(element).safe ||
        (definition.container && !element.closest(`#personalInformation #${definition.container}`)) ||
        (definition.question && normal(element.closest('fieldset')?.querySelector('legend')?.textContent) !== normal(definition.question)) ||
        element.getAttribute('onclick') !== onclick || element.hasAttribute('onchange') ||
        (definition.type === 'radio' && element.getAttribute('value') !== (index === 0 ? 'true' : 'false')) ||
        (definition.type === 'checkbox' && element.getAttribute('value') !== definition.choiceValue) ||
        (definition.maxLength && element.maxLength !== definition.maxLength);
    })) return [];
    // A third option with a familiar name changes the meaning of this group.
    if (definition.type === 'radio' && form.querySelectorAll(`input[name="${definition.name}"]`).length !== 2) return [];
    return elements;
  }

  function editable(element, doc) {
    return rendered(element, doc) && (!inViewport(element, doc) || visible(element, doc)) && !element.matches(':disabled') && !element.readOnly;
  }

  function answered(elements, definition) {
    return ['radio', 'checkbox'].includes(definition.type) ? elements.some(element => element.checked) : Boolean(String(elements[0]?.value || '').trim());
  }

  function scan(doc, rawUrl) {
    const result = { supported: isSupportedUrl(rawUrl), recognizedPage: false, fields: [], bindings: [], ambiguous: [], skipped: 0 };
    const pageId = result.supported ? identifyPage(doc) : null;
    if (!pageId) return result;
    result.recognizedPage = true;
    for (const [key, definition] of Object.entries(pageForms[pageId].definitions)) {
      const elements = matchingControls(doc, definition);
      if (!elements.length) {
        if (doc.querySelectorAll(`[id="${definition.id}"]`).length > 1) result.ambiguous.push(definition.label);
        result.skipped++; continue;
      }
      if (!elements.every(element => editable(element, doc)) || answered(elements, definition)) { result.skipped++; continue; }
      result.fields.push({ key, label: definition.label });
      result.bindings.push({ key, element: elements[0], elements });
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
    if (['zip', 'mailingZip'].includes(key) && !/^\d{5}$/.test(value)) return null;
    if (key === 'suffix' && !['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'Jr.', 'Sr.'].includes(value)) return null;
    if (key === 'bestContactTime' && value.length > 30) return null;
    if (element.tagName === 'SELECT') {
      const choices = Array.from(element.options).filter(option => !option.disabled && option.value && (normal(option.value) === normal(value) || normal(option.textContent) === normal(value) || (['state', 'mailingState'].includes(key) && ['ia', 'iowa'].includes(normal(value)) && ['ia', 'iowa'].includes(normal(option.textContent)))));
      return choices.length === 1 ? choices[0].value : null;
    }
    if (element.maxLength >= 0 && value.length > element.maxLength) return null;
    return value;
  }

  function hasDependentAnswers(key, doc) {
    const containers = { hasHomeAddress: ['homeAddrDiv', 'sameAdd'], mailingSameAsHome: ['sameAdd'], isApplicant: ['progSelection'] }[key] || [];
    return containers.some(id => Array.from(doc.querySelectorAll(`#personalInformation #${id} input, #personalInformation #${id} select`)).some(element =>
      element.type !== 'hidden' && (['radio', 'checkbox'].includes(element.type) ? element.checked : Boolean(String(element.value || '').trim()))));
  }

  function fill(doc, rawUrl, originalBindings, values) {
    const filled = [], skipped = [];
    const order = [...Object.keys(definitions), ...Object.keys(householdDefinitions)];
    // Only bindings captured in the original rendered-field preview are eligible.
    // Newly revealed fields need a fresh scan in the next Autofill pass.
    for (const binding of [...originalBindings].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))) {
      const fresh = scan(doc, rawUrl);
      const { key, element } = binding;
      const definition = definitionFor(key);
      const current = fresh.bindings.find(item => item.key === key && item.element === element);
      const original = binding.elements || [element];
      if (!definition || doc.location.href !== rawUrl || !current || !Object.prototype.hasOwnProperty.call(values, key) ||
          current.elements.length !== original.length || current.elements.some((item, index) => item !== original[index])) { skipped.push(key); continue; }
      if (['radio', 'checkbox'].includes(definition.type)) {
        const value = values[key];
        if (!['yes', 'no'].includes(value) || hasDependentAnswers(key, doc)) { skipped.push(key); continue; }
        // An explicit No already matches an unchecked program box. Never clear
        // a checked choice or run its potentially destructive hide/reset handler.
        if (definition.type === 'checkbox' && value === 'no') { skipped.push(key); continue; }
        const target = definition.type === 'radio' && value === 'no' ? current.elements[1] : element;
        if (!scrollToField(target, doc) || doc.location.href !== rawUrl ||
            !scan(doc, rawUrl).bindings.some(item => item.key === key && item.element === element) || hasDependentAnswers(key, doc)) { skipped.push(key); continue; }
        target.click();
        if (target.checked) filled.push(key); else skipped.push(key);
        continue;
      }
      const value = formatValue(key, values[key], element);
      if (value === null) { skipped.push(key); continue; }
      if (!scrollToField(element, doc) || doc.location.href !== rawUrl ||
          !scan(doc, rawUrl).bindings.some(item => item.key === key && item.element === element)) { skipped.push(key); continue; }
      const prototype = element.tagName === 'SELECT' ? doc.defaultView.HTMLSelectElement.prototype : doc.defaultView.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(element, value);
      element.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
      element.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
      if (element.value === value) filled.push(key); else skipped.push(key);
    }
    return { filled, skipped };
  }

  function currentControls(form, doc) {
    return Array.from(form.querySelectorAll('input, select, textarea')).filter(element =>
      element.type !== 'hidden' && rendered(element, doc));
  }

  function mandatory(element) {
    if (['firstName', 'lastName', 'hasHome1', 'hasHome2', 'sameAddress1', 'sameAddress2', 'applicant1', 'applicant2', 'addressLine1', 'city', 'state', 'zipcode', 'mailingAddressLine1', 'mailingCity', 'mailingState', 'mailingZipcode'].includes(element.id)) return true;
    if (element.required || element.getAttribute('aria-required') === 'true') return true;
    if (Array.from(element.labels || []).some(label => /\*/.test(label.textContent))) return true;
    if (!['checkbox', 'radio'].includes(element.type)) return false;
    const legend = element.closest('fieldset')?.querySelector('legend');
    return Boolean(legend && /\*/.test(legend.textContent));
  }

  function personalIssues(form, doc) {
    const controls = currentControls(form, doc);
    const covered = new Set(), checklist = [];
    let requiredRemaining = 0, manualRemaining = 0;
    for (const [key, definition] of Object.entries(definitions)) {
      const ids = definition.noId ? [definition.id, definition.noId] : [definition.id];
      const present = controls.filter(element => ids.includes(element.id));
      if (!present.length) continue;
      present.forEach(element => covered.add(element));
      const elements = matchingControls(doc, definition);
      const required = definition.type === 'checkbox' ? false : present.some(mandatory);
      const invalid = !elements.length || !elements.every(element => rendered(element, doc)) || elements.some(element => element.matches(':disabled')) ||
        elements.some(element => element.getAttribute('aria-invalid') === 'true' || (element.willValidate && !element.validity.valid && answered(elements, definition)));
      const clearing = !answered(present, definition) && hasDependentAnswers(key, doc);
      let status;
      if (invalid || clearing) { status = 'manual'; manualRemaining++; }
      else if (answered(elements, definition)) status = 'complete';
      else if (required) { status = 'missing'; requiredRemaining++; }
      else status = 'optional';
      checklist.push({ key, label: clearing ? `${definition.label} — review existing dependent answers` : definition.label, status, required,
        fillable: !invalid && !clearing && elements.every(element => editable(element, doc)) && status !== 'complete' });
    }
    const programs = controls.filter(element => element.name === 'programs');
    if (programs.length) {
      const missing = !programs.some(element => element.checked);
      checklist.push({ key: 'programs', label: 'Choose at least one program', status: missing ? 'missing' : 'complete', required: true, fillable: false });
      if (missing) requiredRemaining++;
    }
    const unknown = controls.filter(element => !covered.has(element)).length;
    const expected = ['firstName', 'lastName', 'hasHome1', 'hasHome2', 'applicant1', 'applicant2'];
    const selected = id => form.querySelector(`[id="${id}"]`)?.checked === true;
    if (selected('hasHome1')) expected.push('addressLine1', 'addressLine2', 'city', 'state', 'zipcode', 'sameAddress1', 'sameAddress2');
    if (selected('hasHome2') || selected('sameAddress2')) expected.push('mailingAddressLine1', 'mailingAddressLine2', 'mailingCity', 'mailingState', 'mailingZipcode');
    if (selected('applicant1')) expected.push('medicaid', 'snap', 'tanf');
    if (selected('medicaid')) expected.push('helpPayMedBill1', 'helpPayMedBill2');
    if (selected('snap') || selected('tanf')) expected.push('bestTime');
    const missingCore = expected.some(id => {
      const matches = form.querySelectorAll(`[id="${id}"]`);
      return matches.length !== 1 || !rendered(matches[0], doc);
    });
    const external = Array.from(form.elements).some(element => !form.contains(element));
    const errors = Array.from(form.querySelectorAll('[role="alert"], .error, .errors, .errorMessage')).some(element => rendered(element, doc) && element.textContent.trim());
    if (unknown || missingCore || external || errors) {
      // Never include a page-provided label: it may contain a household member's
      // name or another answer. Unknown controls get one generic attention row.
      manualRemaining += unknown + Number(missingCore) + Number(external) + Number(errors);
      checklist.push({ key: 'manualReview', label: 'Review unrecognized controls or portal errors', status: 'manual', required: true, fillable: false });
    }
    return { requiredRemaining, manualRemaining, checklist };
  }

  function focusField(doc, rawUrl, key) {
    if (!isSupportedUrl(rawUrl) || doc.location.href !== rawUrl || !identifyPage(doc)) return false;
    const definition = definitionFor(key === 'programs' ? 'programMedicaid' : key);
    if (!definition) return false;
    const elements = matchingControls(doc, definition);
    const element = elements.find(item => rendered(item, doc) && !item.matches(':disabled'));
    if (!element || !scrollToField(element, doc) || doc.location.href !== rawUrl || !matchingControls(doc, definition).includes(element)) return false;
    element.focus({ preventScroll: true });
    return doc.activeElement === element;
  }

  // Steps SecondHand never operates. Each maps to a plain instruction for the applicant.
  function protectedStep(doc, headings) {
    const shown = selector => Array.from(doc.querySelectorAll(selector)).some(element => rendered(element, doc));
    if (shown('#captchaDiv, [name="captchaAnswer"], #simpleCaptcha')) return { pageKey: 'iowa-captcha', heading: 'Security check', todo: 'Solve the CAPTCHA, then click Continue.' };
    if (shown('#termChkbox')) return { pageKey: 'iowa-consent', heading: 'Let’s get started', todo: 'Read and accept Iowa’s consent, then click Continue.' };
    if (shown('input[type="password"], #securityCode')) return { pageKey: 'iowa-verification', heading: 'Sign in or verify', todo: 'Sign in or verify in Iowa’s form, then continue.' };
    if (shown('[aria-modal="true"]')) return { pageKey: 'iowa-popup', heading: 'Iowa pop-up', todo: 'Answer Iowa’s pop-up, then continue.' };
    if (headings.some(heading => /\b(signature|certification|attestation|review and submit|submit application|confirmation|terms and conditions)\b/.test(heading))) {
      return { pageKey: 'iowa-protected-step', heading: 'Finish this step yourself', todo: 'Sign or submit in Iowa’s form yourself.' };
    }
    return null;
  }

  function continueButton(doc, onclick) {
    // An information-only screen has no named fields to submit.
    const named = Array.from(doc.querySelectorAll('input, select, textarea')).filter(element =>
      element.type !== 'hidden' && (element.id || element.name) && !element.closest('#languageFormMenu') && rendered(element, doc));
    if (named.length) return null;
    const buttons = Array.from(doc.querySelectorAll('button.saveButton')).filter(button => rendered(button, doc) && normal(button.textContent) === 'continue');
    if (buttons.length !== 1) return null;
    const [button] = buttons;
    if (button.getAttribute('onclick') !== onclick || button.type !== 'button' || button.matches(':disabled') || button.getAttribute('aria-disabled') === 'true' ||
        button.hasAttribute('formaction') || button.hasAttribute('formtarget')) return null;
    return button;
  }

  function probePage(doc, rawUrl) {
    const result = { kind: 'unsupported', pageKey: 'unsupported', heading: 'Unsupported website', reason: 'Open the official Iowa benefits portal.', fields: [], checklist: [], requiredRemaining: 0, manualRemaining: 0 };
    if (!isSupportedUrl(rawUrl)) return result;
    result.kind = 'manual'; result.pageKey = 'iowa-manual'; result.heading = 'Iowa benefits application';
    result.reason = 'Complete this step in Iowa’s form. SecondHand has not verified its controls.';
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3')).filter(element => rendered(element, doc)).map(element => normal(element.textContent));
    const blocked = protectedStep(doc, headings);
    if (blocked) return { ...result, ...blocked, kind: 'blocked', reason: blocked.todo };
    const pageId = identifyPage(doc);
    if (pageId === 'household') {
      const definition = householdDefinitions.householdApplyProg;
      const elements = matchingControls(doc, definition);
      const status = !elements.length || !elements.every(element => rendered(element, doc)) ? 'manual' : answered(elements, definition) ? 'complete' : 'missing';
      return { ...result, kind: 'fillable', pageKey: 'iowa-program-intent', heading: 'Household Application Information', fields: scan(doc, rawUrl).fields,
        checklist: [{ key: 'householdApplyProg', label: definition.label, status, required: true, fillable: status === 'missing' }],
        requiredRemaining: Number(status === 'missing'), manualRemaining: Number(status === 'manual'),
        reason: status === 'complete' ? 'Click Continue in Iowa’s form.' : 'Answer whether anyone is applying, then solve the CAPTCHA.',
        ...(status === 'complete' ? { todo: 'Click Continue in Iowa’s form.' } : {}) };
    }
    if (pageId === 'personal') {
      const scanResult = scan(doc, rawUrl);
      const issues = personalIssues(doc.querySelector(forms.personal), doc);
      return { ...result, ...issues, kind: 'fillable', pageKey: 'iowa-personal-information', heading: 'Enter Personal Information', fields: scanResult.fields,
        todo: 'Check your answers, then click Save and Continue.',
        reason: issues.manualRemaining ? 'Answer the remaining questions and correct any errors in Iowa’s form.' : issues.requiredRemaining ? 'Complete the required applicant fields in Iowa’s form.' : 'Review your answers, then click Save and Continue in Iowa’s form.' };
    }
    const info = headings.map(heading => infoScreens[heading]).find(Boolean);
    if (info) {
      const ready = Boolean(continueButton(doc, info.onclick));
      return { ...result, kind: ready ? 'info' : 'manual', pageKey: info.pageKey, heading: info.heading,
        reason: ready ? 'Information only. SecondHand can continue for you.' : 'Read this page, then click Continue in Iowa’s form.',
        ...(ready ? {} : { todo: 'Read this page, then click Continue in Iowa’s form.' }) };
    }
    const known = [
      ['household application information', 'iowa-program-intent', 'Household Application Information', 'Answer whether anyone is applying, solve the CAPTCHA, then click Continue.'],
      ['assisting organization or person', 'iowa-assistance', 'Assisting Organization or Person', 'If nobody is helping you, leave this blank and click Continue.'],
      ['select address', 'iowa-select-address', 'Select Address', 'Pick the correct address, then click Continue.'],
      ['about you', 'iowa-about-you', 'About you', 'Click Continue in Iowa’s form.']
    ].find(([heading]) => headings.includes(heading));
    if (known) {
      [, result.pageKey, result.heading, result.todo] = known;
      result.reason = result.todo;
      if (result.pageKey === 'iowa-select-address') { result.manualRemaining = 1; result.checklist = [{ key: 'addressReview', label: 'Review and choose the correct address in Iowa’s form', status: 'manual', required: true, fillable: false }]; }
      return result;
    }
    if (headings.includes('welcome')) { result.pageKey = 'iowa-home'; result.heading = 'Welcome'; result.reason = 'Choose Apply for Assistance in Iowa’s portal to begin.'; }
    return result;
  }

  // Clicks the recorded Continue on an information-only screen, once, after re-verifying it.
  function continuePage(doc, rawUrl) {
    const fail = reason => ({ continued: false, reason });
    if (!isSupportedUrl(rawUrl) || doc.location.href !== rawUrl) return fail('The page changed. Check it before continuing.');
    const page = probePage(doc, rawUrl);
    const info = Object.values(infoScreens).find(screen => screen.pageKey === page.pageKey);
    if (page.kind !== 'info' || !info) return fail('This page needs you. Continue in Iowa’s form.');
    const button = continueButton(doc, info.onclick);
    if (!button || !scrollToField(button, doc) || doc.location.href !== rawUrl || continueButton(doc, info.onclick) !== button) return fail('Continue isn’t safely available. Click it in Iowa’s form.');
    try { button.click(); } catch { return fail('Iowa’s Continue button didn’t respond. Click it yourself.'); }
    return { continued: true, reason: 'Continued to the next screen.' };
  }

  // Saved profile fields a page needs, and how they become that page's answers.
  function profileRequest(pageKey) {
    if (pageKey === 'iowa-personal-information') return Object.keys(definitions);
    if (pageKey === 'iowa-program-intent') return [...programKeys];
    return [];
  }
  function pageValues(pageKey, values) {
    if (pageKey === 'iowa-program-intent') return programKeys.some(key => values?.[key] === 'yes') ? { householdApplyProg: 'yes' } : {};
    return pageKey === 'iowa-personal-information' ? values : {};
  }

  const api = Object.freeze({ PORTAL, definitions, isSupportedUrl, rendered, visible, scan, fill, formatValue, focusField, probePage, continuePage, profileRequest, pageValues });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandIowa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
