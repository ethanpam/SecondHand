/* Chrome's built-in Summarizer, used only from SecondHand's own extension pages. It runs on this
   computer: the page's text never leaves it, and nothing is stored. */
(function (root) {
  'use strict';
  const STALL_MS = 20000; // a download with no progress for this long is reported as stuck
  const MAX_POINTS = 5;
  const MAX_ROUNDS = 3; // summaries of summaries before a page is called too long
  const OPTIONS = Object.freeze({ type: 'key-points', length: 'short', format: 'plain-text' });
  const CONTEXT = 'Text from a food assistance or benefits application page. List what the page says. Do not tell the reader whether they qualify.';
  // A point that tells the reader they qualify is a decision, not what the page says, so it is never
  // shown. "You qualify if…" stays: it is a rule. Chrome writes the points only in these languages.
  const word = pattern => `(?<!\\p{L})(?:${pattern})(?!\\p{L})`;
  const VERDICTS = Object.freeze({
    en: { claim: new RegExp(`${word('you|your household|your family')}\\s+${word('qualify|qualifies|will qualify|would qualify|are eligible|is eligible|will be eligible|are qualified|are approved|is approved|will be approved')}|${word('you[’\']re')}\\s+${word('eligible|qualified|approved')}`, 'iu'),
      condition: new RegExp(word('if|unless|when|whether|only|may|might|could|must|need|needs|depends|until|as long as'), 'iu') },
    es: { claim: new RegExp(`^\\s*${word('califica|es elegible|reúne los requisitos|cumple (?:con )?los requisitos')}|${word('usted|tú|su hogar|su familia')}\\s+${word('califica|calificará|es elegible|será elegible|reúne los requisitos|cumple (?:con )?los requisitos|está aprobad[oa]|será aprobad[oa]')}`, 'iu'),
      condition: new RegExp(word('si|cuando|solo|sólo|puede|pueden|podría|debe|deben|depende|siempre que|a menos que'), 'iu') }
  });
  const verdict = (point, language) => VERDICTS[language].claim.test(point) && !VERDICTS[language].condition.test(point);
  const BULLET = /^\s*(?:[*•‣◦\-–—]|\d{1,2}[.)])\s*/;

  // Splits text Chrome can't take in one go at the line, else the sentence, else the space nearest
  // its middle, until every piece fits.
  async function pieces(text, fits) {
    if (await fits(text)) return [text];
    if (text.length < 2) throw new Error('Chrome’s summarizer has no room for this page’s text: its input quota is too small.');
    const at = middleBreak(text);
    return [...await pieces(text.slice(0, at).trim(), fits), ...await pieces(text.slice(at).trim(), fits)];
  }
  function middleBreak(text) {
    const middle = text.length / 2;
    for (const pattern of [/\n/g, /[.!?。！？]\s/g, /\s/g]) {
      let best = -1;
      for (const match of text.matchAll(pattern)) {
        const at = match.index + match[0].length;
        if (at < text.length && (best < 0 || Math.abs(at - middle) < Math.abs(best - middle))) best = at;
      }
      if (best > 0) return best;
    }
    return Math.floor(middle);
  }
  // Chrome's plain-text key points, one per line, as plain sentences.
  function parse(output, language) {
    if (typeof output !== 'string') throw new Error('Chrome’s summarizer returned something other than text.');
    return output.split('\n').map(line => line.replace(BULLET, '').trim()).filter(line => line && !verdict(line, language)).slice(0, MAX_POINTS);
  }

  function create(scope = root, { stallMs = STALL_MS } = {}) {
    const summarizers = new Map(); // "es<en" -> Promise of Chrome's summarizer writing Spanish about an English page
    const languages = new WeakMap(); // summarizer -> the language it writes
    const points = new Map(); // "es\ntext" -> Promise of the points for that text
    const options = (output, input) => ({ ...OPTIONS, outputLanguage: output, ...(input ? { expectedInputLanguages: [input] } : {}) });
    const availability = (output, input) => scope.Summarizer.availability(options(output, input));

    return {
      // An explicit check for the API itself: when it is missing, the panel shows one plain line.
      supported: () => typeof scope.Summarizer !== 'undefined',
      availability,

      // The applicant's language when Chrome can write it and SecondHand can check it; else English,
      // which the side panel translates or says plainly.
      async outputLanguage(chosen, input) {
        if (chosen === 'en' || !Object.hasOwn(VERDICTS, chosen)) return 'en';
        return await availability(chosen, input) === 'unavailable' ? 'en' : chosen;
      },

      // One summarizer per pair of languages. When Chrome must download its model, call this from the
      // applicant's click: Chrome requires it. A download that never starts is reported, not hidden.
      summarizer(output, input, { onProgress = () => {}, onStall = () => {} } = {}) {
        if (!Object.hasOwn(VERDICTS, output)) return Promise.reject(new Error(`SecondHand can’t check key points written in ${output}.`));
        const pair = `${output}<${input}`;
        if (!summarizers.has(pair)) {
          let timer = setTimeout(onStall, stallMs);
          const created = scope.Summarizer.create({ ...options(output, input), sharedContext: CONTEXT, monitor(monitor) {
            monitor.addEventListener('downloadprogress', event => {
              clearTimeout(timer);
              onProgress(event.loaded);
              if (event.loaded < 1) timer = setTimeout(onStall, stallMs);
            });
          } }).finally(() => clearTimeout(timer)).then(summarizer => { languages.set(summarizer, output); return summarizer; });
          // A failed attempt is not kept, so the next click tries again; the caller still gets the error.
          summarizers.set(pair, created.catch(error => { summarizers.delete(pair); throw error; }));
        }
        return summarizers.get(pair);
      },

      // Up to five key points for a page's text, each text once per language. Text longer than
      // Chrome's input quota is summarized in pieces, and the pieces' points summarized again.
      points(summarizer, text) {
        const language = languages.get(summarizer);
        const key = `${language}\n${text}`;
        if (!points.has(key)) {
          const fits = async piece => await summarizer.measureInputUsage(piece) <= summarizer.inputQuota;
          const written = (async () => {
            let input = text;
            for (let round = 0; round < MAX_ROUNDS; round++) {
              const parts = await pieces(input, fits);
              const outputs = [];
              for (const part of parts) {
                const output = await summarizer.summarize(part);
                if (typeof output !== 'string') throw new Error('Chrome’s summarizer returned something other than text.');
                outputs.push(output);
              }
              if (outputs.length === 1) return parse(outputs[0], language);
              input = outputs.join('\n');
            }
            throw new Error('This page is too long for Chrome’s summarizer.');
          })();
          points.set(key, written.catch(error => { points.delete(key); throw error; }));
        }
        return points.get(key);
      }
    };
  }

  const api = Object.freeze({ create, pieces, CONTEXT });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandSummary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
