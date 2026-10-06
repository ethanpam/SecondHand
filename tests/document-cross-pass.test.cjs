'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../shared/document-parser.cjs');

// Minimal invented positioned words: no external OCR files, sample identifiers,
// or sample dollar amounts. The two passes share page pixels, not assumptions.
function ssa({ year = '2023', repaidYear = year, netYear = year } = {}) {
  const words = [];
  const line = (text, x, y) => {
    for (const token of text.split(/\s+/)) {
      const width = token.length * 6;
      words.push({ text: token, confidence: 94, bbox: { x0: x, y0: y, x1: x + width, y1: y + 16 } });
      x += width + 5;
    }
  };
  line('FORM SSA-1099 SOCIAL SECURITY BENEFIT STATEMENT', 200, 30);
  line(year, 70, 70);
  line('Box 1. Name', 70, 120);
  line('Box 2. Beneficiary’s Social Security Number', 850, 120);
  line('RIVER EXAMPLE', 70, 160);
  line('111-22-3333', 850, 160);
  line(`Box 3. Benefits Paid in ${year}`, 70, 230);
  line(`Box 4. Benefits Repaid to SSA in ${repaidYear}`, 600, 230);
  line(`Box 5. Net Benefits for ${netYear} (Box 3 minus Box 4)`, 1150, 230);
  line('123.45', 70, 280); line('10.00', 600, 280); line('113.45', 1150, 280);
  line('DESCRIPTION OF AMOUNT IN BOX 3', 70, 340);
  line('Box 6. Voluntary Federal Income Tax Withholding', 850, 410);
  line('1.00', 850, 460);
  line('Box 7. Address', 850, 520);
  line('42 FICTIONAL ROAD', 850, 570);
  line('EXAMPLE CITY, IA 50001', 850, 620);
  line('Box 8. Claim Number', 850, 680);
  return { pageNumber: 1, width: 1900, height: 850, text: words.map(word => word.text).join(' '), words };
}

function w2Header() {
  const words = [];
  let x = 70;
  for (const text of ['W-2', 'Wage', 'and', 'Tax', 'Statement']) {
    words.push({ text, confidence: 94, bbox: { x0: x, y0: 80, x1: x + text.length * 7, y1: 98 } });
    x += text.length * 7 + 6;
  }
  return { pageNumber: 2, width: 1900, height: 850, text: 'W-2 Wage and Tax Statement', words };
}

function paired(primary, alternative = primary) {
  return { ...structuredClone(primary), alternative: { text: alternative.text, words: structuredClone(alternative.words), confidence: 94 } };
}

function appendPage(first, second) {
  return { ...first, height: first.height + second.height, width: Math.max(first.width, second.width),
    text: `${first.text}\n${second.text}`,
    words: [...structuredClone(first.words), ...second.words.map(word => ({ ...word,
      bbox: { ...word.bbox, y0: word.bbox.y0 + first.height, y1: word.bbox.y1 + first.height } }))] };
}

const fields = result => Object.fromEntries(result.fields.map(field => [field.id, field]));
function assertAmbiguous(pages) {
  const result = analyzeDocument({ pages });
  assert.equal(result.type, 'unknown');
  assert.equal(result.taxYear, '');
  assert.deepEqual(result.fields, []);
  assert.match(result.warnings.join(' '), /multiple|more than one|disagree|ambig|different|conflict/i);
}

test('consistent two-pass statement still proposes anchored fields', () => {
  const result = analyzeDocument({ pages: [paired(ssa())] }), values = fields(result);
  assert.equal(result.type, 'ssa-1099'); assert.equal(result.taxYear, '2023');
  assert.equal(values.applicantSsn.value, '111-22-3333');
  assert.equal(values.addressLine1.value, '42 FICTIONAL ROAD');
  assert.equal(values.taxLineSsaBox3.value, '123.45');
});

test('a second form found only on another page alternate makes the whole document ambiguous', () => {
  const second = w2Header();
  assertAmbiguous([paired(ssa()), paired({ ...second, text: '', words: [] }, second)]);
});

test('a second same-type form found only on another page alternate is also ambiguous', () => {
  const second = { ...ssa(), pageNumber: 2 };
  assertAmbiguous([paired(ssa()), paired({ ...second, text: '', words: [] }, second)]);
});

test('mixed forms visible only together in the selected page alternate suppress names and addresses too', () => {
  const primary = ssa(), combined = appendPage(primary, w2Header());
  assertAmbiguous([paired({ ...primary, height: combined.height }, combined)]);
});

test('different form types recognized on the same page across passes are not reconciled', () => {
  assertAmbiguous([paired(ssa(), w2Header())]);
});

test('one recognized form per pass on different pages is not treated as one person', () => {
  for (const alternate of [w2Header(), { ...ssa(), pageNumber: 2 }]) {
    const first = ssa();
    assertAmbiguous([paired(first, { ...first, words: [], text: '' }),
      paired({ ...alternate, words: [], text: '' }, alternate)]);
  }
});

test('an alternate-only form is never promoted into suggestions when the primary is unreadable', () => {
  const secondary = ssa();
  const result = analyzeDocument({ pages: [paired({ ...secondary, words: [], text: '' }, secondary)] });
  assert.equal(result.type, 'unknown'); assert.deepEqual(result.fields, []);
});

test('an alternate conflicting year cannot be lost when the primary has one selected year', () => {
  const result = analyzeDocument({ pages: [paired(ssa({ year: '2023' }), ssa({ year: '2023', repaidYear: '2022', netYear: '2022' }))] });
  assert.equal(result.type, 'ssa-1099'); assert.equal(result.taxYear, '');
  assert.match(result.warnings.join(' '), /years disagree.*2022.*2023/);
  const values = fields(result);
  assert.equal(values.taxLineSsaBox3.value, '123.45');
  assert.equal(values.taxLineSsaBox4, undefined);
  assert.equal(values.taxLineSsaBox5, undefined);
  assert.equal(values.taxLineSsaBox6.value, '1.00');
  assert.equal(values.addressLine1.value, '42 FICTIONAL ROAD');
});

test('different clear statement years do not leave settled year labels on retained amounts', () => {
  const result = analyzeDocument({ pages: [paired(ssa({ year: '2023' }), ssa({ year: '2024' }))] }), values = fields(result);
  assert.equal(result.taxYear, '');
  for (const id of ['taxLineSsaBox3', 'taxLineSsaBox4', 'taxLineSsaBox5']) assert.equal(values[id], undefined);
  assert.equal(values.taxLineSsaBox6.value, '1.00');
  assert.match(result.warnings.join(' '), /year/i);
});

test('primary year conflicts are preserved while alternate labels cannot bless mismatched amounts', () => {
  const result = analyzeDocument({ pages: [paired(ssa({ year: '2023', repaidYear: '2022', netYear: '2022' }), ssa({ year: '2023' }))] });
  assert.equal(result.taxYear, '');
  assert.match(result.warnings.join(' '), /years disagree.*2022.*2023/);
  assert.equal(fields(result).taxLineSsaBox4, undefined);
  assert.equal(fields(result).taxLineSsaBox5, undefined);
});
