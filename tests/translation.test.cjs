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

// Laya reads English (#84). Chrome's translator, as a test table: Spanish text it knows, and every call recorded.
const SPANISH = new Map([
  ['¿Cuál es su correo electrónico?', 'What is your email?'],
  ['¿Hay alguien en su hogar de 60 años o más?', 'Is anyone in your household 60 or older?'],
  ['Sí', 'Yes'], ['No', 'No'],
  ['¿Tiene una mascota?', 'Do you have a pet?'],
  ['Perro', 'Dog'], ['Gato', 'Cat'], ['Ninguna', 'None'],
  ['¿Qué prefiere?', 'What do you prefer?'], ['Opción A', 'Option'], ['Opción B', 'Option'],
  ['¿Cuál es su ocupación?', '']
]);
function spanishAI({ detected = [{ detectedLanguage: 'es', confidence: 0.95 }], detector = 'available', translator = 'available', table = SPANISH } = {}) {
  return chromeAI({ detected, detector, translator, create: async () => ({ async translate(text) {
    spanish.calls.translate.push(text);
    if (!table.has(text)) throw new Error(`Synthetic table has no ${text}`);
    return table.get(text);
  } }) });
}
let spanish;
const withSpanish = options => (spanish = spanishAI(options));
const noCalls = calls => assert.deepEqual([calls.translatorAvailability, calls.translatorCreate, calls.translate], [[], [], []], 'no translator calls');

const EMAIL = { id: 'f0:q1', label: '¿Cuál es su correo electrónico?', type: 'email', options: [] };
const SIXTY = { id: 'f0:q2', label: '¿Hay alguien en su hogar de 60 años o más?', type: 'radio', options: ['Sí', 'No'] };
const PET = { id: 'f0:q3', label: '¿Tiene una mascota?', type: 'radio', options: ['Perro', 'Gato', 'Ninguna'] };

test('Laya’s questions in another language are translated on this computer, and its answers map back to the page’s own options by position', async () => {
  const ai = withSpanish();
  const prepared = await translation.create(ai.scope).forLaya([{ boxes: [EMAIL], choices: [SIXTY, PET], declared: '' }]);
  assert.equal(prepared.reason, null);
  assert.deepEqual(prepared.boxes, [{ id: 'f0:q1', label: 'What is your email?', type: 'email', options: [] }]);
  assert.deepEqual(prepared.choices, [
    { id: 'f0:q2', label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] },
    { id: 'f0:q3', label: 'Do you have a pet?', type: 'radio', options: ['Dog', 'Cat', 'None'] }]);
  // Laya answers with the English it was asked; the page gets its own option at the same position.
  assert.deepEqual(prepared.mapAnswers([['f0:q2', 'No'], ['f0:q3', 'Cat']]), [['f0:q2', 'No'], ['f0:q3', 'Gato']]);
  assert.throws(() => prepared.mapAnswers([['f0:q3', 'Gato']]), /Laya/, 'an answer Laya wasn’t offered is an error, never matched by its words');
  assert.throws(() => prepared.mapAnswers([['f0:q9', 'Yes']]), /Laya/);
  // Only the page's question words went to Chrome's translator: labels and options, once each.
  assert.deepEqual(ai.calls.translatorAvailability, [{ sourceLanguage: 'es', targetLanguage: 'en' }]);
  assert.deepEqual(ai.calls.translate.sort(), ['¿Cuál es su correo electrónico?', '¿Hay alguien en su hogar de 60 años o más?', 'Sí', 'No', '¿Tiene una mascota?', 'Perro', 'Gato', 'Ninguna'].sort());
});

test('English questions go to Laya as they are, with no translator calls', async () => {
  const cases = [
    ['Chrome’s detector reads English', chromeAI({ detected: [{ detectedLanguage: 'en', confidence: 0.97 }] }), 'es'],
    ['no detector in this Chrome, and the page declares English', chromeAI({ detected: [] }), 'en-US'],
    ['the detector isn’t downloaded, and the page declares English', chromeAI({ detector: 'downloadable' }), 'en']
  ];
  delete cases[1][1].scope.LanguageDetector;
  const boxes = [{ id: 'f0:q1', label: 'What is your email?', type: 'email', options: [] }];
  const choices = [{ id: 'f0:q2', label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] }];
  for (const [name, ai, declared] of cases) {
    const prepared = await translation.create(ai.scope).forLaya([{ boxes, choices, declared }]);
    assert.equal(prepared.reason, null, name);
    assert.deepEqual([prepared.boxes, prepared.choices], [boxes, choices], name);
    assert.deepEqual(prepared.mapAnswers([['f0:q2', 'No']]), [['f0:q2', 'No']], name);
    noCalls(ai.calls);
  }
  const none = chromeAI();
  assert.deepEqual(plainPrepared(await translation.create(none.scope).forLaya([])), { boxes: [], choices: [], reason: null });
  assert.deepEqual(none.calls.detect, [], 'a page without Laya questions asks nothing');
});
const plainPrepared = ({ boxes, choices, reason }) => ({ boxes, choices, reason });

test('when the questions’ language can’t be told, Laya gets none of them and the applicant is told why', async () => {
  const unknown = { key: 'translate.layaUnknownLanguage', params: {} };
  // No detector, no declared language, Spanish words: never sent as if they were English.
  const bare = withSpanish();
  delete bare.scope.LanguageDetector;
  const prepared = await translation.create(bare.scope).forLaya([{ boxes: [EMAIL], choices: [SIXTY], declared: '' }]);
  assert.deepEqual(plainPrepared(prepared), { boxes: [], choices: [], reason: unknown });
  assert.throws(() => prepared.mapAnswers([['f0:q2', 'No']]), /Laya/);
  noCalls(bare.calls);
  // A ready detector that isn't sure decides, whatever the page declares.
  for (const [detected, declared] of [[[{ detectedLanguage: 'en', confidence: 0.3 }], 'en'], [[{ detectedLanguage: 'und', confidence: 0.99 }], 'en'], [[], 'es']]) {
    const ai = withSpanish({ detected });
    assert.deepEqual(plainPrepared(await translation.create(ai.scope).forLaya([{ boxes: [EMAIL], choices: [SIXTY], declared }])),
      { boxes: [], choices: [], reason: unknown }, JSON.stringify(detected));
    noCalls(ai.calls);
  }
});

