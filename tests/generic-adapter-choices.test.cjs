'use strict';
// #184: a student pantry's intake (Jotform) asked for the student status, the help wanted, where the income comes from, and
// whether the family gets cash assistance. The rules answer them from the saved lists: an option is checked only when it is
// the one option that names a saved answer. Options one saved answer names together stay unchecked, and the question stays open.
const test = require('node:test');
const assert = require('node:assert/strict');
const generic = require('../extension/generic-adapter.js');
const { laidOut } = require('./helpers/harness.cjs');

const page = html => laidOut(html, 'https://pantry.example.org/intake');
const keysOf = result => result.matched.map(item => item.key);
const fillAll = (doc, result, saved) => generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), generic.deriveValues(saved));
const checked = (doc, name) => [...doc.querySelectorAll(`input[name="${name}"]`)].filter(box => box.checked).map(box => box.value);

// The live form's markup, as Jotform draws a radio group and a checkbox group: a label the group names with aria-labelledby.
const item = (type, n, q, value) => `<span class="form-${type}-item"><input type="${type}" class="form-${type}" id="input_${q}_${n}" name="q${q}[]" value="${value}"><label id="label_input_${q}_${n}" for="input_${q}_${n}">${value}</label></span>`;
const question = (type, q, label, options) => `<li class="form-line jf-required" data-type="control_${type}" id="id_${q}"><label class="form-label form-label-top" id="label_${q}" for="input_${q}">${label}<span class="form-required">*</span></label>
  <div id="cid_${q}" class="form-input-wide jf-required"><div class="form-single-column" role="${type === 'radio' ? 'radiogroup' : 'group'}" aria-labelledby="label_${q}">${options.map((value, n) => item(type, n, q, value)).join('')}</div></div></li>`;
const QA = {
  student: ['radio', 3, 'Student Status', ['Undergraduate', 'Graduate', 'Feirstein Graduate']],
  help: ['checkbox', 4, 'Assistance/Information Needed', ['Fresh Food', 'Vouchers', 'Food Pantry', 'Grocery Gift Cards', 'Social Services']],
  income: ['checkbox', 5, 'Current Source of Income/Resources', ['Financial Aid', 'Family Support', 'On-Campus Job', 'Off-Campus Job', 'Other Support']],
  cash: ['radio', 6, 'Do you or anyone in your family receive Cash Assistance through NYC HRA?', ['Yes', 'No']]
};
const qaForm = (...which) => `<form class="jotform-form"><ul>${(which.length ? which : Object.keys(QA)).map(name => question(...QA[name])).join('')}</ul></form>`;

test('the live form’s four questions are matched to the saved answers, and one request asks for the saved lists', () => {
  const result = generic.plan(page(qaForm()));
  assert.deepEqual(keysOf(result), ['studentLevel', 'helpWanted', 'incomeSources', 'receivesCashAssistance']);
  assert.deepEqual(result.unmatched, []);
  assert.deepEqual(generic.requestKeys(keysOf(result)), ['studentLevel', 'helpWanted', 'incomeSources', 'currentBenefits']);
});

test('the live form fills from saved answers: each saved answer checks the one option that names it', () => {
  const doc = page(qaForm());
  const result = generic.plan(doc);
  const filled = fillAll(doc, result, { studentLevel: 'undergraduate', helpWanted: 'food-pantry,fresh-produce,snap-help', incomeSources: 'financial-aid,family-support', currentBenefits: 'snap' });
  assert.deepEqual(filled.filled, result.matched.map(item => item.id));
  assert.deepEqual(checked(doc, 'q3[]'), ['Undergraduate']);
  assert.deepEqual(checked(doc, 'q4[]'), ['Fresh Food', 'Food Pantry'], 'help applying for SNAP is on no option, and the other options are left alone');
  assert.deepEqual(checked(doc, 'q5[]'), ['Financial Aid', 'Family Support']);
  assert.deepEqual(checked(doc, 'q6[]'), ['No'], 'a household that gets SNAP alone gets no cash assistance');
  assert.ok([...doc.querySelectorAll('input:checked')].every(box => box.getAttribute('data-secondhand-filled') === 'rule'));
});

