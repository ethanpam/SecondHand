'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const generic = require('../extension/generic-adapter.js');
const forms = require('./fixtures/pantry-forms.cjs');
const { laidOut } = require('./helpers/harness.cjs');

const page = (html, url = 'https://pantry.example.org/intake') => laidOut(html, url);
// Radio groups are named by the group, other controls by their id.
const controlName = element => (element?.type === 'radio' ? element.name : element?.id || element?.name);
const byElement = (doc, result) => Object.fromEntries(result.matched.map(item => [controlName(generic.elementFor(item.id)) || item.id, item.key]));
const profile = {
  firstName: 'Avery', middleName: 'Jordan', lastName: 'Example', birthDate: '1985-04-12', email: 'avery.example@example.invalid',
  mobilePhone: '2025550148', homePhone: '2025550147', addressLine1: '123 Test Way', addressLine2: 'Unit 4', city: 'Demo City', state: 'IA', zip: '50309',
  householdSize: '3', householdAdults: '2', householdChildren: '1', householdSeniors: '0', householdVeteran: 'no', householdDisability: 'yes',
  monthlyEarnedIncome: '900', monthlyOtherIncome: '100', monthlyRent: '800', monthlyUtilities: '150'
};

test('a plain pantry intake form maps every common question to the saved profile', () => {
  const doc = page(forms.plainPantry);
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), {
    fname: 'firstName', lname: 'lastName', dob: 'birthDate', addr: 'addressLine1', city: 'city', st: 'state', zip: 'zip',
    phone: 'phone', email: 'email', hh: 'householdSize', adults: 'householdAdults', kids: 'householdChildren', seniors: 'householdSeniors',
    vet: 'householdVeteran', income: 'totalMonthlyIncome'
  });
  assert.ok(result.matched.every(item => item.confidence === 'high'));
  assert.deepEqual(result.unmatched.map(field => field.label), ['Anything else we should know?']);
  assert.equal(typeof result.token, 'string');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Create a password|Card number/, 'password and card fields are never scanned');
});

test('Google Forms and Jotform layouts map through aria-labelledby, autocomplete, sub-labels, and questions', () => {
  const google = page(forms.googleStyle);
  const googleResult = generic.plan(google);
  assert.deepEqual(googleResult.matched.map(item => item.key), ['fullName', 'email', 'zip', 'householdSize']);
  assert.equal(googleResult.unmatched.length, 0);
  const jot = page(forms.jotformStyle);
  const jotResult = generic.plan(jot);
  assert.deepEqual(byElement(jot, jotResult), { first_3: 'firstName', last_3: 'lastName', input_4: 'state', input_5: 'monthlyRent' });
  assert.deepEqual(jotResult.unmatched.map(field => field.label), ['Tell us about your situation']);
});

test('numbered and run-together questions match once the number is dropped and words are split', () => {
  const doc = page(forms.numberedGoogle);
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { email: 'email', phone: 'phone', zip: 'zip', dob: 'birthDate', city: 'city' });
  assert.deepEqual(result.unmatched.map(field => field.label), ['6. U.S. citizen?']);
});

test('"first and last name" is a full name; asides in parentheses are dropped unless they change who is asked', () => {
  const labels = ['Full Name (First and Last Name) *', 'First & last name', 'Phone (optional)', 'Last name (spouse)', 'Name (of your pet)', 'Phone (work)', 'Guardian phone'];
  const doc = page(labels.map((label, index) => `<label for="f${index}">${label}</label><input id="f${index}">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { f0: 'fullName', f1: 'fullName', f2: 'phone' });
  assert.deepEqual(result.unmatched.map(field => field.label), ['Last name (spouse)', 'Name (of your pet)', 'Phone (work)', 'Guardian phone']);
});

test('a guardian’s or parent’s name is never filled: the applicant being that person would be a guess', () => {
  const labels = ['2. Guardian first and last name', 'Parent/Guardian First and Last Name', 'Guardian name', 'Parent first and last name', 'Name of parent or guardian'];
  const doc = page(labels.map((label, index) => `<label for="g${index}">${label}</label><input id="g${index}" autocomplete="name">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, [], 'not by the rules, nor by the box’s autocomplete hint');
  for (const item of result.unmatched) for (const key of ['fullName', 'firstName', 'lastName', 'studentNameGrade']) assert.equal(generic.canSuggest(key, item), false, `${item.label}: ${key}`);
  const filled = generic.fillFields(doc, result.token, result.unmatched.map(({ id }) => ({ id, key: 'fullName', guessed: true })), generic.deriveValues({ firstName: 'Avery', lastName: 'Example' }));
  assert.deepEqual(filled.filled, [], 'a guess naming the applicant is refused too');
});

test('a generic date or time sub-label is read together with its question, and birth dates go only to birth questions', () => {
  const doc = page(forms.googleDates);
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { dob: 'birthDate' });
  assert.deepEqual(result.unmatched.map(field => field.label),
    ['5.Date ordered: Date', 'Pickup time: Hour', 'Pickup time: Minute', 'Birthday: Month', 'Birthday: Day', 'Birthday: Year']);
  for (const label of ['5.Date ordered: Date', 'Birthday: Month', 'Month of birth', 'Child’s date of birth', 'Date'])
    assert.equal(generic.canSuggest('birthDate', { label }), false, label);
  for (const label of ['Your birthday', 'Date of birth (MM/DD/YYYY)']) assert.equal(generic.canSuggest('birthDate', { label }), true, label);
  assert.equal(generic.canSuggest('email', { label: 'Date' }), true);
  assert.equal(generic.canSuggest('password', { label: 'Password' }), false);
  // A guessed birth date is never placed in a question that is not about birth.
  const ordered = result.unmatched.find(field => field.label.startsWith('5.'));
  const month = result.unmatched.find(field => field.label === 'Birthday: Month');
  const dob = result.matched.find(item => item.key === 'birthDate');
  const filled = generic.fillFields(doc, result.token, [{ id: ordered.id, key: 'birthDate', guessed: true }, { id: month.id, key: 'birthDate', guessed: false },
    { id: dob.id, key: 'birthDate', guessed: false }], generic.deriveValues(profile));
  assert.deepEqual(filled.filled, [dob.id]);
  assert.equal(doc.getElementById('ordered').value, '');
  assert.equal(doc.getElementById('month').value, '');
  assert.equal(doc.getElementById('dob').value, '1985-04-12');
});

// Google registers a choice when its div[role=radio] is clicked; this stands in for its script.
function googleClicks(doc) {
  const clicks = [];
  for (const option of doc.querySelectorAll('[role="radiogroup"] [role="radio"]')) {
    option.addEventListener('click', () => {
      clicks.push(option.getAttribute('data-value'));
      for (const other of option.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')) other.setAttribute('aria-checked', String(other === option));
    });
  }
  return clicks;
}

test('Google Forms choice questions are planned, counted as need-you, and filled by clicking the matching option', () => {
  const doc = page(forms.googleChoices);
  const clicks = googleClicks(doc);
  const result = generic.plan(doc);
  assert.deepEqual(result.matched.map(item => item.key), ['householdSize', 'householdVeteran']);
  assert.deepEqual(result.unmatched.map(({ label, type, options, required }) => ({ label, type, options, required })), [
    { label: 'Which pantry location?', type: 'radio', options: ['North', 'South'], required: true },
    { label: 'Which items do you need?', type: 'checkbox', options: ['Produce', 'Dairy'], required: true },
    { label: 'County', type: 'listbox', options: ['Polk', 'Story'], required: true }
  ], 'an answered question is not planned; the rest wait for the applicant');
  const filled = generic.fillFields(doc, result.token, [...result.matched.map(({ id, key }) => ({ id, key, guessed: false })),
    ...result.unmatched.map(({ id }) => ({ id, key: 'county', guessed: true }))], generic.deriveValues({ ...profile, county: 'Polk' }));
  assert.deepEqual(filled.filled, result.matched.map(item => item.id));
  assert.deepEqual(clicks, ['Three', 'No'], 'only the matching options are clicked; the answered question is never touched');
  const checkedIn = heading => [...doc.getElementById(heading).parentElement.querySelectorAll('[aria-checked="true"]')].map(option => option.getAttribute('data-value'));
  assert.deepEqual(checkedIn('c1'), ['Three']);
  assert.deepEqual(checkedIn('c4'), ['Yes']);
  assert.equal(doc.querySelector('[role="listbox"] [aria-selected="true"]').getAttribute('data-value'), '');
});

test('number words and "or more" choices pick the right count; a click Google ignores is not reported as filled', () => {
  const pick = size => {
    const doc = page(forms.googleChoices);
    googleClicks(doc);
    const result = generic.plan(doc);
    const size_ = result.matched.find(item => item.key === 'householdSize');
    generic.fillFields(doc, result.token, [{ id: size_.id, key: 'householdSize', guessed: false }], { householdSize: size });
    return [...doc.querySelectorAll('#c1 ~ [role="radiogroup"] [aria-checked="true"]')].map(option => option.getAttribute('data-value'));
  };
  assert.deepEqual(pick('1'), ['One (Myself)']);
  assert.deepEqual(pick('5'), ['Five or more']);
  assert.deepEqual(pick('8'), ['Five or more']);
  assert.deepEqual(pick('0'), [], 'no option means zero people');
  const doc = page(forms.googleChoices);
  const result = generic.plan(doc);
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), generic.deriveValues(profile));
  assert.deepEqual(filled.filled, [], 'without Google registering the click, nothing counts as filled');
});

