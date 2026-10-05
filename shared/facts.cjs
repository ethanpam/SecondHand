'use strict';
// Turns a saved profile into short plain-language facts for the local decision model.
// Every calculation (ages, bands, totals) happens here in code; the model only reads
// the sentences. A fact is stated only when the saved answers prove it, and it is left
// out when they are missing, or when it comes from a birth date after today or more than
// 130 years ago (#135). Names, contact details, street address and SSN are never facts.
const { localToday, ageOn, householdCounts, memberAges } = require('./household.cjs');

// Saved fields whose facts need the applicant's permission before an answer based on them
// reaches a website: identity, money, health, housing and immigration details. Facts worked out
// from household members' birth dates name 'householdMembers.birthDate': they reveal ages, as the
// applicant's own birth date does.
const SENSITIVE_SOURCES = Object.freeze(['ssn', 'birthDate', 'householdMembers.birthDate', 'monthlyEarnedIncome', 'monthlyOtherIncome', 'assetsOnHand', 'monthlyMedicalExpenses',
  'householdDisability', 'householdPregnant', 'householdMedicare', 'householdAllCitizens', 'householdLegalStatus', 'hasHomeAddress']);
const AGE_THRESHOLDS = Object.freeze([18, 55, 60, 62, 65]);
const STATE_NAMES = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'the District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming'
});

