'use strict';

const LIMITS = Object.freeze({ fileBytes: 30 * 1024 * 1024, pages: 12, pagePixels: 16_000_000,
  imagePixels: 40_000_000, dimension: 20000, textPerPage: 200000, wordsPerPage: 12000,
  totalText: 500000, totalWords: 80000, timeoutMs: 5 * 60 * 1000 });
const ERRORS = Object.freeze({
  CANCELLED: 'Document reading was cancelled.', BUSY: 'Another document is being read. Cancel it first.',
  LOCKED: 'Unlock SecondHand before reading a document.', INVALID_REQUEST: 'The document request is invalid.',
  FILE_SIZE: 'Choose a document no larger than 30 MiB.', FILE_TYPE: 'Choose a PDF, PNG, or JPEG document.',
  IMAGE_SIZE: 'This image is too large to read safely. Use an image no larger than 40 megapixels.',
  PAGE_LIMIT: 'This PDF has too many pages. Choose a PDF with 12 pages or fewer.',
  PASSWORD: 'This PDF is password protected. Choose an unlocked copy.',
  OUTPUT_LIMIT: 'This document contains too much text to read at once. Choose fewer pages.',
  TIMEOUT: 'Document reading took too long. Try fewer pages or a smaller image.',
  ASSETS: 'The local document reader is unavailable. Reinstall SecondHand and try again.',
  READ_FAILED: 'The document could not be read. Check that it is a valid PDF, PNG, or JPEG and try again.'
});
function fault(code) { return Object.assign(new Error(ERRORS[code] || ERRORS.READ_FAILED), { code: Object.hasOwn(ERRORS, code) ? code : 'READ_FAILED', publicMessage: ERRORS[code] || ERRORS.READ_FAILED }); }
function requestId(value) { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw fault('INVALID_REQUEST'); return value; }
function imageSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > LIMITS.dimension || height > LIMITS.dimension || width * height > LIMITS.imagePixels) throw fault('IMAGE_SIZE');
  return { width, height };
}
function documentKind(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) throw fault('FILE_TYPE');
  if (bytes.length > LIMITS.fileBytes) throw fault('FILE_SIZE');
  // Tolerate a short BOM/whitespace prefix used by some PDF generators.
  if (/^\s*%PDF-/.test(bytes.subarray(0, 1024).toString('latin1'))) return { kind: 'pdf' };
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { kind: 'png', ...imageSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) break;
        return { kind: 'jpeg', ...imageSize(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)) };
      }
      offset += length;
    }
  }
  throw fault('FILE_TYPE');
}
function progress(value) {
  if (!value || !['loading', 'rendering', 'recognizing'].includes(value.phase) || !Number.isInteger(value.page) ||
      !Number.isInteger(value.total) || value.page < 0 || value.total < 0 || value.page > value.total || value.total > LIMITS.pages) return null;
  return { phase: value.phase, page: value.page, total: value.total };
}
function validatePages(value) {
  if (!value || !Array.isArray(value.pages) || !value.pages.length || value.pages.length > LIMITS.pages || value.pageCount !== value.pages.length) throw fault('READ_FAILED');
  let textCount = 0, wordCount = 0;
  const confidence = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
  function recognition(result, width, height) {
    if (!result || typeof result.text !== 'string' || result.text.length > LIMITS.textPerPage || !confidence(result.confidence) ||
        !Array.isArray(result.words) || result.words.length > LIMITS.wordsPerPage) throw fault('OUTPUT_LIMIT');
    textCount += result.text.length; wordCount += result.words.length;
    if (textCount > LIMITS.totalText || wordCount > LIMITS.totalWords) throw fault('OUTPUT_LIMIT');
    let wordCharacters = 0;
    const words = result.words.map(word => {
      const b = word?.bbox;
      if (!word || typeof word.text !== 'string' || word.text.length > 1000 || !confidence(word.confidence) || !b ||
          !['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(b[key])) || b.x0 < 0 || b.y0 < 0 || b.x1 < b.x0 || b.y1 < b.y0 || b.x1 > width || b.y1 > height) throw fault('OUTPUT_LIMIT');
      wordCharacters += word.text.length;
      if (wordCharacters > LIMITS.textPerPage) throw fault('OUTPUT_LIMIT');
      return { text: word.text, confidence: word.confidence, bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } };
    });
    return { text: result.text, confidence: result.confidence, words };
  }
  const pages = value.pages.map((page, index) => {
    if (page.pageNumber !== index + 1 || !Number.isInteger(page.width) || !Number.isInteger(page.height) || page.width < 1 || page.height < 1 ||
        page.width > LIMITS.dimension || page.height > LIMITS.dimension || page.width * page.height > LIMITS.pagePixels) throw fault('OUTPUT_LIMIT');
    return { pageNumber: page.pageNumber, ...recognition(page, page.width, page.height), width: page.width, height: page.height,
      ...(page.alternative === undefined ? {} : { alternative: recognition(page.alternative, page.width, page.height) }) };
  });
  return { pageCount: pages.length, pages };
}
module.exports = { LIMITS, ERRORS, fault, requestId, documentKind, progress, validatePages };