test('a saved answer that names several options leaves those options unchecked and the question open; the rest are checked', () => {
  // On-Campus Job and Off-Campus Job are both a job: which one is the applicant's can't be told.
  const doc = page(qaForm('income'));
  const result = generic.plan(doc);
  const filled = fillAll(doc, result, { incomeSources: 'job,financial-aid,family-support' });
  assert.deepEqual([filled.filled, filled.partial], [[result.matched[0].id], [result.matched[0].id]], 'filled, and only in part');
  assert.deepEqual(checked(doc, 'q5[]'), ['Financial Aid', 'Family Support']);
  // The question stays in the plan as one the rules matched, marked as answered in part: it still needs the applicant, and isn't filled again.
  const again = generic.plan(doc);
  assert.deepEqual(again.matched.map(({ key, partial }) => ({ key, partial })), [{ key: 'incomeSources', partial: true }]);
  assert.deepEqual(fillAll(doc, again, { incomeSources: 'job,financial-aid,family-support' }).filled, []);
  assert.deepEqual(checked(doc, 'q5[]'), ['Financial Aid', 'Family Support']);
  assert.deepEqual(generic.navigationFields(doc).map(field => field.answered), [false], 'Fill and continue never moves on past it');
  // Once the applicant checks a box of their own, it is answered.
  doc.getElementById('input_5_2').click();
  assert.deepEqual(generic.plan(doc).matched, []);
  assert.deepEqual(generic.navigationFields(doc).map(field => field.answered), [true]);
  // With a job alone, no option is the job's: nothing is checked, and the question stays open as it was.
  const job = page(qaForm('income'));
  const plan = generic.plan(job);
  const none = fillAll(job, plan, { incomeSources: 'job' });
  assert.deepEqual([none.filled, none.partial, checked(job, 'q5[]')], [[], [], []]);
  assert.deepEqual(generic.plan(job).matched.map(({ key, partial }) => ({ key, partial })), [{ key: 'incomeSources', partial: undefined }]);
  // A graduate student at Feirstein is a graduate student too. A question with one answer can't be answered in part.
  const student = page(qaForm('student'));
  assert.deepEqual(fillAll(student, generic.plan(student), { studentLevel: 'graduate' }).filled, []);
  assert.deepEqual(checked(student, 'q3[]'), []);
});

test('a question answered in full reports nothing as partial', () => {
  const doc = page(qaForm('income', 'help'));
  const filled = fillAll(doc, generic.plan(doc), { incomeSources: 'financial-aid,other', helpWanted: 'food-pantry' });
  assert.deepEqual([filled.filled.length, filled.partial], [2, []]);
  assert.deepEqual(generic.plan(doc).matched, []);
});

test('an answer no option names fills nothing, and Other and None go only to their own options', () => {
  const cases = [
    ['student', { studentLevel: 'not-student' }, 'q3[]', []],
    ['student', { studentLevel: 'high-school' }, 'q3[]', []],
    ['income', { incomeSources: 'pension' }, 'q5[]', []],
    ['income', { incomeSources: 'none' }, 'q5[]', []],
    ['income', { incomeSources: 'other' }, 'q5[]', ['Other Support']],
    ['help', { helpWanted: 'snap-help,other' }, 'q4[]', []],
    ['cash', { currentBenefits: 'cash-assistance' }, 'q6[]', ['Yes']],
    ['cash', { currentBenefits: 'none' }, 'q6[]', ['No']],
    ['cash', {}, 'q6[]', []]
  ];
  for (const [name, saved, group, expected] of cases) {
    const doc = page(qaForm(name));
    fillAll(doc, generic.plan(doc), saved);
    assert.deepEqual(checked(doc, group), expected, `${name}: ${JSON.stringify(saved)}`);
  }
});