test('a document that loses its window while choices settle stops waiting and reports that the page changed', async () => {
  // Google never confirms these clicks, so each choice waits to settle.
  const pendingFill = () => {
    const doc = page(forms.googleChoices);
    const result = generic.plan(doc);
    const size = result.matched.find(item => item.key === 'householdSize');
    const filled = generic.fillFields(doc, result.token, [{ id: size.id, key: 'householdSize', guessed: false }], { householdSize: '3' });
    assert.deepEqual(filled.pending, [size.id]);
    return { doc, token: result.token, filled, id: size.id };
  };
  // Chrome gives a document its page left behind no window; jsdom keeps it, so the test takes it away.
  const detach = doc => Object.defineProperty(doc, 'defaultView', { value: null, configurable: true });

  const during = pendingFill();
  const started = Date.now();
  const settling = generic.settle(during.doc, during.token, during.filled, { timeoutMs: 5000 });
  await new Promise(resolve => setTimeout(resolve, 30));
  detach(during.doc);
  assert.deepEqual(await settling, { ok: false, pageChanged: true, filled: [], skipped: [during.id], rejected: [], pending: [] });
  assert.ok(Date.now() - started < 1000, 'it stops waiting once the page is gone');
  assert.equal(during.doc.querySelector('[data-secondhand-filled]'), null, 'nothing on the old page is marked as filled');

  const before = pendingFill();
  detach(before.doc);
  assert.deepEqual(await generic.settle(before.doc, before.token, before.filled), { ok: false, pageChanged: true, filled: [], skipped: [before.id], rejected: [], pending: [] },
    'a page already gone is not waited on');
});

test('age-band household questions map to the profile’s own counts when the band is one of them, otherwise to a band count', () => {
  const questions = {
    kids017: '# of people in your household 0 - 17 yrs old', kidsUnder18: 'Number of children under 18', kidsAges: 'Number of household members ages 0 to 17',
    adults1864: 'Number of adults (18-64)', adultsPeople: 'How many people in your household are 18 to 64 years old', seniors65: 'Number of seniors (65+)',
    seniorsOlder: 'How many people 65 or older live in your household', seniorsAdults: 'Number of adults 65 and older',
    band1859: '# of people in your household 18 - 59 yrs old', band60: '# of people in your household 60 + yrs', seniors60: 'Number of seniors (60+)',
    kids05: '# of Children 0-5 years old', kids618: '# of Children 6-18 years old', adults18: 'Adults 18+', kidsUnder5: 'Number of children (under 5)',
    older60: 'Number of people 60 and older', ages618: 'Number of household members ages 6 to 18', dash05: 'Children 0–5', orOlder: 'How many people in your household are 60 or older?',
    andOver: 'People in household 60 and over', yearsOlder: 'Number of people 60 years and older', underFive: 'How many children under 5 live in your household?',
    andUnder: 'Number of children 5 and under', through: 'Number of people ages 18 through 59'
  };
  const doc = page(Object.entries(questions).map(([id, label]) => `<label for="${id}">${label}</label><input id="${id}" type="number">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { kids017: 'householdChildren', kidsUnder18: 'householdChildren', kidsAges: 'householdChildren',
    adults1864: 'householdAdults', adultsPeople: 'householdAdults', seniors65: 'householdSeniors', seniorsOlder: 'householdSeniors', seniorsAdults: 'householdSeniors',
    band1859: 'householdCount:18-59', band60: 'householdCount:60+', seniors60: 'householdCount:60+', kids05: 'householdCount:0-5', kids618: 'householdCount:6-18',
    adults18: 'householdCount:18+', kidsUnder5: 'householdCount:0-4', older60: 'householdCount:60+', ages618: 'householdCount:6-18', dash05: 'householdCount:0-5',
    orOlder: 'householdCount:60+', andOver: 'householdCount:60+', yearsOlder: 'householdCount:60+', underFive: 'householdCount:0-4', andUnder: 'householdCount:0-5',
    through: 'householdCount:18-59' });
  assert.deepEqual(result.unmatched, []);
});

test('band questions that aren’t a clear count of people by age stay with the applicant', () => {
  const labels = ['Number of people under 0', 'Number of people 121+', 'Number of people 18 to 5', 'People over 60', 'Number of people 60 or so', 'Number of people 1.5 to 3',
    'Number of pets 0-5', 'Ages of children 0-5', 'Number of people in your household who work 2 jobs', 'Number of people 007-10', 'Number of people 0-5-9'];
  const doc = page(labels.map((label, index) => `<label for="b${index}">${label}</label><input id="b${index}" type="number">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.unmatched.map(field => field.label), labels);
});

test('the extension reads band keys exactly as the desktop does', () => {
  const household = require('../shared/household.cjs');
  const keys = ['householdCount:0-17', 'householdCount:60+', 'householdCount:0-5', 'householdCount:120+', 'householdCount:5-5', 'householdCount:05-10', 'householdCount:10-5',
    'householdCount:0-121', 'householdCount:121+', 'householdCount:', 'householdcount:0-5', 'householdCount:0–5', 'householdCount:1000+', 'householdSize', '', null];
  for (const key of keys) assert.equal(generic.isBandKey(key), household.isBandKey(key), JSON.stringify(key));
});

test('band counts fill number boxes and count choices, and are asked for by key', () => {
  const doc = page('<label for="young"># of people in your household 0 - 17 yrs old</label><input id="young" type="number">' +
    '<label for="mid"># of people in your household 18 - 59 yrs old</label><input id="mid" type="number">' +
    '<label for="old"># of people in your household 60 + yrs</label><select id="old"><option value="">Choose</option><option>0</option><option>1</option><option>2</option><option>3+</option></select>' +
    '<label for="kids">Children 0-5</label><input id="kids" type="text">');
  const result = generic.plan(doc);
  assert.deepEqual(generic.requestKeys(result.matched.map(item => item.key)), ['householdChildren', 'householdCount:18-59', 'householdCount:60+', 'householdCount:0-5']);
  const values = generic.deriveValues({ householdChildren: '2', 'householdCount:18-59': '1', 'householdCount:60+': '4', 'householdCount:0-5': '0' });
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), values);
  assert.equal(filled.filled.length, 4);
  assert.deepEqual(['young', 'mid', 'old', 'kids'].map(id => doc.getElementById(id).value), ['2', '1', '3+', '0']);
  // A band count is placed only where the rules matched it, never as a guess elsewhere.
  for (const label of ['Household size', 'Number of children', 'Anything else?']) assert.equal(generic.canSuggest('householdCount:0-5', { label }), false, label);
  assert.equal(generic.GENERIC_KEYS.some(key => key.startsWith('householdCount:')), false);
});

