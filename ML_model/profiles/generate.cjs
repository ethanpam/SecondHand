'use strict';
// Fictional households for training data. Seeded, so the same seed and date always give
// the same households. No names, contact details, street addresses or SSNs: only the
// fields the facts builder reads, with some left blank so the model learns "facts don't say".

const IOWA = Object.freeze([
  ['Polk', 'Des Moines', 503], ['Linn', 'Cedar Rapids', 524], ['Scott', 'Davenport', 528], ['Johnson', 'Iowa City', 522], ['Black Hawk', 'Waterloo', 507],
  ['Woodbury', 'Sioux City', 511], ['Story', 'Ames', 500], ['Dubuque', 'Dubuque', 520], ['Pottawattamie', 'Council Bluffs', 515], ['Dallas', 'Waukee', 502],
  ['Warren', 'Indianola', 501], ['Clinton', 'Clinton', 527], ['Cerro Gordo', 'Mason City', 504], ['Muscatine', 'Muscatine', 527], ['Marshall', 'Marshalltown', 501],
  ['Des Moines', 'Burlington', 526], ['Webster', 'Fort Dodge', 505], ['Wapello', 'Ottumwa', 525], ['Lee', 'Keokuk', 526], ['Jasper', 'Newton', 502]
]);
const OTHER_STATES = Object.freeze(['IL', 'MN', 'NE', 'MO', 'WI', 'SD', 'TX', 'CA', 'NY', 'GA', 'OH', 'PA', 'CO', 'NV', 'OK', 'RI']);
const OTHER_COUNTIES = Object.freeze(['Jefferson', 'Franklin', 'Washington', 'Marion', 'Madison', 'Clay', 'Monroe', 'Greene', 'Lincoln', 'Jackson']);
const OTHER_CITIES = Object.freeze(['Springfield', 'Riverton', 'Fairview', 'Lakewood', 'Oakdale', 'Greenville', 'Milford', 'Centerville']);

// mulberry32: a small, well-known seeded generator.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function calendar(today) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(today));
  if (!match) throw new Error('today must be a YYYY-MM-DD date.');
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function household(next, today) {
  const chance = p => next() < p;
  const pick = list => list[Math.floor(next() * list.length)];
  const between = (low, high) => low + Math.floor(next() * (high - low + 1));
  const weighted = entries => { let r = next() * entries.reduce((sum, [, w]) => sum + w, 0); for (const [value, w] of entries) { r -= w; if (r < 0) return value; } return entries.at(-1)[0]; };
  const money = (low, high, step = 10) => String(between(low / step, high / step) * step);

  const age = weighted([[[18, 24], 15], [[25, 44], 35], [[45, 59], 20], [[60, 64], 10], [[65, 95], 20]]);
  const applicantAge = between(age[0], age[1]);
  // A birth date exactly applicantAge years before today, minus 0 to 364 days.
  const birth = new Date(today);
  birth.setUTCFullYear(birth.getUTCFullYear() - applicantAge);
  birth.setUTCDate(birth.getUTCDate() - between(0, 364));
  const senior = applicantAge >= 65;
  const adults = (senior ? 0 : 1) + weighted([[0, 45], [1, 40], [2, 10], [3, 5]]);
  const children = applicantAge < 55 ? weighted([[0, 45], [1, 20], [2, 17], [3, 10], [4, 5], [5, 3]]) : weighted([[0, 85], [1, 10], [2, 5]]);
  const seniors = (senior ? 1 : 0) + (applicantAge >= 55 ? weighted([[0, 60], [1, 40]]) : weighted([[0, 95], [1, 5]]));
  const iowa = chance(0.6);
  const [county, city, zip3] = iowa ? pick(IOWA) : [pick(OTHER_COUNTIES), pick(OTHER_CITIES), between(100, 989)];
  const allCitizens = chance(0.88);
  const earnedNone = chance(0.3);

  const profile = {
    birthDate: birth.toISOString().slice(0, 10),
    state: iowa ? 'IA' : pick(OTHER_STATES), county: chance(0.5) ? `${county} County` : county, city, zip: `${zip3}${String(between(0, 99)).padStart(2, '0')}`,
    hasHomeAddress: chance(0.94) ? 'yes' : 'no',
    householdSize: String(adults + children + seniors), householdAdults: String(adults), householdChildren: String(children), householdSeniors: String(seniors),
    householdVeteran: chance(0.1) ? 'yes' : 'no', householdDisability: chance(0.2) ? 'yes' : 'no', householdPregnant: chance(0.06) ? 'yes' : 'no',
    householdMedicare: chance(seniors ? 0.8 : 0.08) ? 'yes' : 'no', householdAllCitizens: allCitizens ? 'yes' : 'no',
    householdLegalStatus: allCitizens ? '' : chance(0.7) ? 'yes' : 'no',
    monthlyEarnedIncome: earnedNone ? '0' : money(200, 4800, 50), monthlyOtherIncome: chance(0.4) ? '0' : money(100, 1800),
    monthlyRent: chance(0.1) ? '0' : money(300, 1800), monthlyUtilities: money(0, 400), assetsOnHand: chance(0.2) ? `${money(0, 3000)}.${String(between(0, 99)).padStart(2, '0')}` : money(0, 3000),
    monthlyMedicalExpenses: chance(0.5) ? '0' : money(10, 500),
    programSnap: chance(0.7) ? 'yes' : 'no', programFip: chance(0.2) ? 'yes' : 'no', programMedicaid: chance(0.5) ? 'yes' : 'no'
  };
  // Blank answers, so the model learns when the facts don't say.
  const sparse = chance(0.03);
  for (const field of Object.keys(profile)) if (profile[field] && chance(sparse ? 0.8 : 0.12)) profile[field] = '';
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => value !== ''));
}

function generateHouseholds({ count, seed, today }) {
  if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error('count must be a whole number from 1 to 100000.');
  if (!Number.isInteger(seed)) throw new Error('seed must be a whole number.');
  const date = calendar(today);
  const next = random(seed);
  return Array.from({ length: count }, () => household(next, date));
}

module.exports = { generateHouseholds };
