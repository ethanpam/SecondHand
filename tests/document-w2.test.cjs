'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detect, parse } = require('../shared/document-w2.cjs');
const { analyzeDocument } = require('../shared/document-parser.cjs');

// Positioned fictional words, independent of the PDF sample and its numbers.
// All positions are fixture layout, never parser coordinates.
function fixture({ first = 'RIVER Q', last = 'EXAMPLE', year = '2023', wages = '23,456.78', combined = false } = {}) {
  const words = [];
  const line = (text, x, y, group) => {
    for (const token of text.split(' ')) {
      const width = token.length * 7;
      words.push({ text: token, confidence: 93, bbox: { x0: x, y0: y, x1: x + width, y1: y + 16 }, group });
      x += width + 7;
    }
  };
  line("a Employee's social security number", 350, 60, 'ssn-label');
  line('000-34-5678', 450, 90, 'ssn');
  line('b Employer identification number (EIN)', 50, 150, 'ein-label');
  line('00-1234567', 70, 180, 'ein');
  line("c Employer's name address and ZIP code", 50, 230, 'employer-label');
  line('FICTIONAL EMPLOYER LLC', 70, 270, 'employer-name');
  line('99 EMPLOYER STREET', 70, 310, 'employer-address');
  line('ELSEWHERE NY 10001', 70, 350, 'employer-city');
  line('d Control number', 50, 430, 'control-label');
  line('TEST-2020-9999', 70, 460, 'control');
  line("e Employee's first name and initial", 50, 550, 'name-label');
  line('Last name', 560, 550, 'last-label');
  line('Suff.', 900, 550, 'suffix-label');
  line(combined ? `${first} ${last}` : first, 70, 590, 'first');
  if (!combined) line(last, 570, 590, 'last');
  line('42 FICTIONAL ROAD', 70, 640, 'street');
  line('APT 7C', 70, 680, 'unit');
  line('CEDAR RAPIDS, IA 52401-1234', 70, 720, 'city');
  line("f Employee's address and ZIP code", 50, 790, 'address-label');
  line('15 State Employer state ID number', 50, 850, 'state-label');
  line('IA IA-TEST-ONLY', 70, 900, 'state-value');
  const boxes = [
    ['1 Wages tips other compensation', 1000, 150, wages, 'box1'], ['2 Federal income tax withheld', 1400, 150, '1,111.22', 'box2'],
    ['3 Social security wages', 1000, 250, '23,000.00', 'box3'], ['4 Social security tax withheld', 1400, 250, '1,400.00', 'box4'],
    ['5 Medicare wages and tips', 1000, 350, '23,100.00', 'box5'], ['6 Medicare tax withheld', 1400, 350, '300.50', 'box6'],
    ['7 Social security tips', 1000, 450, '', 'box7'], ['8 Allocated tips', 1400, 450, '', 'box8']
  ];
  for (const [caption, x, y, value, group] of boxes) { line(caption, x, y, `${group}-label`); if (value) line(value, x + 75, y + 40, group); }
  line('11 Nonqualified plans', 1000, 550, 'next-column');
  line('13 Statutory employee Retirement plan', 1000, 620, 'checkbox-labels');
  line('14 Other', 1000, 710, 'other-label');
  line('W-2 Wage and Tax Statement', 80, 980, 'title');
  line(year, 850, 980, 'year');
  return { pageNumber: 3, width: 1900, height: 1200, text: `W-2 Wage and Tax Statement ${year}`, words };
}
const values = result => Object.fromEntries(result.fields.map(field => [field.id, field.value]));
const profile = result => Object.fromEntries(result.fields.filter(field => field.profileKey).map(field => [field.profileKey, field.value]));
const remove = (page, ...groups) => { page.words = page.words.filter(word => !groups.includes(word.group)); return page; };

test('aligned employee cells produce distinct identity/address candidates and annual amounts stay review-only', () => {
  const page = fixture(); assert.equal(detect(page), 1);
  const result = parse(page), found = values(result);
  assert.equal(result.type, 'w2'); assert.equal(result.title, 'Form W-2 wage statement'); assert.equal(result.taxYear, '2023');
  assert.deepEqual(profile(result), { ssn: '000-34-5678', firstName: 'RIVER', middleName: 'Q', lastName: 'EXAMPLE',
    addressLine1: '42 FICTIONAL ROAD', addressLine2: 'APT 7C', city: 'CEDAR RAPIDS', state: 'IA', zip: '52401-1234' });
  assert.deepEqual(Object.fromEntries(Object.entries(found).filter(([id]) => id.startsWith('taxLine'))), {
    taxLineW2Box1: '23456.78', taxLineW2Box2: '1111.22', taxLineW2Box3: '23000.00', taxLineW2Box4: '1400.00', taxLineW2Box5: '23100.00', taxLineW2Box6: '300.50'
  });
  for (const field of result.fields) {
    assert.equal(field.page, 3); assert.equal(field.confidence, 93); assert.ok(field.sourceLabel);
    if (field.kind === 'amount') { assert.equal(field.profileKey, undefined); assert.equal(field.sourceRole, 'document'); }
    else assert.equal(field.sourceRole, 'applicant');
  }
  assert.equal(result.fields.find(field => field.profileKey === 'ssn').kind, 'identifier');
  assert.match(result.warnings.join(' '), /not copied or converted into current monthly income/);
});

