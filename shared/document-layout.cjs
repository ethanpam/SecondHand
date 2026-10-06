'use strict';

// Shared positioned-OCR helpers. Values are selected from bounded cells, never a document-wide number search.
const normalize = text => String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
const centerY = word => (word.bbox.y0 + word.bbox.y1) / 2;
const centerX = word => (word.bbox.x0 + word.bbox.x1) / 2;
const phrase = text => text.split(/\s+/).map(normalize);
const meanConfidence = words => Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / (words.length || 1));
const content = words => words.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0).map(word => word.text).join(' ').trim();
const wordHeight = word => word.bbox.y1 - word.bbox.y0;
const medianHeight = words => words.map(wordHeight).sort((a, b) => a - b)[Math.floor(words.length / 2)];
const inside = (mark, word) => word.bbox.x0 <= mark.bbox.x0 && mark.bbox.x1 <= word.bbox.x1 && word.bbox.y0 <= mark.bbox.y0 && mark.bbox.y1 <= word.bbox.y1;

// OCR can report a mark it split off a word, such as the dot of an i, as its
// own tiny word inside that word's box. It is part of the word already read,
// not separate text. Ordered by position, it would break a printed label or
// join a value. Only marks far shorter than this page's text are dropped.
function withoutSplitMarks(words) {
  const typical = medianHeight(words) || 0;
  const tiny = word => wordHeight(word) * 3 <= typical;
  const text = words.filter(word => !tiny(word));
  return words.filter(mark => !tiny(mark) || !text.some(word => inside(mark, word)));
}

function wordRows(page) {
  const width = Number(page.width), height = Number(page.height);
  if (!(width > 0 && height > 0) || !Array.isArray(page.words)) return [];
  const words = withoutSplitMarks(page.words.slice(0, 12000).filter(word => typeof word?.text === 'string' && word.text.trim() && word.text.length <= 250 &&
    Number.isFinite(word.confidence) && word.confidence >= 0 && word.confidence <= 100 && word.bbox &&
    ['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(word.bbox[key])) &&
    word.bbox.x0 >= 0 && word.bbox.y0 >= 0 && word.bbox.x1 <= width && word.bbox.y1 <= height &&
    word.bbox.x1 > word.bbox.x0 && word.bbox.y1 > word.bbox.y0)
    .map(word => ({ ...word, text: word.text.trim() })));
  const tolerance = Math.max(2, (medianHeight(words) || 10) * 0.5);
  const rows = [];
  for (const word of words.sort((a, b) => centerY(a) - centerY(b))) {
    const recent = rows[rows.length - 1];
    if (recent && Math.abs(centerY(word) - recent.y) <= tolerance) {
      recent.words.push(word);
      recent.y = recent.words.reduce((sum, item) => sum + centerY(item), 0) / recent.words.length;
    } else rows.push({ y: centerY(word), words: [word] });
  }
  for (const row of rows) {
    row.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    row.text = content(row.words);
  }
  return rows;
}

function matches(rows, label) {
  const wanted = phrase(label).join(''), found = [];
  for (const row of rows) for (let index = 0; index < row.words.length; index++) {
    if (!normalize(row.words[index].text)) continue;
    let joined = '';
    for (let end = index; end < Math.min(row.words.length, index + 20); end++) {
      joined += normalize(row.words[end].text);
      if (!wanted.startsWith(joined)) break;
      if (joined !== wanted) continue;
      const words = row.words.slice(index, end + 1);
      found.push({ row, words, x0: words[0].bbox.x0, x1: words.at(-1).bbox.x1,
        y0: Math.min(...words.map(word => word.bbox.y0)), y1: Math.max(...words.map(word => word.bbox.y1)) });
      break;
    }
  }
  return found;
}

function afterLabel(rows, anchor, next, x0, x1) {
  // The next header's columns can have slightly different vertical bounds.
  // Stop at its entire row so a short word in an adjacent label cannot become
  // part of the preceding cell (especially the taxpayer's SSN).
  const bottom = next && Math.min(...next.row.words.map(word => word.bbox.y0));
  if (!anchor || !next || bottom <= anchor.y1 || !(x1 > x0)) return [];
  // One value row in a bounded cell only. Never search farther down the page
  // when a primary value is blank (a spouse/dependent could be there).
  const candidates = rows.map(row => row.words.filter(word => centerY(word) > anchor.y1 && centerY(word) < bottom &&
    centerX(word) >= x0 && centerX(word) < x1)).filter(words => words.length);
  return candidates.length === 1 ? candidates[0] : [];
}

function money(raw) {
  const value = raw.trim().replace(/\s+/g, '').replace(/^\$/, '');
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.\d{2})?$/.test(value)) return null;
  return value.replace(/,/g, '');
}

module.exports = { wordRows, matches, content, afterLabel, money, normalize, centerX, centerY, meanConfidence };
