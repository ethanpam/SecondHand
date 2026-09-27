'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const translation = require('../extension/translation.js');

// Stand-ins for Chrome's built-in Translator and LanguageDetector (mocks live only in tests).
function chromeAI({ translator = 'available', detector = 'available', detected = [{ detectedLanguage: 'en', confidence: 0.97 }], create } = {}) {
  const calls = { translatorAvailability: [], translatorCreate: [], translate: [], detectorCreate: 0, detect: [] };
  const Translator = {
    async availability(options) { calls.translatorAvailability.push(options); return translator; },
    async create(options) {
      calls.translatorCreate.push(options);
      if (create) return create(options);
      return { async translate(text) { calls.translate.push(text); return `[${options.targetLanguage}] ${text}`; } };
    }
  };
  const LanguageDetector = {
    async availability() { return detector; },
    async create() { calls.detectorCreate++; return { async detect(text) { calls.detect.push(text); return detected; } }; }
  };
  return { scope: { Translator, LanguageDetector }, calls };
}
const progress = loaded => Object.assign(new Event('downloadprogress'), { loaded });

test('without the Translator API the service says so, and the page language is the declared one', async () => {
  const service = translation.create({});
  assert.equal(service.supported(), false);
  assert.equal(await service.pageLanguage(['First name'], 'en-US'), 'en');
  assert.equal(await service.pageLanguage(['First name'], ''), '');
  assert.equal(translation.create(chromeAI().scope).supported(), true);
});

test('the page language comes from Chrome’s detector reading the questions when it is ready, else from the page’s declared language', async () => {
  const spanish = chromeAI({ detected: [{ detectedLanguage: 'es', confidence: 0.91 }, { detectedLanguage: 'en', confidence: 0.05 }] });
  assert.equal(await translation.create(spanish.scope).pageLanguage(['¿Cuántas personas viven en su casa?', 'Nombre'], 'en'), 'es', 'the text wins over a wrong declaration');
  assert.deepEqual(spanish.calls.detect, ['¿Cuántas personas viven en su casa?\nNombre']);
  for (const detected of [[{ detectedLanguage: 'es', confidence: 0.3 }], [{ detectedLanguage: 'und', confidence: 0.99 }], []]) {
    assert.equal(await translation.create(chromeAI({ detected }).scope).pageLanguage(['Name'], 'en-GB'), 'en', JSON.stringify(detected));
  }
  const labelsOnly = chromeAI();
  assert.equal(await translation.create(labelsOnly.scope).pageLanguage([], 'en'), 'en', 'with no page words to read, the declared language decides');
  assert.deepEqual(labelsOnly.calls.detect, []);
  const notReady = chromeAI({ detector: 'downloadable' });
  assert.equal(await translation.create(notReady.scope).pageLanguage(['Name'], 'en'), 'en');
  assert.equal(notReady.calls.detectorCreate, 0, 'a detector is never downloaded without the applicant asking');
  const broken = chromeAI();
  broken.scope.LanguageDetector.create = async () => { throw new Error('Synthetic detector failure'); };
  await assert.rejects(translation.create(broken.scope).pageLanguage(['Name'], 'en'), /Synthetic detector failure/, 'a failure is not hidden behind the declared language');
});

test('a ready translator translates each text once per page, on this computer, and forgets them when the page changes', async () => {
  const ai = chromeAI();
  const service = translation.create(ai.scope);
  assert.equal(await service.availability('en', 'es'), 'available');
  assert.deepEqual(ai.calls.translatorAvailability, [{ sourceLanguage: 'en', targetLanguage: 'es' }]);
  const translator = await service.translator('en', 'es');
  assert.equal(await service.translator('en', 'es'), translator, 'one translator per language pair');
  const first = await service.translate(translator, 'en', 'es', ['First name', 'Last name', 'First name']);
  assert.deepEqual([...first], [['First name', '[es] First name'], ['Last name', '[es] Last name']]);
  await service.translate(translator, 'en', 'es', ['First name']);
  assert.deepEqual(ai.calls.translate, ['First name', 'Last name'], 'cached for the page');
  service.forget();
  await service.translate(translator, 'en', 'es', ['First name']);
  assert.deepEqual(ai.calls.translate, ['First name', 'Last name', 'First name']);
  assert.equal(ai.calls.translatorCreate[0].sourceLanguage, 'en');
  assert.equal(ai.calls.translatorCreate[0].targetLanguage, 'es');
  const odd = chromeAI({ create: async () => ({ async translate() { return 42; } }) });
  const oddService = translation.create(odd.scope);
  await assert.rejects(oddService.translate(await oddService.translator('en', 'es'), 'en', 'es', ['Name']), /translat/i, 'a reply that is not text is an error');
});

test('a download reports its progress; one that never starts says so; one that fails is tried again on the next click', async () => {
  let monitor;
  let finish;
  const downloading = chromeAI({ translator: 'downloadable', create: options => { options.monitor(monitor = new EventTarget()); return new Promise(resolve => { finish = resolve; }); } });
  const seen = [];
  const pending = translation.create(downloading.scope, { stallMs: 30 }).translator('en', 'es', { onProgress: value => seen.push(value), onStall: () => seen.push('stalled') });
  monitor.dispatchEvent(progress(0));
  monitor.dispatchEvent(progress(0.5));
  monitor.dispatchEvent(progress(1));
  finish({ async translate(text) { return text; } });
  await pending;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(seen, [0, 0.5, 1], 'no stall once Chrome is downloading');

  const stuck = chromeAI({ translator: 'downloadable', create: () => new Promise(() => {}) });
  const stalls = [];
  translation.create(stuck.scope, { stallMs: 20 }).translator('en', 'es', { onStall: () => stalls.push('stalled') });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(stalls, ['stalled']);

  let attempts = 0;
  const flaky = chromeAI({ create: async () => { if (++attempts === 1) throw new Error('Synthetic download failure'); return { async translate(text) { return text; } }; } });
  const service = translation.create(flaky.scope);
  await assert.rejects(service.translator('en', 'es'), /Synthetic download failure/);
  assert.ok(await service.translator('en', 'es'));
  assert.equal(attempts, 2);
});
