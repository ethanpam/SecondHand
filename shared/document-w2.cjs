'use strict';

const { validateProfile } = require('./schema.cjs');
const { wordRows, matches, content, afterLabel, money, normalize, centerX, centerY, meanConfidence } = require('./document-layout.cjs');
const FIRST_LABEL = "Employee's first name and initial";
const ADDRESS_LABEL = "Employee's address and ZIP code";
const TITLE = 'Wage and Tax Statement';
const NAME = /^[\p{L}][\p{L}\p{M} .’'-]{0,99}$/u;
const BOXES = [
  { code: '1', caption: 'Wages tips other compensation', label: 'W-2 wages (box 1)', right: '2', next: '3' },
  { code: '2', caption: 'Federal income tax withheld', label: 'Federal income tax withheld (W-2 box 2)', next: '4' },
  { code: '3', caption: 'Social security wages', label: 'Social Security wages (W-2 box 3)', right: '4', next: '5' },
  { code: '4', caption: 'Social security tax withheld', label: 'Social Security tax withheld (W-2 box 4)', next: '6' },
  { code: '5', caption: 'Medicare wages and tips', label: 'Medicare wages (W-2 box 5)', right: '6', next: '7' },
  { code: '6', caption: 'Medicare tax withheld', label: 'Medicare tax withheld (W-2 box 6)', next: '8' },
  { code: '7', caption: 'Social security tips' },
  { code: '8', caption: 'Allocated tips' }
];
const one = (rows, label) => { const found = matches(rows, label); return found.length === 1 ? found[0] : null; };
const sameRow = (left, right) => left && right && Math.abs((left.y0 + left.y1 - right.y0 - right.y1) / 2) <= Math.max(left.y1 - left.y0, right.y1 - right.y0) * 0.8;
function columnStart(anchor, code) {
  if (!anchor) return null;
  const before = anchor.row.words.filter(word => normalize(word.text) === code && word.bbox.x1 <= anchor.x0 && anchor.x0 - word.bbox.x1 <= (anchor.y1 - anchor.y0) * 3);
  return before.length === 1 ? before[0].bbox.x0 : anchor.x0;
}

// Count recognizable forms, including copies on the same page. The dispatcher
// must reject multiple forms instead of combining different employee blocks.
function detect(page) {
  if (!page || typeof page !== 'object') return 0;
  const rows = wordRows(page), titles = matches(rows, TITLE);
  const formWords = rows.flatMap(row => row.words).filter(word => normalize(word.text) === 'w2');
  if (!titles.length || !formWords.length) return 0;
  return Math.max(titles.length, matches(rows, FIRST_LABEL).length);
}

function parse(page) {
  const fields = [], warnings = [];
  const result = { type: 'w2', title: 'Form W-2 wage statement', taxYear: '', fields, warnings };
  const count = detect(page);
  if (count !== 1) {
    warnings.push(count > 1 ? 'More than one W-2 form was found. Review each form separately; no fields were proposed.' : 'The W-2 layout could not be identified reliably. Review the extracted text yourself.');
    return result;
  }
  const rows = wordRows(page), title = one(rows, TITLE);
  const pageNumber = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : 1;
  const years = [...new Set(title.row.words.map(word => word.text.replace(/^[|([{]+|[|\])},.]+$/g, '')).filter(text => /^(?:19|20)\d{2}$/.test(text)))];
  if (years.length === 1) result.taxYear = years[0];
  else warnings.push('The W-2 tax year could not be identified unambiguously.');
  const add = (id, label, value, words, profileKey, source, kind, sourceRole = kind === 'amount' ? 'document' : 'applicant') => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f]/.test(value) || !words.length) return;
    if (profileKey) {
      try { value = validateProfile({ [profileKey]: value })[profileKey]; } catch { return; }
    }
    fields.push({ id, label, value, page: pageNumber, confidence: meanConfidence(words),
      ...(profileKey ? { profileKey } : {}), sourceLabel: content(source.words).slice(0, 150), sourceRole, ...(kind ? { kind } : {}) });
  };

  // Each amount is below its own printed caption, above the next caption, and
  // left of the adjacent box. No amount or employer identifier is searched for
  // elsewhere on the page when the bounded cell is blank.
  const boxes = Object.fromEntries(BOXES.map(box => [box.code, one(rows, box.caption)]));
  for (const box of BOXES.filter(box => box.next)) {
    const anchor = boxes[box.code], next = boxes[box.next];
    const partnerCode = box.right || String(Number(box.code) - 1), partner = boxes[partnerCode];
    if (!anchor || !next || !sameRow(anchor, partner) || next.y0 <= anchor.y1) continue;
    const left = columnStart(anchor, box.code);
    const right = box.right ? columnStart(partner, box.right) : page.width;
    if (!(right > left) || (!box.right && partner.x0 >= anchor.x0)) continue;
    const words = afterLabel(rows, anchor, next, left, right).filter(word => !/^[|_]+$/.test(word.text));
    const numbers = words.filter(word => /\d/.test(word.text));
    if (numbers.length !== 1 || words.some(word => word !== numbers[0] && word.text !== '$')) continue;
    const value = money(numbers[0].text);
    if (value !== null) add(`taxLineW2Box${box.code}`, `${box.label}${result.taxYear ? ` — ${result.taxYear}` : ''}`, value, numbers, undefined, anchor, 'amount');
  }

  // The employee's SSN label can have an overlapping scan artifact between
  // "Employee's" and "social". Still require both parts on that same row and
  // read only the horizontal span of the employee label before the EIN row.
  const social = one(rows, 'social security number'), ein = one(rows, 'Employer identification number');
  if (social && ein && ein.y0 > social.y1) {
    const employee = social.row.words.filter(word => /^employee'?s$/.test(normalize(word.text)) && word.bbox.x1 <= social.x0);
    if (employee.length === 1) {
      const anchor = { ...social, x0: employee[0].bbox.x0, words: [employee[0], ...social.words] };
      const words = afterLabel(rows, anchor, ein, anchor.x0, anchor.x1);
      const value = content(words).replace(/\s+/g, '');
      if (/^\d{3}-?\d{2}-?\d{4}$/.test(value)) add('w2EmployeeSsn', 'Employee Social Security number', value, words, 'ssn', anchor, 'identifier');
    }
  }

  // Employer details are historical source references, never applicant fields.
  // Box c ends at the control-number header, before the employee block. Require
  // a complete domestic name/street/locality shape rather than guessing which
  // row is the employer name when a row is absent.
  const employer = one(rows, "Employer's name address and ZIP code"), control = one(rows, 'Control number');
  const employerRight = columnStart(boxes['1'], '1');
  if (employer && control && employerRight && employer.x1 < employerRight && employer.y1 < control.y0) {
    const employerRows = rows.map(row => row.words.filter(word => centerY(word) > employer.y1 && centerY(word) < control.y0 &&
      centerX(word) >= employer.x0 && centerX(word) < employerRight)).filter(words => words.length);
    const inside = employerRows.every(words => words.every(word => word.bbox.x0 >= employer.x0 - (word.bbox.y1 - word.bbox.y0) / 2 && word.bbox.x1 <= employerRight));
    if (inside && (employerRows.length === 3 || employerRows.length === 4)) {
      const name = content(employerRows[0]), street = content(employerRows[1]);
      const locality = /^([\p{L}][\p{L} .'-]{0,99}),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/u.exec(content(employerRows.at(-1)));
      const unit = employerRows.length === 4 ? content(employerRows[2]) : '';
      if (locality && /^[\p{L}\p{N}][\p{L}\p{N} .,'’&()/+-]{0,199}$/u.test(name) && /\p{L}/u.test(name) &&
          /\d/.test(street) && /\p{L}/u.test(street) && (!unit || /^(?:APT\.?|UNIT|SUITE|STE\.?|#)\s*[\p{L}\p{N}][\p{L}\p{N} .#/-]{0,29}$/iu.test(unit))) {
        try {
          validateProfile({ city: locality[1], state: locality[2], zip: locality[3] });
          const addEmployer = (id, label, value, words) => add(id, label, value, words, undefined, employer, undefined, 'employer');
          addEmployer('w2EmployerName', 'Employer name on W-2 (historical)', name, employerRows[0]);
          addEmployer('w2EmployerStreet', 'Employer street address on W-2', street, employerRows[1]);
          if (unit) addEmployer('w2EmployerUnit', 'Employer apartment or suite', unit, employerRows[2]);
          for (const [id, label, value] of [['w2EmployerCity', 'Employer city', locality[1]], ['w2EmployerState', 'Employer state', locality[2]], ['w2EmployerZip', 'Employer ZIP code', locality[3]]]) {
            addEmployer(id, label, value, employerRows.at(-1));
          }
        } catch { /* Uncertain employer addresses remain in raw text only. */ }
      }
    }
  }
  if (ein && employer && employerRight && ein.y1 < employer.y0 && ein.x1 < employerRight) {
    const words = afterLabel(rows, ein, employer, ein.x0, employerRight);
    const value = content(words).replace(/\s+/g, '');
    if (/^(?:\d{2}-\d{7}|\d{9})$/.test(value) && words.every(word => word.bbox.x1 <= employerRight)) {
      add('w2EmployerEin', 'Employer EIN (review only)', value, words, undefined, ein, 'identifier', 'employer');
    }
  }

  const employee = one(rows, FIRST_LABEL), address = one(rows, ADDRESS_LABEL);
  const last = one(rows, 'Last name'), suffix = one(rows, 'Suff'), nextColumn = one(rows, 'Nonqualified plans');
  if (employee && address && sameRow(employee, last) && sameRow(employee, nextColumn) && employee.y1 < address.y0) {
    const left = columnStart(employee, 'e'), right = columnStart(nextColumn, '11');
    if (right > employee.x1 && last.x0 > employee.x1 && last.x0 < right) {
      const block = rows.map(row => ({ y: row.y, words: row.words.filter(word => centerY(word) > employee.y1 && centerY(word) < address.y0 && centerX(word) >= left && centerX(word) < right) }))
        .filter(row => row.words.length);
      const nameRow = block[0];
      let nameUsed = false;
      if (nameRow && NAME.test(content(nameRow.words))) {
        nameUsed = true;
        const firstWords = nameRow.words.filter(word => centerX(word) < last.x0);
        const lastWords = nameRow.words.filter(word => centerX(word) >= last.x0 && centerX(word) < (sameRow(last, suffix) ? suffix.x0 : right));
        const firstValue = content(firstWords), lastValue = content(lastWords);
        if (NAME.test(firstValue) && NAME.test(lastValue)) {
          const parts = firstValue.split(/\s+/), initial = parts.length > 1 && /^[\p{L}]\.?$/u.test(parts.at(-1)) ? parts.pop().replace('.', '') : '';
          add('w2EmployeeFirstName', 'Employee first name', parts.join(' '), firstWords, 'firstName', employee);
          if (initial) add('w2EmployeeMiddleName', 'Employee middle initial', initial, firstWords, 'middleName', employee);
          add('w2EmployeeLastName', 'Employee last name', lastValue, lastWords, 'lastName', last);
        } else {
          add('w2EmployeeName', 'Employee name (check the printed name columns)', content(nameRow.words), nameRow.words, undefined, employee);
          warnings.push('The employee name did not occupy separate first-name and last-name columns. It is shown for review only; enter the name parts yourself.');
        }
      }
      // On this verified W-2 layout the f caption is printed BELOW the employee
      // address. Only rows between e and f belong to this employee block.
      const addressRows = block.slice(nameUsed ? 1 : 0);
      const locality = addressRows.at(-1);
      if (locality && locality.words.length >= 3) {
        const zipWord = locality.words.at(-1), stateWord = locality.words.at(-2), cityWords = locality.words.slice(0, -2);
        const zip = zipWord.text.replace(/[,;]$/, ''), state = stateWord.text.replace(/[,;]$/, '');
        const city = content(cityWords).replace(/[,;]$/, '');
        const streets = addressRows.slice(0, -1);
        if (/^\d{5}(?:-\d{4})?$/.test(zip) && /^[A-Za-z]{2}$/.test(state) && NAME.test(city) && streets.length <= 2) {
          // Preserve a printed apartment on the same street line; do not guess
          // a split or silently remove it. A separate unit line stays separate.
          if (streets.length && /\d/.test(content(streets[0].words)) && /\p{L}/u.test(content(streets[0].words))) {
            add('w2EmployeeAddressLine1', 'Employee address on W-2', content(streets[0].words), streets[0].words, 'addressLine1', address);
            if (streets.length === 2) add('w2EmployeeAddressLine2', 'Employee address second line on W-2', content(streets[1].words), streets[1].words, 'addressLine2', address);
          }
          add('w2EmployeeCity', 'Employee city', city, cityWords, 'city', address);
          add('w2EmployeeState', 'Employee state', state, [stateWord], 'state', address);
          add('w2EmployeeZip', 'Employee ZIP code', zip, [zipWord], 'zip', address);
        }
      }
    }
  }
  warnings.push('W-2 amounts describe a past tax year. They are review-only and are not copied or converted into current monthly income.');
  warnings.push('Confirm that the employee is the applicant and that the printed address is still current. Employer details are never proposed as applicant details.');
  if (fields.some(field => field.confidence < 75)) warnings.push('Some detected values have low OCR confidence. Compare them with the original document.');
  if (!fields.some(field => field.profileKey)) warnings.push('The employee details could not be separated reliably. Review the text and enter the details yourself.');
  return result;
}

module.exports = { detect, parse };