test('a full employee name in the first-name column stays review-only without guessed surname splitting', () => {
  const result = parse(fixture({ combined: true }));
  assert.equal(values(result).w2EmployeeName, 'RIVER Q EXAMPLE');
  for (const key of ['firstName', 'middleName', 'lastName']) assert.equal(profile(result)[key], undefined);
  assert.equal(profile(result).addressLine1, '42 FICTIONAL ROAD');
  assert.match(result.warnings.join(' '), /separate first-name and last-name columns/);
});

test('varied name parts, tax years and amounts are read from cells, never from sample constants', () => {
  const result = parse(fixture({ first: 'MARY ANNE', last: "O'NEILL-SAMPLE", year: '2022', wages: '765.43' }));
  assert.equal(profile(result).firstName, 'MARY ANNE'); assert.equal(profile(result).middleName, undefined);
  assert.equal(profile(result).lastName, "O'NEILL-SAMPLE");
  assert.equal(result.taxYear, '2022'); assert.equal(values(result).taxLineW2Box1, '765.43');
  assert.equal(parse(fixture({ first: '李', last: '王' })).fields.find(field => field.profileKey === 'firstName').value, '李');
});

test('scaling and translating all boxes preserves extraction and source boundaries', () => {
  const page = fixture(); const expected = values(parse(page));
  page.width = page.width * 1.7 + 100; page.height = page.height * 1.7 + 150;
  for (const word of page.words) {
    for (const axis of ['x0', 'x1']) word.bbox[axis] = word.bbox[axis] * 1.7 + 31;
    for (const axis of ['y0', 'y1']) word.bbox[axis] = word.bbox[axis] * 1.7 + 47;
  }
  assert.deepEqual(values(parse(page)), expected);
});

test('blank employee cells never fall back to employer identity, address, EIN, or state tax data', () => {
  const page = remove(fixture(), 'first', 'last', 'street', 'unit', 'city', 'ssn');
  const result = parse(page);
  assert.deepEqual(profile(result), {});
  assert.ok(result.fields.every(field => !/EMPLOYER|ELSEWHERE|00-1234567|IA-TEST/.test(field.value)));
  assert.equal(values(result).taxLineW2Box1, '23456.78');
});

test('missing employee or address boundary anchors omit the employee block rather than searching farther', () => {
  for (const group of ['name-label', 'address-label', 'last-label', 'next-column']) {
    const result = parse(remove(fixture(), group));
    for (const key of ['firstName', 'lastName', 'addressLine1', 'city', 'zip']) assert.equal(profile(result)[key], undefined, group);
    assert.equal(values(result).taxLineW2Box1, '23456.78', group);
  }
});

test('amounts require their own caption, adjacent column and next-row boundary', () => {
  assert.equal(values(parse(remove(fixture(), 'box1'))).taxLineW2Box1, undefined);
  for (const group of ['box1-label', 'box2-label', 'box3-label']) assert.equal(values(parse(remove(fixture(), group))).taxLineW2Box1, undefined, group);
  const corrupt = fixture(); corrupt.words.find(word => word.group === 'box1').text = '23,4S6.78';
  assert.equal(values(parse(corrupt)).taxLineW2Box1, undefined);
  const duplicateValue = fixture(); const amount = duplicateValue.words.find(word => word.group === 'box1');
  duplicateValue.words.push({ ...amount, bbox: { ...amount.bbox, x0: amount.bbox.x0 + 130, x1: amount.bbox.x1 + 130 } });
  assert.equal(values(parse(duplicateValue)).taxLineW2Box1, undefined);
});

test('duplicate monetary labels are ambiguous and never choose whichever amount appears first', () => {
  const page = fixture();
  page.words.push(...page.words.filter(word => word.group === 'box1-label').map(word => ({ ...word, bbox: { ...word.bbox, y0: 1100, y1: 1116 } })));
  assert.equal(values(parse(page)).taxLineW2Box1, undefined);
});

test('the employee SSN must be bounded by its own label and next employer-ID header', () => {
  for (const group of ['ssn-label', 'ein-label', 'ssn']) assert.equal(profile(parse(remove(fixture(), group))).ssn, undefined, group);
  const mislabelled = fixture(); mislabelled.words.find(word => word.group === 'ssn-label' && /Employee/.test(word.text)).text = "Employer's";
  assert.equal(profile(parse(mislabelled)).ssn, undefined);
});

