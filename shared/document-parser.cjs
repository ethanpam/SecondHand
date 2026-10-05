'use strict';

// Review candidates only. This module never writes a profile, infers eligibility,
// or converts historical/joint tax amounts into current monthly income.
const { validateProfile } = require('./schema.cjs');
const additionalForms = [
  { type: 'w2', ...require('./document-w2.cjs') },
  { type: 'ssa1099', ...require('./document-ssa1099.cjs') },
  { type: '1099-nec', ...require('./document-1099nec.cjs') }
];

const PROFILE_KEYS = new Set(['firstName', 'middleName', 'lastName', 'ssn', 'addressLine1', 'addressLine2', 'city', 'state', 'zip']);
const { wordRows, matches, content, afterLabel, money, normalize, centerX, meanConfidence } = require('./document-layout.cjs');

function recognizedType(page) {
  const text = typeof page?.text === 'string' ? page.text.slice(0, 10000) : '';
  // Sparse segmentation can split the initial I of Income onto its own line.
  // Allow whitespace at that boundary, preserving the full printed title.
  if (/\b1\s*040\s*[-–]?\s*SR\b/i.test(text) && /\bI\s*ncome\s+Tax\s+Return\s+\w+\s+Seniors/i.test(text)) return '1040-sr';
  if (/\b1040\b/.test(text) && /U\.?\s*S\.?\s*(?:Individual\s+)?I\s*ncome\s+Tax\s+Return/i.test(text)) return '1040';
  return null;
}

