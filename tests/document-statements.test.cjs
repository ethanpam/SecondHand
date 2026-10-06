'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../shared/document-parser.cjs');
// Apple Vision word geometry from the three explicitly synthetic PDF test fixtures.
const layouts = require('./fixtures/document-statement-layouts.json');
const expectedAddresses = {
  w2: { addressLine1: '1847 TEST DATA AVE, APT 4B', city: 'DES MOINES', state: 'IA', zip: '50309' },
  'ssa-1099': { addressLine1: '1847 TEST DATA AVE', addressLine2: 'APT 4B', city: 'DES MOINES', state: 'IA', zip: '50309' },
  '1099-nec': { addressLine1: '1847 TEST DATA AVE', addressLine2: 'APT 4B', city: 'DES MOINES', state: 'IA', zip: '50309' }
};
const profile = result => Object.fromEntries(result.fields.filter(f => f.profileKey).map(f => [f.profileKey, f.value]));

for (const [type, sample] of Object.entries(layouts)) {
  test(`${type} proposes the recipient, not payer/employer, and never monthly income`, () => {
    const result = analyzeDocument({ pages: [sample] });
    assert.equal(result.type, type);
    assert.deepEqual(profile(result), expectedAddresses[type]);
    assert.ok(result.fields.some(field => field.value === 'ALEXANDER J SAMPLE' && !field.profileKey), 'Combined names stay visible for source review without guessed first/last boundaries.');
    assert.ok(result.fields.every(f => !/income|ssn|phone|household/i.test(f.profileKey)));
    assert.ok(result.fields.every(f => !f.id.startsWith('taxLine')), 'Single-pass Vision output cannot propose monetary values.');
  });
  test(`${type} never substitutes another identity when the recipient name is blank`, () => {
    const page = structuredClone(sample);
    page.words = page.words.filter(w => !['ALEXANDER', 'J', 'SAMPLE'].includes(w.text));
    const result = profile(analyzeDocument({ pages: [page] }));
    assert.equal(result.firstName, undefined);
    assert.equal(result.lastName, undefined);
  });
  test(`${type} refuses ambiguous compound names`, () => {
    const page = structuredClone(sample);
    page.words.find(w => w.text === 'J').text = 'JANE';
    assert.equal(profile(analyzeDocument({ pages: [page] })).firstName, undefined);
  });
  test(`${type} does not combine multiple statements`, () => {
    assert.equal(analyzeDocument({ pages: [sample, sample] }).fields.length, 0);
  });
}

test('foreign recipient country suppresses domestic 1099 address while the combined name stays review-only', () => {
  const page = structuredClone(layouts['1099-nec']);
  page.words.filter(w => w.text === 'US').at(-1).text = 'CA';
  const analysis = analyzeDocument({ pages: [page] });
  const result = profile(analysis);
  assert.equal(result.firstName, undefined);
  assert.ok(analysis.fields.some(field => field.value === 'ALEXANDER J SAMPLE' && !field.profileKey));
  assert.equal(result.addressLine1, undefined);
  assert.equal(result.zip, undefined);
});

test('mixed statement types do not combine profiles', () => {
  assert.equal(analyzeDocument({ pages: [layouts.w2, layouts['1099-nec']] }).fields.length, 0);
});

for (const [type, sample] of Object.entries(layouts)) {
  test(`${type} requires matching second readings for SSN and annual income`, () => {
    const page = structuredClone(sample);
    page.alternative = structuredClone(sample);
    const result = analyzeDocument({ pages: [page] });
    assert.equal(profile(result).ssn, type === '1099-nec' ? undefined : '000-12-3456');
    const incomeID = ({'1099-nec':'taxLineNecBox1a', 'ssa-1099':'taxLineSsaBox3', w2:'taxLineW2Box1'})[type];
    assert.equal(result.fields.find(f => f.id === incomeID).value, type === 'ssa-1099' ? '18600.00' : '68450.00');
    assert.equal(result.taxYear, type === 'ssa-1099' ? '' : type === 'w2' ? '2025' : '2026');
    for (const word of page.alternative.words) {
      word.text = word.text.replace('000-12-3456', '000-12-3457').replace(/68,?450/, '68451').replace('18,600', '18,601');
    }
    const mismatch = analyzeDocument({ pages: [page] });
    assert.equal(profile(mismatch).ssn, undefined);
    assert.equal(mismatch.fields.some(f => f.id === incomeID), false);
    assert.equal(profile(mismatch).zip, '50309');
  });
}
