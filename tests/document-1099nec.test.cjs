'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detect, parse } = require('../shared/document-1099nec.cjs');
const { analyzeDocument } = require('../shared/document-parser.cjs');

// Synthetic positioned words reproduce the observed separate recipient cells,
// not the supplied PDF's values. No OCR engine or local artifact is required.
function fixture(overrides = {}) {
  const values = { name: 'RIVER Q EXAMPLE', tin: '12-3456789', street: '42 FIXTURE WAY', apartment: 'APT 9C', city: 'CEDAR RAPIDS',
    state: 'IA', country: 'US', zip: '52401-1234', year: '2027', revision: '2026', amount: '20,345.67', ...overrides };
  const words = [];
  const line = (text, x, y) => {
    for (const token of text.split(' ').filter(Boolean)) {
      const width = token.length * 6;
      words.push({ text: token, confidence: 91, bbox: { x0: x, y0: y, x1: x + width, y1: y + 18 } });
      x += width + 7;
    }
  };
  line("PAYER'S name", 100, 70); line('FICTIONAL PAYER BUSINESS LLC', 100, 110);
  line('Form 1099-NEC', 1650, 100); line(`(Rev. December ${values.revision})`, 1650, 150);
  line('For calendar year', 1650, 200); line(values.year, 1730, 240);
  line('Street address', 100, 150); line('Room or suite no.', 750, 150);
  line('999 PAYER ROAD', 100, 180); line('SUITE 500', 750, 180);
  line('City or town', 100, 220); line('Telephone number', 750, 220);
  line('PAYER CITY', 100, 250); line('555-555-0100', 750, 250);
  line('State or province', 100, 270); line('Country', 600, 270); line('ZIP or foreign postal code', 850, 270);
  line('NY', 100, 310); line('US', 600, 310); line('10001', 850, 310);
  line("PAYER'S TIN", 100, 360); line("RECIPIENT'S TIN", 600, 360);
  line('88-8888888', 100, 400); line(values.tin, 600, 400);
  line("RECIPIENT'S name", 100, 450); line(values.name, 100, 490);
  line('Street address', 100, 540); line('Apt. no.', 900, 540);
  line(values.street, 100, 580); line(values.apartment, 900, 580);
  line('City or town', 100, 620); line(values.city, 100, 660);
  line('State or province', 100, 710); line('Country', 600, 710); line('ZIP or foreign postal code', 850, 710);
  line(values.state, 100, 750); line(values.country, 600, 750); line(values.zip, 850, 750);
  line('Account number (see instructions)', 100, 1000); line('SYNTHETIC-ACCOUNT', 100, 1040);
  line('1a Nonemployee compensation', 1200, 300); line(`$ ${values.amount}`, 1210, 350);
  line('1b Cash tips', 1200, 400); line('1c TTOC', 1650, 400); line('$ 125.00', 1210, 450);
  line('1d Overtime compensation', 1200, 500); line('$ 250.25', 1210, 550);
  line('2 Payer made direct sales', 1200, 600);
  line('3 Excess golden parachute payments', 1200, 700); line('$ 0.00', 1210, 750);
  line('4 Federal income tax withheld', 1200, 800); line('$ 765.43', 1210, 850);
  line('5 State tax withheld', 1200, 1000); line("6 State/Payer's state no.", 1650, 1000); line('7 State income', 2100, 1000);
  line('$ 321.00', 1210, 1040); line('IA / SYNTHETIC-STATE-ID', 1660, 1040); line('$ 20345.67', 2110, 1040);
  line('$', 1210, 1070); line('$', 2110, 1070);
  line(`Form 1099-NEC (Rev. ${values.revision})`, 100, 1140);
  line('Department of the Treasury - Internal Revenue Service', 1900, 1140);
  const page = { pageNumber: 3, width: 2600, height: 1800, words, text: 'Form 1099-NEC Nonemployee Compensation' };
  return { page, line };
}
const valuesById = result => Object.fromEntries(result.fields.map(field => [field.id, field.value]));
const profile = result => Object.fromEntries(result.fields.filter(field => field.profileKey).map(field => [field.profileKey, field.value]));
const removeRegion = (page, x0, x1, y0, y1) => { page.words = page.words.filter(word => !(word.bbox.x0 >= x0 && word.bbox.x0 < x1 && word.bbox.y0 >= y0 && word.bbox.y0 < y1)); };

