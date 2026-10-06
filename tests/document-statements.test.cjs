'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeDocument } = require('../shared/document-parser.cjs');
// Apple Vision word geometry from the three explicitly synthetic PDF test fixtures.
const layouts = require('./fixtures/document-statement-layouts.json');
const profile = result => Object.fromEntries(result.fields.filter(f => f.profileKey).map(f => [f.profileKey, f.value]));

for (const [type, sample] of Object.entries(layouts)) {
  test(`${type} proposes the recipient, not payer/employer, and never monthly income`, () => {
    const result = analyzeDocument({ pages: [sample] });
    assert.equal(result.type, type);
    assert.deepEqual(profile(result), { firstName: 'ALEXANDER', middleName: 'J', lastName: 'SAMPLE',
      addressLine1: '1847 TEST DATA AVE', addressLine2: '4B', city: 'DES MOINES', state: 'IA', zip: '50309' });
    assert.ok(result.fields.every(f => !/income|ssn|phone|household/i.test(f.profileKey)));
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

test('foreign recipient country suppresses domestic 1099 address, not recipient name', () => {
  const page = structuredClone(layouts['1099-nec']);
  page.words.filter(w => w.text === 'US').at(-1).text = 'CA';
  const result = profile(analyzeDocument({ pages: [page] }));
  assert.equal(result.firstName, 'ALEXANDER');
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
    assert.equal(profile(result).ssn, '000-12-3456');
    assert.equal(result.fields.find(f => f.id.startsWith('annual')).value, type === 'ssa-1099' ? '18600.00' : '68450.00');
    assert.equal(result.taxYear, type === 'ssa-1099' ? '2019' : type === 'w2' ? '2025' : '2026');
    for (const word of page.alternative.words) {
      word.text = word.text.replace('000-12-3456', '000-12-3457').replace(/68,?450/, '68451').replace('18,600', '18,601');
    }
    const mismatch = analyzeDocument({ pages: [page] });
    assert.equal(profile(mismatch).ssn, undefined);
    assert.equal(mismatch.fields.some(f => f.id.startsWith('annual')), false);
    assert.equal(profile(mismatch).firstName, 'ALEXANDER');
  });
}