test('common wordings of the four questions are matched, and their options read the same way', () => {
  const radios = (label, options, name = 'r') => `<fieldset><legend>${label}</legend>${options.map(option => `<label><input type="radio" name="${name}" value="${option}"> ${option}</label>`).join('')}</fieldset>`;
  const boxes = (label, options, name = 'c') => `<fieldset><legend>${label}</legend>${options.map(option => `<label><input type="checkbox" name="${name}" value="${option}"> ${option}</label>`).join('')}</fieldset>`;
  const select = (label, options) => `<label for="s">${label}</label><select id="s"><option value="">Choose one</option>${options.map(option => `<option>${option}</option>`).join('')}</select>`;
  const levels = ['Not a student', 'High school', 'Undergraduate', 'Graduate student'];
  const sources = ['Employment', 'Self-employed', 'Student loans', 'Money from family', 'Unemployment', 'Social Security/SSI/SSDI', 'Child support', 'Pension', 'None'];
  const benefits = ['SNAP (Food Stamps)', 'WIC', 'TANF', 'Medicaid', 'SSI', 'Section 8', 'Free or reduced school lunch', 'None of the above'];
  const help = ['Food pantry', 'Fresh produce', 'Meal vouchers', 'Gift cards', 'Help applying for SNAP', 'Social services'];
  const cases = [
    [radios('What is your student status?', levels), 'studentLevel'], [radios('Are you currently a student?', levels), 'studentLevel'],
    [select('Student level', levels), 'studentLevel'], [radios('Current student status *', levels), 'studentLevel'],
    [boxes('Sources of income', sources), 'incomeSources'], [boxes('What are your sources of income?', sources), 'incomeSources'],
    [boxes('Source(s) of household income (check all that apply)', sources), 'incomeSources'], [boxes('Income sources', sources), 'incomeSources'],
    [boxes('Where does your household’s income come from?', sources), 'incomeSources'], [boxes('Type of income received', sources), 'incomeSources'],
    [boxes('Current benefits', benefits), 'currentBenefits'], [boxes('Which benefits do you currently receive?', benefits), 'currentBenefits'],
    [boxes('Do you or anyone in your household receive any of the following benefits?', benefits), 'currentBenefits'],
    [boxes('Benefits currently received', benefits), 'currentBenefits'],
    [boxes('What kind of help do you need?', help), 'helpWanted'], [boxes('Services needed', help), 'helpWanted'],
    [boxes('Type of assistance needed', help), 'helpWanted'], [boxes('What services are you interested in?', help), 'helpWanted'],
    [radios('Does your household receive SNAP?', ['Yes', 'No']), 'receivesSnap'], [radios('Is anyone in your household receiving SNAP (food stamps) benefits?', ['Yes', 'No']), 'receivesSnap'],
    [radios('Does anyone in your household get WIC?', ['Yes', 'No']), 'receivesWic'], [radios('Does your family receive TANF?', ['Yes', 'No']), 'receivesCashAssistance'],
    [radios('Is anyone in your household on Medicaid?', ['Yes', 'No']), 'receivesMedicaid'], [radios('Does anyone in your household receive SSI?', ['Yes', 'No']), 'receivesSsi'],
    [radios('Does your household receive housing assistance?', ['Yes', 'No']), 'receivesHousingAssistance'],
    [radios('Does anyone in your household receive free or reduced school meals?', ['Yes', 'No']), 'receivesSchoolMeals']
  ];
  for (const [html, key] of cases) assert.deepEqual(keysOf(generic.plan(page(html))), [key], html);
  const fill = (html, saved) => { const doc = page(html); fillAll(doc, generic.plan(doc), saved); return [...doc.querySelectorAll('input:checked, option:checked')].map(node => node.value).filter(Boolean); };
  assert.deepEqual(fill(boxes('Sources of income', sources), { incomeSources: 'job,self-employment,financial-aid,family-support,unemployment,social-security,child-support,pension' }), sources.slice(0, -1));
  assert.deepEqual(fill(boxes('Sources of income', sources), { incomeSources: 'none' }), ['None']);
  assert.deepEqual(fill(boxes('Current benefits', benefits), { currentBenefits: 'snap,wic,cash-assistance,medicaid,ssi,housing,school-meals' }), benefits.slice(0, -1));
  assert.deepEqual(fill(boxes('Current benefits', benefits), { currentBenefits: 'none' }), ['None of the above']);
  assert.deepEqual(fill(boxes('What kind of help do you need?', help), { helpWanted: 'food-pantry,fresh-produce,food-vouchers,gift-cards,snap-help,social-services' }), help);
  assert.deepEqual(fill(select('Student level', levels), { studentLevel: 'not-student' }), ['Not a student']);
  assert.deepEqual(fill(radios('What is your student status?', levels), { studentLevel: 'graduate' }), ['Graduate student']);
  assert.deepEqual(fill(radios('Does your household receive SNAP?', ['Yes', 'No']), { currentBenefits: 'snap,wic' }), ['Yes']);
  assert.deepEqual(fill(radios('Does anyone in your household receive SSI?', ['Yes', 'No']), { currentBenefits: 'snap,wic' }), ['No']);
});

