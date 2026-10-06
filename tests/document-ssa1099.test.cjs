'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detect, parse } = require('../shared/document-ssa1099.cjs');
const { analyzeDocument } = require('../shared/document-parser.cjs');

// Positioned, invented OCR words exercise printed-cell relationships. This is
// not a transcription fixture or evidence of accuracy on an unobserved form.
function fixture({ year = '2023', box4Year = year, box5Year = year, name = 'MORGAN LEE VAN EXAMPLE', ssn = '000-12-3456',
  paid = '23,456.78', repaid = '56.00', net = '23,400.78', withheld = '125.00',
  street = '901 FICTIONAL LANE APT 7C', town = 'TEST CITY, IA 50309', unit = '', claim = '999-88-7777-A' } = {}) {
  const words = [];
  const line = (text, x, y) => {
    for (const token of text.split(/\s+/).filter(Boolean)) {
      const width = token.length * 7;
      words.push({ text: token, confidence: 93, bbox: { x0: x, y0: y, x1: x + width, y1: y + 18 } });
      x += width + 6;
    }
  };
  line('FORM SSA-1099 – SOCIAL SECURITY BENEFIT STATEMENT', 250, 40);
  line(year, 100, 100);
  line('Box 1. Name', 100, 170);
  line('Box 2. Beneficiary’s Social Security Number', 1000, 170);
  line(name, 100, 215); line(ssn, 1000, 215);
  line(`Box 3. Benefits Paid in ${year}`, 100, 270);
  line(`Box 4. Benefits Repaid to SSA in ${box4Year}`, 650, 270);
  line(`Box 5. Net Benefits for ${box5Year} (Box 3 minus Box 4)`, 1200, 270);
  line(paid, 100, 330); line(repaid, 650, 330); line(net, 1200, 330);
  line('DESCRIPTION OF AMOUNT IN BOX 3', 100, 400);
  line('DESCRIPTION OF AMOUNT IN BOX 4', 1000, 400);
  line('Benefits paid by direct deposit 999,999.99', 100, 470);
  line('Medicare Part B premiums 4,567.00', 100, 520);
  line('Box 6. Voluntary Federal Income Tax Withholding', 1000, 650);
  line(withheld, 1000, 710);
  line('Box 7. Address', 1000, 800);
  line(street, 1000, 870);
  if (unit) line(unit, 1000, 920);
  line(town, 1000, unit ? 970 : 920);
  line('Box 8. Claim Number (Use this number if you need to contact SSA.)', 1000, 1100);
  line(claim, 1000, 1160);
  line('Form SSA-1099-SM (6-2019)', 100, 1250);
  return { pageNumber: 2, width: 2000, height: 1500, confidence: 93, text: words.map(word => word.text).join(' '), words };
}
const byId = result => Object.fromEntries(result.fields.map(field => [field.id, field]));
const dropLine = (page, y) => { page.words = page.words.filter(word => word.bbox.y0 !== y); return page; };

test('SSA boxes supply bounded review fields without splitting beneficiary names or deriving income', () => {
  const page = fixture(), before = structuredClone(page), result = parse(page), fields = byId(result);
  assert.equal(detect(page), 1);
  assert.equal(result.type, 'ssa-1099');
  assert.equal(result.title, 'Form SSA-1099 benefit statement');
  assert.equal(result.taxYear, '2023');
  assert.equal(fields.ssaRecipientName.value, 'MORGAN LEE VAN EXAMPLE');
  assert.equal(fields.ssaRecipientName.profileKey, undefined);
  assert.equal(fields.applicantSsn.value, '000-12-3456');
  assert.equal(fields.applicantSsn.profileKey, 'ssn');
  assert.equal(fields.applicantSsn.kind, 'identifier');
  assert.equal(fields.applicantSsn.sourceRole, 'applicant');
  assert.equal(fields.applicantSsn.sourceLabel, 'Box 2. Beneficiary’s Social Security Number');
  assert.equal(fields.addressLine1.value, '901 FICTIONAL LANE');
  assert.equal(fields.addressLine2.value, 'APT 7C');
  assert.equal(fields.city.value, 'TEST CITY');
  assert.equal(fields.state.value, 'IA');
  assert.equal(fields.zip.value, '50309');
  assert.equal(fields.addressLine1.sourceLabel, 'Box 7. Address');
  assert.deepEqual([3, 4, 5, 6].map(box => fields[`taxLineSsaBox${box}`].value), ['23456.78', '56.00', '23400.78', '125.00']);
  assert.ok(result.fields.filter(field => field.id.startsWith('taxLine')).every(field => !field.profileKey));
  assert.ok(result.fields.every(field => field.page === 2 && field.confidence === 93));
  assert.ok(!result.fields.some(field => /firstName|lastName|monthly|medicare|disability|eligibility|claim/i.test(field.profileKey || field.id)));
  assert.match(result.warnings.join(' '), /not current monthly income/);
  assert.deepEqual(page, before);
});

