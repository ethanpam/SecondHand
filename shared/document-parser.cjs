'use strict';

// Review candidates only. This module never writes a profile, infers eligibility,
// or converts historical/joint tax amounts into current monthly income.
const { validateProfile } = require('./schema.cjs');

const PROFILE_KEYS = new Set(['firstName', 'middleName', 'lastName', 'ssn', 'addressLine1', 'addressLine2', 'city', 'state', 'zip']);
const normalize = text => String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
const centerY = word => (word.bbox.y0 + word.bbox.y1) / 2;
const centerX = word => (word.bbox.x0 + word.bbox.x1) / 2;
const phrase = text => text.split(/\s+/).map(normalize);
const meanConfidence = words => Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / (words.length || 1));
const content = words => words.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0).map(word => word.text).join(' ').trim();
const wordHeight = word => word.bbox.y1 - word.bbox.y0;
const medianHeight = words => words.map(wordHeight).sort((a, b) => a - b)[Math.floor(words.length / 2)];
const inside = (mark, word) => word.bbox.x0 <= mark.bbox.x0 && mark.bbox.x1 <= word.bbox.x1 && word.bbox.y0 <= mark.bbox.y0 && mark.bbox.y1 <= word.bbox.y1;

// OCR can report a mark it split off a word, such as the dot of an i, as its
// own tiny word inside that word's box. It is part of the word already read,
// not separate text. Ordered by position, it would break a printed label or
// join a value. Only marks far shorter than this page's text are dropped.
function withoutSplitMarks(words) {
  const typical = medianHeight(words) || 0;
  const tiny = word => wordHeight(word) * 3 <= typical;
  const text = words.filter(word => !tiny(word));
  return words.filter(mark => !tiny(mark) || !text.some(word => inside(mark, word)));
}

function wordRows(page) {
  const width = Number(page.width), height = Number(page.height);
  if (!(width > 0 && height > 0) || !Array.isArray(page.words)) return [];
  const words = withoutSplitMarks(page.words.slice(0, 12000).filter(word => typeof word?.text === 'string' && word.text.trim() && word.text.length <= 250 &&
    Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 100 && word.bbox &&
    ['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(word.bbox[key])) &&
    word.bbox.x0 >= 0 && word.bbox.y0 >= 0 && word.bbox.x1 <= width && word.bbox.y1 <= height &&
    word.bbox.x1 > word.bbox.x0 && word.bbox.y1 > word.bbox.y0)
    .map(word => ({ ...word, text: word.text.trim() })));
  const tolerance = Math.max(2, (medianHeight(words) || 10) * 0.5);
  const rows = [];
  for (const word of words.sort((a, b) => centerY(a) - centerY(b))) {
    const recent = rows[rows.length - 1];
    if (recent && Math.abs(centerY(word) - recent.y) <= tolerance) {
      recent.words.push(word);
      recent.y = recent.words.reduce((sum, item) => sum + centerY(item), 0) / recent.words.length;
    } else rows.push({ y: centerY(word), words: [word] });
  }
  for (const row of rows) {
    row.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    row.text = content(row.words);
  }
  return rows;
}

function matches(rows, label) {
  const wanted = phrase(label).join(''), found = [];
  for (const row of rows) for (let index = 0; index < row.words.length; index++) {
    if (!normalize(row.words[index].text)) continue;
    let joined = '';
    for (let end = index; end < Math.min(row.words.length, index + 20); end++) {
      joined += normalize(row.words[end].text);
      if (!wanted.startsWith(joined)) break;
      if (joined !== wanted) continue;
      const words = row.words.slice(index, end + 1);
      found.push({ row, words, x0: words[0].bbox.x0, x1: words.at(-1).bbox.x1,
        y0: Math.min(...words.map(word => word.bbox.y0)), y1: Math.max(...words.map(word => word.bbox.y1)) });
      break;
    }
  }
  return found;
}

function afterLabel(rows, anchor, next, x0, x1) {
  // The next header's columns can have slightly different vertical bounds.
  // Stop at its entire row so a short word in an adjacent label cannot become
  // part of the preceding cell (especially the taxpayer's SSN).
  const bottom = next && Math.min(...next.row.words.map(word => word.bbox.y0));
  if (!anchor || !next || bottom <= anchor.y1 || !(x1 > x0)) return [];
  // One value row in a bounded cell only. Never search farther down the page
  // when a primary value is blank (a spouse/dependent could be there).
  const candidates = rows.map(row => row.words.filter(word => centerY(word) > anchor.y1 && centerY(word) < bottom &&
    centerX(word) >= x0 && centerX(word) < x1)).filter(words => words.length);
  return candidates.length === 1 ? candidates[0] : [];
}

function recognizedType(page) {
  const text = typeof page?.text === 'string' ? page.text.slice(0, 10000) : '';
  if (/\bSSA[-– ]?1099\b/i.test(text) && /SOCIAL SECURITY BENEFIT STATEMENT/i.test(text)) return 'ssa-1099';
  if (/\b1099[-– ]?NEC\b/i.test(text) && /Nonemployee\s+Compensation/i.test(text)) return '1099-nec';
  if (/\bW[-– ]?2\b/i.test(text) && /Wage and Tax Statement/i.test(text)) return 'w2';
  if (/\b1\s*040\s*[-–]?\s*SR\b/i.test(text) && /Income Tax Return\s+\w+\s+Seniors/i.test(text)) return '1040-sr';
  if (/\b1040\b/.test(text) && /U\.?\s*S\.?\s*(?:Individual )?Income Tax Return/i.test(text)) return '1040';
  return null;
}

function money(raw) {
  const value = raw.trim().replace(/\s+/g, '').replace(/^\$/, '');
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.\d{2})?$/.test(value)) return null;
  return value.replace(/,/g, '');
}

