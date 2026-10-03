/* Chrome's built-in Translator and Language Detector, used only from SecondHand's own extension
   pages and its service worker. Both run on this computer: no request of SecondHand's leaves it,
   and nothing is stored. */
(function (root) {
  'use strict';
  const CONFIDENCE = 0.6; // the detector's lowest confidence SecondHand trusts over the page's declared language
  const STALL_MS = 20000; // a download with no progress for this long is reported as stuck
  const primary = tag => (typeof tag === 'string' ? tag.trim().toLowerCase().split(/[-_]/)[0] : '');

  function create(scope = root, { stallMs = STALL_MS } = {}) {
    const translators = new Map(); // "en>es" -> Promise of Chrome's translator for that pair
    const translations = new Map(); // "en>es\ntext" -> text, for the page on screen
    let detector = null;

    // The language Chrome's detector reads in the texts: null when the detector isn't ready, '' when it
    // isn't sure. A failure is thrown, never hidden behind the declared language.
    async function detected(texts) {
      if (!texts.length || typeof scope.LanguageDetector === 'undefined' || await scope.LanguageDetector.availability() !== 'available') return null;
      detector ||= scope.LanguageDetector.create().catch(error => { detector = null; throw error; });
      const [best] = await (await detector).detect(texts.join('\n'));
      return best && best.detectedLanguage !== 'und' && best.confidence >= CONFIDENCE ? primary(best.detectedLanguage) : '';
    }

    // One frame's questions for Laya, in English. They count as English only when the detector reads
    // English, or, with no detector ready, when the frame declares English. A translator that needs a
    // download is never asked to download: that takes the applicant's click.
    async function englishQuestions(boxes, choices, declared) {
      const skip = (key, params = {}) => ({ boxes: [], choices: [], reason: { key, params } });
      try {
        const texts = [...new Set([...boxes, ...choices].flatMap(question => [question.label, ...question.options]).filter(text => text.trim()))];
        const found = await detected(texts);
        const source = found === null ? primary(declared) : found;
        if (source === 'en') return { boxes, choices, reason: null };
        if (!source) return skip('translate.layaUnknownLanguage');
        if (typeof scope.Translator === 'undefined') return skip('translate.layaCantTranslate');
        const available = await service.availability(source, 'en');
        if (available === 'unavailable') return skip('translate.layaCantTranslate');
        if (available !== 'available') return skip('translate.layaNeedsDownload');
        const english = await service.translate(await service.translator(source, 'en'), source, 'en', texts);
        const clear = text => typeof english.get(text) === 'string' && english.get(text).trim() !== '';
        const sent = {
          boxes: boxes.filter(box => clear(box.label)).map(box => ({ ...box, label: english.get(box.label) })),
          // Options that become the same words can't be told apart, so their question isn't sent.
          choices: choices.filter(question => clear(question.label) && question.options.every(clear) && new Set(question.options.map(option => english.get(option))).size === question.options.length)
            .map(question => ({ ...question, label: english.get(question.label), options: question.options.map(option => english.get(option)) }))
        };
        const unclear = sent.boxes.length < boxes.length || sent.choices.length < choices.length;
        return { ...sent, reason: unclear ? { key: 'translate.layaUnclear', params: {} } : null };
      } catch (error) {
        return skip('translate.layaFailed', { detail: String(error?.message || error).slice(0, 240) });
      }
    }

    const service = {
      // An explicit check for the API itself: when it is missing, the panel shows one plain line.
      supported: () => typeof scope.Translator !== 'undefined',

      // Chrome's detector reads the page's own question text when it is ready. It is never
      // downloaded without the applicant asking, so until then the page's declared language is used.
      async pageLanguage(texts, declared) {
        return await detected(texts) || primary(declared);
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

      // Laya reads English (#84). `groups` are each frame's questions for Laya, with the language the frame
      // declares. Questions in another language are translated to English here, on this computer: their labels
      // and options only, never an answer. Questions whose language can't be told, or that Chrome can't
      // translate clearly, are not sent, and `reason` says why. `mapAnswers` turns Laya's English answers
      // back into the page's own options, by position only.
      async forLaya(groups) {
        const boxes = [], choices = [], originals = new Map(); // question id -> the page's own options, in order
        let reason = null;
        for (const { boxes: groupBoxes = [], choices: groupChoices = [], declared = '' } of groups) {
          if (!groupBoxes.length && !groupChoices.length) continue;
          const english = await englishQuestions(groupBoxes, groupChoices, declared);
          boxes.push(...english.boxes);
          choices.push(...english.choices);
          for (const question of english.choices) originals.set(question.id, groupChoices.find(original => original.id === question.id).options);
          reason ||= english.reason;
        }
        const asked = new Map(choices.map(question => [question.id, question.options]));
        const mapAnswers = entries => entries.map(([id, option]) => {
          const index = asked.has(id) ? asked.get(id).indexOf(option) : -1;
          if (index < 0) throw new Error('Laya answered a question or option it wasn’t asked.');
          return [id, originals.get(id)[index]];
        });
        return { boxes, choices, reason, mapAnswers };
      },

      forget() { translations.clear(); }
    };
    return service;
  }

  const api = Object.freeze({ create, primary });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandTranslation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
