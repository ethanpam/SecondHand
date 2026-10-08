/* Exact observed Iowa emergency/background scalar pages. No network, storage, or model. */
(function (root) {
  'use strict';
  const PORTAL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
  const norm = text => String(text || '').replace(/\s+/g, ' ').trim();
  const LANGUAGES = ['English', 'Afghani', 'American Sign Language', 'Amharic', 'Arabic', 'Aramic', 'Armenian', 'Assyrian', 'Bengali', 'Bosnian', 'Cambodian', 'Cantonese (Chinese)', 'Croatian', 'Egyptian', 'Farsi', 'French', 'German', 'Greek', 'Hebrew', 'Hindi', 'Hmong', 'Ilacano', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Lao', 'Mandarin (Chinese)', 'Mien', 'Other Chinese Language', 'Other Non-English', 'Other Sign Language', 'Persian', 'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Samoan', 'Serbian', 'Spanish', 'Tagalog, Filipino', 'Thai', 'Turkish', 'Urdu', 'Vietnamese'];
  const STATES = [['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming']];
  const RACES = ['American Indian or Alaskan Native', 'Asian', 'Black or African American', 'Hispanic or Latino', 'Native Hawaiian or Other Pacific Islander', 'White', 'Unknown'];
  const NATURALIZED_RULE = '::1007321,1751,1007320,1752,1007319,1753,1007318,1754,6252|Yes:1007321,1751,1007320,1752,1007319,1753,1007318,1754,6252:|No::1007321,1751,1007320,1752,1007319,1753,1007318,1754,6252';
  const RACE_RULE = '::4064,4065,567|American Indian or Alaskan Native::4064,4065,567|Asian:567:4064,4065|Black or African American::4064,4065,567|Hispanic or Latino:4064:4065,567|Native Hawaiian or Other Pacific Islander:4065:4064,567|White::4064,4065,567|Unknown::4064,4065,567';
  const languageRule = `::566|English::566|${LANGUAGES.slice(1).map(language => `${language}:566:`).join('|')}`;
  const handler = rules => `hideShowQuestions('question0', this, '${rules || ''}')`;
  const yn = (key, question, index, label, rules = '') => ({ key, question, index, label, type: 'radio', rules, options: ['Yes', 'No'] });
  const optionValue = (spec, index) => (spec.values || spec.options)[index];
  const PAGES = [
    { path: 'dynamicQuestionsStart', pageKey: 'iowa-emergency-screening', heading: 'Emergency Supplemental Nutrition Assistance Program (SNAP)', phase: 'Start Application',
      intro: 'These questions will help us decide if you can get food assistance quicker.', nextId: null, next: 'submitAction();return false;',
      questions: [yn('emergencyIncomeUnder150', 'question015', 0, 'Does the household expect to have less than $150 income this month?'),
        yn('emergencyCashUnder100', 'question016', 1, 'Is the total amount of money everyone in the household has less than $100?'),
        yn('emergencyMigrantSeasonal', 'question03136', 2, 'Is anyone a migrant or seasonal farm worker?'),
        yn('emergencyHousingExceedsExpectedIncome', 'question017', 3, 'Are your monthly housing mortgage or rent and utility payments more than your expected monthly income?')] },
    { path: 'ssaVerificationRender', pageKey: 'iowa-background-information', heading: 'Background Information', phase: 'Start Application',
      intro: 'Please give us additional information about yourself. If you cannot answer a question you can skip it.', nextId: 'dqButtonId311',
      next: "dynamicQuestionsButton('WARNING!', '', 'Ok', 'Cancel', 'answerSet', 'simple?buttonId=311', 'true', 'dqButtonId311');",
      questions: [yn('iowaResident', 'question02423', 1, 'Are you a resident of Iowa?'),
        yn('migrantSeasonalFarmworker', 'question01007303', 5, 'Are you a migrant or seasonal farm worker?'),
        { key: 'preferredLanguage', question: 'question08', index: 8, label: 'What is your preferred language?', type: 'select', rules: languageRule, options: LANGUAGES },
        { ...yn('wantsFreeLanguageHelp', 'question0566', 9, 'Would you like to have a person who speaks your first language help you when you visit the office at no cost?'), conditional: true },
        yn('naturalizedCitizen', 'question02429', 18, 'Are you a naturalized citizen?', NATURALIZED_RULE),
        { key: 'birthState', question: 'question012', index: 187, label: 'What state were you born in?', type: 'select', rules: '', options: STATES.map(([, state]) => state) },
        { key: 'race', question: 'question014', index: 189, label: 'What is your race?', type: 'checkbox', rules: RACE_RULE, options: RACES, optional: true }] },
    { path: 'dynamicQuestions', pageKey: 'iowa-job-screening', heading: 'Job Information', phase: 'Job and School', intro: null,
      nextId: null, next: 'submitAction();return false;', questions: [
        yn('householdInSchool', 'question01007305', 0, 'Is anyone going to school or college? (For SNAP or FIP applicants, anyone 18 or older and in college or trade school.)'),
        yn('householdOnStrike', 'question052', 3, 'Is anyone currently on strike?', '::1007307|Yes:1007307:|No::1007307'),
        yn('householdWorking', 'question01007279', 6, 'Is anyone working, planning to work in the next two months or is self-employed? (include anyone who has been hired but hasn’t received a paycheck)'),
        yn('householdJobEnded30Days', 'question01007277', 7, 'Has anyone ended a job in the last 30 days?')] },
    { path: 'dynamicQuestions', pageKey: 'iowa-income-screening', heading: 'Income Information', phase: 'Other Income', autocomplete: 'off',
      intro: "To make it faster to review your application, we need to know about your household's income from sources other than jobs. Answer for yourself and everyone in your household.",
      nextId: null, next: 'submitAction();return false;', questions: [
        yn('incomeSocialSecurityRetirement', 'question01973', 0, "Is anyone getting or going to get money from Social Security, Retirement Accounts, Veteran's Administration or Pensions? This includes children."),
        { ...yn('incomeSupportInvestmentsUnemployment', 'question06542', 1, 'Is anyone getting or going to get money from any of these? This includes children.'),
          items: ['Child Support', 'Alimony', 'Capital Gains', 'Dividends/Interests', 'Net Farming/Fishing', 'Net Rental Royalties', 'Unemployment', 'Canceled Debts', 'Court Awards', 'Jury Duty'] },
        { ...yn('incomeGiftsWorkersCompSsi', 'question01007080', 3, 'Is anyone getting or going to get money from any of these? This includes children.'),
          items: ['Loan, gifts, contributions', 'Work Compensation', 'Legal or Insurance settlements/court actions pending', 'Sales of notes, contracts, trust deeds, or promissory notes', 'Strike Pay/Benefits', 'Winnings such as bingo, lottery, prizes', 'Termination/Severance Pay', 'Supplemental Security Income (SSI)', 'Employee or Private disability'] },
        yn('incomeEducationGrantsLoans', 'question01007078', 5, 'Does anyone receive any money from educational grants, loans, and/or scholarships, per capita payments or training allowances?'),
        yn('incomeInKindSupport', 'question01007095', 10, 'Does anyone get housing or rent, utilities, food or clothing, for free or in exchange for work?'),
        yn('incomeExpectedUnchanged', 'question01000022', 15, 'Do you expect your income to stay the same?'),
        yn('incomeFriendsRelatives', 'question01007309', 16, 'Is anyone getting money from friends or relatives?'),
        yn('incomeOther', 'question01007308', 17, 'Does anyone in the home (including children) get any other income that is not listed above?')] },
    { path: 'dynamicQuestions', pageKey: 'iowa-expenses-screening', heading: 'Expenses Information', phase: 'Expenses', autocomplete: 'off',
      intro: 'Tell us about the household expenses and bills you pay regularly. This information helps us see what benefits you can get, so be sure to include all your expenses. Answer for yourself and everyone in your household.',
      nextId: null, next: 'submitAction();return false;', questions: [
        yn('paysDependentCare', 'question0142', 1, 'Dependent Care Expenses (Child, Disabled Adult or Elder Care)?'),
        yn('paysHousing', 'question0149', 2, 'Housing Expenses?'),
        yn('lowRentHousing', 'question01007284', 3, 'Are you on low rent housing?'),
        yn('paysChildSupport', 'question0144', 6, 'Does anyone in the household currently pay child support?'),
        yn('paysUtilities', 'question0150', 7, 'Utility Expense (Gas, Electricity, Water, etc.)?'),
        yn('receivedEnergyAssistanceCurrentAddress', 'question01007285', 8, 'Did you receive energy assistance in the past year at your current address?'),
        yn('paysUncoveredAgedDisabledMedical', 'question0146', 11, 'Medical Expenses (Medical Treatment, Prescriptions, In Home Support or Health Care Services for aged or disabled individuals that are NOT covered by insurance)?'),
        yn('paysMedicare', 'question0147', 12, 'Medicare Coverage Expenses?')] },
    { path: 'dynamicQuestions', pageKey: 'iowa-property-screening', heading: 'Property Information', phase: 'Property', autocomplete: 'off',
      intro: 'Tell us about any assets and other property you own. Answer for yourself and everyone in your household.',
      nextId: null, next: 'submitAction();return false;', questions: [
        yn('hasLiquidAssets', 'question0555', 0, 'Do you or anyone in the household own, have the use of, or have their name on a checking/savings account, a Certificate of Deposit, money in a credit union, cash or uncashed checks?'),
        yn('ownsOrBuyingProperty', 'question0223', 2, "Do you or anyone in the household own property? Is anyone buying property even if you don't live at that property?"),
        yn('hasConservatorshipOrTrust', 'question01007293', 4, 'Does anyone in the household have a conservatorship or trust?'),
        { ...yn('transferredProperty90Days', 'question01007317', 5, 'Has any resource been sold, transferred or given away in the last 90 days?'), values: [' Yes', ' No'] },
        yn('hasPersonalProperty', 'question0226', 6, 'Does anyone own any personal property or equipment?'),
        yn('ownsOrRegisteredVehicle', 'question0227', 8, 'Does anyone own or have their name on the registration of any motor vehicle, even if not running? (car, truck, boat, camper, motorcycle, or other vehicle)'),
        yn('sharesResourcesOutsideHousehold', 'question01007286', 10, 'Do you or anyone in your household own resources with someone who does not live in your household?')] }
  ];
  const NAVIGATION_PAGE_KEYS = Object.freeze(PAGES.map(page => page.pageKey));
  const snapshots = new WeakMap();
  function pageForUrl(url) { return PAGES.find(page => url === `${PORTAL}/applyForBenefits/${page.path}`) || null; }
  function scope(doc, url) {
    const candidates = PAGES.filter(page => url === `${PORTAL}/applyForBenefits/${page.path}`);
    if (!candidates.length) return null;
    const headings = Array.from(doc.querySelectorAll('h2')).filter(element => rendered(element, doc));
    const matches = candidates.filter(page => page.path === 'ssaVerificationRender' || headings.some(element => norm(element.textContent) === page.heading) ||
      (!headings.length && page.questions.filter(spec => rendered(one(doc, spec.question), doc)).length >= 2));
    return matches.length === 1 ? matches[0] : null;
  }
  function rendered(element, doc) {
    if (!element?.isConnected || !doc.defaultView) return false;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const style = doc.defaultView.getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') return false;
    }
    const box = element.getBoundingClientRect();
    return Boolean(element.getClientRects().length && box.width > 0 && box.height > 0);
  }
  function accessible(element, doc) {
    if (!rendered(element, doc)) return false;
    const box = element.getBoundingClientRect(), win = doc.defaultView;
    if (box.left < 0 || box.top < 0 || box.right > win.innerWidth || box.bottom > win.innerHeight) return false;
    if (typeof doc.elementFromPoint === 'function') {
      const top = doc.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!top || (top !== element && !element.contains(top))) return false;
    }
    return true;
  }
  function scroll(element, doc) {
    if (!rendered(element, doc)) return false;
    if (!accessible(element, doc)) element.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return accessible(element, doc);
  }
  function enabled(element) { return !element.matches(':disabled') && !element.readOnly && element.getAttribute('aria-disabled') !== 'true'; }
  function one(doc, id) { const list = doc.querySelectorAll(`[id="${id}"]`); return list.length === 1 ? list[0] : null; }
  function blocked(doc) {
    return Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .popupPage, input[type="password"], [name="captchaAnswer"], #securityCode, #termChkbox'))
      .some(element => rendered(element, doc)) || Array.from(doc.querySelectorAll('h1,h2,h3,label,legend')).some(element => rendered(element, doc) &&
        /\b(signature|certification|certify|attestation|attest|consent|submit application|review and submit|i agree|penalty of perjury)\b/i.test(norm(element.textContent)));
  }
  function context(doc, url) {
    const page = scope(doc, url);
    if (!page || doc.location.href !== url || blocked(doc)) return null;
    const headings = Array.from(doc.querySelectorAll('h2')).filter(element => rendered(element, doc));
    if (headings.filter(element => norm(element.textContent) === page.heading).length !== 1) return null;
    const active = doc.querySelectorAll(`a[title="${page.phase} | Active"]`), people = doc.querySelectorAll('a[title="People | Unvisited"]');
    if (active.length !== 1 || !active[0].parentElement.matches('li.current') || !rendered(active[0], doc) || doc.querySelectorAll('a[title$=" | Active"]').length !== 1 ||
        (page.phase === 'Start Application' && (people.length !== 1 || !people[0].parentElement.matches('li.next') || !rendered(people[0], doc)))) return null;
    const form = one(doc, 'answerSet');
    if (!form || form.tagName !== 'FORM' || form.getAttribute('action') !== 'simple' || form.action !== `${PORTAL}/applyForBenefits/simple` || form.method !== 'post' ||
        form.hasAttribute('target') || form.hasAttribute('onsubmit') || (page.autocomplete && form.getAttribute('autocomplete') !== page.autocomplete) || form.elements.length > 1000 || Array.from(form.elements).some(element => !form.contains(element))) return null;
    let introductions = [];
    if (page.intro && page.pageKey !== 'iowa-background-information') {
      const stepper = page.pageKey === 'iowa-emergency-screening' ? one(doc, 'stepper-div-id') : doc.body;
      if (!stepper || !stepper.contains(form)) return null;
      // Emergency's exact paragraph wrapper was not captured. Match its exact observed
      // introduction in a minimal rendered container before the form, not a guessed class.
      introductions = Array.from(stepper.querySelectorAll('*')).filter(element => !form.contains(element) && !element.contains(form) && rendered(element, doc) &&
        norm(element.textContent) === page.intro && (element.compareDocumentPosition(form) & doc.defaultView.Node.DOCUMENT_POSITION_FOLLOWING) &&
        !Array.from(element.children).some(child => rendered(child, doc) && norm(child.textContent) === page.intro));
    } else if (page.intro) introductions = Array.from(doc.querySelectorAll('div.fullrow.floatLeft > p')).filter(element => !form.contains(element) && rendered(element, doc) && norm(element.textContent).startsWith(page.intro));
    if (page.intro && introductions.length !== 1) return null;
    const names = Array.from(form.querySelectorAll(page.pageKey === 'iowa-background-information' ? '.peTaxInfoName h3' : 'h3')).filter(element => rendered(element, doc));
    if (names.length !== 1 || !norm(names[0].textContent) || names[0].textContent.length > 250) return null;
    const recipient = Array.from(form.querySelectorAll('input[type="hidden"]')).filter(element => ['answerSets[0].personSelection', 'answerSets[0].name', 'questionSetId'].includes(element.name));
    const identity = { form, name: names[0], nameText: names[0]?.textContent, intro: introductions[0], introText: introductions[0]?.textContent, active: active[0], people: people[0],
      recipient: JSON.stringify(recipient.map(element => [element.name, element.value])) };
    for (const [index, element] of recipient.entries()) identity[`recipientNode${index}`] = element;
    const questions = {}, controls = {};
    for (const spec of page.questions) {
      const question = one(doc, spec.question);
      if (!question || !question.matches('div.questionAnswer') || !form.contains(question) || !rendered(question, doc) || question.closest('.disabledQuestion')) continue;
      questions[spec.key] = question;
      const found = questionControls(doc, form, question, spec);
      if (found) controls[spec.key] = found;
    }
    if (!controls.preferredLanguage?.[0].value || controls.preferredLanguage[0].value === 'English') delete controls.wantsFreeLanguageHelp;
    return { page, form, identity, questions, controls };
  }
  function questionControls(doc, form, question, spec) {
    const name = `answerSets[0].answers[${spec.index}].${spec.type === 'checkbox' ? 'answerValues' : 'answerValue'}`;
    const named = Array.from(form.querySelectorAll('[name]')).filter(element => element.name === name);
    const labels = question.querySelectorAll(spec.type === 'select' ? ':scope > div.question > label' : ':scope > fieldset > legend.question');
    if (labels.length !== 1) return null;
    if (spec.items) {
      const items = Array.from(labels[0].querySelectorAll('li'));
      const copy = labels[0].cloneNode(true); copy.querySelectorAll('ul,ol').forEach(list => list.remove());
      if (norm(copy.textContent) !== spec.label || items.length !== spec.items.length || items.some((item, index) => norm(item.textContent) !== spec.items[index])) return null;
    } else if (norm(labels[0].textContent) !== spec.label) return null;
    const elements = spec.type === 'select' ? [one(doc, `answerSets0.answers${spec.index}.answerValue`)] : spec.options.map((_, index) => one(doc, `answerSets0.answers${spec.index}.${spec.type === 'checkbox' ? 'answerValues' : 'answerValue'}${index + 1}`));
    if (named.length !== elements.length || elements.some((element, index) => !element || named[index] !== element || element.form !== form || !question.contains(element) || !rendered(element, doc) || element.className !== 'hasScript')) return null;
    if (spec.type === 'select') {
      const [select] = elements;
      if (select.tagName !== 'SELECT' || select.type !== 'select-one' || labels[0].htmlFor !== select.id || select.getAttribute('onchange') !== handler(spec.rules) ||
          Array.from(select.attributes).some(attribute => attribute.name.startsWith('on') && attribute.name !== 'onchange') || select.options.length !== spec.options.length + 1 ||
          Array.from(select.options).some((option, index) => option.value !== (index ? spec.options[index - 1] : '') || norm(option.textContent) !== (index ? spec.options[index - 1] : 'Select One'))) return null;
    } else if (elements.some((element, index) => element.tagName !== 'INPUT' || element.type !== spec.type || element.getAttribute('value') !== optionValue(spec, index) ||
        element.getAttribute('onclick') !== handler(spec.rules) || (spec.type === 'radio' ? element.getAttribute('onchange') !== `${handler(spec.rules)} ` : element.hasAttribute('onchange')) ||
        Array.from(element.attributes).some(attribute => attribute.name.startsWith('on') && !['onclick', ...(spec.type === 'radio' ? ['onchange'] : [])].includes(attribute.name)) ||
        element.labels.length !== 1 || norm(element.labels[0].textContent) !== spec.options[index] || !question.contains(element.labels[0]))) return null;
    return elements;
  }
  function sameIdentity(before, after) { return after && Object.keys(before).every(key => before[key] === after[key]); }
  function answered(elements) { return elements?.some(element => ['radio', 'checkbox'].includes(element.type) ? element.checked : Boolean(element.value.trim())); }
  function open(elements) { return elements?.length && elements.every(enabled) && !answered(elements); }
  function formState(context) {
    return Array.from(context.form.querySelectorAll('*')).map(element => ({ element, attrs: Array.from(element.attributes).map(attribute => `${attribute.name}=${attribute.value}`).join('|'),
      text: element.childElementCount ? '' : element.textContent, value: element.value, checked: element.checked, disabled: element.disabled, readOnly: element.readOnly,
      visible: rendered(element, element.ownerDocument), validity: element.willValidate ? element.validity.valid : null }));
  }
  function sameForm(before, context) {
    const after = formState(context);
    return before.length === after.length && before.every((entry, index) => Object.keys(entry).every(key => entry[key] === after[index][key]));
  }
  function scan(doc, url) {
    const result = { supported: Boolean(pageForUrl(url)), recognizedPage: false, fields: [], bindings: [], ambiguous: [], skipped: 0 }, current = context(doc, url);
    if (!current) return result;
    result.recognizedPage = true;
    // Private full-form state includes hidden recipient fields, never returned through metadata.
    const state = formState(current);
    for (const spec of current.page.questions) {
      const elements = current.controls[spec.key];
      if (!open(elements)) { result.skipped++; continue; }
      result.fields.push({ key: spec.key, label: spec.label });
      result.bindings.push({ key: spec.key, element: elements[0], elements, identity: current.identity, state });
    }
    return result;
  }
  function parseValue(spec, raw) {
    if (typeof raw !== 'string' || raw.length > 500 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    if (spec.type === 'radio') return raw === 'yes' ? [optionValue(spec, 0)] : raw === 'no' ? [optionValue(spec, 1)] : null;
    if (spec.type === 'select') return spec.options.includes(raw) ? [raw] : null;
    const options = raw.split(';').map(norm);
    return options.length && options.length <= spec.options.length && new Set(options).size === options.length && options.every(option => spec.options.includes(option)) ? options : null;
  }
  function fill(doc, url, bindings, values) {
    const filled = [], skipped = [];
    if (!Array.isArray(bindings) || bindings.length > 30 || !values || typeof values !== 'object') return { filled, skipped };
    let expected = bindings[0]?.state;
    for (const binding of bindings) {
      const current = () => {
        const found = context(doc, url), elements = found?.controls[binding.key];
        return found && Array.isArray(expected) && binding.identity && Array.isArray(binding.elements) && sameIdentity(binding.identity, found.identity) && sameForm(expected, found) && open(elements) && elements.length === binding.elements.length &&
          elements.every((element, index) => element === binding.elements[index]) ? found : null;
      };
      let found = current(), spec = found?.page.questions.find(question => question.key === binding.key);
      const requested = spec && Object.hasOwn(values, binding.key) ? parseValue(spec, values[binding.key]) : null;
      if (!found || !requested || !scroll(binding.element, doc) || !(found = current())) { skipped.push(binding.key); continue; }
      const elements = found.controls[binding.key];
      let okay = true;
      if (spec.type === 'select') {
        const select = elements[0];
        if (!Array.from(select.options).some(option => option.value === requested[0] && !option.disabled)) okay = false;
        else {
          Object.getOwnPropertyDescriptor(doc.defaultView.HTMLSelectElement.prototype, 'value').set.call(select, requested[0]);
          select.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
          const afterInput = context(doc, url);
          if (!sameIdentity(binding.identity, afterInput?.identity) || afterInput.controls[binding.key]?.[0] !== select) okay = false;
          else { select.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); okay = select.value === requested[0]; }
        }
      } else {
        for (const value of requested) {
          const target = elements.find(element => element.value === value);
          if (!target || !enabled(target) || !scroll(target, doc)) { okay = false; break; }
          const fresh = context(doc, url), controls = fresh?.controls[binding.key];
          if (!sameIdentity(binding.identity, fresh?.identity) || !controls || controls.length !== elements.length || controls.some((element, index) => element !== elements[index])) { okay = false; break; }
          if (target.checked) continue;
          target.click();
          if (!target.checked) { okay = false; break; }
        }
        if (elements.some(element => element.checked !== requested.includes(element.value))) okay = false;
      }
      if (okay) filled.push(binding.key); else skipped.push(binding.key);
      // Changes caused by this one answer (including newly revealed questions) are expected;
      // subsequent bindings still require the same applicant and exact observed controls.
      const after = context(doc, url);
      expected = after ? formState(after) : null;
    }
    return { filled, skipped };
  }
  function nextButton(doc, current) {
    const candidates = Array.from(current.form.querySelectorAll('button')).filter(button => norm(button.textContent) === 'Save and Continue');
    if (candidates.length !== 1) return null;
    const [button] = candidates;
    if (button.type !== 'button' || button.className !== 'btn btn-primary saveButton' || button.getAttribute('onclick') !== current.page.next || !enabled(button) || !rendered(button, doc) ||
        (current.page.nextId ? one(doc, current.page.nextId) !== button || button.title !== 'Save and Continue' : button.hasAttribute('id')) ||
        Array.from(button.attributes).some(attribute => attribute.name.startsWith('on') && attribute.name !== 'onclick') ||
        ['form', 'formaction', 'formtarget', 'formmethod', 'formnovalidate', 'formenctype'].some(attribute => button.hasAttribute(attribute))) return null;
    return button;
  }
  function issues(doc, current) {
    const checklist = [], covered = new Set(), known = new Set(Object.values(current.questions));
    let requiredRemaining = 0, manualRemaining = 0;
    for (const spec of current.page.questions) {
      if (spec.conditional && !current.questions[spec.key] && current.controls.preferredLanguage?.[0].value === 'English') continue;
      if (spec.conditional && !current.questions[spec.key] && !current.controls.preferredLanguage?.[0].value) continue;
      const elements = current.controls[spec.key];
      elements?.forEach(element => covered.add(element));
      const valid = elements && elements.every(element => enabled(element) && element.getAttribute('aria-invalid') !== 'true' && (!element.willValidate || element.validity.valid));
      const selected = valid ? elements.filter(element => element.checked) : [];
      const complete = valid && (spec.type === 'radio' ? selected.length === 1 : spec.type === 'checkbox' ? (spec.optional || selected.length > 0) : spec.options.includes(elements[0].value));
      const status = complete ? (spec.optional && !answered(elements) ? 'optional' : 'complete') : open(elements) ? 'missing' : 'manual';
      if (status === 'missing') requiredRemaining++;
      if (status === 'manual') manualRemaining++;
      checklist.push({ key: spec.key, label: spec.label, status, required: !spec.optional, fillable: Boolean(open(elements)) });
    }
    const unknown = Array.from(current.form.querySelectorAll('.questionAnswer')).some(question => rendered(question, doc) && !known.has(question) && !question.contains(current.identity.name)) ||
      Array.from(current.form.querySelectorAll('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="listbox"]'))
        .some(element => element.type !== 'hidden' && rendered(element, doc) && !covered.has(element)) ||
      Array.from(current.form.querySelectorAll('button')).some(button => rendered(button, doc) && button !== nextButton(doc, current) && !(button.type === 'button' && norm(button.textContent) === 'Back'));
    const errors = Array.from(doc.querySelectorAll('[role="alert"], [id*="error" i], [class*="error" i], [aria-busy="true"]')).some(element => rendered(element, doc) && (norm(element.textContent) || element.getAttribute('aria-busy') === 'true'));
    // Follow-ups have not been captured: selecting these answers never implies that their
    // temporarily absent questions are complete.
    const followup = (current.page.pageKey === 'iowa-background-information' && (current.controls.naturalizedCitizen?.[0].checked ||
      (current.controls.preferredLanguage?.[0].value && current.controls.preferredLanguage[0].value !== 'English' && !current.controls.wantsFreeLanguageHelp) ||
      current.controls.race?.some(element => element.checked && ['Asian', 'Hispanic or Latino', 'Native Hawaiian or Other Pacific Islander'].includes(element.value)))) ||
      (current.page.pageKey === 'iowa-job-screening' && current.controls.householdOnStrike?.[0].checked);
    if (unknown || errors || followup) manualRemaining++;
    return { checklist, requiredRemaining, manualRemaining };
  }
  function probePage(doc, url) {
    const page = scope(doc, url);
    if (!page) return null;
    const result = { kind: 'manual', pageKey: `${page.pageKey}-unverified`, heading: page.heading,
      fields: [], checklist: [], requiredRemaining: 0, manualRemaining: 1, canAdvance: false, todo: 'Review this page and continue in Iowa’s form yourself.', reason: 'SecondHand doesn’t recognize this page as it looks now, so it fills nothing here.' };
    const current = context(doc, url);
    if (!current) return result;
    const review = issues(doc, current), canAdvance = !review.requiredRemaining && !review.manualRemaining && Boolean(nextButton(doc, current));
    return { ...result, ...review, kind: 'fillable', pageKey: page.pageKey, fields: scan(doc, url).fields, canAdvance,
      todo: canAdvance ? 'SecondHand can save this page and continue. Review every answer before final submission.' : 'Answer the empty questions in Iowa’s form. If SecondHand doesn’t know a question on this page, answer it and click Save and Continue yourself.',
      reason: 'SecondHand clicks Save and Continue only when every question on this page that needs an answer has one and Iowa shows no errors or pop-ups. A question SecondHand doesn’t know stops it too.' };
  }
  function captureNavigation(doc, url) {
    if (!probePage(doc, url)?.canAdvance) return null;
    const current = context(doc, url), button = nextButton(doc, current), token = Object.freeze({});
    snapshots.set(token, { doc, url, identity: current.identity, state: formState(current), button, expires: Date.now() + 120000 });
    return token;
  }
  function advance(doc, url, token) {
    const saved = token && snapshots.get(token); if (token) snapshots.delete(token);
    const fail = () => ({ advanced: false, reason: 'The page or an answer changed. Review it before continuing.' });
    const safe = () => { const current = context(doc, url); return current && sameIdentity(saved.identity, current.identity) && sameForm(saved.state, current) && nextButton(doc, current) === saved.button && probePage(doc, url).canAdvance; };
    if (!saved || saved.doc !== doc || saved.url !== url || saved.expires < Date.now() || !safe() || !scroll(saved.button, doc) || !safe()) return fail();
    try { saved.button.click(); } catch { return fail(); }
    return { advanced: true, reason: 'Save and Continue was clicked once. Check the next page for required questions or errors.' };
  }
  function profileRequest(pageKey) { return PAGES.find(page => page.pageKey === pageKey)?.questions.map(spec => spec.key) || []; }
  function pageValues(pageKey, profile) {
    const values = {}, page = PAGES.find(item => item.pageKey === pageKey);
    if (!page || !profile || typeof profile !== 'object') return values;
    for (const spec of page.questions) {
      let value = Object.hasOwn(profile, spec.key) ? profile[spec.key] : null;
      if (spec.key === 'birthState') value = STATES.find(([code]) => code === value)?.[1] || null;
      if (parseValue(spec, value)) values[spec.key] = value;
    }
    return values;
  }
  function focusField(doc, url, key) {
    const current = context(doc, url), element = current?.controls[key]?.[0];
    if (!element || !scroll(element, doc) || context(doc, url)?.controls[key]?.[0] !== element) return false;
    element.focus({ preventScroll: true }); return doc.activeElement === element;
  }
  const api = Object.freeze({ PORTAL, NAVIGATION_PAGE_KEYS, scan, fill, probePage, captureNavigation, advance, profileRequest, pageValues, focusField });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SecondHandIowaLater = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
