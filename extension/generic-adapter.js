/* Rules-based adapter for food-assistance forms on sites the applicant approved.
   Fills only confident matches, never overwrites an answer, and never touches
   passwords, payment cards, files, or CAPTCHAs. No network or storage. */
(function (root) {
  'use strict';
  // Saved profile fields a general site may receive, plus answers derived from them.
  const PROFILE_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'suffix', 'birthDate', 'ssn', 'email', 'mobilePhone', 'homePhone', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors',
    'householdVeteran', 'householdDisability', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'monthlyRent', 'monthlyUtilities']);
  const SOURCES = Object.freeze({ fullName: ['firstName', 'lastName'], phone: ['mobilePhone', 'homePhone', 'phone'],
    totalMonthlyIncome: ['monthlyEarnedIncome', 'monthlyOtherIncome'], annualIncome: ['monthlyEarnedIncome', 'monthlyOtherIncome'] });
  const GENERIC_KEYS = Object.freeze(['firstName', 'middleName', 'lastName', 'fullName', 'suffix', 'birthDate', 'ssn', 'email', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip', 'county', 'householdSize', 'householdAdults', 'householdChildren', 'householdSeniors',
    'householdVeteran', 'householdDisability', 'totalMonthlyIncome', 'annualIncome', 'monthlyRent', 'monthlyUtilities']);
  const KIND = Object.freeze({ birthDate: 'date', email: 'email', phone: 'tel', state: 'state', householdSize: 'count', householdAdults: 'count',
    householdChildren: 'count', householdSeniors: 'count', householdVeteran: 'yesno', householdDisability: 'yesno', totalMonthlyIncome: 'money',
    annualIncome: 'money', monthlyRent: 'money', monthlyUtilities: 'money' });
  const AUTOCOMPLETE = Object.freeze({ 'given-name': 'firstName', 'additional-name': 'middleName', 'family-name': 'lastName', name: 'fullName',
    'honorific-suffix': 'suffix', email: 'email', tel: 'phone', 'tel-national': 'phone', 'street-address': 'addressLine1', 'address-line1': 'addressLine1',
    'address-line2': 'addressLine2', 'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'zip', bday: 'birthDate' });
  // Anchored phrases only: a question must say what it asks, not merely mention a word.
  const RULES = [
    [/^(first|given) name$|^first$/, 'firstName'],
    [/^middle (name|initial)$/, 'middleName'],
    [/^(last|family|sur) ?name$|^last$/, 'lastName'],
    [/^(full |legal |applicant )?name$|^((parents?|guardians?)( (or )?(parents?|guardians?))? )?(first (and )?last|full) name$|^name of (the )?head of household$|^head of household name$/, 'fullName'],
    [/^(date of birth|birth ?date|dob|birthday)( mm dd yyyy)?$/, 'birthDate'],
    [/^(social security( number)?|ssn)$/, 'ssn'],
    [/^e ?mail( address)?$/, 'email'],
    [/^((cell|mobile|home|best|primary) )?(phone|telephone)( number)?$|^(mobile|cell) number$/, 'phone'],
    [/^(street |home )?address( line 1)?$|^street$/, 'addressLine1'],
    [/^address line 2$|^(apt|apartment|unit|suite)( number| or unit)?$|^apt suite$/, 'addressLine2'],
    [/^(city|town)$/, 'city'],
    [/^state( province)?$/, 'state'],
    [/^(zip|zip code|zipcode|postal code)$/, 'zip'],
    [/^county$/, 'county'],
    [/^(household size|family size|size of (your )?household|(number of |total )?(people|persons|members) in (your )?household|how many people (live|are) in (your )?household|(total )?household members)$/, 'householdSize'],
    [/^((number of|how many) )?adults( in (your )?household)?( 18 64| 18 to 64)?$/, 'householdAdults'],
    [/^((number of|how many) )?(children|kids)( in (your )?household)?( under 18| 0 17)?$/, 'householdChildren'],
    [/^((number of|how many) )?(seniors|older adults)( in (your )?household)?( 65\+| 65| 60\+)?$/, 'householdSeniors'],
    [/^(is )?anyone in (your |the )?household a (military )?veteran$|^veteran( status)?$/, 'householdVeteran'],
    [/^(does )?anyone in (your |the )?household (have|has) a disability$|^disability$/, 'householdDisability'],
    [/^(total )?(gross )?monthly (household )?income$|^(total )?household income per month$/, 'totalMonthlyIncome'],
    [/^(total )?(gross )?(annual|yearly) (household )?income$|^(total )?household income per year$/, 'annualIncome'],
    [/^(monthly )?(rent|mortgage|rent or mortgage)( payment| amount)?$/, 'monthlyRent'],
    [/^(monthly )?utilit(y|ies)( costs?| bills?)?$/, 'monthlyUtilities']
  ];
  const NAME_HINTS = Object.freeze({ fname: 'first name', firstname: 'first name', lname: 'last name', lastname: 'last name', dob: 'date of birth',
    zipcode: 'zip code', postalcode: 'postal code', hhsize: 'household size', tel: 'phone', telephone: 'phone', email: 'email', zip: 'zip', city: 'city', state: 'state' });
  const STATES = Object.freeze({ AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
    DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky',
    LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
    NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio',
    OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
    VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming' });
  const SKIP_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'image', 'reset', 'color', 'range']);
  const UNSAFE = /\b(password|passcode|pin|cvv|cvc|card number|credit card|debit card|expiration|expiry|security code|captcha|verification code|one time)\b/;
  const LEAD = /^(what is|whats|please enter|please provide|enter|provide|your|the)\s+/;

  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().replace(/[\s*:]+$/, '').trim();
  // "#" reads as "number" ("# of adults", "Apt #").
  const normal = value => String(value || '').toLowerCase().replace(/[‘’']/g, '').replace(/#/g, ' number ').replace(/\*/g, ' ').replace(/[^a-z0-9+]+/g, ' ').trim();
  // A question number or letter the author added ("3.", "4)", "b. ") is not part of the question.
  const QUESTION_NUMBER = /^\s*(\d{1,3}\s*[.)]|[a-z][.)](?=\s))\s*/i;
  // An aside in parentheses ("(First and Last Name)") is dropped, unless it holds numbers
  // (age bands like "(0-5)") or points at someone other than the applicant ("(spouse)").
  const OTHER_PERSON = /\b(child|children|kids?|spouse|partner|husband|wife|emergency|contact|pet|landlord|employer|other|previous|former|maiden|alternate|second|secondary|work|business)\b/i;
  const aside = (text, inner) => /\d/.test(inner) || OTHER_PERSON.test(inner) ? text : ' ';
  function question(value) {
    const words = String(value || '').replace(/([a-z])([A-Z][a-z])/g, '$1 $2').replace(QUESTION_NUMBER, '').replace(/\(([^()]*)\)/g, aside);
    let text = normal(words).replace(/ (required|optional)$/, '');
    for (let previous = ''; previous !== text;) { previous = text; text = text.replace(LEAD, ''); }
    return text;
  }
  const ruleFor = text => RULES.find(([pattern]) => pattern.test(question(text)))?.[1] || null;

  function rendered(element) {
    const win = element.ownerDocument.defaultView;
    if (!win || !element.isConnected) return false;
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    const rect = element.getBoundingClientRect();
    return Boolean(element.getClientRects().length && rect.width > 0 && rect.height > 0);
  }
  function textWithoutControls(node) {
    const copy = node.cloneNode(true);
    copy.querySelectorAll('input, select, textarea, button, script, style').forEach(control => control.remove());
    return clean(copy.textContent);
  }
  function idsText(doc, ids) { return clean(String(ids || '').split(/\s+/).filter(Boolean).map(id => doc.getElementById(id)?.textContent || '').join(' ')); }
  // Short visible text just before a control or group, for forms without <label>.
  function precedingText(node) {
    for (let ancestor = node, depth = 0; ancestor && depth < 3; ancestor = ancestor.parentElement, depth++) {
      for (let sibling = ancestor.previousElementSibling, steps = 0; sibling && steps < 2; sibling = sibling.previousElementSibling, steps++) {
        if (sibling.matches('input, select, textarea, button') || sibling.querySelector('input, select, textarea')) break;
        const text = textWithoutControls(sibling);
        if (text && text.length <= 150) return text;
      }
    }
    return '';
  }
  function labelsFor(element, doc) {
    const candidates = [idsText(doc, element.getAttribute('aria-labelledby')), clean(element.getAttribute('aria-label')),
      ...Array.from(element.labels || [], textWithoutControls), clean(element.getAttribute('placeholder'))];
    const present = candidates.filter(Boolean);
    return present.length ? present : [precedingText(element)].filter(Boolean);
  }
  function groupQuestion(elements, doc) {
    const first = elements[0];
    const container = first.closest('fieldset, [role="radiogroup"], [role="group"]');
    const candidates = [];
    if (container) {
      candidates.push(textWithoutControls(container.querySelector('legend') || doc.createElement('i')), idsText(doc, container.getAttribute('aria-labelledby')), clean(container.getAttribute('aria-label')));
      if (!candidates.some(Boolean)) candidates.push(precedingText(container));
    } else candidates.push(precedingText(first.closest('label') || first));
    return candidates.filter(Boolean);
  }
  function eligible(element) {
    const type = (element.type || '').toLowerCase();
    const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase();
    if (!element.matches('input, select, textarea') || SKIP_TYPES.has(type) || /(^|\s)cc-|one-time-code|password/.test(autocomplete)) return false;
    if (element.disabled || element.readOnly || !rendered(element)) return false;
    const identity = normal(`${element.name || ''} ${element.id || ''} ${Array.from(element.labels || [], label => label.textContent).join(' ')} ${element.getAttribute('aria-label') || ''}`);
    return !UNSAFE.test(identity);
  }
  const optionText = element => clean(Array.from(element.labels || [], textWithoutControls).join(' ') || element.getAttribute('aria-label') || element.value);
  const answered = entry => entry.kind === 'radio' || entry.kind === 'checkbox' ? entry.elements.some(element => element.checked)
    : entry.kind === 'select' ? Boolean(entry.elements[0].value) : Boolean(String(entry.elements[0].value || '').trim());
  function kindOf(element) {
    if (element.tagName === 'SELECT') return 'select';
    if (element.tagName === 'TEXTAREA') return 'textarea';
    return element.type === 'radio' ? 'radio' : element.type === 'checkbox' ? 'checkbox' : 'input';
  }
  function optionsOf(entry) {
    // A select's empty-value entry is a placeholder ("Choose one"), not an answer.
    if (entry.kind === 'select') return Array.from(entry.elements[0].options).filter(option => option.value).map(option => clean(option.textContent) || option.value);
    if (entry.kind === 'radio' || (entry.kind === 'checkbox' && entry.elements.length > 1)) return entry.elements.map(optionText);
    return [];
  }
  const isYesNo = options => options.some(option => /^yes\b/.test(normal(option))) && options.some(option => /^no\b/.test(normal(option)));
  const isNumeric = options => options.length > 0 && options.every(option => /^\d+\+?$|^\d+ or more$/.test(normal(option)));
  // A key is only placed on a control that can hold its kind of answer.
  function compatible(key, entry) {
    const kind = KIND[key] || 'text';
    const type = (entry.elements[0].type || 'text').toLowerCase();
    const options = optionsOf(entry);
    if (kind === 'yesno') return (entry.kind === 'radio' || entry.kind === 'select') ? isYesNo(options) : entry.kind === 'checkbox' && entry.elements.length === 1;
    if (kind === 'count') return (entry.kind === 'input' && ['number', 'text', 'tel', ''].includes(type)) || ((entry.kind === 'select' || entry.kind === 'radio') && isNumeric(options.filter(option => normal(option))));
    if (kind === 'state') return entry.kind === 'select' || (entry.kind === 'input' && type === 'text');
    if (kind === 'date') return entry.kind === 'input' && ['date', 'text', ''].includes(type);
    if (kind === 'email') return entry.kind === 'input' && ['email', 'text'].includes(type);
    if (kind === 'tel') return entry.kind === 'input' && ['tel', 'text'].includes(type);
    if (kind === 'money') return entry.kind === 'input' && ['number', 'text', ''].includes(type);
    return entry.kind === 'textarea' || (entry.kind === 'input' && ['text', 'search', ''].includes(type));
  }
  function match(entry) {
    const element = entry.elements[0];
    const tokens = String(element.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).reverse();
    const auto = tokens.map(token => AUTOCOMPLETE[token]).find(Boolean);
    if (auto && compatible(auto, entry)) return { key: auto, confidence: 'high' };
    for (const text of entry.labels) {
      const key = ruleFor(text);
      if (key && compatible(key, entry)) return { key, confidence: 'high' };
    }
    const hint = normal(`${element.name || ''}`.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\[[^\]]*\]$/, '')) || normal(element.id || '');
    const key = ruleFor(NAME_HINTS[hint.replace(/ /g, '')] || hint);
    if (key && compatible(key, entry)) return { key, confidence: entry.labels.length ? 'medium' : 'high' };
    return { key: null, confidence: null };
  }

  let current = null;
  let sequence = 0;
  function scan(doc) {
    const entries = [];
    const groups = new Map();
    for (const element of doc.querySelectorAll('input, select, textarea')) {
      if (!eligible(element)) continue;
      const kind = kindOf(element);
      if ((kind === 'radio' || kind === 'checkbox') && element.name) {
        const groupKey = `${kind}|${element.form ? Array.from(doc.forms).indexOf(element.form) : -1}|${element.name}`;
        if (groups.has(groupKey)) { groups.get(groupKey).elements.push(element); continue; }
        const entry = { kind, elements: [element] };
        groups.set(groupKey, entry); entries.push(entry);
      } else entries.push({ kind, elements: [element] });
    }
    for (const entry of entries) {
      const grouped = entry.kind === 'radio' || (entry.kind === 'checkbox' && entry.elements.length > 1);
      entry.labels = grouped ? groupQuestion(entry.elements, doc) : labelsFor(entry.elements[0], doc);
    }
    return entries.filter(entry => !answered(entry));
  }

  function plan(doc) {
    const token = `plan-${Date.now().toString(36)}-${++sequence}`;
    const map = new Map();
    const matched = [], unmatched = [];
    scan(doc).forEach((entry, index) => {
      const id = `sh-${sequence}-${index}`;
      map.set(id, entry);
      const result = match(entry);
      if (result.confidence === 'high') { matched.push({ id, key: result.key, confidence: 'high' }); return; }
      const first = entry.elements[0];
      unmatched.push({ id, label: entry.labels[0] || '', type: entry.kind === 'input' ? (first.type || 'text') : entry.kind, options: optionsOf(entry),
        required: entry.elements.some(element => element.required || element.getAttribute('aria-required') === 'true') || /\*\s*$/.test(entry.labels.join(' ')) });
    });
    current = { token, doc, map };
    return { token, matched, unmatched };
  }

  function requestKeys(keys) {
    return [...new Set((Array.isArray(keys) ? keys : []).flatMap(key => SOURCES[key] || [key]))].filter(key => PROFILE_KEYS.includes(key));
  }
  const cents = value => /^\d{1,8}(\.\d{1,2})?$/.test(String(value || '')) ? Math.round(Number(value) * 100) : null;
  const dollars = amount => amount % 100 ? (amount / 100).toFixed(2) : String(amount / 100);
  function deriveValues(values) {
    const result = { ...(values || {}) };
    if (result.firstName && result.lastName) result.fullName = `${result.firstName} ${result.lastName}`;
    const phone = values?.mobilePhone || values?.homePhone || values?.phone;
    if (phone) result.phone = phone; else delete result.phone;
    const earned = cents(values?.monthlyEarnedIncome), other = cents(values?.monthlyOtherIncome);
    // A total is only offered when both parts are known; a partial sum would understate income.
    if (earned !== null && other !== null) { result.totalMonthlyIncome = dollars(earned + other); result.annualIncome = dollars((earned + other) * 12); }
    return result;
  }

  function setValue(element, value) {
    const win = element.ownerDocument.defaultView;
    const prototype = element.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new win.Event('input', { bubbles: true }));
    element.dispatchEvent(new win.Event('change', { bubbles: true }));
    return element.value === value;
  }
  function chooseOption(options, key, value) {
    const wanted = normal(value);
    if (KIND[key] === 'yesno') return options.findIndex(option => new RegExp(`^${wanted}\\b`).test(normal(option)));
    if (key === 'state') return options.findIndex(option => [wanted, normal(STATES[String(value).toUpperCase()])].includes(normal(option)));
    if (KIND[key] === 'count') {
      const exact = options.findIndex(option => normal(option) === wanted);
      if (exact >= 0) return exact;
      let best = -1, bestFloor = -1;
      options.forEach((option, index) => { const floor = /^(\d+)(\+| or more)$/.exec(normal(option)); if (floor && Number(floor[1]) <= Number(value) && Number(floor[1]) > bestFloor) { best = index; bestFloor = Number(floor[1]); } });
      return best;
    }
    return options.findIndex(option => normal(option) === wanted);
  }
  function formatted(key, value, element) {
    const text = String(value);
    if (key === 'birthDate') {
      const [year, month, day] = text.split('-');
      return element.type === 'date' ? text : `${month}/${day}/${year}`;
    }
    if (key === 'phone') {
      const digits = text.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : text;
    }
    return text;
  }
  function fillEntry(entry, key, value) {
    const first = entry.elements[0];
    if (entry.kind === 'input' || entry.kind === 'textarea') {
      const text = formatted(key, value, first);
      if (first.maxLength > 0 && text.length > first.maxLength) return false;
      return setValue(first, text);
    }
    if (entry.kind === 'select') {
      const options = Array.from(first.options);
      // A state select may use codes ("IA") or names ("Iowa") as values.
      let index = key === 'state' ? options.findIndex(option => normal(option.value) === normal(value)) : -1;
      if (index < 0) index = chooseOption(options.map(option => clean(option.textContent) || option.value), key, value);
      const target = options[index];
      return Boolean(target && target.value) && setValue(first, target.value);
    }
    if (entry.kind === 'radio') {
      const index = chooseOption(entry.elements.map(optionText), key, value);
      if (index < 0) return false;
      entry.elements[index].click();
      return entry.elements[index].checked;
    }
    if (entry.kind === 'checkbox' && entry.elements.length === 1 && KIND[key] === 'yesno') {
      if (value !== 'yes') return false;
      first.click();
      return first.checked;
    }
    return false;
  }
  function ensureStyle(doc) {
    if (doc.getElementById('secondhand-filled-style')) return;
    const style = doc.createElement('style');
    style.id = 'secondhand-filled-style';
    style.textContent = '[data-secondhand-filled="rule"]{outline:2px solid #5f9b62!important;outline-offset:1px!important}[data-secondhand-filled="guess"]{outline:2px dashed #d99a2b!important;outline-offset:1px!important}';
    (doc.head || doc.documentElement).append(style);
  }
  function fillFields(doc, token, assignments, values) {
    const ids = (Array.isArray(assignments) ? assignments : []).map(item => item?.id);
    if (!current || current.token !== token || current.doc !== doc) return { ok: false, filled: [], skipped: ids };
    const filled = [], skipped = [];
    for (const assignment of assignments) {
      const entry = current.map.get(assignment?.id);
      const key = assignment?.key;
      const value = values?.[key];
      if (!entry || !GENERIC_KEYS.includes(key) || typeof value !== 'string' || !value || answered(entry) || !entry.elements.every(element => element.isConnected && eligible(element)) || !compatible(key, entry) || !fillEntry(entry, key, value)) {
        skipped.push(assignment?.id); continue;
      }
      ensureStyle(doc);
      entry.elements.forEach(element => element.setAttribute('data-secondhand-filled', assignment.guessed ? 'guess' : 'rule'));
      filled.push(assignment.id);
    }
    return { ok: true, filled, skipped };
  }
  function focusField(doc, id) {
    const entry = current && current.doc === doc ? current.map.get(id) : null;
    const element = entry?.elements[0];
    if (!element || !element.isConnected || !rendered(element)) return false;
    if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.focus({ preventScroll: true });
    return doc.activeElement === element;
  }
  const elementFor = id => current?.map.get(id)?.elements[0] || null;

  const api = Object.freeze({ GENERIC_KEYS, PROFILE_KEYS, plan, requestKeys, deriveValues, fillFields, focusField, elementFor });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandGeneric = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