test('recipient and payer stay separate; only explicit recipient address components can be proposed for profile review', () => {
  const { page } = fixture();
  const before = structuredClone(page), result = parse(page), fields = valuesById(result);
  assert.equal(detect(page), 1);
  assert.equal(result.type, '1099-nec');
  assert.equal(result.taxYear, '2027', 'calendar year wins over the 2026 revision');
  assert.equal(fields.necRecipientName, 'RIVER Q EXAMPLE');
  assert.equal(fields.necRecipientTin, '12-3456789');
  assert.deepEqual(profile(result), { addressLine1: '42 FIXTURE WAY', addressLine2: 'APT 9C', city: 'CEDAR RAPIDS', state: 'IA', zip: '52401-1234' });
  assert.equal(result.fields.find(field => field.id === 'necRecipientTin').kind, 'identifier');
  assert.ok(result.fields.every(field => field.page === 3 && field.confidence === 91 && field.sourceRole === (field.id.startsWith('necPayer') ? 'payer' : 'document')));
  assert.ok(result.fields.every(field => !['firstName', 'middleName', 'lastName', 'ssn', 'phone'].includes(field.profileKey)));
  for (const payerFact of ['FICTIONAL PAYER', '999 PAYER ROAD', 'PAYER CITY', '88-8888888', '10001']) {
    assert.equal(JSON.stringify(result.fields.filter(field => field.sourceRole !== 'payer')).includes(payerFact), false);
  }
  assert.ok(result.fields.filter(field => field.sourceRole === 'payer').every(field => !field.profileKey));
  assert.equal(JSON.stringify(result.fields).includes('555-555-0100'), false);
  assert.equal(JSON.stringify(result.fields).includes('SYNTHETIC-ACCOUNT'), false);
  assert.deepEqual(page, before, 'source words are never corrected or mutated');
});

test('each annual amount uses its own numbered bounded cell with no profile/current-income mapping', () => {
  const result = parse(fixture().page);
  assert.deepEqual(Object.fromEntries(result.fields.filter(field => field.id.startsWith('taxLine')).map(field => [field.id, field.value])), {
    taxLineNecBox1a: '20345.67', taxLineNecBox1b: '125.00', taxLineNecBox1d: '250.25', taxLineNecBox3: '0.00',
    taxLineNecBox4: '765.43', taxLineNecBox5: '321.00', taxLineNecBox7: '20345.67'
  });
  assert.ok(result.fields.filter(field => field.id.startsWith('taxLine')).every(field => !field.profileKey));
  assert.ok(result.warnings.some(warning => /no monthly-income conversion/.test(warning)));
  assert.equal(valuesById(result).taxLineNecBox1c, undefined, 'occupation codes and sales checkboxes are not money');
});

test('varied values, different years and translated/scaled page coordinates do not change cell interpretation', () => {
  const { page } = fixture({ name: 'MORGAN DE LA CRUZ', street: '701 DIFFERENT LANE', apartment: 'B-12', city: 'SANTA FE', state: 'NM', zip: '87501', year: '2031', revision: '2028', amount: '901.23' });
  const expected = parse(page);
  for (const scale of [0.7, 1.8, 2.4]) {
    const shifted = { ...page, width: page.width * scale + 80, height: page.height * scale + 60,
      words: page.words.map(word => ({ ...word, bbox: { x0: word.bbox.x0 * scale + 40, x1: word.bbox.x1 * scale + 40, y0: word.bbox.y0 * scale + 30, y1: word.bbox.y1 * scale + 30 } })) };
    assert.equal(detect(shifted), 1);
    assert.deepEqual(parse(shifted), expected);
  }
  assert.equal(expected.taxYear, '2031');
  assert.equal(valuesById(expected).taxLineNecBox1a, '901.23');
  assert.equal(profile(expected).city, 'SANTA FE');
});

