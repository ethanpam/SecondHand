'use strict';
// The household list's derived answers: ages as of today, the counts a form asks for, and a student's
// name and grade. Every count is worked out here in code from saved birth dates; nothing is guessed.
// A count that needs a birth date the list doesn't have is unknown (''), never a number.

const BAND_PREFIX = 'householdCount:';
// "householdCount:0-17" or "householdCount:60+": whole numbers from 0 to 120, written without leading zeros.
const BAND_KEY = /^householdCount:(0|[1-9]\d{0,2})(?:-(0|[1-9]\d{0,2})|(\+))$/;
const MAX_AGE = 120;
// The profile's fixed counts and the ages each one covers.
const COUNT_BANDS = Object.freeze({ householdChildren: { low: 0, high: 17 }, householdAdults: { low: 18, high: 64 }, householdSeniors: { low: 65, high: null } });

function calendarDate(value, what) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!date || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) throw new Error(`${what} must be a real date written YYYY-MM-DD.`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}
// Today on this computer's calendar, or the day a caller names (a Date or YYYY-MM-DD). This one "today"
// is what a birth date is checked against when it is saved and what ages are worked out from (#135):
// the computer's own date, in its own timezone, never the UTC date.
function localToday(today) {
  if (today === undefined) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }
  if (today instanceof Date) return { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() };
  if (typeof today === 'object' && today && Number.isInteger(today.year)) return today;
  return calendarDate(today, 'today');
}
const pad = (value, size) => String(value).padStart(size, '0');
// The same day written YYYY-MM-DD.
function localDate(today) {
  const { year, month, day } = localToday(today);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}
// A birth date is used only when it is today or earlier and no more than this many years ago.
const MAX_YEARS_BACK = 130;
const before = (a, b) => a.year !== b.year ? a.year < b.year : a.month !== b.month ? a.month < b.month : a.day < b.day;
// Why a saved birth date can't be used on `today`: 'future', 'tooOld', or null when it can (or none is saved).
// A date that isn't a real YYYY-MM-DD date throws: the schema never saves one.
function birthDateProblem(birthDate, today) {
  if (typeof birthDate !== 'string' || !birthDate.trim()) return null;
  const birth = calendarDate(birthDate.trim(), 'Birth date');
  const now = localToday(today);
  if (before(now, birth)) return 'future';
  if (before(birth, { ...now, year: now.year - MAX_YEARS_BACK })) return 'tooOld';
  return null;
}
// Whole years on `today`; a birthday counts on the day itself. Null when no birth date is saved, or when
// the saved one can't be used: then nothing worked out from it is answered.
function ageOn(birthDate, today) {
  if (typeof birthDate !== 'string' || !birthDate.trim() || birthDateProblem(birthDate, today)) return null;
  const birth = calendarDate(birthDate.trim(), 'Birth date');
  const now = localToday(today);
  return now.year - birth.year - (now.month < birth.month || (now.month === birth.month && now.day < birth.day) ? 1 : 0);
}

const members = profile => Array.isArray(profile?.householdMembers) ? profile.householdMembers : [];
// Whether the household list is in use: then it, not the manual counts, answers household questions.
const listed = profile => members(profile).length > 0;
// Whether the applicant's own birth date, or anyone's on the household list, can't be used on `today`.
const hasUnusableBirthDate = (profile, { today } = {}) =>
  [profile?.birthDate, ...members(profile).map(member => member.birthDate)].some(birthDate => birthDateProblem(birthDate, today) !== null);
// Every member's age, or null when the list is empty or a birth date is missing or can't be used.
function memberAges(profile, { today } = {}) {
  const list = members(profile);
  if (!list.length) return null;
  const ages = list.map(member => ageOn(member.birthDate, today));
  return ages.includes(null) ? null : ages;
}
const within = (age, { low, high }) => age >= low && (high === null || age <= high);

// The fixed counts from the list, or null without one. The size counts everyone; the age counts need every birth date.
function householdCounts(profile, { today } = {}) {
  if (!listed(profile)) return null;
  const ages = memberAges(profile, { today });
  const count = band => ages ? String(ages.filter(age => within(age, band)).length) : '';
  return { size: String(members(profile).length), adults: count(COUNT_BANDS.householdAdults), children: count(COUNT_BANDS.householdChildren), seniors: count(COUNT_BANDS.householdSeniors) };
}

function parseBand(key) {
  const match = typeof key === 'string' ? BAND_KEY.exec(key) : null;
  if (!match) return null;
  const low = Number(match[1]);
  const high = match[3] ? null : Number(match[2]);
  if (low > MAX_AGE || (high !== null && (high > MAX_AGE || high < low))) return null;
  return { low, high };
}
const isBandKey = key => parseBand(key) !== null;
// How many members are in the band, from their birth dates: '' when the list is empty, a birth date is missing, or the band is malformed.
function bandCount(profile, key, { today } = {}) {
  const band = parseBand(key);
  const ages = band && memberAges(profile, { today });
  return ages ? String(ages.filter(age => within(age, band)).length) : '';
}
function bandLabel(key) {
  const band = parseBand(key);
  if (!band) throw new Error('Unknown field.');
  const ages = band.high === null ? `${band.low} or older` : band.high === band.low ? `${band.low}` : `${band.low} to ${band.high}`;
  return `People in the household aged ${ages}`;
}

// "First Last, Grade" for the one member who is a student, when every other member is saved as not
// one and the student's grade is saved. Otherwise '' and the question stays with the applicant.
function studentNameGrade(profile) {
  const list = members(profile);
  const students = list.filter(member => member.student === 'yes');
  if (students.length !== 1 || list.some(member => member.student !== 'yes' && member.student !== 'no')) return '';
  const [student] = students;
  const name = [student.firstName, student.lastName].map(part => String(part || '').trim()).filter(Boolean).join(' ');
  const grade = String(student.grade || '').trim();
  return name && grade ? `${name}, ${grade}` : '';
}

// The named fields the household list answers, beside the age-band counts: its size, its counts by age, and the student.
const LIST_ANSWERS = Object.freeze(['householdSize', ...Object.keys(COUNT_BANDS), 'studentNameGrade']);
// What the household list lacks for these fields a page asked for and got no answer to (#180): { need: 'list' } when no list
// is saved, or { need: 'birthDate', person } when a count by age needs a birth date the list doesn't have, `person` naming the
// first such member as My information does ('you', or their row number). Null when none of them is the list's to answer.
function listNeed(profile, fields) {
  const byAge = field => isBandKey(field) || Object.hasOwn(COUNT_BANDS, field);
  if (!fields.some(field => byAge(field) || LIST_ANSWERS.includes(field))) return null;
  if (!listed(profile)) return { need: 'list' };
  const index = members(profile).findIndex(member => typeof member.birthDate !== 'string' || !member.birthDate.trim());
  if (index < 0 || !fields.some(byAge)) return null;
  return { need: 'birthDate', person: members(profile)[index].relationship === 'self' ? 'you' : index + 1 };
}

module.exports = { BAND_PREFIX, COUNT_BANDS, MAX_YEARS_BACK, LIST_ANSWERS, calendarDate, localToday, localDate, birthDateProblem, ageOn, listed, hasUnusableBirthDate, memberAges, householdCounts,
  parseBand, isBandKey, bandCount, bandLabel, studentNameGrade, listNeed };