test('a student box gets the one student’s name and grade; the applicant’s boxes never get a member’s details', () => {
  const labels = { student: 'Student name and grade', students: 'Student’s Name and Grade (if applicable)', slash: 'Student name/grade', of: 'Name and grade of student',
    // A pantry form from the live QA (#89): the question, then an instruction in its own sentence.
    order: 'Student name and grade. Order will be assigned to(first and Last)',
    alone: 'Student name', first: 'First name', full: 'Full name', school: 'Student school' };
  const doc = page(Object.entries(labels).map(([id, label]) => `<label for="${id}">${label}</label><input id="${id}">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { student: 'studentNameGrade', students: 'studentNameGrade', slash: 'studentNameGrade', of: 'studentNameGrade', order: 'studentNameGrade',
    first: 'firstName', full: 'fullName' });
  assert.deepEqual(result.unmatched.map(field => field.label), [labels.alone, labels.school]);
  for (const item of result.unmatched) for (const key of ['fullName', 'firstName', 'lastName']) assert.equal(generic.canSuggest(key, item), false, `${item.label}: ${key}`);
  assert.deepEqual(generic.requestKeys(['studentNameGrade', 'fullName']), ['studentNameGrade', 'firstName', 'lastName']);
  const values = generic.deriveValues({ studentNameGrade: 'Riley Example, 5th', firstName: 'Avery', lastName: 'Example' });
  const idOf = key => result.matched.find(item => item.key === key).id;
  // Each answer in the other's box, as a guess: refused both ways.
  const crossed = generic.fillFields(doc, result.token, [{ id: idOf('firstName'), key: 'studentNameGrade', guessed: true }, { id: idOf('fullName'), key: 'studentNameGrade', guessed: true },
    { id: idOf('studentNameGrade'), key: 'fullName', guessed: true }, { id: result.unmatched[0].id, key: 'fullName', guessed: true }], values);
  assert.deepEqual(crossed.filled, []);
  generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), values);
  assert.deepEqual(['student', 'students', 'slash', 'of', 'order', 'first', 'full', 'alone'].map(id => doc.getElementById(id).value),
    ['Riley Example, 5th', 'Riley Example, 5th', 'Riley Example, 5th', 'Riley Example, 5th', 'Riley Example, 5th', 'Avery', 'Avery Example', '']);
  // Only the first sentence is the question: a longer one that only starts the same way is not.
  const other = page('<label for="x">Student name and grade of your oldest child</label><input id="x"><label for="y">Student name and grade? Bring a report card.</label><input id="y">');
  assert.deepEqual(byElement(other, generic.plan(other)), { y: 'studentNameGrade' });
  // Zero or several students: the desktop has no answer, and the box stays empty.
  const again = page('<label for="s">Student name and grade</label><input id="s">');
  const plan = generic.plan(again);
  assert.deepEqual(generic.fillFields(again, plan.token, plan.matched.map(({ id, key }) => ({ id, key, guessed: false })), generic.deriveValues({})).filled, []);
  assert.equal(again.getElementById('s').value, '');
});

test('Iowa\'s Financial Information page maps every question it can answer from the profile', () => {
  const doc = page(forms.iowaFinancial, 'https://hhsservices.iowa.gov/apspssp/ssp.portal/financialInfo');
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), {
    adults: 'householdAdults', senior: 'anyoneSenior', children: 'householdChildren', resident: 'iowaResident', income: 'totalMonthlyIncome',
    onHand: 'assetsOnHand', medical: 'monthlyMedicalExpenses', citizens: 'householdAllCitizens', legal: 'householdLegalStatus',
    disability: 'householdDisability', pregnant: 'householdPregnant', medicare: 'householdMedicare', healthHelp: 'wantsHealthCoverage'
  });
  assert.deepEqual(result.unmatched, []);
  assert.deepEqual(generic.requestKeys(result.matched.map(item => item.key)).sort(), ['assetsOnHand', 'householdAdults', 'householdAllCitizens', 'householdChildren',
    'householdDisability', 'householdLegalStatus', 'householdMedicare', 'householdPregnant', 'householdSeniors', 'monthlyEarnedIncome', 'monthlyMedicalExpenses',
    'monthlyOtherIncome', 'programMedicaid', 'state']);

  const saved = { ...profile, householdAdults: '9', householdSeniors: '0', programMedicaid: 'yes', assetsOnHand: '250', monthlyMedicalExpenses: '40',
    householdAllCitizens: 'yes', householdLegalStatus: '', householdPregnant: 'no', householdMedicare: 'no' };
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), generic.deriveValues(saved));
  assert.equal(filled.filled.length, 12, 'everything but the blank legal-documents answer');
  const value = id => doc.getElementById(id).value;
  const chosen = name => doc.querySelector(`input[name="${name}"]:checked`)?.id || null;
  assert.equal(value('adults'), '8', '9 adults picks "8 or More"');
  assert.equal(value('children'), '1');
  assert.equal(value('income'), '1000'); assert.equal(value('onHand'), '250'); assert.equal(value('medical'), '40');
  assert.deepEqual(['senior', 'resident', 'citizens', 'legal', 'disability', 'pregnant', 'medicare', 'healthHelp'].map(chosen),
    ['seniorNo', 'residentYes', 'citizensYes', null, 'disabilityYes', 'pregnantNo', 'medicareNo', 'healthHelpYes']);
  assert.equal(doc.getElementById('residentYes').getAttribute('data-secondhand-filled'), 'guess', 'residency from the home state is always a guess to review');
  assert.equal(doc.getElementById('seniorNo').getAttribute('data-secondhand-filled'), 'rule');
  assert.deepEqual(generic.GUESS_KEYS, ['iowaResident']);
});

test('derived yes/no answers are only offered when the saved profile settles them', () => {
  const derive = values => generic.deriveValues(values);
  assert.equal(derive({ householdSeniors: '2' }).anyoneSenior, 'yes');
  assert.equal(derive({ householdSeniors: '0' }).anyoneSenior, 'no');
  assert.equal(derive({ householdSeniors: '' }).anyoneSenior, undefined);
  assert.equal(derive({ householdSeniors: 'a few' }).anyoneSenior, undefined);
  assert.equal(derive({ state: 'IA' }).iowaResident, 'yes');
  assert.equal(derive({ state: 'MN' }).iowaResident, undefined, 'living elsewhere does not settle Iowa residency');
  assert.equal(derive({ state: '' }).iowaResident, undefined);
  assert.equal(derive({ programMedicaid: 'yes' }).wantsHealthCoverage, 'yes');
  assert.equal(derive({ programMedicaid: 'no' }).wantsHealthCoverage, 'no');
  assert.equal(derive({ programMedicaid: '' }).wantsHealthCoverage, undefined);
  assert.equal(derive({ anyoneSenior: 'yes', iowaResident: 'yes', wantsHealthCoverage: 'yes' }).anyoneSenior, undefined, 'derived answers come only from their sources');
  for (const key of ['assetsOnHand', 'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare', 'programMedicaid'])
    assert.ok(generic.PROFILE_KEYS.includes(key), key);
  for (const key of ['assetsOnHand', 'monthlyMedicalExpenses', 'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare', 'anyoneSenior', 'iowaResident', 'wantsHealthCoverage'])
    assert.ok(generic.GENERIC_KEYS.includes(key), key);
  assert.equal(generic.GENERIC_KEYS.includes('programMedicaid'), false, 'a program choice is only placed through the health-coverage question');
});

test('only confident matches are planned; vague labels stay unmatched for the applicant', () => {
  const doc = page('<label for="a">Name of your pet</label><input id="a"><label for="b">Emergency contact phone</label><input id="b" type="tel"><label for="c">Income last year from your side business</label><input id="c">');
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, []);
  assert.equal(result.unmatched.length, 3);
});

test('applicant details never match boxes that name another person in English or Spanish', () => {
  const labels = [
    "Spouse's first name", 'Family Member: Last Name', 'Household member #2: First and Last Name', 'Name of Proxy',
    'Emergency contact phone', 'Landlord name', 'Nombre del cónyuge: First', 'Teléfono del contacto de emergencia',
    'Nombre del representante autorizado', 'Nombre del hijo'
  ];
  const doc = page(labels.map((label, index) => `<label for="p${index}">${label}</label><input id="p${index}" autocomplete="${index === 7 ? 'tel' : 'name'}">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.unmatched.map(field => field.label), labels);
  for (const item of result.unmatched) assert.equal(generic.canSuggest('fullName', item), false, item.label);
});

// Boxes that ask for another person's details (#136, after #83): possessives with ’ and ', dependents, and
// household members with or without a number.
const OTHER_PERSON_LABELS = ['Child’s name', "Child's date of birth", 'Childs phone', 'Children’s Names, Schools and Grades', 'Grandchild’s birthdate',
  'Partner’s phone', "Partner's first name", 'Spouse’s email', 'Husband’s name', 'Wife’s phone number', 'Landlord’s phone number', 'Proxy’s address',
  "Representative's last name", 'Emergency contact’s phone', 'Household member’s name', "Family member's name", 'Dependent name', 'Dependent 1 date of birth',
  'Dependent’s relationship to you', 'Household member name', 'Household member phone', 'Household member', 'Household member 2 name',
  'Household member #3: First name', 'Other members of the household: Full name', 'Additional household member: Email', 'Nombre del miembro del hogar'];
// The same details under another person's section heading, read as "<heading>: <label>".
const OTHER_PERSON_SECTIONS = [['Child 1', 'First name', 'given-name'], ['Child 1', 'Date of birth', 'bday'], ['Dependent', 'Name', 'name'], ['Household member', 'Phone', 'tel'],
  ['Partner’s information', 'Email', 'email'], ['Additional household members', 'Last name', 'family-name'], ['Other adults in the home', 'Full name', 'name']];

test('another person’s boxes get none of the applicant’s details: possessives, dependents, household members and their sections (#136)', () => {
  const doc = page(OTHER_PERSON_LABELS.map((label, index) => `<label for="o${index}">${label}</label><input id="o${index}" autocomplete="name">`).join('') +
    OTHER_PERSON_SECTIONS.map(([heading, label, hint], index) => `<fieldset><legend>${heading}</legend><label for="s${index}">${label}</label><input id="s${index}" autocomplete="${hint}"></fieldset>`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, [], 'not by the rules, nor by the box’s autocomplete hint');
  assert.deepEqual(result.unmatched.map(field => field.label), [...OTHER_PERSON_LABELS, ...OTHER_PERSON_SECTIONS.map(([heading, label]) => `${heading}: ${label}`)]);
  for (const field of result.unmatched) {
    assert.equal(generic.blockedSuggestion(field.label), true, field.label);
    assert.equal(generic.layaQuestion(field), '', `${field.label}: never sent to Laya`);
    for (const key of generic.GENERIC_KEYS) assert.equal(generic.canSuggest(key, field), false, `${field.label}: ${key}`);
  }
  const guesses = result.unmatched.flatMap(({ id }) => ['fullName', 'firstName', 'lastName', 'phone', 'email', 'addressLine1'].map(key => ({ id, key, guessed: true })));
  assert.deepEqual(generic.fillFields(doc, result.token, guesses, generic.deriveValues(profile)).filled, [], 'a guess, from Chrome’s AI or from Laya, is refused');
});

test('#83’s exceptions stay the applicant’s: the household representative, counts of children, dependents and members, the head of household and TEFAP’s household member (#136)', () => {
  const kept = { rep: ['Household representative: First name', null], kids: ['Number of children', 'householdChildren'], under: ['How many children under 18?', 'householdChildren'],
    deps: ['Number of dependents', null], members: ['How many household members?', 'householdSize'], adults: ['Number of household members ages 18 to 64', 'householdAdults'],
    head: ['Name (Head of Household)', 'fullName'], full: ['Full name', 'fullName'],
    // How USDA TEFAP forms ask for the applicant: the question bank keys it to the applicant's full name.
    tefap: ['Name of household member', null] };
  const doc = page(Object.entries(kept).map(([id, [label]]) => `<label for="${id}">${label}</label><input id="${id}">`).join('') +
    '<fieldset><legend>Children</legend><label for="many">How many children under 18?</label><input id="many"></fieldset>');
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { ...Object.fromEntries(Object.entries(kept).filter(([, [, key]]) => key).map(([id, [, key]]) => [id, key])), many: 'householdChildren' });
  for (const [label] of Object.values(kept)) {
    assert.equal(generic.blockedSuggestion(label), false, label);
    assert.equal(generic.layaQuestion({ label, type: 'text', options: [] }), 'text', label);
  }
  assert.equal(generic.canSuggest('firstName', { label: kept.rep[0] }), true);
  assert.equal(generic.canSuggest('householdChildren', { label: kept.deps[0] }), true);
});

test('a field inside another person section is not matched from its short label', () => {
  const doc = page('<fieldset><legend>Emergency Contact</legend><label for="name">Name</label><input id="name" autocomplete="name"><label for="phone">Phone</label><input id="phone" autocomplete="tel"></fieldset>');
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.unmatched.map(field => field.label), ['Emergency Contact: Name', 'Emergency Contact: Phone']);
});