const present = value => typeof value === 'string' && value.trim() !== '';
function count(profile, field) {
  if (!present(profile[field])) return null;
  if (!/^\d{1,3}$/.test(profile[field].trim())) throw new Error(`${field} must be a whole number.`);
  return Number(profile[field]);
}
function cents(profile, field) {
  if (!present(profile[field])) return null;
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(profile[field].trim());
  if (!match) throw new Error(`${field} must be a dollar amount.`);
  return Number(match[1]) * 100 + Number((match[2] || '0').padEnd(2, '0'));
}
function yesNo(profile, field) {
  if (!present(profile[field])) return null;
  const value = profile[field].trim();
  if (value !== 'yes' && value !== 'no') throw new Error(`${field} must be yes or no.`);
  return value === 'yes';
}
const dollars = amount => `$${Math.floor(amount / 100).toLocaleString('en-US')}${amount % 100 ? `.${String(amount % 100).padStart(2, '0')}` : ''}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const applicantAge = (profile, today) => present(profile.birthDate) ? ageOn(profile.birthDate, today) : null;
function ageBand(age) {
  const reached = AGE_THRESHOLDS.filter(threshold => age >= threshold).at(-1);
  const next = AGE_THRESHOLDS.find(threshold => age < threshold);
  if (reached === undefined) return `The applicant is younger than ${next}.`;
  if (next === undefined) return `The applicant is ${reached} or older.`;
  return `The applicant is ${reached} or older and younger than ${next}.`;
}

function buildFacts(profile, { today } = {}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError('A saved profile object is required.');
  const now = localToday(today);
  const facts = [];
  const add = (id, text, sources) => facts.push({ id, text, sources, sensitive: sources.some(source => SENSITIVE_SOURCES.includes(source)) });
  const said = (field, id, yes, no) => { const value = yesNo(profile, field); if (value !== null) add(id, value ? yes : no, [field]); return value; };

  const age = applicantAge(profile, now);
  if (age !== null) {
    add('applicant.age', `The applicant is ${age} years old.`, ['birthDate']);
    add('applicant.ageBand', ageBand(age), ['birthDate']);
  }

  // With a household list, its counts win over the manual ones: the size from its people, the age counts from their birth dates.
  const derived = householdCounts(profile, { today: now });
  const counted = (field, key) => derived ? (derived[key] === '' ? null : Number(derived[key])) : count(profile, field);
  const from = (field, byAge = true) => derived ? [byAge ? 'householdMembers.birthDate' : 'householdMembers'] : [field];
  const size = counted('householdSize', 'size');
  if (size !== null) add('household.size', `The household has ${plural(size, 'person', 'people')}.`, from('householdSize', false));
  const adults = counted('householdAdults', 'adults');
  if (adults !== null) add('household.adults', adults ? `The household has ${plural(adults, 'adult', 'adults')} aged 18 to 64.` : 'The household has no adults aged 18 to 64.', from('householdAdults'));
  const children = counted('householdChildren', 'children');
  if (children !== null) add('household.children', children ? `The household has ${plural(children, 'child', 'children')} under 18.` : 'The household has no children under 18.', from('householdChildren'));
  const seniors = counted('householdSeniors', 'seniors');
  // A senior applicant with a senior count of 0 contradicts itself, so the household claim is left out.
  if (seniors !== null && !(seniors === 0 && age !== null && age >= 65)) {
    add('household.seniors', seniors ? `The household has ${plural(seniors, 'person', 'people')} aged 65 or older.` : 'Nobody in the household is 65 or older.', from('householdSeniors'));
  }
  if (derived) memberFacts(profile, now, add);
  said('householdVeteran', 'household.veteran', 'Someone in the household is a veteran.', 'Nobody in the household is a veteran.');
  said('householdDisability', 'household.disability', 'Someone in the household has a disability.', 'Nobody in the household has a disability.');
  said('householdPregnant', 'household.pregnant', 'Someone in the household is pregnant.', 'Nobody in the household is pregnant.');
  said('householdMedicare', 'household.medicare', 'Someone in the household gets Medicare.', 'Nobody in the household gets Medicare.');
  const citizens = said('householdAllCitizens', 'household.citizens', 'Everyone in the household is a US citizen.', 'Not everyone in the household is a US citizen.');
  if (citizens === false) {
    said('householdLegalStatus', 'household.legalStatus', 'Household members who are not US citizens have legal documents to stay in the US.',
      'Some household members who are not US citizens do not have legal documents to stay in the US.');
  }

  said('hasHomeAddress', 'address.home', 'The applicant has a home address.', 'The applicant does not have a home address.');
  if (present(profile.state)) {
    const code = profile.state.trim().toUpperCase();
    const name = STATE_NAMES[code] || Object.values(STATE_NAMES).find(state => state.toLowerCase() === profile.state.trim().toLowerCase());
    if (!name) throw new Error('state must be a US state.');
    add('address.state', `The applicant lives in ${name}.`, ['state']);
  }
  if (present(profile.county)) {
    const county = profile.county.trim();
    add('address.county', `The applicant lives in ${/\bcounty$/i.test(county) ? county : `${county} County`}.`, ['county']);
  }
  if (present(profile.city)) add('address.city', `The applicant lives in ${profile.city.trim()}.`, ['city']);
  if (present(profile.zip)) add('address.zip', `The applicant’s ZIP code is ${profile.zip.trim()}.`, ['zip']);

  const earned = cents(profile, 'monthlyEarnedIncome');
  const other = cents(profile, 'monthlyOtherIncome');
  if (earned !== null) add('income.earned', earned ? `The household earns ${dollars(earned)} a month from work.` : 'The household has no income from work.', ['monthlyEarnedIncome']);
  if (other !== null) add('income.other', other ? `The household gets ${dollars(other)} a month from other income.` : 'The household has no other income.', ['monthlyOtherIncome']);
  // A total is only stated when both parts are known; a partial sum would understate income.
  if (earned !== null && other !== null) {
    const total = earned + other;
    add('income.total', total ? `The household’s total income is ${dollars(total)} a month (${dollars(total * 12)} a year).` : 'The household has no income.',
      ['monthlyEarnedIncome', 'monthlyOtherIncome']);
  }
  const rent = cents(profile, 'monthlyRent');
  if (rent !== null) add('housing.rent', rent ? `Rent or mortgage costs ${dollars(rent)} a month.` : 'The household pays no rent or mortgage.', ['monthlyRent']);
  const utilities = cents(profile, 'monthlyUtilities');
  if (utilities !== null) add('housing.utilities', utilities ? `Utilities cost ${dollars(utilities)} a month.` : 'The household pays no utilities.', ['monthlyUtilities']);
  const assets = cents(profile, 'assetsOnHand');
  if (assets !== null) add('money.assets', assets ? `The household has ${dollars(assets)} in cash, checking and savings.` : 'The household has no money in cash, checking or savings.', ['assetsOnHand']);
  const medical = cents(profile, 'monthlyMedicalExpenses');
  if (medical !== null) add('medical.costs', medical ? `The household pays ${dollars(medical)} a month in medical costs.` : 'The household has no monthly medical costs.', ['monthlyMedicalExpenses']);

  said('programSnap', 'program.snap', 'The applicant is applying for SNAP food assistance.', 'The applicant is not applying for SNAP food assistance.');
  said('programFip', 'program.fip', 'The applicant is applying for FIP cash assistance.', 'The applicant is not applying for FIP cash assistance.');
  said('programMedicaid', 'program.medicaid', 'The applicant is applying for Medicaid health coverage.', 'The applicant is not applying for Medicaid health coverage.');
  return facts;
}

const listing = numbers => numbers.length === 1 ? String(numbers[0]) : `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
// "in 5th grade", "in grade 3", "in kindergarten", or the grade as saved.
function gradeWords(grade) {
  if (/^\d{1,2}(st|nd|rd|th)$/i.test(grade)) return ` in ${grade.toLowerCase()} grade`;
  if (/^\d{1,2}$/.test(grade)) return ` in grade ${grade}`;
  if (/^(k|kinder|kindergarten)$/i.test(grade)) return ' in kindergarten';
  return ` (grade: ${grade})`;
}
// Facts about the people on the household list, never their names: everyone's age and the children's
// ages (from birth dates, so sensitive), and how many are students (only when every member's answer is saved).
function memberFacts(profile, today, add) {
  const ages = memberAges(profile, { today });
  if (ages) {
    add('household.ages', `The household members are ${listing([...ages].sort((a, b) => b - a))} years old.`, ['householdMembers.birthDate']);
    const children = ages.filter(age => age < 18).sort((a, b) => a - b);
    if (children.length) add('household.childAges', `The household has ${plural(children.length, 'child', 'children')}: ${children.length === 1 ? 'age' : 'ages'} ${listing(children)}.`, ['householdMembers.birthDate']);
  }
  const answers = profile.householdMembers.map(member => member.student);
  if (answers.some(answer => answer !== 'yes' && answer !== 'no')) return;
  const students = profile.householdMembers.filter(member => member.student === 'yes');
  const grade = students.length === 1 && present(students[0].grade) ? gradeWords(students[0].grade.trim()) : '';
  add('household.students', !students.length ? 'Nobody in the household is a student.' : students.length === 1 ? `One household member is a student${grade}.`
    : `${students.length} household members are students.`, ['householdMembers']);
}

const factsText = facts => facts.map(fact => fact.text).join(' ');
// The applicant's age in whole years, or null when no birth date is saved or the saved one can't be used.
const ageOf = (profile, { today } = {}) => applicantAge(profile, localToday(today));

module.exports = { buildFacts, factsText, ageOf, SENSITIVE_SOURCES, STATE_NAMES };