function parseTaxPage(page, type) {
  const rows = wordRows(page), fields = [], warnings = [];
  const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : 1;
  const add = (id, label, value, words, profileKey, source, sourceRole = 'document') => {
    if (!value || !words.length || value.length > 200 || /[\u0000-\u001f]/.test(value)) return;
    if (profileKey) {
      if (!PROFILE_KEYS.has(profileKey)) return;
      try { value = validateProfile({ [profileKey]: value })[profileKey]; } catch { return; }
    }
    // Preserve the printed label separately from our display label. A model
    // comparing our own display label to our own mapping would check no evidence.
    const sourceLabel = source?.words ? content(source.words).slice(0, 150) : '';
    fields.push({ id, label, value, page: pageNumber, confidence: meanConfidence(words),
      ...(profileKey ? { profileKey } : {}), ...(sourceLabel ? { sourceLabel, sourceRole } : {}) });
  };
  const one = label => {
    const found = matches(rows, label);
    return found.length === 1 ? found[0] : null;
  };
  const primary = one('Your first name and middle initial');
  const spouse = one("If joint return spouse's first name and middle initial") || one("spouse's first name and middle initial");
  const home = one('Home address');
  const city = one('City town or post office');
  const foreign = one('Foreign country name');
  const filing = one('Filing');
  const sameRow = (anchor, label) => {
    if (!anchor) return null;
    const nearby = matches(rows, label).filter(item => Math.abs((item.y0 + item.y1 - anchor.y0 - anchor.y1) / 2) < Math.max(item.y1 - item.y0, anchor.y1 - anchor.y0) * 0.8);
    return nearby.length === 1 ? nearby[0] : null;
  };
  const names = (start, end, prefix, primaryPerson) => {
    const last = sameRow(start, 'Last name');
    const social = sameRow(start, primaryPerson ? 'Your social security number' : "Spouse's social security number");
    if (!start || !end || !last || !social || !(start.x0 < last.x0 && last.x0 < social.x0)) return;
    const firstCell = afterLabel(rows, start, end, primary?.x0 ?? start.x0, last.x0);
    const firstWords = firstCell.filter(word => /[\p{L}\p{N}]/u.test(word.text));
    if (firstWords.length !== firstCell.length) warnings.push(`${primaryPerson ? 'The primary taxpayer’s' : 'The spouse’s'} name contains an unreadable mark. Check the middle initial in the original.`);
    const first = content(firstWords);
    // The printed cell combines first name + middle initial, not a full middle
    // name. Preserve a multiword first name unless the final token is one letter.
    if (/^[\p{L}][\p{L} .'-]{0,99}$/u.test(first)) {
      const parts = first.split(/\s+/), initial = parts.length > 1 && /^[\p{L}]\.?$/u.test(parts.at(-1)) ? parts.pop().replace('.', '') : '';
      add(`${prefix}FirstName`, primaryPerson ? 'First name' : 'Spouse first name', parts.join(' '), firstWords, primaryPerson ? 'firstName' : undefined, start, primaryPerson ? 'applicant' : 'spouse');
      if (initial) add(`${prefix}MiddleName`, primaryPerson ? 'Middle initial' : 'Spouse middle initial', initial, firstWords, primaryPerson ? 'middleName' : undefined, start, primaryPerson ? 'applicant' : 'spouse');
    }
    const lastWords = afterLabel(rows, last, end, last.x0, social.x0), surname = content(lastWords);
    if (/^[\p{L}][\p{L} .'-]{0,99}$/u.test(surname)) add(`${prefix}LastName`, primaryPerson ? 'Last name' : 'Spouse last name', surname, lastWords, primaryPerson ? 'lastName' : undefined, last, primaryPerson ? 'applicant' : 'spouse');
    const ssnWords = afterLabel(rows, social, end, social.x0, page.width), ssn = content(ssnWords).replace(/\s+/g, '');
    if (/^\d{3}-?\d{2}-?\d{4}$/.test(ssn)) add(`${prefix}Ssn`, primaryPerson ? 'Social Security number' : 'Spouse Social Security number', ssn, ssnWords, primaryPerson ? 'ssn' : undefined, social, primaryPerson ? 'applicant' : 'spouse');
  };
  names(primary, spouse, 'applicant', true);
  names(spouse, home, 'spouse', false);

  // Only domestic-address cells from the same verified header. A tax address
  // can be old: it is offered for review, never treated as a current residence.
  const state = sameRow(city, 'State'), zip = sameRow(city, 'ZIP code'), apt = sameRow(home, 'Apt no');
  const rightColumn = sameRow(primary, 'Your social security number');
  if (home && city && foreign && primary && spouse && rightColumn && primary.y0 < spouse.y0 && spouse.y0 < home.y0 && home.y0 < city.y0) {
    const foreignValues = filing ? afterLabel(rows, foreign, filing, foreign.x0, rightColumn.x0) : [];
    if (foreignValues.length) warnings.push('Foreign-address information needs manual review; no domestic address was proposed.');
    else {
      const addressWords = apt ? afterLabel(rows, home, city, home.x0, apt.x0) : [];
      const street = content(addressWords);
      if (/\d/.test(street) && /[a-z]/i.test(street)) add('addressLine1', 'Address on tax return', street, addressWords, 'addressLine1', home);
      if (apt) {
        const apartmentWords = afterLabel(rows, apt, city, apt.x0, rightColumn.x0);
        const apartment = content(apartmentWords);
        if (/^[a-z0-9 #./-]{1,30}$/i.test(apartment)) add('addressLine2', 'Apartment or unit', apartment, apartmentWords, 'addressLine2', apt);
      }
      if (state && zip && city.x0 < state.x0 && state.x0 < zip.x0) {
        const cityWords = afterLabel(rows, city, foreign, city.x0, state.x0), town = content(cityWords);
        if (/^[\p{L}][\p{L} .'-]{0,99}$/u.test(town)) add('city', 'City', town, cityWords, 'city', city);
        const stateWords = afterLabel(rows, state, foreign, state.x0, zip.x0);
        add('state', 'State', content(stateWords), stateWords, 'state', state);
      }
      if (zip) {
        const zipWords = afterLabel(rows, zip, foreign, zip.x0, rightColumn.x0);
        add('zip', 'ZIP code', content(zipWords).replace(/\s+/g, ''), zipWords, 'zip', zip);
      }
    }
  }

  const yearText = word => word.text.replace(/^[|[({]+|[|\])},.]+$/g, '');
  const yearWords = rows.filter(row => row.y < page.height * 0.12).flatMap(row => row.words)
    .filter(word => /^(?:19|20)\d{2}$/.test(yearText(word)));
  const years = [...new Set(yearWords.map(yearText))];
  const taxYear = years.length === 1 ? years[0] : '';
  if (!taxYear) warnings.push('The tax year could not be identified unambiguously.');

  const taxLines = [
    ['1a', 'W-2 wages (line 1a)', 'Total amount from', false],
    ['1z', 'Total wages (line 1z)', 'Add lines 1a through 1h', false],
    ['2a', 'Tax-exempt interest (line 2a)', 'Tax-exempt interest', true],
    ['2b', 'Taxable interest (line 2b)', 'Taxable interest', false],
    ['3a', 'Qualified dividends (line 3a)', 'Qualified dividends', true],
    ['3b', 'Ordinary dividends (line 3b)', 'Ordinary dividends', false],
    ['4a', 'IRA distributions (line 4a)', 'IRA distributions', true],
    ['5a', 'Pensions and annuities (line 5a)', 'Pensions and annuities', true],
    ['6a', 'Social Security benefits (line 6a)', 'Social security benefits', true]
  ];
  const amount = (code, label, anchor, left) => {
    if (!anchor) return;
    const row = anchor.row;
    const codes = row.words.filter(word => normalize(word.text).replace(/^l(?=[az]$)/, '1') === code);
    const marker = codes.sort((a, b) => b.bbox.x0 - a.bbox.x0)[0];
    if (!marker || marker.bbox.x0 < anchor.x1) return;
    const nextColumn = left ? row.words.find(word => normalize(word.text) === 'b' && word.bbox.x0 > marker.bbox.x1) : null;
    if (left && !nextColumn) return;
    const words = row.words.filter(word => word.bbox.x0 >= marker.bbox.x1 && (!left || centerX(word) < nextColumn.bbox.x0));
    // Ignore border artifacts but never repair letters into digits or guess zeros.
    const numbers = words.filter(word => /[\d]/.test(word.text));
    if (words.some(word => /[a-z]/i.test(word.text)) || numbers.length !== 1) return;
    const value = money(numbers[0].text);
    if (value !== null) add(`taxLine${code}`, `${label}${taxYear ? ` — ${taxYear}` : ''}`, value, numbers, undefined, anchor);
  };
  for (const [code, label, caption, left] of taxLines) amount(code, label, one(caption), left);
  for (const [code, caption, label] of [
    ['4b', 'IRA distributions', 'Taxable IRA distributions (line 4b)'],
    ['5b', 'Pensions and annuities', 'Taxable pensions and annuities (line 5b)'],
    ['6b', 'Social security benefits', 'Taxable Social Security benefits (line 6b)']
  ]) {
    const anchor = one(caption);
    amount(code, label, anchor && sameRow(anchor, 'Taxable amount'), false);
  }
  warnings.push('Tax-return amounts are historical and may combine income for more than one person. They are not copied into current monthly income.');
  warnings.push('Confirm that the primary taxpayer and address belong to the applicant before selecting any profile fields.');
  if (fields.some(field => field.confidence < 75)) warnings.push('Some detected values have low OCR confidence. Compare them with the original document.');
  if (!fields.some(field => field.profileKey)) warnings.push('The taxpayer header could not be read reliably; use the extracted text and enter profile details yourself.');
  return { type, title: type === '1040-sr' ? 'Form 1040-SR tax return' : 'Form 1040 tax return', taxYear, fields, warnings };
}

// Require a single recognizable document, even when different form types share
// a page or PDF. Each parser establishes its own printed-label boundaries.
function recognizedForms(page) {
  const type = recognizedType(page);
  const taxHeaders = type ? matches(wordRows(page), 'Your first name and middle initial') : [];
  const found = taxHeaders.map(() => ({ page, parse: candidate => parseTaxPage(candidate, type), type }));
  for (const parser of additionalForms) {
    const count = parser.detect(page);
    for (let index = 0; index < count; index++) found.push({ page, parse: parser.parse, type: parser.type });
  }
  return found;
}

function analyzeDocument(document) {
  const pages = Array.isArray(document?.pages) ? document.pages.slice(0, 12) : [];
  const found = pages.flatMap((page, pageIndex) => recognizedForms(page).map(form => ({ ...form, pageIndex })));
  const alternates = pages.flatMap((page, pageIndex) => page?.alternative && Array.isArray(page.alternative.words)
    ? recognizedForms({ ...page, ...page.alternative, alternative: undefined }).map(form => ({ ...form, pageIndex })) : []);
  // A second form seen in either pass is evidence of ambiguity, even when the
  // other pass misses its heading or cannot read its applicant cells.
  const ambiguous = found.length > 1 || alternates.length > 1 || (found.length === 1 &&
    alternates.some(form => form.pageIndex !== found[0].pageIndex || form.type !== found[0].type));
  if (found.length === 1 && !ambiguous) {
    const { page, parse } = found[0];
    const result = parse(page);
    const alternate = alternates.length === 1 ? alternates[0].parse(alternates[0].page) : null;
    const sameForm = alternate?.type === result.type;
    const alternateFields = new Map(sameForm ? alternate.fields.map(field => [field.id, field]) : []);
    const omitted = [], omittedSsn = [], omittedIdentifier = [];
    result.fields = result.fields.filter(field => {
      const isAmount = field.id.startsWith('taxLine'), isSsn = field.id.endsWith('Ssn');
      const isIdentifier = isSsn || field.kind === 'identifier';
      if (!isAmount && !isIdentifier) return true;
      const other = alternateFields.get(field.id);
      if (!other || other.value !== field.value || other.profileKey !== field.profileKey || other.sourceRole !== field.sourceRole ||
          (isAmount && other.label !== field.label)) {
        (isSsn ? omittedSsn : isIdentifier ? omittedIdentifier : omitted).push(field.id);
        return false;
      }
      field.confidence = Math.min(field.confidence, other.confidence);
      return true;
    });
    // Agreement reduces grid-related truncation but is not proof of accuracy.
    // All amounts remain read-only, with no route into monthly-income answers.
    if (omitted.length || !result.fields.some(field => field.id.startsWith('taxLine'))) {
      result.warnings.push('Some tax amounts could not be read consistently and were left out. Review the amounts in the original document.');
    }
    if (omittedSsn.length) result.warnings.push('A Social Security number could not be read consistently and was left out. Enter it yourself after checking the original document.');
    if (omittedIdentifier.length) result.warnings.push('A taxpayer identifier could not be read consistently and was left out. Check the original document.');
    if (sameForm && result.taxYear !== alternate.taxYear) {
      result.taxYear = '';
      result.warnings.push('The tax year is missing or inconsistent between OCR passes. Check each printed year in the original document.');
    }
    if (sameForm) for (const warning of alternate.warnings.filter(message => /year/i.test(message))) {
      if (!result.warnings.includes(warning)) result.warnings.push(warning);
    }
    result.warnings.unshift('OCR can misread letters or digits even when confidence is high. Check every selected value against the original document.');
    return result;
  }
  return { type: 'unknown', title: 'Scanned document', taxYear: '', fields: [], warnings: [ambiguous
    ? 'More than one tax-return or statement header was found. Review each document separately; no profile values were proposed.'
    : 'This document does not have a supported tax-form layout. Review the extracted text and enter any useful details yourself.'] };
}

module.exports = { analyzeDocument, wordRows };