test('the detector’s confident reading wins over the page’s declared language, and without a detector the declared language is used', async () => {
  const templated = withSpanish();
  const read = await translation.create(templated.scope).forLaya([{ boxes: [], choices: [SIXTY], declared: 'en' }]);
  assert.deepEqual(read.choices.map(question => question.options), [['Yes', 'No']], 'Spanish words under an English declaration are translated');
  const declaredOnly = withSpanish();
  delete declaredOnly.scope.LanguageDetector;
  const declared = await translation.create(declaredOnly.scope).forLaya([{ boxes: [], choices: [SIXTY], declared: 'es-MX' }]);
  assert.deepEqual(declared.choices.map(question => question.label), ['Is anyone in your household 60 or older?']);
  assert.deepEqual(declaredOnly.calls.translatorAvailability, [{ sourceLanguage: 'es', targetLanguage: 'en' }]);
});

test('without a usable translator, questions in another language stay with the applicant, with the reason, and nothing is downloaded', async () => {
  const cant = { key: 'translate.layaCantTranslate', params: {} };
  const cases = [
    ['no Translator in this Chrome', () => { const ai = withSpanish(); delete ai.scope.Translator; return ai; }, cant],
    ['Chrome can’t translate Spanish here', () => withSpanish({ translator: 'unavailable' }), cant],
    ['the Spanish model isn’t downloaded', () => withSpanish({ translator: 'downloadable' }), { key: 'translate.layaNeedsDownload', params: {} }],
    ['the Spanish model is downloading', () => withSpanish({ translator: 'downloading' }), { key: 'translate.layaNeedsDownload', params: {} }],
    ['the availability check fails', () => { const ai = withSpanish(); ai.scope.Translator.availability = async () => { throw new Error('Synthetic availability failure'); }; return ai; },
      { key: 'translate.layaFailed', params: { detail: 'Synthetic availability failure' } }],
    ['the translator can’t be made', () => { const ai = withSpanish(); ai.scope.Translator.create = async () => { throw new Error('Synthetic create failure'); }; return ai; },
      { key: 'translate.layaFailed', params: { detail: 'Synthetic create failure' } }],
    ['a translation fails', () => withSpanish({ table: new Map() }), { key: 'translate.layaFailed', params: { detail: 'Synthetic table has no ¿Cuál es su correo electrónico?' } }],
    ['the detector fails', () => { const ai = withSpanish(); ai.scope.LanguageDetector.create = async () => { throw new Error('Synthetic detector failure'); }; return ai; },
      { key: 'translate.layaFailed', params: { detail: 'Synthetic detector failure' } }]
  ];
  for (const [name, make, reason] of cases) {
    const ai = make();
    const prepared = await translation.create(ai.scope).forLaya([{ boxes: [EMAIL], choices: [SIXTY], declared: 'es' }]);
    assert.deepEqual(plainPrepared(prepared), { boxes: [], choices: [], reason }, name);
    if (reason.key !== 'translate.layaFailed') assert.deepEqual(ai.calls.translatorCreate, [], `${name}: no translator is made, so nothing is downloaded`);
  }
});

test('a question Chrome can’t translate clearly stays with the applicant; the rest still go to Laya', async () => {
  const ai = withSpanish();
  const prepared = await translation.create(ai.scope).forLaya([{ boxes: [EMAIL, { id: 'f0:q4', label: '¿Cuál es su ocupación?', type: 'text', options: [] }],
    choices: [SIXTY, { id: 'f0:q5', label: '¿Qué prefiere?', type: 'radio', options: ['Opción A', 'Opción B'] }], declared: 'es' }]);
  assert.deepEqual(prepared.boxes.map(box => box.id), ['f0:q1'], 'an empty translation is not sent');
  assert.deepEqual(prepared.choices.map(question => question.id), ['f0:q2'], 'options that translate to the same words are not sent');
  assert.deepEqual(prepared.reason, { key: 'translate.layaUnclear', params: {} });
  assert.deepEqual(prepared.mapAnswers([['f0:q2', 'Yes']]), [['f0:q2', 'Sí']]);
});

test('each frame’s questions are read in their own language: an English page with a Spanish form inside it', async () => {
  const ai = withSpanish({ detected: undefined });
  delete ai.scope.LanguageDetector;
  const english = { id: 'f0:q9', label: 'Do you have a car?', type: 'radio', options: ['Yes', 'No'] };
  const embedded = { ...SIXTY, id: 'f4:q2' };
  const prepared = await translation.create(ai.scope).forLaya([{ boxes: [], choices: [english], declared: 'en' }, { boxes: [], choices: [embedded], declared: 'es' }]);
  assert.deepEqual(prepared.choices, [english, { id: 'f4:q2', label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] }]);
  assert.deepEqual(prepared.mapAnswers([['f0:q9', 'No'], ['f4:q2', 'Yes']]), [['f0:q9', 'No'], ['f4:q2', 'Sí']]);
  assert.deepEqual(ai.calls.translate.sort(), ['¿Hay alguien en su hogar de 60 años o más?', 'No', 'Sí'].sort(), 'the English page’s words never went to the translator');
});
