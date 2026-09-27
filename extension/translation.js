/* Chrome's built-in Translator and Language Detector, used only from SecondHand's own extension
   pages. Both run on this computer: no request of SecondHand's leaves it, and nothing is stored. */
(function (root) {
  'use strict';
  const CONFIDENCE = 0.6; // the detector's lowest confidence SecondHand trusts over the page's declared language
  const STALL_MS = 20000; // a download with no progress for this long is reported as stuck
  const primary = tag => (typeof tag === 'string' ? tag.trim().toLowerCase().split(/[-_]/)[0] : '');

  function create(scope = root, { stallMs = STALL_MS } = {}) {
    const translators = new Map(); // "en>es" -> Promise of Chrome's translator for that pair
    const translations = new Map(); // "en>es\ntext" -> text, for the page on screen
    let detector = null;

    return {
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

      forget() { translations.clear(); }
    };
  }

  const api = Object.freeze({ create, primary });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandTranslation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