test('conflicting heading and box years remain visible per box with no selected tax year', () => {
  const result = parse(fixture({ year: '2019', box4Year: '2018', box5Year: '2018' })), fields = byId(result);
  assert.equal(result.taxYear, '');
  assert.match(fields.taxLineSsaBox3.label, /2019/);
  assert.match(fields.taxLineSsaBox4.label, /2018/);
  assert.match(fields.taxLineSsaBox5.sourceLabel, /2018/);
  assert.match(result.warnings.join(' '), /years disagree \(2018, 2019\)/);
});

test('a bounded inline beneficiary name remains review-only and never crosses the SSN column', () => {
  const page = fixture();
  for (const word of page.words) {
    if (word.bbox.y0 === 215 && word.bbox.x0 < 1000) {
      word.bbox.x0 += 200; word.bbox.x1 += 200;
      word.bbox.y0 = 170; word.bbox.y1 = 188;
    }
  }
  const fields = byId(parse(page));
  assert.equal(fields.ssaRecipientName.value, 'MORGAN LEE VAN EXAMPLE');
  assert.equal(fields.ssaRecipientName.profileKey, undefined);
  assert.equal(fields.ssaRecipientName.sourceLabel, 'Box 1. Name');
  assert.equal(fields.applicantSsn.value, '000-12-3456');

  const conflicting = structuredClone(page);
  conflicting.words.push({ text: 'ANOTHER PERSON', confidence: 93, bbox: { x0: 100, y0: 215, x1: 240, y1: 233 } });
  assert.equal(byId(parse(conflicting)).ssaRecipientName, undefined, 'both inline and below-label names are ambiguous');
  const crossing = structuredClone(page);
  crossing.words.push({ text: 'OTHER', confidence: 93, bbox: { x0: 990, y0: 170, x1: 1030, y1: 188 } });
  assert.equal(byId(parse(crossing)).ssaRecipientName, undefined, 'a word crossing into Box 2 cannot be part of the name');
});

test('the Apple Vision statement fixture preserves the inline beneficiary name without guessing name parts', () => {
  const page = require('./fixtures/document-statement-layouts.json')['ssa-1099'];
  const before = structuredClone(page), result = parse(page), fields = byId(result);
  assert.equal(result.type, 'ssa-1099');
  assert.equal(fields.ssaRecipientName.value, 'ALEXANDER J SAMPLE');
  assert.equal(fields.ssaRecipientName.profileKey, undefined);
  assert.equal(result.fields.some(field => ['firstName', 'middleName', 'lastName'].includes(field.profileKey)), false);
  assert.equal(fields.addressLine1.value, '1847 TEST DATA AVE');
  assert.equal(fields.city.value, 'DES MOINES');
  assert.deepEqual(page, before);
});

