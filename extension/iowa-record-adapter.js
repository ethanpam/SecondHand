/* One explicitly owned local record on each observed Iowa financial form.
   No network, model, storage, implicit owner, income conversion, or Add Another Entry. */
(function (root) {
  'use strict';
  const PORTAL = 'https://hhsservices.iowa.gov/apspssp/ssp.portal';
  const URL = `${PORTAL}/applyForBenefits/dynamicQuestions`, PAGE = 'iowa-job-history';
  const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
  const label = value => norm(value).replace(/\s*[*:]\s*$/, '').trim().toLowerCase();
  const person = value => norm(value).toLowerCase();
  const safeText = value => typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f\u200b\u202a-\u202e\u2066-\u2069]/.test(value);
  const PREFIX = ':1007278,69,70,1007368,72,73,74,75,76,2802,2803,1000181,1000021,1000020,1000019:7987,7988,1771,1007281';
  const PERSON_RULE = ':69,70,2803,72,73,74,75,1000181,1007368,2802,1000020,76,1000019,1000021,1007278:7987,7988,1771,1007281';
  const frequencies = ['Annually', 'Every Other Week', 'Irregular/Infrequent', 'Monthly', 'Quarterly', 'Semi Annually', 'Twice a Month', 'Weekly'];
  const hide = rule => `hideShowQuestions('question0', this, '${rule || ''}')`;
  const yn = (key, question, index, text, rule = '') => ({ key, question, index, text, type: 'radio', options: ['Yes', 'No'], rule });
  const fields = [
    { key: 'workOrTraining', question: 'question069', index: 0, text: 'Work or Training:', type: 'radio', options: ['Work', 'Training'], rule: '::2803,1007368,1000181|Work:2803,1007368,1000181:|Training::2803,1007368,1000181' },
    { key: 'startDate', question: 'question070', index: 2, text: 'Start Date', type: 'date' },
    yn('selfEmployed', 'question02803', 3, 'Is this job self-employment?', '::1007368,1000181|Yes:1007368,1000181:|No::1007368,1000181'),
    { key: 'employer', question: 'question072', index: 4, text: 'Employer Name:', type: 'text' },
    { key: 'jobTitle', question: 'question073', index: 5, text: 'Job Title', type: 'text' },
    { key: 'monthlyHours', question: 'question074', index: 6, text: 'Monthly Number of Hours:', type: 'hours' },
    { key: 'amount', question: 'question075', index: 8, text: 'Gross Income (before taxes) per pay period', type: 'money' },
    yn('hasBusinessExpenses', 'question01007368', 10, 'Do you have business expenses related to your self-employment?'),
    { key: 'frequency', question: 'question02802', index: 11, text: 'Pay period frequency', type: 'select' },
    { key: 'tipsOrCommissions', question: 'question076', index: 13, text: 'Tips or Commissions', type: 'money' },
    yn('incomeExpectedSame', 'question01000019', 14, 'Do you expect this income to stay the same?')
  ];
  const changes = [
    { key: 'changedJobs30Days', text: 'Change Jobs', index: 1 },
    { key: 'stoppedWorking30Days', text: 'Stop working', index: 2 },
    { key: 'fewerHours30Days', text: 'Start working fewer hours', index: 3 }
  ];
  const LABELS = { person: 'Person this job record belongs to', workOrTraining: 'Work or training', startDate: 'Job start date', selfEmployed: 'Self-employment', employer: 'Employer name', jobTitle: 'Job title', monthlyHours: 'Monthly hours', amount: 'Gross income per pay period', selfEmploymentMonthlyNet: 'Monthly net self-employment income', hasBusinessExpenses: 'Business expenses for self-employment', frequency: 'Pay period frequency', tipsOrCommissions: 'Tips or commissions', incomeExpectedSame: 'Income expected to stay the same', changedJobs30Days: 'Changed jobs in the last 30 days', stoppedWorking30Days: 'Stopped working in the last 30 days', fewerHours30Days: 'Started working fewer hours in the last 30 days' };
  const REQUEST = Object.freeze({ recordType: 'jobs', fields: Object.freeze(Object.keys(LABELS)) });
  const previews = new WeakMap(), navigation = new WeakMap(), proofs = new WeakMap();
  function rendered(element, doc) {
    if (!element?.isConnected) return false;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const style = doc.defaultView.getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') return false;
    }
    const rect = element.getBoundingClientRect(); return Boolean(element.getClientRects().length && rect.width > 0 && rect.height > 0);
  }
  function accessible(element, doc) {
    if (!rendered(element, doc)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.top < 0 || rect.left < 0 || rect.right > doc.defaultView.innerWidth || rect.bottom > doc.defaultView.innerHeight) return false;
    if (typeof doc.elementFromPoint !== 'function') return true;
    const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return top === element || element.contains(top);
  }
  function scroll(element, doc) { if (!rendered(element, doc)) return false; if (!accessible(element, doc)) element.scrollIntoView?.({ block: 'center', inline: 'nearest' }); return accessible(element, doc); }
  const only = (doc, id) => { const all = doc.querySelectorAll(`[id="${id}"]`); return all.length === 1 ? all[0] : null; };
  const labels = input => Array.from(input.labels || []).map(item => label(item.textContent)).join('|');
  const editable = (input, doc) => rendered(input, doc) && !input.matches(':disabled') && !input.readOnly;
  const answered = elements => elements.some(input => ['radio', 'checkbox'].includes(input.type) ? input.checked : norm(input.value));
  function scope(doc, url) { return url === URL && Array.from(doc.querySelectorAll('h2')).some(h => rendered(h, doc) && norm(h.textContent) === 'Job and Job History'); }
  function blocked(doc) {
    return Array.from(doc.querySelectorAll('.modal,.popupPage,[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open],input[type="password"],#termChkbox,[name="captchaAnswer"]')).some(el => rendered(el, doc)) ||
      Array.from(doc.querySelectorAll('h1,h2,h3,label,legend')).some(el => rendered(el, doc) && /\b(consent|certify|certification|signature|submit application|attestation|penalty of perjury)\b/i.test(norm(el.textContent)));
  }
  function controlsFor(doc, form, spec) {
    const question = only(doc, spec.question); if (!question || !form.contains(question) || !question.classList.contains('questionAnswer') || !rendered(question, doc) || question.classList.contains('disabledQuestion')) return null;
    const name = `answerSets[0].answers[${spec.index}].answerValue`;
    const named = Array.from(form.querySelectorAll('[name]')).filter(el => el.name === name);
    if (spec.type === 'radio') {
      const legend = question.querySelector('fieldset > legend');
      if (!legend || label(legend.textContent) !== label(spec.text) || named.length !== 2) return null;
      for (let i = 0; i < 2; i++) {
        const el = only(doc, `answerSets0.answers${spec.index}.answerValue${i + 1}`);
        if (!el || el !== named[i] || !question.contains(el) || el.form !== form || el.type !== 'radio' || el.className !== 'hasScript' || el.value !== spec.options[i] || labels(el) !== label(spec.options[i]) || el.getAttribute('onclick') !== hide(spec.rule) || el.getAttribute('onchange') !== `${hide(spec.rule)} ` || Array.from(el.attributes).some(a => a.name.startsWith('on') && !['onclick', 'onchange'].includes(a.name))) return null;
      }
      return named;
    }
    const input = only(doc, `answerSets0.answers${spec.index}.answerValue`);
    if (!input || named.length !== 1 || input !== named[0] || input.form !== form || !question.contains(input) || labels(input) !== label(spec.text)) return null;
    if (['select', 'assetType'].includes(spec.type)) {
      if (input.tagName !== 'SELECT' || input.type !== 'select-one' || input.className !== 'hasScript' || input.getAttribute('onchange') !== hide('') || Array.from(input.attributes).some(a => a.name.startsWith('on') && a.name !== 'onchange')) return null;
      const options = [...input.options], choices = spec.options || frequencies;
      if (options.length !== choices.length + 1 || options.some((opt, i) => opt.disabled || opt.value !== (i ? choices[i - 1] : '') || norm(opt.textContent) !== (i ? choices[i - 1] : 'Select One'))) return null;
    } else if (input.tagName !== 'INPUT' || input.type !== 'text' || Array.from(input.attributes).some(a => a.name.startsWith('on')) || input.hasAttribute('pattern') ||
      (spec.type === 'date' ? input.className !== 'date-format-class hasDatepicker' || input.title !== 'mm/dd/yyyy' : Boolean(input.className) || input.autocomplete !== 'off')) return null;
    return [input];
  }
  function context(doc, url) {
    if (!scope(doc, url) || doc.location.href !== url || blocked(doc)) return null;
    const form = only(doc, 'answerSet'), active = doc.querySelectorAll('a[title="Job and School | Active"]');
    if (!form || form.tagName !== 'FORM' || form.getAttribute('action') !== 'simple' || form.action !== `${PORTAL}/applyForBenefits/simple` || form.method !== 'post' || form.hasAttribute('onsubmit') || form.hasAttribute('target') || Array.from(form.elements).some(el => !form.contains(el)) || active.length !== 1 || !active[0].parentElement.matches('li.current') || !rendered(active[0], doc)) return null;
    for (const title of ['Start Application | Visited', 'People | Visited', 'Other Income | Unvisited']) if (doc.querySelectorAll(`a[title="${title}"]`).length !== 1) return null;
    const owner = only(doc, 'answerSets0.personSelection');
    if (!owner || owner.form !== form || owner.tagName !== 'SELECT' || owner.type !== 'select-one' || owner.name !== 'answerSets[0].personSelection' || owner.className !== 'hasScript' || labels(owner) !== 'select a person' || !editable(owner, doc) || Array.from(owner.attributes).some(a => a.name.startsWith('on') && a.name !== 'onchange')) return null;
    const options = [...owner.options];
    if (options.length < 2 || options.length > 21 || options[0].value !== '' || norm(options[0].textContent) !== 'Select One' || options.some(opt => opt.disabled) || options.slice(1).some(opt => !/^(0|[1-9]\d{0,3})$/.test(opt.value) || !safeText(norm(opt.textContent)) || !norm(opt.textContent)) || new Set(options.map(opt => opt.value)).size !== options.length) return null;
    // Each actual person option needs the same observed enable/disable rule. Unknown person
    // conditions cannot be substituted with a primary applicant or the first option.
    const rules = PREFIX + options.slice(1).map(opt => `|${opt.value}${PERSON_RULE}`).join('');
    if (owner.getAttribute('onchange') !== `enableDisableQuestions('question0', this, '${rules}')`) return null;
    const controls = { person: [owner] }, specs = {};
    for (const spec of fields) { const found = controlsFor(doc, form, spec); if (found) { controls[spec.key] = found; specs[spec.key] = spec; } }
    const working = controls.workOrTraining?.[0].checked && !controls.workOrTraining?.[1].checked;
    if (!working) { delete controls.selfEmployed; delete controls.hasBusinessExpenses; }
    const selfEmployed = working && controls.selfEmployed?.[0].checked && !controls.selfEmployed?.[1].checked;
    const instruction = only(doc, 'question01000181');
    if (selfEmployed && instruction && form.contains(instruction) && rendered(instruction, doc) && norm(instruction.textContent) === 'Enter monthly net income if you are self-employed') {
      if (controls.amount) { controls.selfEmploymentMonthlyNet = controls.amount; specs.selfEmploymentMonthlyNet = { ...specs.amount, key: 'selfEmploymentMonthlyNet' }; delete controls.amount; }
    } else if (selfEmployed || !working || !controls.selfEmployed?.[1].checked) delete controls.amount;
    if (!selfEmployed) delete controls.hasBusinessExpenses;
    const changeQuestion = only(doc, 'question01007278');
    if (changeQuestion && form.contains(changeQuestion) && rendered(changeQuestion, doc) && label(changeQuestion.querySelector('legend')?.textContent) === 'in the past 30 days, did this person') {
      const all = Array.from(form.querySelectorAll('input[name="answerSets[0].answers[17].answerValues"]'));
      for (const spec of changes) {
        const input = only(doc, `answerSets0.answers17.answerValues${spec.index}`);
        if (all.length === 3 && input === all[spec.index - 1] && input.form === form && input.type === 'checkbox' && input.className === 'hasScript' && input.value === spec.text && labels(input) === label(spec.text) && input.getAttribute('onclick') === hide('') && !input.hasAttribute('onchange') && changeQuestion.contains(input)) { controls[spec.key] = [input]; specs[spec.key] = { ...spec, type: 'checkbox' }; }
      }
    }
    return { form, owner, options, active: active[0], controls, specs, working, selfEmployed, instruction, changeQuestion };
  }
  function state(current) {
    return { form: current.form, active: current.active, controls: Array.from(current.form.querySelectorAll('input,select,textarea,button')).map(el => ({ el, name: el.name, id: el.id, type: el.type, value: el.value, checked: el.checked, disabled: el.disabled, readOnly: el.readOnly, required: el.required, rendered: rendered(el, el.ownerDocument), attrs: Array.from(el.attributes).map(a => `${a.name}=${a.value}`).join('|'), options: el.tagName === 'SELECT' ? Array.from(el.options).map(opt => `${opt.value}|${opt.textContent}|${opt.disabled}`).join('\n') : '', labels: labels(el) })) };
  }
  function same(saved, current) { if (!saved || !current || saved.form !== current.form || saved.active !== current.active) return false; const fresh = state(current); return saved.controls.length === fresh.controls.length && saved.controls.every((el, i) => Object.keys(el).every(key => el[key] === fresh.controls[i][key])); }
  function format(key, value) {
    if (!safeText(value) || !norm(value)) return null;
    value = norm(value);
    if (key === 'person') return value;
    if (key === 'workOrTraining') return ['Work', 'Training'].includes(value) ? value : null;
    if (['selfEmployed', 'hasBusinessExpenses', 'incomeExpectedSame', ...changes.map(f => f.key)].includes(key)) return ['yes', 'no'].includes(value) ? value : null;
    if (key === 'frequency') return frequencies.includes(value) ? value : null;
    if (['startDate', 'acquiredDate'].includes(key)) { const date = new Date(`${value}T00:00:00.000Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}` : null; }
    if (['amount', 'selfEmploymentMonthlyNet', 'tipsOrCommissions', 'monthlyHours', 'currentValue', 'amountOwed'].includes(key)) return /^\d{1,9}(?:\.\d{1,2})?$/.test(value) && (key !== 'monthlyHours' || Number(value) <= 744) ? value : null;
    if (key === 'type') return value === 'Cash/Uncashed Check' ? value : null;
    return ['employer', 'jobTitle', 'accountOrPolicy', 'institution'].includes(key) ? value : null;
  }
  function existing(current, key) { const elements = current.controls[key]; if (!elements) return ''; if (elements[0].type === 'radio') return elements.find(el => el.checked)?.value || ''; if (elements[0].type === 'checkbox') return elements[0].checked ? 'yes' : ''; return norm(elements[0].value); }
  function equivalent(current, key, value) {
    const actual = existing(current, key); if (!actual) return true;
    if (current.controls[key][0].type === 'radio' && ['yes', 'no'].includes(value)) return actual.toLowerCase() === value;
    if (['amount', 'selfEmploymentMonthlyNet', 'tipsOrCommissions', 'monthlyHours', 'currentValue', 'amountOwed'].includes(key)) return /^\d+(?:\.\d{1,2})?$/.test(actual) && Number(actual) === Number(value);
    return actual === value;
  }
  function scan(doc, url) {
    const result = { supported: url === URL, recognizedPage: false, fields: [], bindings: [], ambiguous: [], skipped: 0 }, current = context(doc, url);
    if (!current) return result; result.recognizedPage = true;
    const saved = state(current);
    for (const [key, elements] of Object.entries(current.controls)) {
      if (!current.owner.value && key !== 'person') continue;
      const proof = proofs.get(current.form);
      if (key !== 'person' && (elements[0].type === 'checkbox' ? proof?.pageKey === PAGE && proof.person === current.options.find(opt => opt.value === current.owner.value) && proof.answers[key] && (proof.answers[key] === 'yes') === elements[0].checked : answered(elements))) continue;
      if (!elements.every(el => editable(el, doc))) continue;
      const binding = { key, element: elements[0], elements };
      previews.set(binding, saved); result.bindings.push(binding); result.fields.push({ key, label: LABELS[key] });
    }
    return result;
  }
  function recordContext(doc, url, bindings) {
    const current = context(doc, url), saved = bindings?.length && previews.get(bindings[0]);
    if (!current || !same(saved, current) || bindings.some(b => previews.get(b) !== saved)) return null;
    const option = current.options.find(opt => opt.value === current.owner.value);
    return option?.value ? { personName: norm(option.textContent) } : {};
  }
  function fill(doc, url, bindings, values) {
    const filled = [], skipped = bindings.map(b => b.key), fail = () => ({ filled: [], skipped, unsafe: true });
    let current = context(doc, url);
    const saved = bindings.length && previews.get(bindings[0]);
    if (!current || !same(saved, current) || bindings.some(b => previews.get(b) !== saved) || !values || typeof values !== 'object' || !format('person', values.person)) return fail();
    const matching = current.options.slice(1).filter(opt => person(opt.textContent) === person(values.person));
    if (matching.length !== 1 || (current.owner.value && current.owner.value !== matching[0].value)) return fail();
    if (!current.owner.value && Object.entries(current.controls).some(([key, elements]) => key !== 'person' && answered(elements))) return fail();
    const amountBox = only(doc, 'answerSets0.answers8.answerValue');
    if (current.controls.selfEmployed && !answered(current.controls.selfEmployed) && norm(amountBox?.value)) return fail();
    // Reject a different existing job before modifying any field, not just a different person.
    for (const key of Object.keys(current.controls)) if (key !== 'person' && values[key] && format(key, values[key]) && !equivalent(current, key, format(key, values[key]))) return fail();
    const prior = proofs.get(current.form);
    const proof = prior?.pageKey === PAGE && prior.person === matching[0] ? prior : { pageKey: PAGE, person: matching[0], answers: {}, anchor: null, monthlyNet: false };
    proofs.set(current.form, proof);
    proof.monthlyNet = values.selfEmployed === 'yes' && values.frequency === 'Monthly';
    for (const binding of bindings) {
      const { key } = binding;
      current = context(doc, url);
      if (!current || current.owner !== saved.controls.find(item => item.el === current.owner)?.el || (current.owner.value && current.owner.value !== matching[0].value)) return { filled, skipped: bindings.filter(b => !filled.includes(b.key)).map(b => b.key), unsafe: true };
      const elements = current.controls[key];
      if (!elements || elements.some((el, index) => el !== binding.elements[index]) || !elements.every(el => editable(el, doc))) continue;
      const value = format(key, values[key]); if (value === null) continue;
      if (key === 'person') {
        if (!current.owner.value) { if (!scroll(current.owner, doc) || !same(saved, context(doc, url))) return fail(); current.owner.value = matching[0].value; current.owner.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); filled.push(key); }
        continue;
      }
      if (current.owner.value !== matching[0].value || !current.working && key !== 'workOrTraining') continue;
      if (elements[0].type === 'checkbox' && elements[0].checked && value === 'yes') proof.answers[key] = 'yes';
      if (answered(elements)) continue;
      if (current.selfEmployed && ['selfEmploymentMonthlyNet', 'frequency'].includes(key) && !proof.monthlyNet) continue;
      const input = elements[0];
      if (input.type === 'checkbox' && value === 'no') { proof.answers[key] = 'no'; continue; }
      const target = input.type === 'radio' ? elements[(current.specs[key].options || ['Yes', 'No']).findIndex(option => option.toLowerCase() === value.toLowerCase())] : input;
      if (!target || !scroll(target, doc) || !context(doc, url)?.controls[key]?.includes(target)) continue;
      if (['radio', 'checkbox'].includes(input.type)) target.click();
      else { const proto = input.tagName === 'SELECT' ? doc.defaultView.HTMLSelectElement.prototype : doc.defaultView.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value); input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); }
      if (existing(context(doc, url) || current, key)) { filled.push(key); if (input.type === 'checkbox') proof.answers[key] = value; }
    }
    current = context(doc, url);
    if (current) proof.anchor = ['employer', 'startDate', 'jobTitle'].map(key => ({ key, value: existing(current, key) }));
    return { filled, skipped: bindings.filter(b => !filled.includes(b.key)).map(b => b.key) };
  }
  function nextButton(doc, current) {
    const buttons = Array.from(current.form.querySelectorAll('button')).filter(el => rendered(el, doc) && norm(el.textContent) === 'Save and Continue');
    if (buttons.length !== 1) return null; const button = buttons[0];
    return button.type === 'button' && button.className === 'btn btn-primary saveButton' && !button.id && !button.hasAttribute('title') && button.getAttribute('onclick') === 'submitAction();return false;' && !button.matches(':disabled') && button.getAttribute('aria-disabled') !== 'true' && !Array.from(button.attributes).some(a => a.name.startsWith('on') && a.name !== 'onclick') && !['formaction', 'formtarget', 'formmethod', 'formnovalidate'].some(name => button.hasAttribute(name)) ? button : null;
  }
  function probePage(doc, url) {
    if (!scope(doc, url)) return null;
    const result = { kind: 'manual', pageKey: PAGE, heading: 'Job and Job History', canAdvance: false, fields: [], checklist: [], requiredRemaining: 0, manualRemaining: 1,
      todo: 'Choose and review a saved job record for this person. Complete any remaining questions in Iowa’s form.', reason: 'SecondHand fills this page only from a saved job record for the person chosen on this page. If no one is chosen yet, it chooses the person the record belongs to. It clicks Save and Continue only when every question that needs an answer has one and Iowa shows no errors or pop-ups. A question SecondHand doesn’t know stops it too.' };
    const current = context(doc, url); if (!current) return result;
    const proof = proofs.get(current.form), covered = new Set(), checklist = [];
    let missing = 0, manual = 0;
    const proofCurrent = proof?.pageKey === PAGE && proof.person.value === current.owner.value && proof.person === current.options.find(opt => opt.value === current.owner.value) && (!proof.anchor || proof.anchor.every(item => item.value === existing(current, item.key)));
    for (const [key, elements] of Object.entries(current.controls)) {
      elements.forEach(el => covered.add(el)); let complete = answered(elements), valid = elements.every(el => !el.matches(':disabled') && el.getAttribute('aria-invalid') !== 'true' && (!el.willValidate || el.validity.valid));
      if (elements[0].type === 'checkbox') complete = Boolean(proofCurrent && proof.answers[key] && (proof.answers[key] === 'yes') === elements[0].checked);
      if (complete && key !== 'person' && !['radio', 'checkbox'].includes(elements[0].type)) {
        let raw = existing(current, key); if (['startDate', 'acquiredDate'].includes(key)) { const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw); raw = parts ? `${parts[3]}-${parts[1]}-${parts[2]}` : ''; }
        valid &&= format(key, raw) !== null;
      }
      const status = !valid ? 'manual' : complete ? 'complete' : 'missing';
      if (status === 'manual') manual++; if (status === 'missing') missing++;
      checklist.push({ key, label: LABELS[key], status, required: true, fillable: status === 'missing' });
    }
    const expected = ['person', 'workOrTraining', 'startDate', 'selfEmployed', 'employer', 'jobTitle', 'monthlyHours', current.selfEmployed ? 'selfEmploymentMonthlyNet' : 'amount', 'frequency', 'tipsOrCommissions', 'incomeExpectedSame', ...changes.map(f => f.key), ...(current.selfEmployed ? ['hasBusinessExpenses'] : [])];
    const unknownControls = Array.from(current.form.querySelectorAll('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="combobox"],[role="checkbox"],[role="radio"]')).some(el => el.type !== 'hidden' && rendered(el, doc) && !covered.has(el));
    const knownQuestions = new Set([current.owner.closest('.questionAnswer'), ...Object.values(current.specs).map(spec => only(doc, spec.question)).filter(Boolean), current.changeQuestion, current.selfEmployed ? current.instruction : null]);
    const unknownQuestions = Array.from(current.form.querySelectorAll('.questionAnswer')).some(el => rendered(el, doc) && !knownQuestions.has(el));
    const error = Array.from(doc.querySelectorAll('[role="alert"],[id*="error" i],[class*="error" i],[aria-busy="true"]')).some(el => rendered(el, doc) && (norm(el.textContent) || el.getAttribute('aria-busy') === 'true'));
    if (!proofCurrent || !current.working || expected.some(key => !current.controls[key]) || unknownControls || unknownQuestions || error || current.selfEmployed && (!proof.monthlyNet || existing(current, 'frequency') !== 'Monthly')) manual++;
    return { ...result, kind: 'fillable', fields: scan(doc, url).fields, checklist, requiredRemaining: missing, manualRemaining: manual, canAdvance: !missing && !manual && Boolean(nextButton(doc, current)) };
  }
  function captureNavigation(doc, url) { if (!probePage(doc, url)?.canAdvance) return null; const current = context(doc, url), token = Object.freeze({}); navigation.set(token, { doc, url, state: state(current), button: nextButton(doc, current), expires: Date.now() + 120000 }); return token; }
  function advance(doc, url, token) {
    const saved = token && navigation.get(token); if (token) navigation.delete(token);
    const fail = () => ({ advanced: false, reason: 'The page or an answer changed. Review it before continuing.' });
    const safe = () => { const current = context(doc, url); return current && same(saved.state, current) && nextButton(doc, current) === saved.button && probePage(doc, url)?.canAdvance; };
    if (!saved || saved.doc !== doc || saved.url !== url || saved.expires < Date.now() || !safe() || !scroll(saved.button, doc) || !safe()) return fail();
    try { saved.button.click(); } catch { return fail(); }
    return { advanced: true, reason: 'Save and Continue was clicked once. Check the next page for required questions or errors.' };
  }
  function focusField(doc, url, key) { const current = context(doc, url), input = current?.controls[key]?.[0]; if (!input || !scroll(input, doc) || context(doc, url)?.controls[key]?.[0] !== input) return false; input.focus({ preventScroll: true }); return doc.activeElement === input; }
  const PAYMENT_TYPES = [['1977', 'Social Security'], ['1986', 'Railroad Retirement'], ['1995', 'Private Pension'], ['1998', 'Deferred Comp'], ['2001', 'Government Employee'], ['2004', 'Retirement - Military'], ['2007', '401K'], ['2010', 'Individual Retirement Account (IRA)'], ['2013', 'Annuity'], ['2818', 'Veteran Aid and Attendance'], ['2822', 'Veteran Disability - Partial'], ['2826', 'Veteran Disability - Total']];
  const RENT_TYPES = [['2999', 'Rent(Amount you are responsible to pay)'], ['1007287', 'Lot Rent(Amount you are responsible to pay)'], ['3126', 'Mortgage(Amount you are responsible to pay)'], ['3003', 'Insurance (Home)(if you pay separate from your mortgage)'], ['3007', "Home-Owner's Association Fees"], ['3011', 'Property Taxes(if you pay separate from your mortgage)']];
  const utilities = [ ['gas', 'Gas'], ['electricity', 'Electricity / Lights'], ['waterSewage', 'Water / Sewage'], ['telephone', 'Telephone'], ['petFees', 'Pet Fees'], ['garageRent', 'Garage Rent'], ['landlordExtra', 'Extra Charges from your Landlord'], ['garbage', 'Garbage / Trash'], ['heatingCooling', 'Any of the utility bills you have to pay are for heating or cooling/air conditioning?'] ];
  const recordPages = [
    { pageKey: 'iowa-retirement-income', recordType: 'otherIncomeSources', heading: 'Income from Other Sources – Retirement, Disability and Death Benefits', phase: 'Other Income', intro: 'Tell us about retirement money that you or someone in your home has.',
      prefix: ':1986,2818,1987,2819,1988,2820,2822,2823,2824,2826,1995,2827,1996,2828,1997,1998,1999,2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2806,2807,1977,2809,1978,2810,1979:1984,2816,1985,2817,1989,2821,1990,1991,1992,1993,2825,1994,2829,2805,2808,2811,1980,2812,1981,2813,1982,2814,1983,2815',
      rule: ':1977,1978,1979,2806,2807,1986,1987,1988,2809,2810,1995,1996,1997,1998,1999,2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2818,2819,2820,2822,2823,2824,2826,2827,2828:2805,1980,1981,1982,1983,1984,1985,2808,1989,1990,1991,1992,1993,1994,2811,2812,2813,2814,2815,2816,2817,2821,2825,2829', types: PAYMENT_TYPES,
      supported: { '1977': { type: 'Social Security', marker: 'question01977', amount: ['question01978', 1, 'How much Social Security?'], frequency: ['question01979', 2, 'How often?'] }, '1995': { type: 'Private Pension', marker: 'question01995', amount: ['question01996', 25, 'How much Private Pension?'], frequency: ['question01997', 26, 'How often?'] } } },
    { pageKey: 'iowa-housing-expenses', recordType: 'housingExpenses', heading: 'Housing Expenses', phase: 'Expenses', intro: 'You told us that there are people in your home that pay for housing costs. Tell us more about these people by filling in the information for all fields for at least one type.',
      prefix: ':3008,3009,3011,3012,3013,1007289,3126,2999,1007288,3127,3000,1007287,3128,3001,3003,3004,3005,3007:3010,1007290,3014,3129,3002,3006',
      rule: ':2999,3000,3001,1007287,1007288,1007289,3126,3127,3128,3003,3004,3005,3007,3008,3009,3011,3012,3013:3002,1007290,3129,3006,3010,3014', types: RENT_TYPES,
      supported: { '2999': { type: 'Rent', aliases: ['Rent(Amount you are responsible to pay)'], marker: 'question02999', amount: ['question03000', 1, 'How much?'], frequency: ['question03001', 2, 'How often'] } } },
    { pageKey: 'iowa-utility-expenses', recordType: 'utilityExpenses', heading: 'Utility Expenses', phase: 'Expenses', intro: 'You told us that there are people in your home that pay for utility costs. Tell us more about these people by selecting all the utilities they pay for.',
      prefix: ':1007291:', rule: ':1007291:', checkbox: { question: 'question01007291', index: 0, legend: 'Utility Type:', options: utilities } },
    { pageKey: 'iowa-liquid-assets', recordType: 'assets', heading: 'Other Property - Liquid Assets', phase: 'Property', intro: 'Tell us about the liquid assets, such as money in bank accounts or stocks/bonds you or someone in your home have.',
      prefix: ':7040,580,581,582,583,3113,3114,3115,3116,3117,4462,1007294,3125:3118', rule: ':580,581,582,583,3125,4462,3113,3114,3115,3116,3117,1007294,7040:3118',
      direct: [
        { key: 'type', question: 'question0580', index: 0, text: 'Type', type: 'assetType', options: ['Annuity Accounts', 'Assistive Technology Accounts', 'Cash/Uncashed Check', 'Certificate of Deposit', 'Checking Account', 'Income Tax Refund', 'Life Estate', 'Life Insurance', 'Money Market', 'Mutual Funds', 'Other Liquid Assets', 'Promissory Notes', 'Retirement Plans', 'Savings/Credit Union Account', 'Stocks/Bonds', 'Tribal Gaming Disbursements', 'Trust', 'Winnings'] },
        { key: 'currentValue', question: 'question0581', index: 1, text: 'Current Value', type: 'money' },
        { key: 'amountOwed', question: 'question0582', index: 2, text: 'Amount Owed (if any)', type: 'money', optional: true },
        { key: 'accountOrPolicy', question: 'question0583', index: 3, text: 'Account/Policy #', type: 'text', optional: true },
        { key: 'institution', question: 'question03125', index: 4, text: 'Name of Bank (if any):', type: 'text', optional: true },
        { key: 'acquiredDate', question: 'question01007294', index: 12, text: 'When did this person get the asset (mm/dd/yyyy)?', type: 'date', optional: true }
      ] }

  ];
  const typedScope = (doc, url) => url === URL ? recordPages.find(page => Array.from(doc.querySelectorAll('h2')).some(el => rendered(el, doc) && norm(el.textContent) === page.heading)) || null : null;
  const requestFor = page => Object.freeze({ recordType: page.recordType, fields: Object.freeze(page.direct ? ['person', ...page.direct.map(item => item.key)] : page.checkbox ? ['person', ...page.checkbox.options.map(([key]) => key)] : ['person', 'type', 'amount', 'frequency']) });
  function typedContext(doc, url) {
    const page = typedScope(doc, url); if (!page || doc.location.href !== url || blocked(doc)) return null;
    const form = only(doc, 'answerSet'), active = doc.querySelectorAll(`a[title="${page.phase} | Active"]`);
    if (!form || form.tagName !== 'FORM' || form.getAttribute('action') !== 'simple' || form.action !== `${PORTAL}/applyForBenefits/simple` || form.method !== 'post' || form.hasAttribute('target') || form.hasAttribute('onsubmit') || active.length !== 1 || !active[0].parentElement.matches('li.current') || !rendered(active[0], doc) || Array.from(form.elements).some(el => !form.contains(el))) return null;
    if (!Array.from(doc.querySelectorAll('p')).some(el => rendered(el, doc) && norm(el.textContent).includes(page.intro))) return null;
    const owner = only(doc, 'answerSets0.personSelection');
    if (!owner || owner.form !== form || owner.tagName !== 'SELECT' || owner.type !== 'select-one' || owner.name !== 'answerSets[0].personSelection' || owner.className !== 'hasScript' || labels(owner) !== 'select a person' || !editable(owner, doc) || Array.from(owner.attributes).some(a => a.name.startsWith('on') && a.name !== 'onchange')) return null;
    const options = [...owner.options];
    if (options.length < 2 || options.length > 21 || options[0].value !== '' || norm(options[0].textContent) !== 'Select One' || options.some(opt => opt.disabled) || options.slice(1).some(opt => !/^(0|[1-9]\d{0,3})$/.test(opt.value) || !safeText(norm(opt.textContent)) || !norm(opt.textContent)) || new Set(options.map(opt => opt.value)).size !== options.length) return null;
    if (owner.getAttribute('onchange') !== `enableDisableQuestions('question0', this, '${page.prefix}${options.slice(1).map(opt => `|${opt.value}${page.rule}`).join('')}')`) return null;
    const controls = { person: [owner] }, specs = {}, knownQuestions = new Set([owner.closest('.questionAnswer')]);
    let type = null, entry = null, selectedType = '';
    if (page.direct) {
      for (const spec of page.direct) { const found = controlsFor(doc, form, spec); if (found) { controls[spec.key] = found; specs[spec.key] = spec; knownQuestions.add(only(doc, spec.question)); } }
      type = controls.type?.[0] || null; if (type?.value && type.value !== 'Cash/Uncashed Check') return null;
    } else if (page.types) {
      type = only(doc, 'questionType');
      if (!type || type.form !== form || type.tagName !== 'SELECT' || type.type !== 'select-one' || type.name !== 'questionType' || type.className !== 'hasScript' || labels(type) !== 'select a type' || Array.from(type.attributes).some(a => a.name.startsWith('on'))) return null;
      if (type.options.length !== page.types.length + 1 || Array.from(type.options).some((opt, index) => opt.disabled || opt.value !== (index ? page.types[index - 1][0] : '') || norm(opt.textContent) !== (index ? page.types[index - 1][1] : 'Select One'))) return null;
      if (type.value && !Object.hasOwn(page.supported, type.value)) return null;
      controls.type = [type]; knownQuestions.add(type.closest('.questionAnswer'));
      const expanded = Object.entries(page.supported).filter(([, candidate]) => ['amount', 'frequency'].some(key => { const [question, index, text] = candidate[key]; return controlsFor(doc, form, { key, question, index, text, type: key === 'amount' ? 'money' : 'select' }); }));
      if (expanded.length > 1 || expanded.length === 1 && type.value && expanded[0][0] !== type.value) return null;
      selectedType = expanded[0]?.[0] || type.value;
      entry = page.supported[selectedType];
      if (entry) {
        const marker = only(doc, entry.marker);
        if (!marker || !form.contains(marker) || !marker.classList.contains('questionAnswer') || !marker.classList.contains('hiddenLabel') || norm(marker.textContent) !== page.types.find(([id]) => id === selectedType)[1]) return null;
        knownQuestions.add(marker);
        for (const key of ['amount', 'frequency']) {
          const [question, index, text] = entry[key], spec = { key, question, index, text, type: key === 'amount' ? 'money' : 'select' };
          const found = controlsFor(doc, form, spec); if (found) { controls[key] = found; specs[key] = spec; knownQuestions.add(only(doc, question)); }
        }
      }
    } else {
      const group = only(doc, page.checkbox.question), expected = page.checkbox.options, name = `answerSets[0].answers[${page.checkbox.index}].answerValues`;
      if (group && form.contains(group) && rendered(group, doc) && label(group.querySelector('legend')?.textContent) === label(page.checkbox.legend)) {
        knownQuestions.add(group);
        const named = Array.from(form.querySelectorAll('input')).filter(el => el.name === name);
        for (let index = 0; index < expected.length; index++) {
          const [key, text] = expected[index], input = only(doc, `answerSets0.answers${page.checkbox.index}.answerValues${index + 1}`);
          if (named.length !== expected.length || input !== named[index] || input.form !== form || !group.contains(input) || input.type !== 'checkbox' || input.className !== 'hasScript' || input.value !== text || labels(input) !== label(text) || input.getAttribute('onclick') !== hide('') || Array.from(input.attributes).some(a => a.name.startsWith('on') && a.name !== 'onclick')) continue;
          controls[key] = [input]; specs[key] = { key, type: 'checkbox' };
        }
      }
    }
    return { page, form, active: active[0], owner, options, controls, specs, type, entry, selectedType, knownQuestions };
  }
  function typedLabel(current, key) { if (current.page.direct && key !== 'person') return current.page.direct.find(spec => spec.key === key)?.text || key; return key === 'person' ? 'Person this record belongs to' : key === 'type' ? 'Type of income or housing cost' : key === 'amount' ? current.page.recordType === 'housingExpenses' ? 'Your share of rent' : 'Current payment amount' : key === 'frequency' ? LABELS.frequency : current.page.checkbox.options.find(([name]) => name === key)?.[1] || key; }
  function typedScan(doc, url) {
    const result = { supported: url === URL, recognizedPage: false, fields: [], bindings: [], ambiguous: [], skipped: 0 }, current = typedContext(doc, url);
    if (!current) return result; result.recognizedPage = true; const saved = state(current), proof = proofs.get(current.form);
    for (const [key, elements] of Object.entries(current.controls)) {
      if (!current.owner.value && key !== 'person' || !elements.every(el => editable(el, doc))) continue;
      if (key === 'type' && current.page.types && current.selectedType) continue;
      if (key !== 'person' && (elements[0].type === 'checkbox' ? proof?.pageKey === current.page.pageKey && proof.person === current.options.find(opt => opt.value === current.owner.value) && proof.answers[key] && (proof.answers[key] === 'yes') === elements[0].checked : answered(elements))) continue;
      const binding = { key, element: elements[0], elements }; previews.set(binding, saved); result.bindings.push(binding); result.fields.push({ key, label: typedLabel(current, key) });
    }
    return result;
  }
  function typedRecordContext(doc, url, bindings) {
    const current = typedContext(doc, url), saved = bindings?.length && previews.get(bindings[0]);
    if (!current || !same(saved, current) || bindings.some(binding => previews.get(binding) !== saved)) return null;
    return current.owner.value ? { personName: norm(current.options.find(opt => opt.value === current.owner.value)?.textContent) } : {};
  }
  function typedFill(doc, url, bindings, values) {
    const filled = [], fail = () => ({ filled: [], skipped: bindings.map(b => b.key), unsafe: true });
    let current = typedContext(doc, url); const saved = bindings.length && previews.get(bindings[0]);
    if (!current || !same(saved, current) || bindings.some(b => previews.get(b) !== saved) || !values || !format('person', values.person)) return fail();
    const owners = current.options.slice(1).filter(opt => person(opt.textContent) === person(values.person));
    if (owners.length !== 1 || current.owner.value && current.owner.value !== owners[0].value) return fail();
    const typeId = current.page.types ? Object.entries(current.page.supported).find(([, item]) => item.type === values.type || item.aliases?.includes(values.type))?.[0] : null;
    if (current.page.types && (!typeId || current.selectedType && current.selectedType !== typeId)) return fail();
    if (current.page.direct && values.type !== 'Cash/Uncashed Check') return fail();
    if (!current.owner.value && Object.entries(current.controls).some(([key, elements]) => key !== 'person' && answered(elements))) return fail();
    const expected = {};
    for (const [key, elements] of Object.entries(current.controls)) {
      if (key === 'person' || key === 'type' && !current.page.direct) continue;
      const value = current.page.checkbox ? ['yes', 'no'].includes(values[key]) ? values[key] : null : format(key, values[key]);
      if (value !== null) expected[key] = value;
      if (value !== null && !equivalent(current, key, value)) return fail();
    }
    const prior = proofs.get(current.form);
    const proof = prior?.pageKey === current.page.pageKey && prior.person === owners[0] ? prior : { pageKey: current.page.pageKey, person: owners[0], answers: {}, expected: {} };
    proof.typeId = typeId; Object.assign(proof.expected, expected); proofs.set(current.form, proof);
    for (const binding of bindings) {
      current = typedContext(doc, url); if (!current || current.owner !== saved.controls.find(item => item.el === current.owner)?.el || current.owner.value && current.owner.value !== owners[0].value) return { ...fail(), filled };
      const { key, elements } = binding;
      if (current.controls[key]?.some((el, index) => el !== elements[index]) || !current.controls[key] || !elements.every(el => editable(el, doc))) continue;
      const input = elements[0];
      if (key === 'person') {
        if (!input.value) { if (!scroll(input, doc) || !same(saved, typedContext(doc, url))) return fail(); input.value = owners[0].value; input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); filled.push(key); }
        continue;
      }
      if (current.owner.value !== owners[0].value) continue;
      const value = key === 'type' && !current.page.direct ? typeId : current.page.checkbox ? ['yes', 'no'].includes(values[key]) ? values[key] : null : format(key, values[key]);
      if (value === null) continue;
      if (input.type === 'checkbox') { proof.answers[key] = value; if (value === 'no' || input.checked) continue; }
      else if (norm(input.value)) continue;
      if (!scroll(input, doc) || typedContext(doc, url)?.controls[key]?.[0] !== input) continue;
      if (input.type === 'checkbox') input.click();
      else { const proto = input.tagName === 'SELECT' ? doc.defaultView.HTMLSelectElement.prototype : doc.defaultView.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value); input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); input.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); }
      filled.push(key);
    }
    return { filled, skipped: bindings.filter(b => !filled.includes(b.key)).map(b => b.key) };
  }
  function typedProbe(doc, url) {
    const page = typedScope(doc, url); if (!page) return null;
    const base = { kind: 'manual', pageKey: page.pageKey, heading: page.heading, canAdvance: false, fields: [], checklist: [], requiredRemaining: 0, manualRemaining: 1,
      todo: 'Choose and review a saved record for this person. Complete any remaining questions in Iowa’s form.', reason: 'SecondHand fills this page only from a saved record for the person chosen on this page. If no one is chosen yet, it chooses the person the record belongs to. It clicks Save and Continue only when every question that needs an answer has one and Iowa shows no errors or pop-ups. A question SecondHand doesn’t know stops it too.' };
    const current = typedContext(doc, url); if (!current) return base;
    const proof = proofs.get(current.form), covered = new Set(), checklist = [];
    let missing = 0, manual = 0;
    const validProof = proof?.pageKey === page.pageKey && proof.person === current.options.find(opt => opt.value === current.owner.value) && (!page.types || proof.typeId === current.selectedType);
    const keys = requestFor(page).fields;
    for (const key of keys) {
      const elements = current.controls[key]; if (!elements) { manual++; continue; } elements.forEach(el => covered.add(el));
      const input = elements[0]; let complete = key === 'type' && page.types ? Boolean(current.selectedType) : answered(elements), valid = !input.matches(':disabled') && input.getAttribute('aria-invalid') !== 'true' && (!input.willValidate || input.validity.valid);
      if (input.type === 'checkbox') complete = Boolean(validProof && proof.answers[key] && (proof.answers[key] === 'yes') === input.checked);
      else if (['amount', 'frequency'].includes(key) || page.direct && key !== 'person') {
        let value = input.value; if (key === 'acquiredDate') { const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value); value = parts ? `${parts[3]}-${parts[1]}-${parts[2]}` : ''; }
        valid &&= !complete || Boolean(format(key, value) && validProof && proof.expected[key] && equivalent(current, key, proof.expected[key]));
      }
      const optional = Boolean(current.specs[key]?.optional);
      const status = !valid ? 'manual' : complete ? 'complete' : optional ? 'optional' : 'missing'; if (status === 'missing') missing++; if (status === 'manual') manual++;
      checklist.push({ key, label: typedLabel(current, key), status, required: !optional, fillable: status === 'missing' && rendered(input, doc) });
    }
    const unknown = Array.from(current.form.querySelectorAll('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="combobox"],[role="checkbox"],[role="radio"]')).some(el => el.type !== 'hidden' && rendered(el, doc) && !covered.has(el)) || Array.from(current.form.querySelectorAll('.questionAnswer')).some(el => rendered(el, doc) && !current.knownQuestions.has(el));
    const error = Array.from(doc.querySelectorAll('[role="alert"],[id*="error" i],[class*="error" i],[aria-busy="true"]')).some(el => rendered(el, doc) && (norm(el.textContent) || el.getAttribute('aria-busy') === 'true'));
    if (!validProof || unknown || error) manual++;
    return { ...base, kind: 'fillable', fields: typedScan(doc, url).fields, checklist, requiredRemaining: missing, manualRemaining: manual, canAdvance: !missing && !manual && Boolean(nextButton(doc, current)) };
  }
  function typedCapture(doc, url) { if (!typedProbe(doc, url)?.canAdvance) return null; const current = typedContext(doc, url), token = Object.freeze({}); navigation.set(token, { typed: true, doc, url, state: state(current), button: nextButton(doc, current), expires: Date.now() + 120000 }); return token; }
  function typedAdvance(doc, url, token) {
    const saved = token && navigation.get(token); if (token) navigation.delete(token);
    const fail = () => ({ advanced: false, reason: 'The page or an answer changed. Review it before continuing.' });
    const safe = () => { const current = typedContext(doc, url); return current && same(saved.state, current) && nextButton(doc, current) === saved.button && typedProbe(doc, url)?.canAdvance; };
    if (!saved || saved.doc !== doc || saved.url !== url || saved.expires < Date.now() || !safe() || !scroll(saved.button, doc) || !safe()) return fail();
    try { saved.button.click(); } catch { return fail(); }
    return { advanced: true, reason: 'Save and Continue was clicked once. Check the next page for required questions or errors.' };
  }
  const api = Object.freeze({ PORTAL, NAVIGATION_PAGE_KEYS: Object.freeze([PAGE, ...recordPages.map(page => page.pageKey)]),
    scan: (doc, url) => typedScope(doc, url) ? typedScan(doc, url) : scan(doc, url),
    fill: (doc, url, bindings, values) => typedScope(doc, url) ? typedFill(doc, url, bindings, values) : fill(doc, url, bindings, values),
    probePage: (doc, url) => typedProbe(doc, url) || probePage(doc, url),
    captureNavigation: (doc, url) => typedScope(doc, url) ? typedCapture(doc, url) : captureNavigation(doc, url),
    advance: (doc, url, token) => navigation.get(token)?.typed ? typedAdvance(doc, url, token) : advance(doc, url, token),
    focusField: (doc, url, key) => { if (!typedScope(doc, url)) return focusField(doc, url, key); const input = typedContext(doc, url)?.controls[key]?.[0]; if (!input || !scroll(input, doc)) return false; input.focus({ preventScroll: true }); return doc.activeElement === input; },
    recordContext: (doc, url, bindings) => typedScope(doc, url) ? typedRecordContext(doc, url, bindings) : recordContext(doc, url, bindings),
    recordRequest: pageKey => pageKey === PAGE ? REQUEST : recordPages.some(page => page.pageKey === pageKey) ? requestFor(recordPages.find(page => page.pageKey === pageKey)) : null });
  if (typeof module === 'object' && module.exports) module.exports = api; else root.SecondHandIowaRecords = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
