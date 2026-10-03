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

test('forLaya translates non-English labels and options to English, and maps answers back strictly by option position', async () => {
  const dictionary = new Map([
    ['¿Cuál es su correo electrónico?', 'What is your email?'],
    ['¿Tiene 60 años o más?', 'Are you 60 years or older?'],
    ['Sí', 'Yes'],
    ['No', 'No'],
    ['¿Tiene una mascota?', 'Do you have a pet?'],
    ['Cierto', 'True'],
    ['Falso', 'False']
  ]);
  const spanishAI = chromeAI({
    detected: [{ detectedLanguage: 'es', confidence: 0.95 }],
    create: async () => ({
      async translate(text) {
        if (!dictionary.has(text)) throw new Error(`Untranslated: ${text}`);
        return dictionary.get(text);
      }
    })
  });
  const service = translation.create(spanishAI.scope);
  const boxes = [{ id: 'q1', label: '¿Cuál es su correo electrónico?', type: 'email', options: [] }];
  const choices = [
    { id: 'q2', label: '¿Tiene 60 años o más?', type: 'radio', options: ['Sí', 'No'] },
    { id: 'q3', label: '¿Tiene una mascota?', type: 'radio', options: ['Cierto', 'Falso'] }
  ];

  const prepared = await service.forLaya({ boxes, choices });
  assert.equal(prepared.reason, null);
  assert.deepEqual(prepared.boxes, [{ id: 'q1', label: 'What is your email?', type: 'email', options: [] }]);
  assert.deepEqual(prepared.choices, [
    { id: 'q2', label: 'Are you 60 years or older?', type: 'radio', options: ['Yes', 'No'] },
    { id: 'q3', label: 'Do you have a pet?', type: 'radio', options: ['True', 'False'] }
  ]);

  // Answers come from Laya as English options; mapAnswers maps them back strictly by option position (never by text match).
  const mapped = prepared.mapAnswers([['q2', 'No'], ['q3', 'True']]);
  assert.deepEqual(mapped, [['q2', 'No'], ['q3', 'Cierto']], 'Cierto was mapped because True was at index 0, not by text');
  assert.deepEqual(spanishAI.calls.translatorAvailability, [{ sourceLanguage: 'es', targetLanguage: 'en' }]);
});

test('English questions make zero translator calls and return unchanged', async () => {
  const englishAI = chromeAI({ detected: [{ detectedLanguage: 'en', confidence: 0.99 }] });
  const service = translation.create(englishAI.scope);
  const boxes = [{ id: 'q1', label: 'What is your email?', type: 'email', options: [] }];
  const choices = [{ id: 'q2', label: 'Are you 60 years or older?', type: 'radio', options: ['Yes', 'No'] }];

  const prepared = await service.forLaya({ boxes, choices });
  assert.equal(prepared.reason, null);
  assert.deepEqual(prepared.boxes, boxes);
  assert.deepEqual(prepared.choices, choices);
  assert.deepEqual(prepared.mapAnswers([['q2', 'No']]), [['q2', 'No']]);
  assert.deepEqual(englishAI.calls.translatorAvailability, [], 'no availability check');
  assert.deepEqual(englishAI.calls.translatorCreate, [], 'no translator created');
  assert.deepEqual(englishAI.calls.translate, [], 'no translate calls');
});

test('if translation is missing, unavailable, needs download, or fails, questions stay with the applicant with a clear reason', async () => {
  const boxes = [{ id: 'q1', label: '¿Cuál es su correo?', type: 'email', options: [] }];
  const choices = [{ id: 'q2', label: '¿Es ciudadano?', type: 'radio', options: ['Sí', 'No'] }];

  // 1. Translator missing
  const missing = translation.create({});
  const missingResult = await missing.forLaya({ boxes, choices }, 'es');
  assert.deepEqual(missingResult.boxes, []);
  assert.deepEqual(missingResult.choices, []);
  assert.deepEqual(missingResult.reason, { key: 'translate.missing', params: {} });

  // 2. Translator unavailable
  const unavailAI = chromeAI({ detector: 'available', detected: [{ detectedLanguage: 'es', confidence: 0.95 }], translator: 'unavailable' });
  const unavailResult = await translation.create(unavailAI.scope).forLaya({ boxes, choices });
  assert.deepEqual(unavailResult.boxes, []);
  assert.deepEqual(unavailResult.choices, []);
  assert.deepEqual(unavailResult.reason, { key: 'translate.unavailable', params: { source: 'Spanish', target: 'English' } });

  // 3. Translator downloadable (user hasn't allowed/triggered download)
  const downloadAI = chromeAI({ detector: 'available', detected: [{ detectedLanguage: 'es', confidence: 0.95 }], translator: 'downloadable' });
  const downloadResult = await translation.create(downloadAI.scope).forLaya({ boxes, choices });
  assert.deepEqual(downloadResult.boxes, []);
  assert.deepEqual(downloadResult.choices, []);
  assert.deepEqual(downloadResult.reason, { key: 'translate.needsDownload', params: { language: 'Spanish' } });

  // 4. Translation fails
  const failingAI = chromeAI({
    detected: [{ detectedLanguage: 'es', confidence: 0.95 }],
    create: async () => ({ async translate() { throw new Error('Network failure'); } })
  });
  const failingResult = await translation.create(failingAI.scope).forLaya({ boxes, choices });
  assert.deepEqual(failingResult.boxes, []);
  assert.deepEqual(failingResult.choices, []);
  assert.deepEqual(failingResult.reason, { key: 'translate.failed', params: { detail: 'Network failure' } });
});