test('filled sample values and observed OCR row artifacts preserve cell ownership', () => {
  // Actual raster OCR places the name and SSN on different value rows, adds a
  // grid mark beside Box 3, and sometimes prefixes Box 8 with a smart quote.
  const page = fixture({ year: '2019', box4Year: '2018', box5Year: '2018', name: 'ALEXANDER J SAMPLE',
    ssn: '000-12-3456', paid: '18,600.00', repaid: '0.00', net: '18,600.00', withheld: '0.00',
    street: '1847 TEST DATA AVE APT 4B', town: 'DES MOINES, IA 50309', claim: '000-12-3456-A' });
  for (const word of page.words) {
    if (word.bbox.y0 === 215 && word.bbox.x0 < 1000) { word.bbox.y0 -= 23; word.bbox.y1 -= 23; }
    if (word.bbox.y0 === 1100 && word.text === 'Box') word.text = '‘Box';
  }
  page.words.push({ text: '~~', confidence: 31, bbox: { x0: 620, y0: 270, x1: 634, y1: 288 } });
  const result = parse(page), fields = byId(result);
  assert.equal(result.fields.length, 12);
  assert.equal(fields.ssaRecipientName.value, 'ALEXANDER J SAMPLE');
  assert.equal(fields.applicantSsn.value, '000-12-3456');
  assert.equal(fields.taxLineSsaBox3.value, '18600.00');
  assert.equal(fields.taxLineSsaBox5.value, '18600.00');
  assert.equal(fields.addressLine1.value, '1847 TEST DATA AVE');
  assert.equal(fields.addressLine2.value, 'APT 4B');
  assert.equal(fields.city.value, 'DES MOINES');
  assert.equal(result.taxYear, '');
});

test('split heading-year digits are read only within the isolated heading row', () => {
  const page = fixture({ year: '2026' });
  page.words = page.words.filter(word => word.bbox.y0 !== 100);
  for (const [text, x0] of [['20', 100], ['2', 124], ['6', 140]]) {
    page.words.push({ text, confidence: 90, bbox: { x0, y0: 100, x1: x0 + text.length * 7, y1: 118 } });
  }
  assert.equal(parse(page).taxYear, '2026');
  page.words.find(word => word.text === '6' && word.bbox.y0 === 100).text = '7';
  assert.equal(parse(page).taxYear, '');
  assert.match(parse(page).warnings.join(' '), /years disagree \(2026, 2027\)/);
});

test('scale, translation, and changed fictional values preserve anchored extraction', () => {
  for (const scale of [0.6, 1.7]) {
    const page = fixture({ year: '2027', ssn: '123-45-6789', paid: '19.25', repaid: '0.00', net: '19.25', withheld: '0.00', street: '77 EXAMPLE ROAD', unit: 'UNIT 12', town: 'DEMO TOWN, MN 55101-1234' });
    page.width = page.width * scale + 200; page.height = page.height * scale + 200;
    for (const word of page.words) for (const key of ['x0', 'x1', 'y0', 'y1']) word.bbox[key] = word.bbox[key] * scale + 100;
    const result = parse(page), fields = byId(result);
    assert.equal(result.taxYear, '2027'); assert.equal(fields.taxLineSsaBox3.value, '19.25');
    assert.equal(fields.applicantSsn.value, '123-45-6789'); assert.equal(fields.addressLine2.value, 'UNIT 12');
    assert.equal(fields.state.value, 'MN'); assert.equal(fields.zip.value, '55101-1234');
  }
});

test('blank primary cells never borrow claim number, description amount, or another box', () => {
  const result = parse(fixture({ name: '', ssn: '', paid: '', repaid: '', net: '', withheld: '', street: '', town: '' }));
  assert.deepEqual(result.fields.map(field => field.id), ['ssaIssuerName']);
  assert.match(result.warnings.join(' '), /No filled values/);
  assert.equal(result.taxYear, '2023');
});

test('incorrect OCR digits are not repaired and correct adjacent amounts stay independent', () => {
  const fields = byId(parse(fixture({ ssn: 'OOO-12-3456', paid: '23,456.7O', repaid: '0.OO', net: '123.45', withheld: '12 3.45', town: 'TEST CITY, IA 5O309' })));
  assert.equal(fields.applicantSsn, undefined);
  assert.equal(fields.taxLineSsaBox3, undefined); assert.equal(fields.taxLineSsaBox4, undefined);
  assert.equal(fields.taxLineSsaBox5.value, '123.45'); assert.equal(fields.taxLineSsaBox6, undefined);
  assert.equal(fields.addressLine1, undefined); assert.equal(fields.zip, undefined);
});