test('blank recipient cells never borrow payer name, address, telephone or taxpayer ID', () => {
  const { page } = fixture({ name: '', tin: '', street: '', apartment: '', city: '', state: '', country: '', zip: '' });
  const result = parse(page);
  assert.deepEqual(profile(result), {});
  assert.equal(valuesById(result).necRecipientName, undefined);
  assert.equal(valuesById(result).necRecipientTin, undefined);
  assert.ok(result.fields.every(field => field.id.startsWith('taxLine') || field.sourceRole === 'payer'));
});

test('combined person/business names and every supported TIN spelling remain review-only', () => {
  for (const name of ['LEE WONG', 'MARIA DEL CARMEN DE LA CRUZ', 'EXAMPLE SERVICES LLC', 'FICTIONAL TRADING & SONS']) {
    for (const tin of ['123456789', '000-12-3456', '12-3456789']) {
      const result = parse(fixture({ name, tin }).page);
      assert.equal(valuesById(result).necRecipientName, name);
      const identifier = result.fields.find(field => field.id === 'necRecipientTin');
      assert.equal(identifier.value, tin);
      assert.equal(identifier.kind, 'identifier');
      assert.equal(identifier.profileKey, undefined);
      assert.ok(result.fields.every(field => !/Name$|^ssn$/.test(field.profileKey || '')));
    }
  }
  for (const tin of ['000-112-3456', '***-**-3456', '88-8888888 12-3456789']) assert.equal(valuesById(parse(fixture({ tin }).page)).necRecipientTin, undefined);
});

test('missing/duplicate recipient anchors cannot select the matching payer anchor or combine repeated cells', () => {
  for (const [x0, x1, y0, y1] of [[100, 900, 540, 541], [100, 500, 620, 621], [600, 850, 710, 711], [850, 1200, 710, 711]]) {
    const { page } = fixture(); removeRegion(page, x0, x1, y0, y1);
    assert.deepEqual(profile(parse(page)), {});
  }
  const duplicate = fixture(); duplicate.line('Street address', 100, 600);
  assert.deepEqual(profile(parse(duplicate.page)), {});
  const duplicateTin = fixture(); duplicateTin.line("RECIPIENT'S TIN", 600, 380);
  assert.equal(valuesById(parse(duplicateTin.page)).necRecipientTin, undefined);
});

test('foreign, missing or uncertain country/state/ZIP cells do not grant a domestic-address mapping', () => {
  for (const changes of [{ country: 'CA', state: 'ON', zip: 'K1A 0B1' }, { country: '' }, { state: '1A' }, { state: 'ZZ' }, { zip: '5O309' }]) {
    const result = parse(fixture(changes).page);
    assert.deepEqual(profile(result), {});
    assert.ok(result.warnings.some(warning => /No domestic address was proposed/.test(warning)));
  }
});

test('calendar-year blank, ambiguity or missing label never fall back to header/footer revision years', () => {
  const blank = parse(fixture({ year: '' }).page);
  assert.equal(blank.taxYear, '');
  assert.ok(blank.warnings.some(warning => /revision date was not used/.test(warning)));
  const missing = fixture(); removeRegion(missing.page, 1600, 2000, 200, 201);
  assert.equal(parse(missing.page).taxYear, '');
  const ambiguous = fixture(); ambiguous.line('2028', 1730, 270);
  assert.equal(parse(ambiguous.page).taxYear, '');
  const duplicate = fixture(); duplicate.line('For calendar year', 1650, 220);
  assert.equal(parse(duplicate.page).taxYear, '');
});

