'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const summary = require('../extension/summary.js');

// A stand-in for Chrome's built-in Summarizer (mocks live only in tests). Usage is one token per
// four characters, as Chrome's documentation estimates.
function chromeSummarizer({ availability = 'available', quota = 4000, output = () => '* Bring a photo ID.\n* Pickup is on Fridays.\n* Call to reschedule.', create } = {}) {
  const calls = { availability: [], create: [], summarize: [], measure: [] };
  const Summarizer = {
    async availability(options) { calls.availability.push(options); return typeof availability === 'function' ? availability(options) : availability; },
    async create(options) {
      calls.create.push(options);
      if (create) return create(options);
      return {
        inputQuota: quota,
        async measureInputUsage(text) { calls.measure.push(text); return Math.ceil(text.length / 4); },
        async summarize(text) { calls.summarize.push(text); return output(text); }
      };
    }
  };
  return { scope: { Summarizer }, calls };
}
const progress = loaded => Object.assign(new Event('downloadprogress'), { loaded });
const OPTIONS = { type: 'key-points', length: 'short', format: 'plain-text' };

test('without the Summarizer API the service says so', () => {
  assert.equal(summary.create({}).supported(), false);
  assert.equal(summary.create(chromeSummarizer().scope).supported(), true);
});

test('the points are asked for in the applicant’s language when Chrome writes it, else in English, for the page’s declared language', async () => {
  const spanish = chromeSummarizer();
  const service = summary.create(spanish.scope);
  assert.equal(await service.outputLanguage('es', 'en'), 'es');
  assert.deepEqual(spanish.calls.availability, [{ ...OPTIONS, outputLanguage: 'es', expectedInputLanguages: ['en'] }]);
  assert.equal(await service.outputLanguage('en', 'en'), 'en');
  assert.equal(await service.outputLanguage('vi', ''), 'en', 'SecondHand can only check points in English and Spanish for a verdict');
  assert.equal(spanish.calls.availability.length, 1, 'English, and languages SecondHand can’t check, are not asked about');
  const englishOnly = chromeSummarizer({ availability: options => options.outputLanguage === 'es' ? 'unavailable' : 'available' });
  assert.equal(await summary.create(englishOnly.scope).outputLanguage('es', 'en'), 'en');
  assert.equal(await service.availability('en', ''), 'available');
  assert.deepEqual(spanish.calls.availability.at(-1), { ...OPTIONS, outputLanguage: 'en' }, 'a page that declares no language is not guessed');
});

test('the points are three to five plain lines, never a statement that the reader qualifies', async () => {
  const ai = chromeSummarizer({ output: () => '* You qualify for SNAP.\n- Bring a photo ID.\n\n• Households under the income limit qualify.\n1. You may qualify if your income is under $2,000.\n2) Pickup is on Fridays.\n* You’re eligible for emergency boxes.\n* Call to reschedule.\n* Bring bags.\n* Arrive early.' });
  const service = summary.create(ai.scope);
  const summarizer = await service.summarizer('en', 'en');
  assert.deepEqual(await service.points(summarizer, 'Synthetic page text.'), ['Bring a photo ID.', 'Households under the income limit qualify.',
    'You may qualify if your income is under $2,000.', 'Pickup is on Fridays.', 'Call to reschedule.']);
  assert.deepEqual(ai.calls.create, [{ ...OPTIONS, outputLanguage: 'en', expectedInputLanguages: ['en'], sharedContext: summary.CONTEXT, monitor: ai.calls.create[0].monitor }]);
  assert.deepEqual(ai.calls.summarize, ['Synthetic page text.'], 'Chrome sees the page’s text and nothing else');
  const spanish = chromeSummarizer({ output: () => '* Usted califica para SNAP.\n* Califica para la ayuda.\n* Lleve una identificación con foto.\n* Si su ingreso es bajo, usted califica.' });
  const es = summary.create(spanish.scope);
  assert.deepEqual(await es.points(await es.summarizer('es', 'en'), 'Synthetic page text.'), ['Lleve una identificación con foto.', 'Si su ingreso es bajo, usted califica.']);
  const odd = summary.create(chromeSummarizer({ output: () => 42 }).scope);
  await assert.rejects(odd.points(await odd.summarizer('en', ''), 'Synthetic page text.'), /summar/i, 'a reply that is not text is an error');
  await assert.rejects(summary.create(chromeSummarizer().scope).summarizer('fr', ''), /fr/, 'points in a language SecondHand can’t check are never asked for');
});