test('missing printed boundary prevents extracting values from the affected block', () => {
  assert.ok(!parse(dropLine(fixture(), 400)).fields.some(field => /taxLineSsaBox[345]/.test(field.id)));
  assert.ok(!parse(dropLine(fixture(), 1100)).fields.some(field => ['addressLine1', 'addressLine2', 'city', 'state', 'zip'].includes(field.id)));
  assert.equal(byId(parse(dropLine(fixture(), 800))).taxLineSsaBox6, undefined);
  assert.deepEqual(parse(dropLine(fixture(), 170)).fields, []);
});

test('multiple recognizable primary forms reject the page instead of choosing a person', () => {
  const page = fixture(); page.height *= 2;
  page.words.push(...structuredClone(page.words).map(word => ({ ...word, bbox: { ...word.bbox, y0: word.bbox.y0 + 1500, y1: word.bbox.y1 + 1500 } })));
  assert.equal(detect(page), 2); assert.deepEqual(parse(page).fields, []);
});

test('footer revision and unrelated raw text cannot identify a statement or replace the printed year', () => {
  const page = fixture({ year: '' , box4Year: '', box5Year: '' });
  page.text += ' 2028 fictional filename';
  assert.equal(parse(page).taxYear, '');
  const noTitle = dropLine(fixture(), 40);
  assert.equal(detect(noTitle), 0); assert.deepEqual(parse(noTitle).fields, []);
  assert.equal(detect({ text: fixture().text, width: 2000, height: 1500, words: [] }), 0);
});

test('ambiguous extra address rows and foreign localities are not profile candidates', () => {
  for (const options of [{ town: 'TORONTO ON M4B 1B3' }, { street: 'ANOTHER PERSON', town: 'TEST CITY, IA 50309' }, { unit: 'CANADA' }]) {
    assert.ok(!parse(fixture(options)).fields.some(field => ['addressLine1', 'addressLine2', 'city', 'state', 'zip'].includes(field.id)));
  }
});

test('a second value row in the SSN or amount cell makes that cell manual', () => {
  const page = fixture();
  page.words.push({ text: '111-22-3333', confidence: 93, bbox: { x0: 1000, y0: 241, x1: 1100, y1: 259 } });
  page.words.push({ text: '876.00', confidence: 93, bbox: { x0: 100, y0: 360, x1: 150, y1: 378 } });
  const fields = byId(parse(page));
  assert.equal(fields.applicantSsn, undefined); assert.equal(fields.taxLineSsaBox3, undefined);
  assert.equal(fields.taxLineSsaBox5.value, '23400.78');
});

test('low confidence is disclosed and malformed OCR boxes cannot supply values', () => {
  const page = fixture();
  page.words.filter(word => word.bbox.y0 === 330 && word.bbox.x0 === 100).forEach(word => { word.confidence = 50; });
  assert.match(parse(page).warnings.join(' '), /low OCR confidence/);
  const ssn = page.words.find(word => word.text === '000-12-3456'); ssn.bbox.x1 = Infinity;
  assert.equal(byId(parse(page)).applicantSsn, undefined);
});

test('SSA historical reference uses printed source and net-benefit label without benefit-status inference', () => {
  const page = fixture(); page.alternative = { text: page.text, words: structuredClone(page.words) };
  const result = analyzeDocument({ pages: [page] });
  assert.deepEqual(result.statement, { documentType: 'ssa-1099', taxYear: '2023', sourceName: 'SOCIAL SECURITY', sourceRole: 'issuer',
    recipientName: 'MORGAN LEE VAN EXAMPLE', annualIncome: '23400.78', annualIncomeLabel: 'Net benefits (Box 5) — 2023',
    annualWithholding: '125.00', annualWithholdingLabel: 'Federal income tax withheld (Box 6)' });
  assert.ok(!/000-12-3456|999-88-7777|Medicare|disability|monthly/i.test(JSON.stringify(result.statement)));
  const conflicting = fixture({ year: '2019', box4Year: '2018', box5Year: '2018' });
  conflicting.alternative = { text: conflicting.text, words: structuredClone(conflicting.words) };
  const unknownYear = analyzeDocument({ pages: [conflicting] });
  assert.equal(unknownYear.statement.taxYear, '');
  assert.equal(unknownYear.statement.annualIncome, ''); assert.equal(unknownYear.statement.annualWithholding, '');
  assert.equal(byId(unknownYear).taxLineSsaBox5.value, '23400.78', 'per-box evidence remains visible for manual review');
});