test('same-page duplicate forms reject all fields, while an incidental W-2 reference is not a second form', () => {
  const page = fixture(); const second = fixture({ first: 'OTHER', last: 'PERSON' });
  page.height *= 2;
  page.words.push(...second.words.map(word => ({ ...word, bbox: { ...word.bbox, y0: word.bbox.y0 + 1200, y1: word.bbox.y1 + 1200 } })));
  assert.equal(detect(page), 2); assert.deepEqual(parse(page).fields, []);
  const single = fixture(); single.words.push({ text: 'W-2', confidence: 90, bbox: { x0: 50, x1: 80, y0: 1120, y1: 1136 } });
  assert.equal(detect(single), 1);
});

test('year is taken only from the printed title row and conflicting years stay unknown', () => {
  const absent = remove(fixture(), 'year');
  assert.equal(parse(absent).taxYear, '', 'control-number years are not a tax year');
  const ambiguous = fixture(); const year = ambiguous.words.find(word => word.group === 'year');
  ambiguous.words.push({ ...year, text: '2024', bbox: { ...year.bbox, x0: 1100, x1: 1128 } });
  assert.equal(parse(ambiguous).taxYear, '');
  assert.match(parse(ambiguous).warnings.join(' '), /tax year could not/);
});

test('malformed or unrelated pages have no proposed fields and source words are never mutated', () => {
  for (const page of [null, {}, { width: 100, height: 100, words: [], text: 'W-2' }]) { assert.equal(detect(page), 0); assert.deepEqual(parse(page).fields, []); }
  const page = fixture(), before = structuredClone(page); parse(page); assert.deepEqual(page, before);
});

test('document integration requires matching alternate OCR for employee SSN and every annual amount', () => {
  const page = fixture();
  page.alternative = { text: page.text, words: structuredClone(page.words) };
  const document = { name: 'fictional-w2.pdf', pageCount: 1, pages: [page] };
  const before = structuredClone(document);
  const agreed = analyzeDocument(document);
  assert.equal(agreed.type, 'w2');
  assert.equal(profile(agreed).ssn, '000-34-5678');
  assert.equal(values(agreed).taxLineW2Box1, '23456.78');
  assert.deepEqual(document, before, 'agreement checking does not mutate OCR evidence');

  page.alternative.words.find(word => word.group === 'ssn').text = '000-35-5678';
  page.alternative.words.find(word => word.group === 'box1').text = '23,456.79';
  const disputed = analyzeDocument(document);
  assert.equal(profile(disputed).ssn, undefined);
  assert.equal(values(disputed).taxLineW2Box1, undefined);
  assert.equal(values(disputed).taxLineW2Box2, '1111.22', 'unrelated agreeing amount remains review-only');
  assert.equal(disputed.fields.find(field => field.id === 'taxLineW2Box2').profileKey, undefined);
  assert.equal(profile(disputed).addressLine1, '42 FICTIONAL ROAD');
  assert.match(disputed.warnings.join(' '), /Social Security number could not be read consistently/);
  assert.match(disputed.warnings.join(' '), /tax amounts could not be read consistently/);
});

test('single OCR pass may propose employee name and address but never SSN or monetary values', () => {
  const result = analyzeDocument({ pages: [fixture()] });
  assert.equal(result.type, 'w2');
  assert.equal(profile(result).firstName, 'RIVER');
  assert.equal(profile(result).city, 'CEDAR RAPIDS');
  assert.equal(profile(result).ssn, undefined);
  assert.equal(result.fields.some(field => field.id.startsWith('taxLine') || field.kind === 'identifier'), false);
});

test('document integration rejects multiple W-2 forms and mixed W-2/tax-return pages', () => {
  const anotherW2 = fixture({ first: 'OTHER', last: 'PERSON' });
  anotherW2.pageNumber = 4;
  const header = 'Your first name and middle initial'.split(' ').map((text, index) => ({
    text, confidence: 90, bbox: { x0: 30 + index * 90, x1: 30 + index * 90 + text.length * 7, y0: 70, y1: 86 }
  }));
  const taxReturn = { pageNumber: 4, width: 1900, height: 1200,
    text: 'Form 1040 U.S. Individual Income Tax Return 2024', words: header };
  for (const other of [anotherW2, taxReturn]) {
    const result = analyzeDocument({ pages: [fixture(), other] });
    assert.equal(result.type, 'unknown');
    assert.deepEqual(result.fields, []);
    assert.match(result.warnings.join(' '), /More than one tax-return or statement header/);
  }
  const samePage = fixture();
  samePage.height *= 2;
  samePage.words.push(...anotherW2.words.map(word => ({ ...word,
    bbox: { ...word.bbox, y0: word.bbox.y0 + 1200, y1: word.bbox.y1 + 1200 } })));
  const result = analyzeDocument({ pages: [samePage] });
  assert.equal(result.type, 'unknown'); assert.deepEqual(result.fields, []);
});