test('forLaya does not send untranslated labels or options to Laya and gives a reason', async () => {
  const dictionary = new Map([
    ['¿Cuál es su correo electrónico?', 'What is your email?'],
    ['Sí', 'Yes'],
    ['No', 'No']
  ]);
  const spanishAI = chromeAI({
    detected: [{ detectedLanguage: 'es', confidence: 0.95 }],
    create: async () => ({
      async translate(text) {
        if (!dictionary.has(text)) return '';
        return dictionary.get(text);
      }
    })
  });
  const service = translation.create(spanishAI.scope);
  const boxes = [
    { id: 'q1', label: '¿Cuál es su correo electrónico?', type: 'email', options: [] },
    { id: 'q2', label: '¿Cuál es su ocupación?', type: 'text', options: [] }
  ];
  const choices = [
    { id: 'q3', label: '¿Pregunta sin traducción?', type: 'radio', options: ['Sí', 'No'] },
    { id: 'q4', label: '¿Tiene 60 años o más?', type: 'radio', options: ['Sí', 'Opción desconocida'] }
  ];

  const prepared = await service.forLaya({ boxes, choices });
  // q1 translated successfully, q2 was untranslated so excluded from boxes
  assert.deepEqual(prepared.boxes, [{ id: 'q1', label: 'What is your email?', type: 'email', options: [] }]);
  // q3 label untranslated, q4 has untranslated option, so both excluded from choices
  assert.deepEqual(prepared.choices, []);
  assert.deepEqual(prepared.reasons.get('q2'), { key: 'translate.untranslated', params: {} });
  assert.deepEqual(prepared.reasons.get('q3'), { key: 'translate.untranslated', params: {} });
  assert.deepEqual(prepared.reasons.get('q4'), { key: 'translate.untranslated', params: {} });
});

test('mapAnswers drops answers that do not map back to an original option by position', async () => {
  const dictionary = new Map([
    ['¿Tiene 60 años o más?', 'Are you 60 years or older?'],
    ['Sí', 'Yes'],
    ['No', 'No']
  ]);
  const spanishAI = chromeAI({
    detected: [{ detectedLanguage: 'es', confidence: 0.95 }],
    create: async () => ({
      async translate(text) {
        return dictionary.get(text);
      }
    })
  });
  const service = translation.create(spanishAI.scope);
  const choices = [
    { id: 'q1', label: '¿Tiene 60 años o más?', type: 'radio', options: ['Sí', 'No'] }
  ];
  const prepared = await service.forLaya({ choices });
  assert.deepEqual(prepared.choices, [{ id: 'q1', label: 'Are you 60 years or older?', type: 'radio', options: ['Yes', 'No'] }]);
  // An answer that does not match any translated option must be dropped (empty array)
  assert.deepEqual(prepared.mapAnswers([['q1', 'Maybe']]), []);
  // A valid answer maps back to the original option at that position
  assert.deepEqual(prepared.mapAnswers([['q1', 'Yes']]), [['q1', 'Sí']]);
});

test('forLaya skips questions whose translated options collide and gives a reason', async () => {
  const dictionary = new Map([
    ['¿Qué prefiere?', 'What do you prefer?'],
    ['Opción A', 'Option'],
    ['Opción B', 'Option']
  ]);
  const spanishAI = chromeAI({
    detected: [{ detectedLanguage: 'es', confidence: 0.95 }],
    create: async () => ({
      async translate(text) {
        return dictionary.get(text);
      }
    })
  });
  const service = translation.create(spanishAI.scope);
  const choices = [
    { id: 'q1', label: '¿Qué prefiere?', type: 'radio', options: ['Opción A', 'Opción B'] }
  ];
  const prepared = await service.forLaya({ choices });
  assert.deepEqual(prepared.choices, []);
  assert.deepEqual(prepared.reasons.get('q1'), { key: 'translate.optionsCollided', params: {} });
  assert.deepEqual(prepared.reason, { key: 'translate.optionsCollided', params: {} });
});
