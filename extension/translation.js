/* Chrome's built-in Translator and Language Detector, used only from SecondHand's own extension
   pages. Both run on this computer: no request of SecondHand's leaves it, and nothing is stored. */
(function (root) {
  'use strict';
  const CONFIDENCE = 0.6; // the detector's lowest confidence SecondHand trusts over the page's declared language
  const STALL_MS = 20000; // a download with no progress for this long is reported as stuck
  const primary = tag => (typeof tag === 'string' ? tag.trim().toLowerCase().split(/[-_]/)[0] : '');

  const languageName = (code, lang = 'en') => (typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames([lang], { type: 'language' }).of(code) : code) || code;

  function create(scope = root, { stallMs = STALL_MS } = {}) {
    const translators = new Map(); // "en>es" -> Promise of Chrome's translator for that pair
    const translations = new Map(); // "en>es\ntext" -> text, for the page on screen
    let detector = null;

    const service = {
      // An explicit check for the API itself: when it is missing, the panel shows one plain line.
      supported: () => typeof scope.Translator !== 'undefined',

      // Chrome's detector reads the page's own question text when it is ready. It is never
      // downloaded without the applicant asking, so until then the page's declared language is used.
      async pageLanguage(texts, declared) {
        const fallback = primary(declared);
        if (!texts.length || typeof scope.LanguageDetector === 'undefined' || await scope.LanguageDetector.availability() !== 'available') return fallback;
        detector ||= scope.LanguageDetector.create().catch(error => { detector = null; throw error; });
        const [best] = await (await detector).detect(texts.join('\n'));
        return best && best.detectedLanguage !== 'und' && best.confidence >= CONFIDENCE ? primary(best.detectedLanguage) : fallback;
      },

      availability: (source, target) => scope.Translator.availability({ sourceLanguage: source, targetLanguage: target }),

      // One translator per language pair. When Chrome must download it, call this from the
      // applicant's click: Chrome requires it. A download that never starts is reported, not hidden.
      translator(source, target, { onProgress = () => {}, onStall = () => {} } = {}) {
        const pair = `${source}>${target}`;
        if (!translators.has(pair)) {
          let timer = setTimeout(onStall, stallMs);
          const created = scope.Translator.create({ sourceLanguage: source, targetLanguage: target, monitor(monitor) {
            monitor.addEventListener('downloadprogress', event => {
              clearTimeout(timer);
              onProgress(event.loaded);
              if (event.loaded < 1) timer = setTimeout(onStall, stallMs);
            });
          } }).finally(() => clearTimeout(timer));
          // A failed attempt is not kept, so the next click tries again; the caller still gets the error.
          translators.set(pair, created.catch(error => { translators.delete(pair); throw error; }));
        }
        return translators.get(pair);
      },

      async translate(translator, source, target, texts) {
        const out = new Map();
        for (const text of new Set(texts)) {
          const key = `${source}>${target}\n${text}`;
          if (!translations.has(key)) {
            const translated = await translator.translate(text);
            if (typeof translated !== 'string') throw new Error('Chrome’s translator returned something other than text.');
            translations.set(key, translated);
          }
          out.set(text, translations.get(key));
        }
        return out;
      },

      // Prepares form questions for Laya on this computer. Non-English labels and options
      // are translated to English, and answers map back strictly by option position.
      // Untranslatable questions remain with the applicant with a clear reason.
      async forLaya({ boxes = [], choices = [] } = {}, declared = '') {
        const passThrough = { boxes, choices, mapAnswers: entries => entries, reason: null, reasons: new Map() };
        const texts = [...new Set([...boxes.map(b => b.label), ...choices.flatMap(c => [c.label, ...c.options])].filter(text => typeof text === 'string' && text.trim() !== ''))];
        if (!texts.length) return passThrough;
        const source = await service.pageLanguage(texts, declared);
        if (!source || source === 'en') return passThrough;

        const allIds = [...boxes.map(b => b.id), ...choices.map(c => c.id)];
        if (typeof scope.Translator === 'undefined') {
          const reason = { key: 'translate.missing', params: {} };
          return { boxes: [], choices: [], mapAnswers: entries => entries, reason, reasons: new Map(allIds.map(id => [id, reason])) };
        }
        const sourceName = languageName(source, 'en');
        const targetName = languageName('en', 'en');
        let avail;
        try {
          avail = await service.availability(source, 'en');
        } catch (error) {
          const reason = { key: 'translate.failed', params: { detail: error.message } };
          return { boxes: [], choices: [], mapAnswers: entries => entries, reason, reasons: new Map(allIds.map(id => [id, reason])) };
        }
        if (avail === 'unavailable') {
          const reason = { key: 'translate.unavailable', params: { source: sourceName, target: targetName } };
          return { boxes: [], choices: [], mapAnswers: entries => entries, reason, reasons: new Map(allIds.map(id => [id, reason])) };
        }
        if (avail !== 'available') {
          const reason = { key: 'translate.needsDownload', params: { language: sourceName } };
          return { boxes: [], choices: [], mapAnswers: entries => entries, reason, reasons: new Map(allIds.map(id => [id, reason])) };
        }
        try {
          const trans = await service.translator(source, 'en');
          const translatedMap = await service.translate(trans, source, 'en', texts);
          const reasons = new Map();
          const translatedBoxes = [];
          for (const b of boxes) {
            const translatedLabel = translatedMap.get(b.label);
            if (typeof translatedLabel !== 'string' || translatedLabel.trim() === '') {
              reasons.set(b.id, { key: 'translate.untranslated', params: {} });
              continue;
            }
            translatedBoxes.push({ ...b, label: translatedLabel });
          }
          const translatedChoices = [];
          for (const c of choices) {
            const translatedLabel = translatedMap.get(c.label);
            if (typeof translatedLabel !== 'string' || translatedLabel.trim() === '') {
              reasons.set(c.id, { key: 'translate.untranslated', params: {} });
              continue;
            }
            const translatedOptions = [];
            let optionsOk = true;
            for (const opt of c.options) {
              const translatedOpt = translatedMap.get(opt);
              if (typeof translatedOpt !== 'string' || translatedOpt.trim() === '') {
                optionsOk = false;
                break;
              }
              translatedOptions.push(translatedOpt);
            }
            if (!optionsOk) {
              reasons.set(c.id, { key: 'translate.untranslated', params: {} });
              continue;
            }
            if (new Set(translatedOptions).size !== translatedOptions.length) {
              reasons.set(c.id, { key: 'translate.optionsCollided', params: {} });
              continue;
            }
            translatedChoices.push({ ...c, label: translatedLabel, options: translatedOptions });
          }
          const mapAnswers = entries => {
            if (!Array.isArray(entries)) return [];
            const mapped = [];
            for (const [id, answer] of entries) {
              const original = choices.find(c => c.id === id);
              const translated = translatedChoices.find(c => c.id === id);
              if (!original || !translated) continue;
              const idx = translated.options.indexOf(answer);
              if (idx === -1) continue;
              mapped.push([id, original.options[idx]]);
            }
            return mapped;
          };
          const reason = (!translatedBoxes.length && !translatedChoices.length && reasons.size) ? reasons.values().next().value : null;
          return { boxes: translatedBoxes, choices: translatedChoices, mapAnswers, reason, reasons };
        } catch (error) {
          const reason = { key: 'translate.failed', params: { detail: error.message } };
          return { boxes: [], choices: [], mapAnswers: entries => entries, reason, reasons: new Map(allIds.map(id => [id, reason])) };
        }
      },

      forget() { translations.clear(); }
    };
    return service;
  }

  const api = Object.freeze({ create, primary, languageName });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandTranslation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