test('amount blanks, overlapping cells, extra numeric rows and duplicate numbered labels omit the affected amount', () => {
  const blank = fixture(); removeRegion(blank.page, 1200, 2100, 350, 351);
  assert.equal(valuesById(parse(blank.page)).taxLineNecBox1a, undefined);
  assert.equal(valuesById(parse(blank.page)).taxLineNecBox1b, '125.00');
  const extra = fixture(); extra.line('9999.99', 1210, 375);
  assert.equal(valuesById(parse(extra.page)).taxLineNecBox1a, undefined);
  const clipped = fixture(); clipped.page.words.find(word => word.text === '20,345.67').bbox.x1 = 2200;
  assert.equal(valuesById(parse(clipped.page)).taxLineNecBox1a, undefined);
  const duplicate = fixture(); duplicate.line('1a Nonemployee compensation', 1200, 325);
  assert.equal(valuesById(parse(duplicate.page)).taxLineNecBox1a, undefined);
  const secondState = fixture(); secondState.line('500.00', 1250, 1070);
  assert.equal(valuesById(parse(secondState.page)).taxLineNecBox5, undefined);
  for (const amount of ['12.3', '12,34.56', 'O.00', '(100.00)', '100.00 200.00']) assert.equal(valuesById(parse(fixture({ amount }).page)).taxLineNecBox1a, undefined);
});

test('overlapping OCR fragments inside an otherwise exact printed caption do not break the box boundary', () => {
  const { page } = fixture();
  const term = page.words.find(word => word.text === 'Nonemployee');
  page.words.push({ text: 'noise', confidence: 30, bbox: { x0: term.bbox.x0 + 5, x1: term.bbox.x1 - 5, y0: term.bbox.y0 + 2, y1: term.bbox.y1 + 2 } });
  assert.equal(valuesById(parse(page)).taxLineNecBox1a, '20345.67');
  const modified = fixture();
  const compensation = modified.page.words.find(word => word.text === 'compensation' && word.bbox.y0 === 300);
  const x = compensation.bbox.x0;
  compensation.bbox.x0 += 30; compensation.bbox.x1 += 30;
  modified.line('not', x, 300);
  assert.equal(valuesById(parse(modified.page)).taxLineNecBox1a, undefined, 'a real intervening word changes the caption, unlike overlapping OCR noise');
});

test('a recipient address word crossing the next component boundary is not imported whole or clipped', () => {
  const { page } = fixture();
  page.words.find(word => word.text === 'WAY').bbox.x1 = 1000;
  const result = parse(page);
  assert.equal(profile(result).addressLine1, undefined);
  assert.equal(profile(result).addressLine2, 'APT 9C');
});

test('duplicate recipients/forms are counted and fail closed; unverified older layouts stay manual', () => {
  const single = fixture().page, duplicate = structuredClone(single);
  duplicate.height *= 2;
  duplicate.words.push(...single.words.map(word => ({ ...word, bbox: { ...word.bbox, y0: word.bbox.y0 + 1700, y1: word.bbox.y1 + 1700 } })));
  assert.equal(detect(duplicate), 2);
  assert.deepEqual(parse(duplicate).fields, []);
  const old = fixture(); removeRegion(old.page, 1200, 2600, 400, 401); removeRegion(old.page, 1200, 2600, 500, 501);
  assert.equal(detect(old.page), 1);
  assert.deepEqual(parse(old.page).fields, []);
  assert.match(parse(old.page).warnings[0], /Older or incomplete layouts/);
  const missingName = fixture(); removeRegion(missingName.page, 100, 1200, 450, 451);
  assert.equal(detect(missingName.page), 0);
  assert.deepEqual(parse(missingName.page).fields, []);
});

test('source labels remain observed evidence, not generated field labels or answer values', () => {
  const result = parse(fixture().page), street = result.fields.find(field => field.profileKey === 'addressLine1');
  assert.equal(street.sourceLabel, 'Street address');
  assert.notEqual(street.sourceLabel, street.label);
  assert.equal(result.fields.find(field => field.id === 'taxLineNecBox1a').sourceLabel, '1a Nonemployee compensation');
  assert.ok(result.fields.every(field => !field.sourceLabel.includes(field.value)));
  for (const bad of [null, undefined, {}, { words: [] }, { words: [], text: 'Form 1099-NEC' }]) {
    assert.equal(detect(bad), 0);
    assert.deepEqual(parse(bad).fields, []);
  }
});

test('Apple Vision far-right instruction boxes do not truncate the recipient city cell', () => {
  const source = structuredClone(require('./fixtures/document-statement-layouts.json')['1099-nec']);
  const before = structuredClone(source), result = parse(source);
  assert.deepEqual(profile(result), {
    addressLine1: '1847 TEST DATA AVE', addressLine2: 'APT 4B', city: 'DES MOINES', state: 'IA', zip: '50309'
  });
  assert.equal(result.taxYear, '2026');
  assert.deepEqual(source, before);
});