function parseTaxPage(page, type) {
  const rows = wordRows(page), fields = [], warnings = [];
  const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : 1;
  const add = (id, label, value, words, profileKey) => {
    if (!value || !words.length || value.length > 200 || /[\u0000-\u001f]/.test(value)) return;
    if (profileKey) {
      if (!PROFILE_KEYS.has(profileKey)) return;
      try { value = validateProfile({ [profileKey]: value })[profileKey]; } catch { return; }
    }
    fields.push({ id, label, value, page: pageNumber, confidence: meanConfidence(words), ...(profileKey ? { profileKey } : {}) });
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
      add(`${prefix}FirstName`, primaryPerson ? 'First name' : 'Spouse first name', parts.join(' '), firstWords, primaryPerson ? 'firstName' : undefined);
      if (initial) add(`${prefix}MiddleName`, primaryPerson ? 'Middle initial' : 'Spouse middle initial', initial, firstWords, primaryPerson ? 'middleName' : undefined);
    }
    const lastWords = afterLabel(rows, last, end, last.x0, social.x0), surname = content(lastWords);
    if (/^[\p{L}][\p{L} .'-]{0,99}$/u.test(surname)) add(`${prefix}LastName`, primaryPerson ? 'Last name' : 'Spouse last name', surname, lastWords, primaryPerson ? 'lastName' : undefined);
    const ssnWords = afterLabel(rows, social, end, social.x0, page.width), ssn = content(ssnWords).replace(/\s+/g, '');
    if (/^\d{3}-?\d{2}-?\d{4}$/.test(ssn)) add(`${prefix}Ssn`, primaryPerson ? 'Social Security number' : 'Spouse Social Security number', ssn, ssnWords, primaryPerson ? 'ssn' : undefined);
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
      if (/\d/.test(street) && /[a-z]/i.test(street)) add('addressLine1', 'Address on tax return', street, addressWords, 'addressLine1');
      if (apt) {
        const apartmentWords = afterLabel(rows, apt, city, apt.x0, rightColumn.x0);
        const apartment = content(apartmentWords);
        if (/^[a-z0-9 #./-]{1,30}$/i.test(apartment)) add('addressLine2', 'Apartment or unit', apartment, apartmentWords, 'addressLine2');
      }
      if (state && zip && city.x0 < state.x0 && state.x0 < zip.x0) {
        const cityWords = afterLabel(rows, city, foreign, city.x0, state.x0), town = content(cityWords);
        if (/^[\p{L}][\p{L} .'-]{0,99}$/u.test(town)) add('city', 'City', town, cityWords, 'city');
        const stateWords = afterLabel(rows, state, foreign, state.x0, zip.x0);
        add('state', 'State', content(stateWords), stateWords, 'state');
      }
      if (zip) {
        const zipWords = afterLabel(rows, zip, foreign, zip.x0, rightColumn.x0);
        add('zip', 'ZIP code', content(zipWords).replace(/\s+/g, ''), zipWords, 'zip');
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
    if (value !== null) add(`taxLine${code}`, `${label}${taxYear ? ` — ${taxYear}` : ''}`, value, numbers);
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

// Identity and labeled annual amounts. Statement amounts never become current monthly income.
function parseStatementPage(page, type) {
  const rows = wordRows(page), fields = [];
  const unique = list => list.length === 1 ? list[0] : null;
  const one = label => unique(matches(rows, label));
  const sameRow = (anchor, label) => anchor && unique(matches(rows, label).filter(item =>
    Math.abs((item.y0 + item.y1 - anchor.y0 - anchor.y1) / 2) < Math.max(item.y1 - item.y0, anchor.y1 - anchor.y0) * 0.8));
  const below = (label, anchor) => anchor && unique(matches(rows, label).filter(item => item.y0 > anchor.y1));
  const cellRows = (start, end, left, right) => {
    if (!start || !end || end.y0 <= start.y1 || !(right > left)) return [];
    return rows.map(row => row.words.filter(word => centerY(word) > start.y1 && centerY(word) < end.y0 && centerX(word) >= left && centerX(word) < right)).filter(words => words.length);
  };
  const add = (key, label, value, words) => {
    if (!value || !words.length || !PROFILE_KEYS.has(key)) return;
    try { value = validateProfile({ [key]: value })[key]; } catch { return; }
    fields.push({ id: key, label, value, profileKey: key, page: page.pageNumber || 1, confidence: meanConfidence(words) });
  };
  const fullName = words => {
    const name = content(words);
    // Combined-name fields have no reliable boundary for compound surnames. Leave ambiguous names manual.
    if (!/^[\p{L}][\p{L} .'-]{1,99}$/u.test(name)) return;
    const parts = name.split(/\s+/);
    if (!(parts.length === 2 || (parts.length === 3 && /^[\p{L}]\.?$/u.test(parts[1])))) return;
    add('firstName', 'First name', parts[0], words);
    if (parts.length === 3) add('middleName', 'Middle initial', parts[1].replace('.', ''), words);
    add('lastName', 'Last name', parts.at(-1), words);
  };
  const street = words => {
    const raw = content(words);
    if (!/^\d+[\p{L}\d .,'#/-]+$/u.test(raw)) return;
    const match = raw.match(/^(.*?)(?:,?\s+(?:APT\.?|UNIT|SUITE|STE\.?|#)\s*([\w-]+))$/i);
    add('addressLine1', 'Address on statement', (match ? match[1] : raw).replace(/,$/, '').trim(), words);
    if (match) add('addressLine2', 'Apartment or unit', match[2], words);
  };
  const cityStateZip = words => {
    const match = content(words).match(/^([\p{L} .'-]+),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/u);
    if (!match) return;
    add('city', 'City', match[1].trim(), words);
    add('state', 'State', match[2], words);
    add('zip', 'ZIP code', match[3], words);
  };
  if (type === '1099-nec') {
    const name = one("RECIPIENT'S name");
    const address = below('Street address', name), city = below('City or town', address);
    const state = below('State or province', city), end = below('Account number', state);
    const apt = sameRow(address, 'Apt no'), country = sameRow(state, 'Country');
    const zip = sameRow(state, 'ZIP or foreign postal code');
    if (name && address && city && state && end && apt && country && zip) {
      const right = Math.max(address.row.words.find(word => normalize(word.text) === '2')?.bbox.x0 || 0, apt.x1);
      // Recipient cells are below the recipient name; never search the similar payer cells above it.
      const nameRows = cellRows(name, address, name.x0, right);
      const streetRows = cellRows(address, city, address.x0, apt.x0);
      const cityRows = cellRows(city, state, city.x0, right);
      const stateRows = cellRows(state, end, state.x0, country.x0);
      const zipRows = cellRows(zip, end, zip.x0, right);
      const countryRows = cellRows(country, end, country.x0, zip.x0);
      const domestic = countryRows.length === 1 && /^(US|USA|UNITED STATES)$/i.test(content(countryRows[0]));
      if (nameRows.length === 1) fullName(nameRows[0]);
      if (domestic) {
        if (streetRows.length === 1) street(streetRows[0]);
        const aptRows = cellRows(apt, city, apt.x0, right);
        if (aptRows.length === 1 && /^(?:APT\s*)?[A-Z0-9-]+$/i.test(content(aptRows[0]))) add('addressLine2', 'Apartment or unit', content(aptRows[0]).replace(/^APT\s*/i, ''), aptRows[0]);
        if (cityRows.length === 1 && /^[\p{L} .'-]+$/u.test(content(cityRows[0]))) add('city', 'City', content(cityRows[0]), cityRows[0]);
        if (stateRows.length === 1) add('state', 'State', content(stateRows[0]), stateRows[0]);
        if (zipRows.length === 1) add('zip', 'ZIP code', content(zipRows[0]), zipRows[0]);
      }
    }
  } else if (type === 'w2') {
    const name = one("Employee's first name and initial"), end = one("Employee's address and ZIP code");
    const suffix = sameRow(name, 'Suff');
    if (name && end && suffix) {
      const values = cellRows(name, end, name.x0, suffix.x1);
      if (values.length === 3) {
        fullName(values[0]); street(values[1]); cityStateZip(values[2]);
      }
    }
  } else if (type === 'ssa-1099') {
    const name = one('Box 1 Name'), social = one('Box 2'), benefits = one('Box 3 Benefits Paid');
    const address = one('Box 7 Address'), end = one('Box 8 Claim Number');
    if (name && social && benefits && name.y0 < benefits.y0) {
      const values = cellRows(name, benefits, name.x0, social.x0);
      const inline = name.row.words.filter(word => word.bbox.x0 >= name.x1 && centerX(word) < social.x0);
      if (inline.length && values.length === 0) fullName(inline);
      else if (!inline.length && values.length === 1) fullName(values[0]);
    }
    if (address && end) {
      const values = cellRows(address, end, address.x0, page.width);
      if (values.length === 2) { street(values[0]); cityStateZip(values[1]); }
    }
  }
  const addSSN = (start, end, left, right) => {
    const values = cellRows(start, end, left, right).flat().filter(word => /^\d{3}-?\d{2}-?\d{4}$/.test(word.text));
    if (values.length === 1) add('ssn', 'Social Security number', values[0].text, values);
  };
  const addAmount = (id, label, start, end, left, right) => {
    const values = cellRows(start, end, left, right);
    if (values.length !== 1) return;
    const words = values[0].filter(word => word.text !== '$');
    if (words.length !== 1) return;
    const value = money(words[0].text);
    if (value !== null) fields.push({id, label, value, page: page.pageNumber || 1, confidence: meanConfidence(words)});
  };
  if (type === '1099-nec') {
    const social = one("RECIPIENT'S TIN"), name = one("RECIPIENT'S name");
    const amount = one('Nonemployee compensation'), next = one('Cash tips') || one('Payer made direct sales');
    if (social && name && amount) addSSN(social, name, social.x0, amount.x0);
    const right = one('For Recipient');
    if (amount && next && right) addAmount('annualCompensation', 'Nonemployee compensation (box 1)', amount, next, amount.x0, right.x0);
  } else if (type === 'w2') {
    const social = one("Employee's social security number"), end = one('Employer identification number');
    const omb = one('OMB No');
    if (social && end && omb) addSSN(social, end, social.x0, omb.x0);
    const amount = one('Wages tips other compensation'), next = one('Social security wages'), right = one('Federal income tax withheld');
    if (amount && next && right) addAmount('annualWages', 'Wages, tips, other compensation (box 1)', amount, next, amount.x0, right.x0);
  } else if (type === 'ssa-1099') {
    const social = one('Box 2'), end = one('Box 3 Benefits Paid');
    if (social && end) addSSN(social, end, social.x0, page.width);
    const amount = end, next = one('DESCRIPTION OF AMOUNT IN BOX 3'), right = one('Box 4 Benefits Repaid');
    if (amount && next && right) addAmount('annualBenefits', 'Social Security benefits paid (box 3)', amount, next, amount.x0, right.x0);
  }
  const header = type === 'ssa-1099' ? one('Box 1 Name') : null;
  const years = [...new Set(page.words.filter(word => /^(19|20)\d{2}$/.test(word.text) && (!header || word.bbox.y1 < header.y0)).map(word => word.text))];
  const taxYear = years.length === 1 ? years[0] : '';
  return { type, title: ({ w2: 'Form W-2 wage statement', '1099-nec': 'Form 1099-NEC compensation statement', 'ssa-1099': 'Form SSA-1099 benefit statement' })[type],
    taxYear, fields, warnings: ['Check every selected value against the original, including the recipient’s name and current address.',
      'Statement amounts are historical. They are not copied into current monthly income.',
      ...(!fields.length ? ['The recipient details could not be read reliably; enter them manually.'] : [])] };
}

function analyzeDocument(document) {
  const pages = Array.isArray(document?.pages) ? document.pages.slice(0, 12) : [];
  const found = pages.flatMap(page => {
    const type = recognizedType(page);
    const label = ({'1099-nec': "RECIPIENT'S name", 'ssa-1099': 'Box 1 Name', w2: "Employee's first name and initial"})[type] || 'Your first name and middle initial';
    const headers = type ? matches(wordRows(page), label) : [];
    return headers.map(() => ({ page, type }));
  });
  if (found.length === 1) {
    const { page, type } = found[0];
    if (['1099-nec', 'ssa-1099', 'w2'].includes(type)) {
      const result = parseStatementPage(page, type);
      const alternate = page.alternative && Array.isArray(page.alternative.words)
        ? parseStatementPage({...page, ...page.alternative, alternative: undefined}, type) : null;
      result.fields = result.fields.filter(field => !(field.id === 'ssn' || field.id.startsWith('annual')) ||
        alternate?.fields.some(other => other.id === field.id && other.value === field.value));
      if (!alternate || alternate.taxYear !== result.taxYear) result.taxYear = '';
      result.warnings.push('SSNs and annual amounts are proposed only when two readings agree. Check the original; unreadable values stay manual.');
      return result;
    }
    const result = parseTaxPage(page, type);
    const alternate = page.alternative && Array.isArray(page.alternative.words)
      ? parseTaxPage({ ...page, ...page.alternative, alternative: undefined }, type) : null;
    const alternateFields = new Map(alternate?.fields.map(field => [field.id, field]) || []);
    const omitted = [], omittedSsn = [];
    result.fields = result.fields.filter(field => {
      const isAmount = field.id.startsWith('taxLine'), isSsn = field.id.endsWith('Ssn');
      if (!isAmount && !isSsn) return true;
      const other = alternateFields.get(field.id);
      if (!other || other.value !== field.value) {
        (isSsn ? omittedSsn : omitted).push(field.id);
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
    result.warnings.unshift('OCR can misread letters or digits even when confidence is high. Check every selected value against the original document.');
    return result;
  }
  return { type: 'unknown', title: 'Scanned document', taxYear: '', fields: [], warnings: [found.length > 1
    ? 'More than one tax-return header was found. Review each person’s document separately; no profile values were proposed.'
    : 'This document does not have a supported tax-return layout. Review the extracted text and enter any useful details yourself.'] };
}

module.exports = { analyzeDocument, wordRows };