test('questions that only sound alike stay with the applicant: programs applied for, one person’s benefit, education finished, another state', () => {
  const radios = (label, options) => `<fieldset><legend>${label}</legend>${options.map(option => `<label><input type="radio" name="r" value="${option}"> ${option}</label>`).join('')}</fieldset>`;
  const boxes = (label, options) => `<fieldset><legend>${label}</legend>${options.map(option => `<label><input type="checkbox" name="c" value="${option}"> ${option}</label>`).join('')}</fieldset>`;
  for (const html of [
    boxes('Which programs are you applying for?', ['SNAP', 'WIC', 'Medicaid']),
    boxes('Which benefits would you like to apply for?', ['SNAP', 'WIC', 'Medicaid']),
    radios('Do you receive SNAP?', ['Yes', 'No']),
    radios('Does your household receive SNAP in another state?', ['Yes', 'No']),
    radios('Does your household receive SNAP from another state?', ['Yes', 'No']),
    radios('Highest level of education', ['High school', 'Undergraduate', 'Graduate']),
    radios('Primary source of income', ['Employment', 'Pension']),
    radios('Are you a student?', ['Yes', 'No']),
    boxes('Student Status', ['Full-time', 'Part-time']),
    boxes('Sources of income', ['Option A', 'Option B']),
    radios('Do you receive SNAP? (spouse)', ['Yes', 'No'])
  ]) assert.deepEqual(keysOf(generic.plan(page(html))), [], html);
});

test('a question already answered is never changed, and Google Forms checkboxes stay with the applicant', () => {
  const doc = page(qaForm('income', 'help'));
  doc.getElementById('input_5_0').checked = true;
  const result = generic.plan(doc);
  assert.deepEqual(keysOf(result), ['helpWanted'], 'an answered question is not planned');
  const google = page(`<div role="listitem"><div role="heading" id="g">Assistance/Information Needed</div><div role="group" aria-labelledby="g">${['Fresh Food', 'Food Pantry'].map(value =>
    `<div role="checkbox" aria-label="${value}" data-answer-value="${value}" aria-checked="false" tabindex="0"></div>`).join('')}</div></div>`);
  assert.deepEqual(keysOf(generic.plan(google)), []);
});

test('each yes or no about a benefit comes from the saved list of everything the household gets now; nothing while the list is unanswered', () => {
  const derived = currentBenefits => Object.fromEntries(Object.entries(generic.deriveValues({ currentBenefits })).filter(([key]) => key.startsWith('receives')));
  assert.deepEqual(derived('snap,school-meals'), { receivesSnap: 'yes', receivesWic: 'no', receivesCashAssistance: 'no', receivesMedicaid: 'no', receivesSsi: 'no',
    receivesHousingAssistance: 'no', receivesSchoolMeals: 'yes' });
  assert.deepEqual(Object.values(derived('none')), Array(7).fill('no'));
  assert.deepEqual(derived(''), {});
  assert.deepEqual(derived(undefined), {});
  for (const key of Object.keys(derived('none'))) assert.deepEqual(generic.requestKeys([key]), ['currentBenefits'], key);
  // Only the rules place these: never a guess, and never an answer saved from a page.
  for (const key of [...generic.CHOICE_KEYS]) assert.ok(!generic.GENERIC_KEYS.includes(key) && !generic.SAVE_KEYS.includes(key), key);
});
