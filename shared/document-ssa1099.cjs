'use strict';

// SSA benefit statements supply review candidates, never current-income answers.
const { validateProfile } = require('./schema.cjs');
const { wordRows, matches, content, afterLabel, money, centerX, centerY, meanConfidence } = require('./document-layout.cjs');

const TITLE = 'FORM SSA-1099 SOCIAL SECURITY BENEFIT STATEMENT';
const LABELS = {
  name: 'Box 1 Name', ssn: "Box 2 Beneficiary's Social Security Number",
  paid: 'Box 3 Benefits Paid in', repaid: 'Box 4 Benefits Repaid to SSA',
  net: 'Box 5 Net Benefits for', description: 'DESCRIPTION OF AMOUNT IN BOX 3',
  withheld: 'Box 6 Voluntary Federal Income Tax Withholding', address: 'Box 7 Address',
  claim: 'Box 8 Claim Number'
};

function detect(page) {
  const rows = wordRows(page || {}), titles = matches(rows, TITLE);
  // A footer's SSA-1099-SM revision is not another primary form.
  return matches(rows, LABELS.name).length && matches(rows, LABELS.ssn).length ? titles.length : 0;
}

function parse(page) {
  const rows = wordRows(page || {}), fields = [], warnings = [];
  const result = { type: 'ssa1099', title: 'Form SSA-1099 benefit statement', taxYear: '', fields, warnings };
  if (detect(page) !== 1) {
    warnings.push('A single SSA-1099 statement could not be identified reliably. Review the original document.');
    return result;
  }
  const one = label => { const found = matches(rows, label); return found.length === 1 ? found[0] : null; };
  const a = Object.fromEntries(Object.entries(LABELS).map(([key, label]) => [key, one(label)]));
  const title = one(TITLE);
  const sameRow = (left, right) => left && right && left.row === right.row && left.x0 < right.x0;
  const rowBottom = anchor => anchor && Math.min(...anchor.row.words.map(word => word.bbox.y0));
  const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : 1;
  const add = (id, label, value, words, source, profileKey, sourceRole = 'document', kind) => {
    if (!value || value.length > 200 || /[\u0000-\u001f]/.test(value) || !words.length) return;
    if (profileKey) {
      try { value = validateProfile({ [profileKey]: value })[profileKey]; } catch { return; }
    }
    fields.push({ id, label, value, page: pageNumber, confidence: meanConfidence(words),
      sourceLabel: content(source.words).slice(0, 150), sourceRole,
      ...(profileKey ? { profileKey } : {}), ...(kind ? { kind } : {}) });
  };
  const sourceInColumn = (anchor, x1) => anchor && ({ ...anchor,
    words: anchor.row.words.filter(word => word.bbox.x0 >= anchor.x0 && centerX(word) < x1) });
  const printedYear = source => {
    const years = source?.words.map(word => word.text).filter(text => /^(?:19|20)\d{2}$/.test(text)) || [];
    return years.length === 1 ? years[0] : '';
  };
  const amountSources = [
    sourceInColumn(a.paid, a.repaid?.x0 ?? 0),
    sourceInColumn(a.repaid, a.net?.x0 ?? 0),
    sourceInColumn(a.net, page.width)
  ];
  // Read only the isolated heading year and the years in the printed amount
  // labels. A revision, claim number, file name, or description is not a tax year.
  const headingYears = title && a.name ? rows.filter(row => row.y > title.y1 && row.y < a.name.y0)
    .map(row => content(row.words).replace(/\s+/g, '')).filter(text => /^(?:19|20)\d{2}$/.test(text)) : [];
  const years = [...new Set([...headingYears, ...amountSources.map(printedYear)].filter(Boolean))].sort();
  if (years.length === 1) result.taxYear = years[0];
  else if (years.length > 1) warnings.push(`Printed statement years disagree (${years.join(', ')}). Check each box's year in the original; no single tax year was selected.`);
  else warnings.push('The statement year could not be identified unambiguously. Check the original document.');

  const header = sameRow(a.name, a.ssn) && sameRow(a.paid, a.repaid) && sameRow(a.repaid, a.net) && a.name.y1 < a.paid.y0;
  if (header) {
    const nameWords = afterLabel(rows, a.name, a.paid, a.name.x0, a.ssn.x0), fullName = content(nameWords);
    if (/^[\p{L}][\p{L} .'-]{0,149}$/u.test(fullName)) {
      add('ssaRecipientName', 'Beneficiary name (combined; review only)', fullName, nameWords, a.name, undefined, 'applicant');
      warnings.push('Box 1 combines the beneficiary’s name. Enter first, middle, and last names yourself after checking the original.');
    }
    const ssnWords = afterLabel(rows, a.ssn, a.paid, a.ssn.x0, page.width);
    const ssn = content(ssnWords).replace(/\s+/g, '');
    if (/^\d{3}-?\d{2}-?\d{4}$/.test(ssn)) add('applicantSsn', 'Beneficiary Social Security number (Box 2)', ssn, ssnWords, a.ssn, 'ssn', 'applicant', 'identifier');
  }

  if (sameRow(a.paid, a.repaid) && sameRow(a.repaid, a.net) && a.description && a.net.y1 < a.description.y0) {
    for (const [index, anchor, end, id, label] of [
      [0, a.paid, a.repaid.x0, 'taxLineSsaBox3', 'Benefits paid (Box 3)'],
      [1, a.repaid, a.net.x0, 'taxLineSsaBox4', 'Benefits repaid to SSA (Box 4)'],
      [2, a.net, page.width, 'taxLineSsaBox5', 'Net benefits (Box 5)']
    ]) {
      const words = afterLabel(rows, anchor, a.description, anchor.x0, end);
      const raw = content(words), value = money(raw);
      // Multiple numeric fragments or repaired letters are not an amount.
      if (value !== null && /^(?:\$\s*)?[\d,]+(?:\.\d{2})?$/.test(raw)) {
        const year = printedYear(amountSources[index]);
        add(id, `${label}${year ? ` — ${year}` : ''}`, value, words, amountSources[index]);
      }
    }
  }
  if (a.withheld && a.address && a.withheld.y1 < a.address.y0) {
    const words = afterLabel(rows, a.withheld, a.address, a.withheld.x0, page.width), raw = content(words), value = money(raw);
    if (value !== null && /^(?:\$\s*)?[\d,]+(?:\.\d{2})?$/.test(raw)) add('taxLineSsaBox6', 'Federal income tax withheld (Box 6)', value, words, a.withheld);
  }

  if (a.address && a.claim && a.address.y1 < a.claim.y0) {
    const bottom = rowBottom(a.claim);
    const addressRows = rows.map(row => row.words.filter(word => centerY(word) > a.address.y1 && centerY(word) < bottom && centerX(word) >= a.address.x0))
      .filter(words => words.length);
    // A domestic address must occupy two or three rows inside Box 7. An extra
    // name, foreign country, or unreadable row makes the block ambiguous.
    if (addressRows.length === 2 || addressRows.length === 3) {
      const townWords = addressRows.at(-1), town = content(townWords);
      const location = /^([\p{L}][\p{L} .'-]{0,99}),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/u.exec(town);
      let street = content(addressRows[0]), unit = addressRows.length === 3 ? content(addressRows[1]) : '';
      if (!unit) {
        const split = /^(.*?)\s+((?:APT\.?|UNIT|SUITE|STE\.?|#)\s*[A-Z0-9][A-Z0-9 .#/-]{0,29})$/i.exec(street);
        if (split) [, street, unit] = split;
      }
      const validUnit = !unit || /^(?:APT\.?|UNIT|SUITE|STE\.?|#)\s*[A-Z0-9][A-Z0-9 .#/-]{0,29}$/i.test(unit);
      if (location && validUnit && /\d/.test(street) && /[a-z]/i.test(street) && /^[\p{L}\p{N} .#'/-]{1,150}$/u.test(street)) {
        // Validate the whole locality before proposing any part of the block.
        try {
          validateProfile({ city: location[1], state: location[2], zip: location[3] });
          add('addressLine1', 'Address on benefit statement', street, addressRows[0], a.address, 'addressLine1');
          if (unit) add('addressLine2', 'Apartment or unit', unit, addressRows.length === 3 ? addressRows[1] : addressRows[0], a.address, 'addressLine2');
          add('city', 'City', location[1], townWords, a.address, 'city');
          add('state', 'State', location[2], townWords, a.address, 'state');
          add('zip', 'ZIP code', location[3], townWords, a.address, 'zip');
        } catch { /* An uncertain domestic block remains manual. */ }
      }
    }
  }
  warnings.push('Benefit and withholding amounts are historical statement values, not current monthly income. No disability, Medicare, or eligibility answers are inferred.');
  warnings.push('Confirm that the beneficiary and statement address belong to the applicant before selecting any profile fields. The address may be old.');
  if (!fields.length) warnings.push('No filled values could be read reliably inside the labeled boxes. Check the original document and enter the information yourself.');
  if (fields.some(field => field.confidence < 75)) warnings.push('Some detected values have low OCR confidence. Compare them with the original document.');
  return result;
}

module.exports = { detect, parse };
