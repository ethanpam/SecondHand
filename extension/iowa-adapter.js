/* Conservative, fail-closed primary-applicant adapter. No network or storage. */
(function (root) {
  'use strict';
  const PORTAL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
  const addressPolicy = typeof module === 'object' && module.exports ? require('./address-policy.js') : root.SecondHandAddressPolicy;
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
  const pageHeadings = new Set(['enter personal information']);
  const safeSections = new Set([...pageHeadings, "applicant's information", 'contact information', 'address information', 'program information', ...Object.values(questions).map(normal)]);
  const unsafe = /\b(signature|sign here|signing|certification|certify|attestation|attest|password|captcha|verification|security code|one time|username|user name|other people|other members|household members|family members|spouse|child|representative|employer)\b/i;
  const selfQuestions = Object.freeze({
    question01: 'Gender question', question02420: 'Social Security number question', question06179: 'Citizenship question',
    question04: 'Marital status question', question01007331: 'Military service question', question02422: 'Household eating arrangement question',
    question07: 'Disability question', question0565: 'Blindness question'
  });

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

  function matchingControls(doc, definition) {
    const form = doc.querySelector('form#personalInformation[action="enterPersonalInfo"]');
    if (!form) return [];
    const ids = definition.noId ? [definition.id, definition.noId] : [definition.id];
    const controls = ids.map(id => Array.from(doc.querySelectorAll(`[id="${id}"]`)));
    if (controls.some(matches => matches.length !== 1 || !form.contains(matches[0]))) return [];
    const elements = controls.map(matches => matches[0]);
    if (elements.some((element, index) => {
      const names = namesFor(element, doc);
      const expected = definition.type === 'radio' ? [index === 0 ? 'yes' : 'no'] : definition.names;
      const onclick = definition.type === 'radio' ? (definition.handler ? `${definition.handler}('${index === 0 ? 'Yes' : 'No'}');` : null) : (definition.onclick || null);
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
    if (!result.supported) return result;
    if (addressContext(doc, rawUrl)) { result.recognizedPage = true; return result; }
    const self = selfDetailsContext(doc, rawUrl);
    if (self) {
      result.recognizedPage = true;
      if (editable(self.birthDate, doc) && !self.birthDate.value.trim()) {
        result.fields.push({ key: 'birthDate', label: 'Date of birth' });
        result.bindings.push({ key: 'birthDate', element: self.birthDate, elements: [self.birthDate], self: selfDetailsState(self) });
      } else result.skipped++;
      return result;
    }
    if (!identifyPage(doc)) return result;
    result.recognizedPage = true;
    for (const [key, definition] of Object.entries(definitions)) {
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
    if (key === 'birthDate') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(`${value}T00:00:00.000Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || value > new Date().toISOString().slice(0, 10)) return null;
      value = `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
    }
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
    if (originalBindings.some(binding => binding.key === 'birthDate')) return fillSelfDetails(doc, rawUrl, originalBindings, values);
    const filled = [], skipped = [];
    const order = Object.keys(definitions);
    // Only bindings captured in the original rendered-field preview are eligible.
    // Newly revealed fields need a fresh scan/release in the next guided pass.
    for (const binding of [...originalBindings].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))) {
      const fresh = scan(doc, rawUrl);
      const { key, element } = binding;
      const definition = definitions[key];
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
  const navigationSnapshots = new WeakMap();

  // The observed Start Application / Tell Us More page explicitly says these
  // answers describe "yourself". People and later dynamic-question pages share
  // templates, so URL/input IDs alone never establish the recipient.
  function selfDetailsContext(doc, rawUrl) {
    if (rawUrl !== `${PORTAL}/applyForBenefits/dynamicQuestions` || !isSupportedUrl(rawUrl)) return null;
    const forms = doc.querySelectorAll('form#answerSet');
    if (forms.length !== 1) return null;
    const form = forms[0];
    if (form.getAttribute('action') !== 'simple' || form.action !== `${PORTAL}/applyForBenefits/simple` || form.method !== 'post' ||
        form.hasAttribute('onsubmit') || form.hasAttribute('target') || Array.from(form.elements).some(element => !form.contains(element))) return null;
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3')).filter(element => rendered(element, doc));
    if (headings.filter(element => element.tagName === 'H2' && normal(element.textContent) === 'tell us more').length !== 1 ||
        headings.some(element => /\b(signature|certification|attestation|consent|review|submit|confirmation)\b/.test(normal(element.textContent)))) return null;
    if (Array.from(doc.querySelectorAll('[role="dialog"],[aria-modal="true"],input[type="password"],[name="captchaAnswer"],#securityCode,#termChkbox'))
      .some(element => rendered(element, doc))) return null;
    const intro = 'Please give us additional information about yourself. If you cannot answer a question you can skip it.';
    const introductions = Array.from(doc.querySelectorAll('div.fullrow.floatLeft > p')).filter(element => !form.contains(element) &&
      rendered(element, doc) && element.textContent.replace(/\s+/g, ' ').trim().startsWith(intro));
    const active = doc.querySelectorAll('a[title="Start Application | Active"]');
    const people = doc.querySelectorAll('a[title="People | Unvisited"]');
    if (introductions.length !== 1 || active.length !== 1 || people.length !== 1 || !active[0].parentElement.matches('li.current') ||
        !people[0].parentElement.matches('li.next') || !rendered(active[0], doc) || !rendered(people[0], doc)) return null;
    const panels = form.querySelectorAll('div.panel-group');
    if (panels.length !== 1) return null;
    const groups = panels[0].querySelectorAll('div.questionGroup.interviewQuestion');
    if (groups.length !== 2 || !groups[0].classList.contains('peTaxInfoName') || groups[1].classList.contains('peTaxInfoName')) return null;
    const names = groups[0].querySelectorAll('div.medium > h3');
    if (names.length !== 1 || !rendered(names[0], doc) || !names[0].textContent.trim() || names[0].textContent.length > 250) return null;
    const questions = doc.querySelectorAll('[id="question02419"]');
    const inputs = doc.querySelectorAll('[id="answerSets0.answers3.answerValue"]');
    if (questions.length !== 1 || inputs.length !== 1) return null;
    const question = questions[0], birthDate = inputs[0];
    if (!question.matches('.questionAnswer') || question.closest('.disabledQuestion') || !groups[1].contains(question) ||
        !question.querySelector(':scope > div.answer > div.fullrow.flex')?.contains(birthDate) || !rendered(question, doc) || !rendered(birthDate, doc) ||
        birthDate.tagName !== 'INPUT' || birthDate.type !== 'text' || birthDate.name !== 'answerSets[0].answers[3].answerValue' ||
        birthDate.form !== form || form.querySelectorAll('input[name="answerSets[0].answers[3].answerValue"]').length !== 1 ||
        birthDate.title !== 'mm/dd/yyyy' || !birthDate.classList.contains('date-format-class') || !birthDate.classList.contains('hasDatepicker') ||
        birthDate.maxLength !== -1 || birthDate.required || birthDate.hasAttribute('pattern') ||
        Array.from(birthDate.attributes).some(attribute => attribute.name.startsWith('on')) ||
        namesFor(birthDate, doc).join('|') !== 'date of birth (mm/dd/yyyy)') return null;
    // A second rendered birth-date control means the current person/template
    // scope differs from the inspected self-only page.
    const visibleBirthDates = Array.from(form.querySelectorAll('input')).filter(element => rendered(element, doc) &&
      namesFor(element, doc).some(label => /\bdate of birth\b/.test(label)));
    if (visibleBirthDates.length !== 1 || visibleBirthDates[0] !== birthDate) return null;
    return { form, birthDate, question, nameHeading: names[0], group: groups[1], intro: introductions[0], active: active[0], people: people[0] };
  }

  function selfDetailsState(context) {
    return { form: context.form, question: context.question, group: context.group, nameHeading: context.nameHeading,
      nameText: context.nameHeading.textContent, intro: context.intro, introText: context.intro.textContent, active: context.active, people: context.people };
  }

  function fillSelfDetails(doc, rawUrl, bindings, values) {
    const filled = [], skipped = [];
    for (const binding of bindings) {
      const current = () => {
        const context = selfDetailsContext(doc, rawUrl);
        if (!context || doc.location.href !== rawUrl || binding.key !== 'birthDate' || context.birthDate !== binding.element ||
            !binding.self || !editable(context.birthDate, doc) || context.birthDate.value.trim()) return null;
        const state = selfDetailsState(context);
        return Object.keys(state).every(key => state[key] === binding.self[key]) ? context : null;
      };
      const context = current();
      const value = context && Object.hasOwn(values, 'birthDate') ? formatValue('birthDate', values.birthDate, binding.element) : null;
      if (!context || value === null || !scrollToField(binding.element, doc) || !current()) { skipped.push(binding.key); continue; }
      const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLInputElement.prototype, 'value').set;
      setter.call(binding.element, value);
      binding.element.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
      binding.element.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
      if (binding.element.value === value) filled.push('birthDate'); else skipped.push('birthDate');
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
      checklist.push({ key, label: clearing ? `${definition.label}: review existing dependent answers` : definition.label, status, required,
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

  // Only this observed HOME-only layout is actionable. Displayed addresses are
  // used solely for private mutation detection, never for policy or UI output.
  function addressContext(doc, rawUrl) {
    if (!isSupportedUrl(rawUrl) || rawUrl !== `${PORTAL}/applyForBenefits/addressValidation` ||
        !addressPolicy || typeof addressPolicy.decide !== 'function') return null;
    const headings = Array.from(doc.querySelectorAll('h2')).filter(element => rendered(element, doc) && normal(element.textContent) === 'select address');
    const forms = doc.querySelectorAll('form#addressValue');
    if (headings.length !== 1 || forms.length !== 1) return null;
    const form = forms[0];
    if (form.getAttribute('action') !== 'selectedAddress' || form.action !== `${PORTAL}/applyForBenefits/selectedAddress` ||
        form.method !== 'post' || form.hasAttribute('onsubmit') || form.hasAttribute('target') ||
        Array.from(form.elements).some(element => !form.contains(element))) return null;
    if (Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some(element => rendered(element, doc))) return null;
    const bodies = form.querySelectorAll(':scope > div.colWrapper.topMargin > div#alignmentleft.formLayout.alignmentLeft > table > tbody > tr > td > table.fullwidth > tbody');
    if (bodies.length !== 1 || doc.querySelectorAll('[id="alignmentleft"]').length !== 1) return null;
    const tbody = bodies[0], rows = Array.from(tbody.children);
    const text = element => String(element.textContent || '').replace(/\s+/g, ' ').trim();
    const rowText = (row, expected) => row && row.tagName === 'TR' && !row.querySelector('input,select,textarea,button') && text(row) === expected;
    const separator = row => rowText(row, '') && !row.id;
    if (!rowText(rows[0], 'Possible matches for your home address:')) return null;
    const originals = rows.map((row, index) => rowText(row, 'Your Home address as you entered is:') ? index : -1).filter(index => index >= 0);
    if (originals.length !== 1) return null;
    const originalStart = originals[0], radios = [], labels = [], countyRows = [];
    let originalCounty = null;
    function choice(row, county, index, original) {
      if (!row || row.tagName !== 'TR' || !county || county.id !== `homeAddrCounty${index}` ||
          !county.classList.contains('displayNone') || doc.querySelectorAll(`[id="homeAddrCounty${index}"]`).length !== 1) return false;
      const fields = row.querySelectorAll(':scope > td > fieldset');
      if (fields.length !== 1 || row.querySelectorAll('fieldset').length !== 1) return false;
      const fieldset = fields[0];
      const legends = fieldset.querySelectorAll(':scope > legend');
      if (legends.length !== 1 || text(legends[0]) !== 'applyforBenefits.legend.linkText1') return false;
      const controls = row.querySelectorAll('input,select,textarea,button');
      if (controls.length !== 1) return false;
      const radio = controls[0], id = `homeAddressIndex${index}`;
      if (radio.tagName !== 'INPUT' || radio.id !== id || doc.querySelectorAll(`[id="${id}"]`).length !== 1 || radio.type !== 'radio' ||
          radio.name !== 'homeAddressIndex' || radio.getAttribute('value') !== String(index) || radio.value !== String(index) ||
          radio.getAttribute('onclick') !== `onHomeAddrSelect('${index}');` || radio.hasAttribute('onchange') ||
          !editable(radio, doc) || radio.getAttribute('aria-invalid') === 'true') return false;
      const associated = Array.from(radio.labels || []);
      if (associated.length !== 1 || associated[0].getAttribute('for') !== id || !fieldset.contains(associated[0]) ||
          associated[0].querySelectorAll(':scope > div').length !== 1 || associated[0].querySelector('input,select,textarea,button') ||
          !text(associated[0]) || associated[0].textContent.length > 2000 || !rendered(associated[0], doc)) return false;
      const countyControls = county.querySelectorAll('input,select,textarea,button');
      if (original) {
        if (countyControls.length !== 1) return false;
        const select = countyControls[0];
        if (select.tagName !== 'SELECT' || select.type !== 'select-one' || select.id !== `homeAddressLst${index}.county` ||
            select.name !== `homeAddressLst[${index}].county` || doc.querySelectorAll(`[id="${select.id}"]`).length !== 1 ||
            rendered(select, doc) || namesFor(select, doc).join('|') !== 'county') return false;
        originalCounty = select;
      } else if (countyControls.length || text(county)) return false;
      radios.push(radio); labels.push(associated[0]); countyRows.push(county);
      return true;
    }
    let position = 1;
    while (position < originalStart) {
      if (separator(rows[position])) { position++; continue; }
      if (radios.length >= 8 || !choice(rows[position], rows[position + 1], radios.length, false)) return null;
      position += 2;
    }
    if (position !== originalStart || !radios.length) return null;
    const candidateCount = radios.length;
    if (!choice(rows[originalStart + 1], rows[originalStart + 2], candidateCount, true) ||
        rows.slice(originalStart + 3).some(row => !separator(row))) return null;
    if (form.querySelectorAll('input[name="homeAddressIndex"]').length !== radios.length || radios.filter(radio => radio.checked).length > 1) return null;
    const allowed = new Set([...radios, originalCounty]);
    const unknownControls = Array.from(form.querySelectorAll('input,select,textarea')).some(element => element.type !== 'hidden' && !allowed.has(element)) ||
      Boolean(form.querySelector('[contenteditable]:not([contenteditable="false"])'));
    const errors = Array.from(form.querySelectorAll('#selectMailingAddrError,#selectPhysicalAddrError,#errorMsg,#errorMsgHome,#errorMsgMail,[role="alert"],.error,.errors,.errorMessage,[aria-invalid="true"]'))
      .some(element => rendered(element, doc) && (text(element) || element.getAttribute('aria-invalid') === 'true'));
    const warnings = Array.from(form.querySelectorAll('.warning,.warnings')).some(element => rendered(element, doc) && text(element));
    const decision = addressPolicy.decide({ scope: 'home', candidates: radios.slice(0, candidateCount).map((radio, index) => ({ id: radio.id, index, role: 'suggestion' })),
      hasErrors: Boolean(errors), hasWarnings: Boolean(warnings), hasUnknownControls: unknownControls });
    if (!decision.eligible) return null;
    const buttons = Array.from(form.querySelectorAll('button')).filter(button => normal(button.textContent) === 'save and continue');
    if (buttons.length !== 1) return null;
    const button = buttons[0];
    if (button.type !== 'button' || !['btn', 'btn-primary', 'saveAndContinueButton'].every(name => button.classList.contains(name)) ||
        button.getAttribute('onclick') !== 'submitForm();' || !editable(button, doc) || button.getAttribute('aria-disabled') === 'true' ||
        ['formaction', 'formtarget', 'formnovalidate', 'formmethod', 'formenctype'].some(name => button.hasAttribute(name)) ||
        (button.hasAttribute('form') && button.getAttribute('form') !== form.id)) return null;
    // Only the observed Back and hidden modal buttons may accompany Next.
    const unfamiliarButton = Array.from(form.querySelectorAll('button,input[type="button"],input[type="submit"],input[type="reset"]')).some(other => {
      if (other === button) return false;
      if (other.closest('#simplemodal.modal.fade[role="dialog"]') && !rendered(other, doc)) return false;
      return other.tagName !== 'BUTTON' || other.type !== 'button' || normal(other.textContent) !== 'back' ||
        other.getAttribute('onclick') !== "submitUrlLink('enterPersonalInfo?enterPersonalInfo=true');return false;";
    });
    if (unfamiliarButton) return null;
    return { kind: 'address', form, button, first: radios[decision.candidateIndex], radios, labels, countyRows, tbody, candidateCount };
  }

  function addressState(context) {
    return { tbody: context.tbody, radios: [...context.radios], labels: context.labels.map(element => ({ element, text: element.textContent })),
      countyRows: [...context.countyRows], hidden: Array.from(context.form.querySelectorAll('input[type="hidden"]')).map(element => ({ element, id: element.id, name: element.name, value: element.value })) };
  }

  function sameAddressState(before, context) {
    const after = addressState(context);
    return before.tbody === after.tbody && ['radios', 'countyRows'].every(key => before[key].length === after[key].length && before[key].every((element, index) => element === after[key][index])) &&
      ['labels', 'hidden'].every(key => before[key].length === after[key].length && before[key].every((state, index) => Object.keys(state).every(name => state[name] === after[key][index][name])));
  }

  function focusField(doc, rawUrl, key) {
    if (!isSupportedUrl(rawUrl) || doc.location.href !== rawUrl) return false;
    if (key === 'birthDate') {
      const self = selfDetailsContext(doc, rawUrl);
      if (!self || !editable(self.birthDate, doc) || !scrollToField(self.birthDate, doc) || selfDetailsContext(doc, rawUrl)?.birthDate !== self.birthDate) return false;
      self.birthDate.focus({ preventScroll: true });
      return doc.activeElement === self.birthDate;
    }
    if (key === 'addressReview') {
      const address = addressContext(doc, rawUrl);
      if (!address || !scrollToField(address.first, doc) || !addressContext(doc, rawUrl)) return false;
      address.first.focus({ preventScroll: true });
      return doc.activeElement === address.first;
    }
    if (!identifyPage(doc)) return false;
    const definition = definitions[key === 'programs' ? 'programMedicaid' : key];
    if (!definition) return false;
    const elements = matchingControls(doc, definition);
    const element = elements.find(item => rendered(item, doc) && !item.matches(':disabled'));
    if (!element || !scrollToField(element, doc) || doc.location.href !== rawUrl || !matchingControls(doc, definition).includes(element)) return false;
    element.focus({ preventScroll: true });
    return doc.activeElement === element;
  }

  function navigationButton(doc, rawUrl) {
    const address = addressContext(doc, rawUrl);
    if (address) return address;
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
    const result = { kind: 'unsupported', pageKey: 'unsupported', heading: 'Unsupported website', reason: 'Open the official Iowa benefits portal.', canAdvance: false, fields: [], checklist: [], requiredRemaining: 0, manualRemaining: 0 };
    if (!isSupportedUrl(rawUrl)) return result;
    result.kind = 'manual'; result.pageKey = 'iowa-manual'; result.heading = 'Iowa benefits application';
    result.reason = 'Complete this step in Iowa’s form. SecondHand has not verified its controls.';
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3')).filter(element => rendered(element, doc)).map(element => normal(element.textContent));
    if (Array.from(doc.querySelectorAll('input[type="password"], [name="captchaAnswer"], #securityCode, #termChkbox, [aria-modal="true"], [role="dialog"]')).some(element => rendered(element, doc)) ||
        headings.some(heading => /\b(signature|certification|attestation|review and submit|submit application|confirmation|terms and conditions)\b/.test(heading))) {
      return { ...result, kind: 'blocked', pageKey: 'iowa-protected-step', heading: 'Finish this step yourself', reason: 'Account access, verification, consent, signatures, and final submission must be completed directly in Iowa’s portal.' };
    }
    if (headings.includes('select address')) {
      const address = addressContext(doc, rawUrl);
      return { ...result, kind: address ? 'fillable' : 'manual', pageKey: 'iowa-select-address', heading: 'Select Address',
        canAdvance: Boolean(address), manualRemaining: address ? 0 : 1,
        checklist: [{ key: 'addressReview', label: 'First suggested home address', status: address ? (address.first.checked ? 'complete' : 'missing') : 'manual', required: true, fillable: false }],
        reason: address ? 'Next selects Iowa’s first suggested home address and saves this step. Review the selected address before final submission.' : 'Review this address step in Iowa’s form. The expected home suggestions could not be verified, or another address question or error needs attention.' };
    }
    const self = selfDetailsContext(doc, rawUrl);
    if (self) {
      const fields = scan(doc, rawUrl).fields;
      const checklist = [{ key: 'birthDate', label: 'Date of birth', status: self.birthDate.value.trim() ? 'complete' : editable(self.birthDate, doc) ? 'optional' : 'manual', required: false, fillable: fields.length === 1 }];
      for (const [id, label] of Object.entries(selfQuestions)) {
        const group = self.form.querySelector(`[id="${id}"]`);
        if (group && rendered(group, doc)) checklist.push({ key: `self-${id}`, label, status: 'manual', required: false, fillable: false });
      }
      checklist.push({ key: 'selfDetailsReview', label: 'Review the remaining questions and continue in Iowa’s form', status: 'manual', required: false, fillable: false });
      return { ...result, kind: 'fillable', pageKey: 'iowa-self-details', heading: 'Tell Us More', fields, checklist,
        manualRemaining: checklist.filter(item => item.status === 'manual').length, canAdvance: false,
        reason: 'SecondHand can fill your saved date of birth on this verified self-information page. Review and answer the other questions, then choose Save and Continue directly in Iowa’s form.' };
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
      buttonType: next.button.type, onclick: next.button.getAttribute('onclick'), address: next.kind === 'address' ? addressState(next) : null });
    return token;
  }

  function advance(doc, rawUrl, token) {
    const original = token && navigationSnapshots.get(token);
    if (token) navigationSnapshots.delete(token);
    const fail = reason => ({ advanced: false, reason });
    if (!original || original.doc !== doc || original.url !== rawUrl || doc.location.href !== rawUrl || original.expires < Date.now()) return fail('The page changed or the Next preview expired. Check this page again.');
    const page = probePage(doc, rawUrl), next = navigationButton(doc, rawUrl);
    if (!page.canAdvance || !next || next.form !== original.form || next.button !== original.button ||
        next.button.type !== original.buttonType || next.button.getAttribute('onclick') !== original.onclick || !sameControlState(original.controls, next.form) ||
        (original.address && (!next.first || !sameAddressState(original.address, next)))) return fail('The page or an answer changed. Review it and check again before Next.');
    if (original.address) {
      const unchanged = expected => {
        const fresh = addressContext(doc, rawUrl);
        return doc.location.href === rawUrl && fresh && fresh.form === original.form && fresh.button === original.button &&
          sameAddressState(original.address, fresh) && sameControlState(expected, fresh.form) && probePage(doc, rawUrl).canAdvance;
      };
      let expected = original.controls;
      if (!next.first.checked) {
        if (!scrollToField(next.first, doc) || !unchanged(expected)) return fail('The address choice changed or is not safely accessible. Check this page again.');
        try { next.first.click(); }
        catch { return fail('The first address suggestion could not be selected. Review Iowa’s form.'); }
        expected = original.controls.map(state => next.radios.includes(state.element) ? { ...state, checked: state.element === next.first } : state);
      }
      if (!next.first.checked || !unchanged(expected) || !scrollToField(next.button, doc) || !unchanged(expected)) return fail('The address page changed after selection. Review it before continuing.');
      try { next.button.click(); }
      catch { return fail('Iowa’s Next control could not be activated. Check the page before trying again.'); }
      return { advanced: true, reason: 'The first suggested home address was selected and Next was clicked once. Review the address before final submission.' };
    }
    if (!scrollToField(next.button, doc) || doc.location.href !== rawUrl || !probePage(doc, rawUrl).canAdvance || !sameControlState(original.controls, next.form)) return fail('The Next button is not safely accessible. Continue in Iowa’s form.');
    try { next.button.click(); }
    catch { return fail('Iowa’s Next control could not be activated. Check the page before trying again.'); }
    return { advanced: true, reason: 'Next was clicked once. Check the following page for required questions or errors.' };
  }

  // The worker uses only this union's keys for its explicit desktop grant. Each
  // page still uses its own exact selectors and recipient checks internally.
  const supportedDefinitions = Object.freeze({ ...definitions, birthDate: Object.freeze({ label: 'Date of birth' }) });
  const api = Object.freeze({ PORTAL, definitions: supportedDefinitions, isSupportedUrl, rendered, visible, scan, fill, formatValue, focusField, probePage, captureNavigation, advance });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandIowa = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