test('text longer than Chrome’s input quota is split at paragraphs, then sentences, and the pieces’ points are summarized again', async () => {
  const paragraphs = Array.from({ length: 6 }, (_, index) => `Rule ${index}. ${'Bring the listed documents. '.repeat(8).trim()}`);
  const ai = chromeSummarizer({ quota: 150, output: text => text.startsWith('* ') ? '* Combined point.' : `* Point from ${text.slice(0, 6)}` });
  const service = summary.create(ai.scope);
  const points = await service.points(await service.summarizer('en', 'en'), paragraphs.join('\n'));
  assert.deepEqual(points, ['Combined point.']);
  const pieces = ai.calls.summarize.slice(0, -1);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join('\n'), paragraphs.join('\n'), 'every word is summarized once, in order');
  assert.ok(pieces.every(piece => Math.ceil(piece.length / 4) <= 150), 'each piece fits the quota');
  assert.ok(pieces.every(piece => paragraphs.some(paragraph => paragraph.includes(piece) || piece.includes(paragraph))), 'pieces break between paragraphs or sentences');
  assert.equal(ai.calls.summarize.at(-1), pieces.map(piece => `* Point from ${piece.slice(0, 6)}`).join('\n'));

  assert.deepEqual(await summary.pieces('One sentence. Two sentence. Three sentence.', async text => text.length <= 16), ['One sentence.', 'Two sentence.', 'Three sentence.']);
  assert.deepEqual(await summary.pieces('abcdefgh', async text => text.length <= 3), ['ab', 'cd', 'ef', 'gh']);
  await assert.rejects(summary.pieces('abc', async () => false), /quota/, 'a model that takes no text at all is an error');
});

test('each page’s text is summarized once per language of the points', async () => {
  const ai = chromeSummarizer();
  const service = summary.create(ai.scope);
  const summarizer = await service.summarizer('en', 'en');
  assert.equal(await service.summarizer('en', 'en'), summarizer, 'one summarizer per language');
  const first = await service.points(summarizer, 'Synthetic page text.');
  assert.deepEqual(await service.points(summarizer, 'Synthetic page text.'), first);
  assert.equal(ai.calls.summarize.length, 1);
  await service.points(summarizer, 'Other synthetic text.');
  assert.equal(ai.calls.summarize.length, 2);
});

test('a download reports its progress; one that never starts says so; one that fails is tried again on the next click', async t => {
  // The test runs the clock the stall timer counts on.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let monitor, finish;
  const downloading = chromeSummarizer({ availability: 'downloadable', create: options => { options.monitor(monitor = new EventTarget()); return new Promise(resolve => { finish = resolve; }); } });
  const seen = [];
  const pending = summary.create(downloading.scope, { stallMs: 30 }).summarizer('en', 'en', { onProgress: value => seen.push(value), onStall: () => seen.push('stalled') });
  monitor.dispatchEvent(progress(0));
  monitor.dispatchEvent(progress(0.5));
  monitor.dispatchEvent(progress(1));
  finish({ inputQuota: 4000 });
  await pending;
  t.mock.timers.tick(60);
  assert.deepEqual(seen, [0, 0.5, 1], 'no stall once Chrome is downloading');

  const stalls = [];
  summary.create(chromeSummarizer({ availability: 'downloadable', create: () => new Promise(() => {}) }).scope, { stallMs: 20 }).summarizer('en', 'en', { onStall: () => stalls.push('stalled') });
  t.mock.timers.tick(19);
  assert.deepEqual(stalls, [], 'not before its stall time');
  t.mock.timers.tick(1);
  assert.deepEqual(stalls, ['stalled']);

  let attempts = 0;
  const flaky = chromeSummarizer({ create: async () => { if (++attempts === 1) throw new Error('Synthetic download failure'); return { inputQuota: 4000 }; } });
  const service = summary.create(flaky.scope);
  await assert.rejects(service.summarizer('en', 'en'), /Synthetic download failure/);
  assert.ok(await service.summarizer('en', 'en'));
  assert.equal(attempts, 2);
});