test('recipient-column adjacent labels still stop the city cell at their earliest edge', () => {
  const { page } = fixture();
  // The ZIP label in the same recipient row has an unusually tall box. Its
  // upper edge is in the preceding cell, so that city is no longer reliable.
  const zipLabel = page.words.find(word => word.text === 'ZIP' && word.bbox.y0 === 710);
  zipLabel.bbox.y0 = 650; zipLabel.bbox.y1 = 780;
  for (const word of page.words.filter(word => word.bbox.x0 < 1200 && word.bbox.y0 === 750)) {
    word.bbox.y0 += 50; word.bbox.y1 += 50;
  }
  const answers = profile(parse(page));
  assert.equal(answers.city, undefined, 'a recipient-column label must not be ignored like a far-right instruction');
  assert.equal(answers.state, 'IA');
  assert.equal(answers.zip, '52401-1234');
  assert.equal(answers.addressLine1, '42 FIXTURE WAY');
});

test('bounded payer details remain historical references and cannot substitute for recipient details', () => {
  const { page } = fixture(), result = parse(page), fields = valuesById(result);
  assert.equal(fields.necPayerName, 'FICTIONAL PAYER BUSINESS LLC');
  assert.equal(fields.necPayerStreet, '999 PAYER ROAD');
  assert.equal(fields.necPayerRoom, 'SUITE 500');
  assert.equal(fields.necPayerCity, 'PAYER CITY');
  assert.equal(fields.necPayerState, 'NY');
  assert.equal(fields.necPayerCountry, 'US');
  assert.equal(fields.necPayerZip, '10001');
  assert.equal(fields.necPayerTin, '88-8888888');
  assert.ok(result.fields.filter(field => field.id.startsWith('necPayer')).every(field => field.sourceRole === 'payer' && !field.profileKey));
  const blank = fixture(); removeRegion(blank.page, 100, 1200, 110, 129);
  assert.equal(valuesById(parse(blank.page)).necPayerName, undefined);
  assert.equal(valuesById(parse(blank.page)).necRecipientName, 'RIVER Q EXAMPLE');
  const missing = fixture(); removeRegion(missing.page, 100, 750, 150, 169);
  assert.equal(valuesById(parse(missing.page)).necPayerName, undefined);
  assert.equal(valuesById(parse(missing.page)).necPayerStreet, undefined);
  const invalid = fixture(); invalid.page.words.find(word => word.text === '88-8888888').text = '88-888B888';
  assert.equal(valuesById(parse(invalid.page)).necPayerTin, undefined);
  assert.equal(valuesById(parse(invalid.page)).necRecipientTin, '12-3456789');
});

test('a NEC historical reference never persists either TIN and does not infer self-employment status', () => {
  const { page } = fixture(); page.alternative = { text: page.text, words: structuredClone(page.words) };
  const result = analyzeDocument({ pages: [page] });
  assert.equal(result.statement.documentType, '1099-nec');
  assert.equal(result.statement.sourceRole, 'payer');
  assert.equal(result.statement.sourceName, 'FICTIONAL PAYER BUSINESS LLC');
  assert.equal(result.statement.recipientName, 'RIVER Q EXAMPLE');
  assert.equal(result.statement.annualIncome, '20345.67');
  assert.match(result.statement.annualIncomeLabel, /nonemployee compensation.*1a.*2027/);
  assert.equal(result.statement.annualWithholding, '765.43');
  assert.ok(!/88-8888888|12-3456789|selfEmployed|currentlyEmployed/.test(JSON.stringify(result.statement)));
  page.alternative.words.find(word => word.text === '88-8888888').text = '88-8888889';
  page.alternative.words.find(word => word.text === '12-3456789').text = '12-3456788';
  const disputed = analyzeDocument({ pages: [page] });
  assert.equal(valuesById(disputed).necPayerTin, undefined);
  assert.equal(valuesById(disputed).necRecipientTin, undefined);
  assert.equal(disputed.statement.annualIncome, '20345.67');
});
