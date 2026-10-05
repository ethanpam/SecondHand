'use strict';

// The separately labeled recipient cells on the supplied Copy B layout with
// boxes 1a/1b/1d. Older combined-address layouts are not guessed. This parser
// proposes source-review candidates; the dispatcher additionally requires
// agreement of two OCR passes for identifiers and money.
const { validateProfile } = require('./schema.cjs');
const { STATE_NAMES } = require('./facts.cjs');
const { wordRows, matches, content, afterLabel, money, normalize, centerX, centerY, meanConfidence } = require('./document-layout.cjs');
const ADDRESS_KEYS = new Set(['addressLine1', 'addressLine2', 'city', 'state', 'zip']);
const unique = values => values.length === 1 ? values[0] : null;
const height = anchor => anchor.y1 - anchor.y0;
const aligned = (a, b) => a && b && Math.abs(a.y0 + a.y1 - b.y0 - b.y1) / 2 <= Math.max(height(a), height(b)) * 0.6;
const anchor = (row, words) => ({ row, words, x0: words[0].bbox.x0, x1: words.at(-1).bbox.x1,
  y0: Math.min(...words.map(word => word.bbox.y0)), y1: Math.max(...words.map(word => word.bbox.y1)) });

// Exact caption words and printed box number, adjacent in position. OCR can
// emit a second tiny overlapping word inside a correctly recognized caption;
// that duplicate is not an extra caption or a value. Missing/duplicate actual
// caption terms still fail closed. No caption text is invented or executed.
function box(rows, code, caption) {
  const found = [];
  for (const first of matches(rows, code)) {
    let last = first;
    const words = [...first.words];
    for (const token of caption.split(/\s+/)) {
      const next = unique(matches([first.row], token).filter(candidate => candidate.x0 >= last.x1 &&
        candidate.x0 - last.x1 <= Math.max(height(candidate), height(last)) * 3 && aligned(first, candidate) &&
        !first.row.words.some(word => centerX(word) > last.x1 && centerX(word) < candidate.x0 && /[\p{L}\p{N}]/u.test(word.text))));
      if (!next) { last = null; break; }
      words.push(...next.words); last = next;
    }
    if (last) found.push(anchor(first.row, words));
  }
  return unique(found);
}

function detect(page) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.words)) return 0;
  const rows = wordRows(page);
  if (!matches(rows, 'Form 1099-NEC').length) return 0;
  // A title is repeated in the footer. Count recipient sections instead so a
  // page holding two returns is never treated as one recipient's document.
  return matches(rows, "RECIPIENT'S name").length;
}