test('combined address boxes use every required saved part and never a single part', () => {
  const labels = ['City/State', 'City and Zip Code', 'City, State and Zip code', 'Complete Physical Address (including Town/City!)',
    'Ciudad/Estado', 'Ciudad y Código Postal', 'Ciudad, Estado y Código Postal', 'Dirección completa'];
  const doc = page(labels.map((label, index) => `<label for="a${index}">${label}</label><input id="a${index}">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { a0: 'cityState', a1: 'cityZip', a2: 'cityStateZip', a3: 'fullAddress',
    a4: 'cityState', a5: 'cityZip', a6: 'cityStateZip', a7: 'fullAddress' });
  assert.deepEqual(generic.requestKeys(result.matched.map(item => item.key)).sort(), ['addressLine1', 'addressLine2', 'city', 'state', 'zip']);
  const complete = generic.deriveValues(profile);
  assert.equal(complete.cityState, 'Demo City, IA');
  assert.equal(complete.cityZip, 'Demo City, 50309');
  assert.equal(complete.cityStateZip, 'Demo City, IA 50309');
  assert.equal(complete.fullAddress, '123 Test Way, Unit 4, Demo City, IA 50309');
  const incomplete = generic.deriveValues({ city: 'Demo City', state: 'IA' });
  assert.equal(incomplete.cityState, 'Demo City, IA');
  assert.equal(incomplete.cityZip, undefined);
  assert.equal(incomplete.cityStateZip, undefined);
  assert.equal(incomplete.fullAddress, undefined);
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), incomplete);
  assert.equal(doc.getElementById('a0').value, 'Demo City, IA');
  assert.deepEqual(filled.filled, [result.matched[0].id, result.matched[4].id]);
  assert.deepEqual(['a1', 'a2', 'a3', 'a5', 'a6', 'a7'].map(id => doc.getElementById(id).value), ['', '', '', '', '', '']);
});

test('requested profile fields and derived answers cover composite questions', () => {
  assert.deepEqual(generic.requestKeys(['fullName', 'phone', 'totalMonthlyIncome', 'zip', 'zip']).sort(),
    ['firstName', 'homePhone', 'lastName', 'mobilePhone', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'phone', 'zip'].sort());
  const values = generic.deriveValues(profile);
  assert.equal(values.fullName, 'Avery Example');
  assert.equal(values.phone, '2025550148', 'mobile first, then home, then reference phone');
  assert.equal(values.totalMonthlyIncome, '1000');
  assert.equal(values.annualIncome, '12000');
  assert.equal(generic.deriveValues({ monthlyEarnedIncome: '900' }).totalMonthlyIncome, undefined, 'a partial income is never presented as the total');
  for (const key of generic.GENERIC_KEYS) assert.equal(typeof key, 'string');
  assert.ok(generic.GENERIC_KEYS.includes('householdVeteran'));
});

test('filling writes each supported control type, fires events, and outlines what it filled', () => {
  const doc = page(forms.plainPantry);
  const events = [];
  doc.addEventListener('input', event => events.push(`input:${event.target.id || event.target.name}`), true);
  doc.addEventListener('change', event => events.push(`change:${event.target.id || event.target.name}`), true);
  const result = generic.plan(doc);
  const assignments = result.matched.map(({ id, key }) => ({ id, key, guessed: key === 'householdSeniors' }));
  const filled = generic.fillFields(doc, result.token, assignments, generic.deriveValues(profile));
  assert.equal(filled.ok, true);
  assert.equal(filled.filled.length, result.matched.length);
  const value = id => doc.getElementById(id).value;
  assert.equal(value('fname'), 'Avery'); assert.equal(value('dob'), '1985-04-12'); assert.equal(value('st'), 'IA');
  assert.equal(value('phone'), '(202) 555-0148'); assert.equal(value('hh'), '3'); assert.equal(value('seniors'), '0');
  assert.equal(value('income'), '1000');
  assert.equal(doc.querySelector('input[name="vet"][value="n"]').checked, true);
  assert.equal(doc.querySelector('input[name="vet"][value="y"]').checked, false);
  assert.ok(events.includes('input:fname') && events.includes('change:fname'));
  assert.equal(doc.getElementById('fname').getAttribute('data-secondhand-filled'), 'rule');
  assert.equal(doc.getElementById('seniors').getAttribute('data-secondhand-filled'), 'guess');
  assert.equal(value('pw'), ''); assert.equal(value('card'), ''); assert.equal(value('notes'), '');
});

test('text dates, state names, and pre-filled answers are handled without overwriting', () => {
  const doc = page('<label for="d">Birthday</label><input id="d"><label for="s">State</label><select id="s"><option value=""></option><option value="Iowa">Iowa</option><option value="Minnesota">Minnesota</option></select><label for="c">City</label><input id="c" value="Already typed">');
  const result = generic.plan(doc);
  assert.deepEqual(result.matched.map(item => item.key), ['birthDate', 'state'], 'a field that already has an answer is not planned');
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })), generic.deriveValues(profile));
  assert.equal(doc.getElementById('d').value, '04/12/1985');
  assert.equal(doc.getElementById('s').value, 'Iowa');
  assert.equal(doc.getElementById('c').value, 'Already typed');
  assert.equal(filled.filled.length, 2);
});

// #156: a text date box gets the saved date in the order it asks for, read as Save reads a typed date (#142).
function fillDate(html) {
  const doc = page(html);
  const result = generic.plan(doc);
  const dob = result.matched.find(item => item.key === 'birthDate');
  assert.ok(dob, `${html}: matched to the birth date`);
  const filled = generic.fillFields(doc, result.token, [{ id: dob.id, key: 'birthDate', guessed: false }], { birthDate: '1985-04-12' });
  return { value: doc.getElementById('dob').value, filled: filled.filled.includes(dob.id) };
}
const dobBox = (label, attributes = '') => `<label for="dob">${label}</label><input id="dob" ${attributes}><span id="hint">Use DD/MM/YYYY</span>`;
test('a text date box gets the saved date in the order its label, placeholder, description or title asks for', () => {
  for (const [label, attributes, value] of [
    ['Date of birth (MM/DD/YYYY)', '', '04/12/1985'],
    ['Date of birth (DD/MM/YYYY)', '', '12/04/1985'],
    ['Date of birth (YYYY-MM-DD)', '', '1985-04-12'],
    // The hint only in the placeholder.
    ['Date of birth', 'placeholder="MM/DD/YYYY"', '04/12/1985'],
    ['Date of birth', 'placeholder="dd/mm/yyyy"', '12/04/1985'],
    ['Date of birth', 'placeholder="YYYY-MM-DD"', '1985-04-12'],
    // Spanish and French forms write the year as AAAA, and French the day as JJ.
    ['Fecha de nacimiento (DD/MM/AAAA)', 'autocomplete="bday"', '12/04/1985'],
    ['Fecha de nacimiento', 'autocomplete="bday" placeholder="dd/mm/aaaa"', '12/04/1985'],
    ['Fecha de nacimiento (AAAA-MM-DD)', 'autocomplete="bday"', '1985-04-12'],
    ['Date de naissance', 'autocomplete="bday" placeholder="jj/mm/aaaa"', '12/04/1985'],
    ['Date of birth', 'aria-describedby="hint"', '12/04/1985'],
    ['Date of birth', 'title="Day, month and year: DD-MM-YYYY"', '12/04/1985'],
    // The same hint in the label and the placeholder is one order.
    ['Date of birth (MM/DD/YYYY)', 'placeholder="MM/DD/YYYY"', '04/12/1985'],
    ['Date of birth (YYYY-MM-DD)', 'placeholder="YYYY-MM-DD"', '1985-04-12']]) {
    assert.deepEqual(fillDate(dobBox(label, attributes)), { value, filled: true }, `${label} ${attributes}`);
  }
});

test('a date box with no hint gets the date month first, a date input gets it as ISO, and a box asking for two orders gets nothing', () => {
  for (const label of ['Date of birth', 'Birthday', 'DOB']) assert.deepEqual(fillDate(`<label for="dob">${label}</label><input id="dob">`), { value: '04/12/1985', filled: true }, label);
  for (const label of ['Date of birth (DD/MM/YYYY)', 'Date of birth (MM/DD/YYYY)', 'Date of birth']) {
    assert.deepEqual(fillDate(dobBox(label, 'type="date"')), { value: '1985-04-12', filled: true }, `${label}: the browser shows a date input in its own order`);
  }
  // Which order the page wants can't be told: the applicant answers it.
  assert.deepEqual(fillDate(dobBox('Date of birth (MM/DD/YYYY)', 'placeholder="DD/MM/YYYY"')), { value: '', filled: false });
});

test('a stale plan, an unknown key, or a field changed since planning is never filled', () => {
  const doc = page(forms.plainPantry);
  const first = generic.plan(doc);
  const second = generic.plan(doc);
  const assignments = first.matched.map(({ id, key }) => ({ id, key, guessed: false }));
  assert.equal(generic.fillFields(doc, first.token, assignments, generic.deriveValues(profile)).ok, false, 'only the latest plan can fill');
  const fname = second.matched.find(item => item.key === 'firstName');
  doc.getElementById('fname').value = 'Typed by the applicant';
  const result = generic.fillFields(doc, second.token, [{ id: fname.id, key: 'firstName', guessed: false }, { id: fname.id, key: 'password', guessed: true }], generic.deriveValues(profile));
  assert.deepEqual(result.filled, []);
  assert.equal(doc.getElementById('fname').value, 'Typed by the applicant');
});

// Records scrolls and focus changes; jsdom has no scrolling of its own.
function watchAttention(doc) {
  const seen = { scrolled: [], focus: [] };
  doc.defaultView.HTMLElement.prototype.scrollIntoView = function () { seen.scrolled.push(this); };
  for (const type of ['focus', 'blur']) doc.addEventListener(type, event => seen.focus.push(`${type}:${event.target.id}`), true);
  return seen;
}
const highlighted = doc => [...doc.querySelectorAll('[data-secondhand-attention]')];

test('showing a need-you field scrolls to its question and highlights it without moving keyboard focus', () => {
  const doc = page(forms.plainPantry);
  const seen = watchAttention(doc);
  const result = generic.plan(doc);
  assert.equal(generic.focusField(doc, result.unmatched[0].id), true);
  assert.deepEqual(highlighted(doc), [doc.getElementById('notes')]);
  assert.deepEqual(seen.scrolled, [doc.getElementById('notes')]);
  assert.equal(doc.activeElement, doc.body, 'keyboard focus stays where it was');
  assert.deepEqual(seen.focus, []);
  assert.match(doc.getElementById('secondhand-filled-style').textContent, /\[data-secondhand-attention\]/);
  doc.getElementById('notes').dispatchEvent(new doc.defaultView.FocusEvent('focusin', { bubbles: true }));
  assert.deepEqual(highlighted(doc), [], 'the highlight goes away once the applicant is in the question');
  assert.equal(generic.focusField(doc, 'input[type=password]'), false);
});

test('on Google Forms the whole question card is shown, one at a time, and no required check is triggered', () => {
  const doc = page(forms.googleChoices);
  const seen = watchAttention(doc);
  const result = generic.plan(doc);
  const card = heading => doc.getElementById(heading).closest('[role="listitem"]');
  const [location, items] = result.unmatched;
  assert.equal(generic.focusField(doc, location.id), true);
  assert.deepEqual(highlighted(doc), [card('c3')]);
  assert.equal(generic.focusField(doc, items.id), true);
  assert.deepEqual(highlighted(doc), [card('c5')], 'the previous question is no longer highlighted');
  assert.deepEqual(seen.scrolled, [card('c3'), card('c5')]);
  assert.deepEqual(seen.focus, [], 'nothing is focused or blurred, so Google never flags a skipped question');
  const dates = page(forms.googleDates);
  watchAttention(dates);
  const hour = generic.plan(dates).unmatched.find(field => field.label === 'Pickup time: Hour');
  assert.equal(generic.focusField(dates, hour.id), true);
  assert.deepEqual(highlighted(dates), [dates.getElementById('hour')], 'a question with several boxes highlights only the one asked about');
});

test('counts fill number dropdowns and "or more" choices; a yes/no checkbox is only ever checked for yes', () => {
  const doc = page(`<label for="size">Household size</label><select id="size"><option value="">Pick</option><option>1</option><option>2</option><option>3</option><option value="4">4+</option></select>
    <fieldset><legend>How many children?</legend><label><input type="radio" name="kids" value="0">0</label><label><input type="radio" name="kids" value="1">1</label><label><input type="radio" name="kids" value="2">2 or more</label></fieldset>
    <label><input type="checkbox" id="vet" name="vet"> Veteran</label><label><input type="checkbox" id="dis" name="dis"> Disability</label>`);
  const result = generic.plan(doc);
  assert.deepEqual(result.matched.map(item => item.key), ['householdSize', 'householdChildren', 'householdVeteran', 'householdDisability']);
  const filled = generic.fillFields(doc, result.token, result.matched.map(({ id, key }) => ({ id, key, guessed: false })),
    generic.deriveValues({ householdSize: '6', householdChildren: '3', householdVeteran: 'no', householdDisability: 'yes' }));
  assert.equal(doc.getElementById('size').value, '4', '6 people picks the 4+ choice');
  assert.equal(doc.querySelector('input[name="kids"][value="2"]').checked, true, '3 children picks "2 or more"');
  assert.equal(doc.getElementById('vet').checked, false, 'No is never expressed by checking a box');
  assert.equal(doc.getElementById('dis').checked, true);
  assert.equal(filled.filled.length, 3);
});

test('the AI mapper can only suggest keys the rules engine knows how to fill', () => {
  const ai = require('../extension/ai-mapper.js');
  assert.deepEqual([...ai.ALLOWED_KEYS].sort(), [...generic.GENERIC_KEYS].sort());
});

test('the question list names every question on the page, answered or not, and each one can be shown without disturbing a fill', () => {
  const doc = page(forms.plainPantry);
  const seen = watchAttention(doc);
  doc.getElementById('fname').value = 'Typed by the applicant';
  const plan = generic.plan(doc);
  const listed = generic.questions(doc);
  assert.deepEqual(listed.map(item => item.label), ['First Name', 'Last Name', 'Date of Birth', 'Street Address', 'City', 'State', 'ZIP Code', 'Phone Number', 'Email',
    'How many people live in your household?', 'Number of adults', 'Number of children', 'Number of seniors (65+)', 'Is anyone in your household a veteran?', 'Total monthly household income',
    'Anything else we should know?'], 'the answered first name is listed too');
  assert.ok(listed.every(item => /^sq-\d+-\d+$/.test(item.id) && Object.keys(item).sort().join() === 'id,label'), 'ids and labels only');
  assert.doesNotMatch(JSON.stringify(listed), /Typed by the applicant|Create a password|Card number/, 'no answers, and password and card fields are never listed');
  assert.equal(generic.focusField(doc, listed.at(-1).id), true);
  assert.deepEqual(seen.scrolled, [doc.getElementById('notes')]);
  assert.equal(generic.focusField(doc, 'sq-999-0'), false);
  // Listing never replaces the plan a fill is using.
  const lastName = plan.matched.find(item => item.key === 'lastName');
  assert.equal(generic.fillFields(doc, plan.token, [{ id: lastName.id, key: 'lastName', guessed: false }], generic.deriveValues(profile)).ok, true);
  assert.equal(doc.getElementById('lname').value, 'Example');
  assert.equal(doc.getElementById('fname').value, 'Typed by the applicant');
});

test('the card shows for a form the rules or Laya can help with, answered or not, and never disturbs a plan', () => {
  assert.equal(generic.offers(page(forms.plainPantry)), true, 'a sign-up form with a password box still asks for a name');
  assert.equal(generic.offers(page(forms.googleStyle)), true);
  assert.equal(generic.offers(page('<form><label for="reach">Where can we reach you?</label><input id="reach" type="email"></form>')), true, 'a question only Laya could take');
  assert.equal(generic.offers(page('<form><label for="day">Preferred pickup day</label><select id="day"><option value="">Choose</option><option>Monday</option><option>Friday</option></select></form>')), true);
  const answered = page('<form><label for="fname">First name</label><input id="fname" value="Typed by the applicant"></form>');
  assert.equal(generic.offers(answered), true, 'the card stays once the form is filled');
  const doc = page(forms.plainPantry);
  const plan = generic.plan(doc);
  generic.offers(doc);
  const lastName = plan.matched.find(item => item.key === 'lastName');
  assert.equal(generic.fillFields(doc, plan.token, [{ id: lastName.id, key: 'lastName', guessed: false }], generic.deriveValues(profile)).ok, true, 'the plan the worker holds stays valid');
});

test('the card stays hidden on pages without inputs, search boxes, sign-in forms, verification codes, and questions only the applicant answers', () => {
  const hidden = {
    'no inputs': '<main><h1>Our pantry hours</h1><p>Open Monday and Friday.</p></main>',
    'a search form': '<header><form role="search"><input type="search" name="q" aria-label="Search"><button>Go</button></form></header>',
    'a text search box': '<header><input type="text" name="s" placeholder="Search this site"></header>',
    'a search landmark': '<search><label for="find">Find a pantry near you</label><input id="find" type="text"></search>',
    'a sign-in form': '<form><label for="user">Email</label><input id="user" type="email" autocomplete="username"><label for="pw">Password</label><input id="pw" type="password"><button>Sign in</button></form>',
    'a sign-in without a form': '<label for="login">User name</label><input id="login"><label for="secret">Password</label><input id="secret" type="password">',
    'a texted code': '<form><label for="otp">Enter the 6-digit code we sent you</label><input id="otp" inputmode="numeric"></form>',
    'a verification code': '<form><label for="code">Verification code</label><input id="code"></form>',
    'a one-time code': '<form><input name="token" autocomplete="one-time-code" aria-label="Code"></form>',
    'consent only': '<form><label><input type="checkbox" name="agree"> I agree to the terms</label><label for="sig">Signature</label><input id="sig"></form>'
  };
  for (const [name, html] of Object.entries(hidden)) assert.equal(generic.offers(page(html)), false, name);
});

test('Laya takes text boxes and choice questions within the bridge’s limits, never a question only the applicant answers', () => {
  const field = (extra = {}) => ({ label: 'Preferred pickup day', type: 'select', options: ['Monday', 'Friday'], ...extra });
  assert.equal(generic.layaQuestion(field()), 'choice');
  assert.equal(generic.layaQuestion(field({ type: 'radio' })), 'choice');
  assert.equal(generic.layaQuestion(field({ type: 'checkbox' })), 'choice');
  for (const type of ['text', 'textarea', 'number', 'date', 'email', 'tel']) assert.equal(generic.layaQuestion(field({ label: 'Where can we reach you?', type, options: [] })), 'text', type);
  const refused = {
    'a search box': field({ type: 'search', options: [] }),
    'a listbox': field({ type: 'listbox' }),
    'a choice without options': field({ options: [] }),
    'no label': field({ label: '  ' }),
    'a long label': field({ label: 'x'.repeat(201) }),
    'a control character': field({ label: 'Pickup\nday' }),
    'too many options': field({ options: Array.from({ length: 31 }, (_, index) => `Day ${index}`) }),
    'a long option': field({ options: ['Monday', 'y'.repeat(101)] }),
    'repeated options': field({ options: ['Monday', 'Monday'] }),
    'consent': field({ label: 'Do you consent to share your answers?', type: 'radio', options: ['Yes', 'No'] }),
    'an SSN': field({ label: 'Social Security number', type: 'text', options: [] })
  };
  for (const [name, question] of Object.entries(refused)) assert.equal(generic.layaQuestion(question), '', name);
});

test('a question whose label or options carry a bidi control, an invisible character, or a line break is left to the applicant; the joiners Persian, Arabic, and Indic words need are kept', () => {
  const choice = (extra = {}) => ({ label: 'Preferred pickup day', type: 'radio', options: ['Monday', 'Friday'], ...extra });
  const box = label => ({ label, type: 'email', options: [] });
  const unseen = { 'right-to-left override': '\u202E', 'left-to-right isolate': '\u2066', 'right-to-left mark': '\u200F', 'zero-width space': '\u200B', 'word joiner': '\u2060',
    'byte order mark': '\uFEFF', 'soft hyphen': '\u00AD', 'variation selector': '\uFE0F', 'tag letter': '\u{E0041}', 'line separator': '\u2028', 'paragraph separator': '\u2029',
    'next line (C1)': '\u0085', 'control sequence introducer (C1)': '\u009B' };
  for (const [name, character] of Object.entries(unseen)) {
    assert.equal(generic.layaQuestion(choice({ label: `Preferred pickup${character} day` })), '', `${name} in a label`);
    assert.equal(generic.layaQuestion(choice({ options: ['Monday', `Fri${character}day`] })), '', `${name} in an option`);
    assert.equal(generic.layaQuestion(box(`Where can we reach you?${character}`)), '', `${name} in a text box’s label`);
  }
  for (const text of ['می\u200Cخواهید', 'क्\u200Dष']) {
    assert.equal(generic.layaQuestion(choice({ label: `${text}?` })), 'choice', text);
    assert.equal(generic.layaQuestion(choice({ options: [text, 'Friday'] })), 'choice', text);
    assert.equal(generic.layaQuestion(box(`${text}?`)), 'text', text);
  }
});

// Boxes only the applicant answers (#134), each with an autocomplete hint that would otherwise give it a saved field.
const APPLICANT_ONLY = [
  ['Type your full name as your electronic signature', 'name'],
  ['Full name (your electronic signature)', 'name'],
  ['Applicant initials', 'name'],
  ['Enter the code we texted you', 'tel'],
  ['Enter the code we emailed you', 'email'],
  ['Enter the 6-digit code sent to your phone', 'tel'],
  ['Code from the text message', 'tel'],
  ['In what city were you born?', 'address-level2'],
  ['Security question: What is your mother’s maiden name?', 'family-name'],
  ['What was the name of your first pet?', 'given-name'],
  ['Answer to your security question', 'address-level2'],
  ['Username', 'email'],
  ['Create a user name', 'given-name'],
  ['User ID', 'email']
];

test('a box only the applicant answers gets no saved field: not from the rules, a guess or Laya (#134)', () => {
  const doc = page(APPLICANT_ONLY.map(([label, hint], index) => `<label for="u${index}">${label}</label><input id="u${index}" autocomplete="${hint}">`).join(''));
  const result = generic.plan(doc);
  assert.deepEqual(result.matched, [], 'not by the rules, nor by the box’s autocomplete hint');
  assert.deepEqual(result.unmatched.map(field => field.label), APPLICANT_ONLY.map(([label]) => label));
  for (const field of result.unmatched) {
    assert.equal(generic.unsafeQuestion(field), true, field.label);
    assert.equal(generic.layaQuestion(field), '', `${field.label}: never sent to Laya`);
    for (const key of generic.GENERIC_KEYS) assert.equal(generic.canSuggest(key, field), false, `${field.label}: ${key}`);
  }
  const guesses = result.unmatched.flatMap(({ id }) => ['fullName', 'firstName', 'lastName', 'city', 'email', 'phone'].map(key => ({ id, key, guessed: true })));
  const filled = generic.fillFields(doc, result.token, guesses, generic.deriveValues(profile));
  assert.deepEqual(filled.filled, [], 'a guess, from Chrome’s AI or from Laya, is refused');
  assert.deepEqual(APPLICANT_ONLY.map((_, index) => doc.getElementById(`u${index}`).value), APPLICANT_ONLY.map(() => ''));
});

test('ordinary boxes stay fillable by the rules and by a guess, and the SSN box only by its own rule (#134)', () => {
  const doc = page('<label for="full">Full name</label><input id="full"><label for="city">City</label><input id="city"><label for="email">Email</label><input id="email" type="email">' +
    '<label for="reach">Where can we reach you by email?</label><input id="reach" type="email"><label for="ssn">Social Security number</label><input id="ssn">');
  const result = generic.plan(doc);
  assert.deepEqual(byElement(doc, result), { full: 'fullName', city: 'city', email: 'email', ssn: 'ssn' });
  for (const [label, key] of [['Full name', 'fullName'], ['City', 'city'], ['Email', 'email'], ['Where can we reach you by email?', 'email']]) {
    assert.equal(generic.unsafeQuestion({ label, options: [] }), false, label);
    assert.equal(generic.canSuggest(key, { label }), true, `${label}: ${key}`);
    assert.equal(generic.layaQuestion({ label, type: 'text', options: [] }), 'text', label);
  }
  const reach = result.unmatched.find(field => field.label === 'Where can we reach you by email?');
  const ssn = result.matched.find(item => item.key === 'ssn');
  const assignments = [...result.matched.filter(item => item.key !== 'ssn').map(({ id, key }) => ({ id, key, guessed: false })), { id: reach.id, key: 'email', guessed: true },
    { id: ssn.id, key: 'fullName', guessed: true }, { id: ssn.id, key: 'ssn', guessed: false }];
  const filled = generic.fillFields(doc, result.token, assignments, { ...generic.deriveValues(profile), ssn: '123-45-6789' });
  assert.deepEqual(filled.filled, [...result.matched.filter(item => item.key !== 'ssn').map(item => item.id), reach.id, ssn.id]);
  assert.deepEqual(['full', 'city', 'email', 'reach', 'ssn'].map(id => doc.getElementById(id).value),
    ['Avery Example', 'Demo City', 'avery.example@example.invalid', 'avery.example@example.invalid', '123-45-6789'], 'a guess never reaches the SSN box; its rule still does');
});

test('plans carry each matched question’s label, so the side panel can name a question that wasn’t saved', () => {
  const doc = page('<label for="apt">Apartment number</label><input id="apt"><label for="kids">Children 0-5</label><input id="kids" type="number">');
  const result = generic.plan(doc);
  assert.deepEqual(result.matched.map(({ key, label }) => [key, label]), [['addressLine2', 'Apartment number'], ['householdCount:0-5', 'Children 0-5']]);
});

test('the answers a page may give back are the saved profile fields, never the SSN', () => {
  assert.deepEqual(generic.SAVE_KEYS, generic.PROFILE_KEYS.filter(key => key !== 'ssn'));
  const { SAVE_FIELDS } = require('../shared/schema.cjs');
  assert.deepEqual(generic.SAVE_KEYS, SAVE_FIELDS, 'the extension and the desktop agree on what may be saved');
});

const savingPage = () => page('<label for="apt">Apartment number</label><input id="apt">' +
  '<label for="county">County</label><input id="county">' +
  '<label for="dob">Date of birth (MM/DD/YYYY)</label><input id="dob">' +
  '<label for="st">State</label><select id="st"><option value="">Choose</option><option value="IA">Iowa</option><option value="MN">Minnesota</option></select>' +
  '<fieldset><legend>Is anyone in your household a veteran?</legend><label><input type="radio" name="vet" value="y">Yes</label><label><input type="radio" name="vet" value="n">No</label></fieldset>' +
  '<label for="rent">Monthly rent</label><input id="rent">' +
  '<label for="hh">Household size</label><select id="hh"><option value="">Choose</option><option>1</option><option>2</option><option>3</option><option>4+</option></select>' +
  '<label for="ssn">Social Security number</label><input id="ssn">' +
  '<label for="kids">Children 0-5</label><input id="kids" type="number">' +
  '<label for="full">Full name</label><input id="full">');

test('only after the click, a listed box’s answer is read and put in the profile’s own format', () => {
  const doc = savingPage();
  const result = generic.plan(doc);
  const idOf = key => result.matched.find(item => item.key === key).id;
  // Before the applicant answers, nothing is answered and nothing can be read.
  assert.deepEqual(generic.answeredIds(doc, result.token, result.matched.map(item => item.id)), []);
  assert.deepEqual(generic.readAnswer(doc, result.token, idOf('addressLine2'), 'addressLine2'), { empty: true });
  const type = (id, value) => { const box = doc.getElementById(id); box.value = value; box.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); };
  type('apt', '  Unit 5 '); type('county', 'Story'); type('dob', '4/12/1985'); type('st', 'MN'); type('rent', '$1,200.50'); type('hh', '3');
  doc.querySelector('input[name="vet"][value="n"]').click();
  type('ssn', '123-45-6789'); type('kids', '1'); type('full', 'Avery Example');
  assert.deepEqual(generic.answeredIds(doc, result.token, ['addressLine2', 'county', 'birthDate', 'state', 'householdVeteran', 'monthlyRent', 'householdSize'].map(idOf)),
    ['addressLine2', 'county', 'birthDate', 'state', 'householdVeteran', 'monthlyRent', 'householdSize'].map(idOf));
  const read = key => generic.readAnswer(doc, result.token, idOf(key), key);
  assert.deepEqual(read('addressLine2'), { value: 'Unit 5' });
  assert.deepEqual(read('county'), { value: 'Story' });
  assert.deepEqual(read('birthDate'), { value: '1985-04-12' });
  assert.deepEqual(read('state'), { value: 'MN' });
  assert.deepEqual(read('householdVeteran'), { value: 'no' });
  assert.deepEqual(read('monthlyRent'), { value: '1200.50' });
  assert.deepEqual(read('householdSize'), { value: '3' });
  // Never the SSN, a band count, or a composite answer: none of them is a field a page may save.
  for (const key of ['ssn', 'householdCount:0-5', 'fullName']) assert.equal(generic.readAnswer(doc, result.token, idOf(key), key), null, key);
  // Only the key the rules matched to that box, only in the plan that listed it.
  assert.equal(generic.readAnswer(doc, result.token, idOf('county'), 'city'), null);
  assert.equal(generic.readAnswer(doc, 'plan-other', idOf('county'), 'county'), null);
  assert.equal(generic.readAnswer(doc, result.token, 'sh-unknown', 'county'), null);
});

test('an answer that can’t be put in the profile’s format is reported unreadable, never guessed', () => {
  const doc = savingPage();
  const result = generic.plan(doc);
  const idOf = key => result.matched.find(item => item.key === key).id;
  const type = (id, value) => { doc.getElementById(id).value = value; };
  type('dob', 'April 12'); type('rent', 'about 800'); type('hh', '4+');
  for (const key of ['birthDate', 'monthlyRent', 'householdSize']) assert.deepEqual(generic.readAnswer(doc, result.token, idOf(key), key), { unreadable: true }, key);
  type('apt', 'x'.repeat(201));
  assert.deepEqual(generic.readAnswer(doc, result.token, idOf('addressLine2'), 'addressLine2'), { unreadable: true });
});

// #142: a typed date is read in the order its box asks for, or when only one order makes sense. Never guessed.
const dateBox = (attributes = '', label = 'Date of birth') => page(`<label for="dob">${label}</label><input id="dob" ${attributes}><span id="hint">Use MM/DD/YYYY</span>`);
function readDate(doc, typed) {
  const result = generic.plan(doc);
  const id = result.matched.find(item => item.key === 'birthDate').id;
  doc.getElementById('dob').value = typed;
  return generic.readAnswer(doc, result.token, id, 'birthDate');
}
test('a typed date is read in the order the box asks for: its label, placeholder, description or title', () => {
  for (const [attributes, label, typed, value] of [
    ['', 'Date of birth (MM/DD/YYYY)', '04/12/1985', '1985-04-12'],
    ['', 'Date of birth mm/dd/yyyy', '4-12-1985', '1985-04-12'],
    ['placeholder="DD/MM/YYYY"', 'Date of birth', '04/12/1985', '1985-12-04'],
    ['placeholder="dd/mm/aaaa" autocomplete="bday"', 'Fecha de nacimiento', '04/12/1985', '1985-12-04'],
    ['placeholder="jj/mm/aaaa"', 'Date of birth', '04.12.1985', '1985-12-04'],
    ['aria-describedby="hint"', 'Date of birth', '04/12/1985', '1985-04-12'],
    ['title="Day, month and year: DD-MM-YYYY"', 'Date of birth', '4-12-1985', '1985-12-04']]) {
    assert.deepEqual(readDate(dateBox(attributes, label), typed), { value }, `${label} ${attributes}: ${typed}`);
  }
  // A date written in the other order than the box asks for isn't turned around.
  assert.deepEqual(readDate(dateBox('', 'Date of birth (MM/DD/YYYY)'), '13/04/1985'), { unreadable: true });
  assert.deepEqual(readDate(dateBox('placeholder="DD/MM/YYYY"'), '04/13/1985'), { unreadable: true });
});

test('with no order on the box, a typed date is read only when its numbers allow one order', () => {
  for (const [typed, read] of [['13/04/1985', { value: '1985-04-13' }], ['04/13/1985', { value: '1985-04-13' }], ['5/5/1985', { value: '1985-05-05' }],
    ['1985-04-12', { value: '1985-04-12' }], ['04/12/1985', { unreadable: true }], ['12/4/1985', { unreadable: true }], ['13/13/1985', { unreadable: true }],
    ['00/13/1985', { unreadable: true }], ['32/01/1985', { unreadable: true }], ['04/12/85', { unreadable: true }]]) {
    assert.deepEqual(readDate(dateBox(), typed), read, typed);
  }
  // A date box gives the date in its own order already.
  assert.deepEqual(readDate(dateBox('type="date"'), '1985-04-12'), { value: '1985-04-12' });
});

test('a question the page asks more than once, as in a household member’s section with no heading, is never read as the applicant’s', () => {
  const doc = page('<h2>About you</h2><label for="first">First name</label><input id="first"><label for="dob">Date of birth (MM/DD/YYYY)</label><input id="dob">' +
    '<h2>Household members</h2><div class="member"><label for="first2">First name</label><input id="first2"><label for="dob2">Date of birth (MM/DD/YYYY)</label><input id="dob2"></div>' +
    '<label for="zip">Zip code</label><input id="zip">');
  const result = generic.plan(doc);
  const ids = key => result.matched.filter(item => item.key === key).map(item => item.id);
  assert.equal(ids('birthDate').length, 2, 'the section has no heading, so both boxes look like the applicant’s');
  for (const [id, value] of [['first', 'Avery'], ['dob', '04/12/1985'], ['first2', 'Riley'], ['dob2', '09/03/2015'], ['zip', '50309']]) doc.getElementById(id).value = value;
  for (const key of ['birthDate', 'firstName']) for (const id of ids(key)) assert.deepEqual(generic.readAnswer(doc, result.token, id, key), { repeated: true }, `${key} ${id}`);
  assert.deepEqual(generic.readAnswer(doc, result.token, ids('zip')[0], 'zip'), { value: '50309' }, 'a question asked once is read');
  // Answered or not, each box of a repeated question counts: the applicant's own box is often answered already.
  doc.getElementById('dob2').value = '';
  assert.deepEqual(generic.readAnswer(doc, result.token, ids('birthDate')[0], 'birthDate'), { repeated: true });
  // A member section whose heading names the person is that person's: the applicant's own box is read.
  const named = page('<label for="dob">Date of birth (MM/DD/YYYY)</label><input id="dob"><fieldset><legend>Child 1</legend><label for="kid">Date of birth</label><input id="kid"></fieldset>');
  const plan = generic.plan(named);
  const own = plan.matched.filter(item => item.key === 'birthDate');
  assert.equal(own.length, 1);
  named.getElementById('dob').value = '04/12/1985';
  named.getElementById('kid').value = '09/03/2015';
  assert.deepEqual(generic.readAnswer(named, plan.token, own[0].id, 'birthDate'), { value: '1985-04-12' });
});

test('password, code and signature boxes are never read, whatever key they are given', () => {
  const doc = page('<label for="email">Email</label><input id="email" type="email"><label for="pw">Password</label><input id="pw" type="password">' +
    '<label for="code">Verification code</label><input id="code"><label for="sig">Signature</label><input id="sig">');
  const result = generic.plan(doc);
  const email = result.matched.find(item => item.key === 'email');
  doc.getElementById('email').value = 'avery.example@example.invalid';
  doc.getElementById('code').value = '123456';
  doc.getElementById('sig').value = 'Avery Example';
  assert.deepEqual(generic.readAnswer(doc, result.token, email.id, 'email'), { value: 'avery.example@example.invalid' });
  for (const item of result.unmatched) for (const key of ['email', 'firstName', 'county']) assert.equal(generic.readAnswer(doc, result.token, item.id, key), null, `${item.label}: ${key}`);
  assert.equal(JSON.stringify(result).includes('Password'), false, 'a password box is never even planned');
});