function parse(page) {
  const result = { type: '1099-nec', title: 'Form 1099-NEC nonemployee compensation', taxYear: '', fields: [], warnings: [] };
  const { fields, warnings } = result;
  if (detect(page) !== 1) {
    warnings.push('A single 1099-NEC recipient section could not be identified. Review the original document; no values were proposed.');
    return result;
  }
  const rows = wordRows(page), one = label => unique(matches(rows, label));
  const recipient = one("RECIPIENT'S name"), payer = one("PAYER'S name"), recipientTin = one("RECIPIENT'S TIN"), payerTin = one("PAYER'S TIN");
  const account = one('Account number');
  const boxes = {
    '1a': box(rows, '1a', 'Nonemployee compensation'), '1b': box(rows, '1b', 'Cash tips'), '1c': box(rows, '1c', 'TTOC'),
    '1d': box(rows, '1d', 'Overtime compensation'), '2': box(rows, '2', 'Payer made direct sales'),
    '3': box(rows, '3', 'Excess golden parachute payments'), '4': box(rows, '4', 'Federal income tax withheld'),
    '5': box(rows, '5', 'State tax withheld'), '6': box(rows, '6', "State/Payer's state no"), '7': box(rows, '7', 'State income')
  };
  const cash = boxes['1b'], overtime = boxes['1d'], sales = boxes['2'];
  if (!recipient || !payer || !account || !cash || !overtime || !sales ||
      !(payer.y1 < recipient.y0 && recipient.y1 < account.y0 && cash.y1 < overtime.y0 && overtime.y1 < sales.y0) ||
      Math.abs(cash.x0 - overtime.x0) > Math.max(height(cash), height(overtime)) ||
      Math.abs(cash.x0 - sales.x0) > Math.max(height(cash), height(sales)) || recipient.x1 >= cash.x0) {
    warnings.push('The supported 1099-NEC recipient layout could not be bounded reliably. Older or incomplete layouts need manual review.');
    return result;
  }
  const divider = cash.x0;
  const local = label => unique(matches(rows, label).filter(mark => mark.y0 > recipient.y1 && mark.y1 < account.y0 && mark.x0 < divider));
  const street = local('Street address'), apartment = local('Apt. no.'), city = local('City or town');
  const state = local('State or province'), country = local('Country'), zip = local('ZIP or foreign postal code');
  const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : 1;
  const cell = (from, to, left, right) => {
    const words = afterLabel(rows, from, to, left, right);
    // A word whose center happens to be in the cell must not bring in a value
    // crossing into a neighboring person's or address component's column.
    return words.every(word => word.bbox.x0 >= left - (word.bbox.y1 - word.bbox.y0) / 2 && word.bbox.x1 <= right) ? words : [];
  };
  const add = (id, label, value, words, source, { profileKey, sourceRole = 'document', kind } = {}) => {
    if (!value || !words.length || value.length > 200 || /[\u0000-\u001f]/.test(value)) return;
    if (profileKey) {
      if (!ADDRESS_KEYS.has(profileKey)) return;
      try { value = validateProfile({ [profileKey]: value })[profileKey]; } catch { return; }
    }
    fields.push({ id, label, value, page: pageNumber, confidence: meanConfidence(words), sourceRole,
      ...(source?.words ? { sourceLabel: content(source.words).slice(0, 150) } : {}), ...(profileKey ? { profileKey } : {}), ...(kind ? { kind } : {}) });
  };

  // Never use payer address/TIN as a fallback. Every recipient value is below
  // its own label and above the next recipient label in the left-hand column.
  if (street) {
    const nameWords = cell(recipient, street, recipient.x0, divider), name = content(nameWords);
    if (/^[\p{L}\p{N}][\p{L}\p{N} .,'’&()/+-]{0,199}$/u.test(name)) add('necRecipientName', 'Recipient name (check whose information this is)', name, nameWords, recipient);
  }
  if (recipientTin && payerTin && aligned(recipientTin, payerTin) && payerTin.x1 < recipientTin.x0 &&
      payer.y1 < payerTin.y0 && recipientTin.y1 < recipient.y0 && recipientTin.x0 < divider) {
    const words = cell(recipientTin, recipient, recipientTin.x0, divider);
    const tin = content(words).replace(/\s+/g, '');
    if (/^(?:\d{9}|\d{3}-\d{2}-\d{4}|\d{2}-\d{7})$/.test(tin)) add('necRecipientTin', 'Recipient taxpayer identifier (review only)', tin, words, recipientTin, { kind: 'identifier' });
  }

  const addressShape = street && apartment && city && state && country && zip && aligned(street, apartment) &&
    street.x1 < apartment.x0 && apartment.x1 < divider && street.y1 < city.y0 && city.y1 < state.y0 &&
    aligned(state, country) && aligned(state, zip) && state.x1 < country.x0 && country.x1 < zip.x0 && zip.x1 < divider;
  if (addressShape) {
    const countryWords = cell(country, account, country.x0, zip.x0);
    const stateWords = cell(state, account, state.x0, country.x0);
    const zipWords = cell(zip, account, zip.x0, divider);
    const postalState = content(stateWords).toUpperCase(), postalZip = content(zipWords).replace(/\s+/g, '');
    if (!['us', 'usa', 'unitedstates', 'unitedstatesofamerica'].includes(normalize(content(countryWords))) ||
        !Object.hasOwn(STATE_NAMES, postalState) || !/^\d{5}(?:-\d{4})?$/.test(postalZip)) {
      warnings.push('Recipient country, state, or postal-code information needs manual review. No domestic address was proposed.');
    } else {
      const streetWords = cell(street, city, street.x0, apartment.x0), streetValue = content(streetWords);
      if (/\d/.test(streetValue) && /\p{L}/u.test(streetValue)) add('necRecipientStreet', 'Recipient street address on 1099-NEC', streetValue, streetWords, street, { profileKey: 'addressLine1' });
      const apartmentWords = cell(apartment, city, apartment.x0, divider), apartmentValue = content(apartmentWords);
      if (/^[\p{L}\p{N} #./-]{1,40}$/u.test(apartmentValue)) add('necRecipientApartment', 'Recipient apartment or unit', apartmentValue, apartmentWords, apartment, { profileKey: 'addressLine2' });
      const cityWords = cell(city, state, city.x0, divider), cityValue = content(cityWords);
      if (/^[\p{L}][\p{L} .'-]{0,99}$/u.test(cityValue)) add('necRecipientCity', 'Recipient city', cityValue, cityWords, city, { profileKey: 'city' });
      add('necRecipientState', 'Recipient state', postalState, stateWords, state, { profileKey: 'state' });
      add('necRecipientZip', 'Recipient ZIP code', postalZip, zipWords, zip, { profileKey: 'zip' });
    }
  } else warnings.push('The separate recipient address cells could not all be identified. Check the address in the original document.');

  const calendar = one('For calendar year'), firstBox = boxes['1a'] || cash;
  if (calendar && calendar.x0 > divider && calendar.y1 < firstBox.y0) {
    const end = Math.min(firstBox.y0, calendar.y1 + height(calendar) * 4);
    const yearWords = rows.flatMap(row => row.words).filter(word => centerY(word) > calendar.y1 && centerY(word) < end &&
      word.bbox.x0 >= calendar.x0 && word.bbox.x1 <= calendar.x1 + height(calendar) * 2);
    // Only the printed calendar-year cell; revision dates and footer years
    // cannot supply this field, even if the calendar-year cell is blank.
    if (yearWords.length === 1 && /^(?:19|20)\d{2}$/.test(yearWords[0].text)) result.taxYear = yearWords[0].text;
  }
  if (!result.taxYear) warnings.push('The calendar year could not be read unambiguously. The printed revision date was not used as the tax year.');

  function amount(code, next, right, label) {
    const start = boxes[code];
    if (!start || !next || !right || right <= start.x0 || next.y0 <= start.y1) return;
    // Ignore a standalone currency symbol in an otherwise blank second state
    // row. Any second numeric/text row makes the cell ambiguous instead of
    // being joined into or mistaken for one amount.
    const bottom = Math.min(...next.row.words.map(word => word.bbox.y0));
    const candidateRows = rows.map(row => row.words.filter(word => centerY(word) > start.y1 && centerY(word) < bottom &&
      centerX(word) >= start.x0 && centerX(word) < right)).filter(words => words.some(word => !/^\$+$/.test(word.text.trim())));
    if (candidateRows.length !== 1) return;
    const words = candidateRows[0], value = money(content(words));
    if (words.some(word => word.bbox.x0 < start.x0 || word.bbox.x1 > right)) return;
    if (value !== null) add(`taxLineNecBox${code}`, `${label} (box ${code})${result.taxYear ? ` — ${result.taxYear}` : ''}`, value, words, start);
  }
  const bottomTitles = matches(rows, 'Form 1099-NEC').filter(mark => mark.y0 > account.y1), footer = unique(bottomTitles);
  const right = boxes['7']?.x0;
  amount('1a', cash, right, 'Annual nonemployee compensation');
  amount('1b', overtime, boxes['1c']?.x0, 'Annual cash tips');
  amount('1d', sales, right, 'Annual overtime compensation');
  amount('3', boxes['4'], right, 'Annual excess golden parachute payments');
  amount('4', boxes['5'], right, 'Annual federal income tax withheld');
  amount('5', footer, boxes['6']?.x0, 'Annual state tax withheld');
  // The rightmost column has no further numbered box; the final title on its
  // row supplies a conservative right boundary from the actual form footer.
  const footerWords = footer?.row.words || [];
  const footerRight = footerWords.length ? Math.max(...footerWords.map(word => word.bbox.x1)) : null;
  amount('7', footer, footerRight, 'Annual state income');

  if (fields.filter(field => field.id.startsWith('taxLineNecBox')).length < 7) warnings.push('Some numbered amount cells were blank or could not be read as one bounded amount. Check those boxes in the original document.');

  warnings.push('Confirm that the recipient and tax-year address belong to the applicant. Payer information is never proposed as applicant information.');
  warnings.push('The recipient name is kept together because this box may name a person or a business. First and last names are not guessed.');
  warnings.push('A recipient taxpayer identifier may be an SSN, ITIN, or EIN. It is review-only and is never copied into the applicant Social Security number.');
  warnings.push('1099-NEC amounts describe a tax year and may not represent current income. They are review-only; no monthly-income conversion is made.');
  return result;
}

module.exports = { detect, parse };
