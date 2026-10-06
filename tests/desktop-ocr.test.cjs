'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { LIMITS, documentKind, validatePages, progress } = require('../desktop/ocr-limits.cjs');
const { createDocumentReader, readSelectedFile } = require('../desktop/ocr-service.cjs');
const { assetPath, ORIGIN } = require('../desktop/ocr-engine.cjs');
const { runFile } = require('./helpers/harness.cjs');
const ID = 'b1be3de2-8bcc-4f07-94a6-f534f0b34047';
const OTHER = 'fd2bda70-5d1e-4d3c-9d34-4e7c1607f2e5';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const page = () => ({ pageCount: 1, pages: [{ pageNumber: 1, text: 'Synthetic', confidence: 90, width: 100, height: 100,
  words: [{ text: 'Synthetic', confidence: 91, bbox: { x0: 1, y0: 1, x1: 90, y1: 20 } }] }] });
const png = (width, height) => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
};

test('document sniffing bounds decoded image dimensions before browser decoding', () => {
  assert.deepEqual(documentKind(png(1200, 1600)), { kind: 'png', width: 1200, height: 1600 });
  assert.equal(documentKind(Buffer.from('%PDF-1.7\nsynthetic')).kind, 'pdf');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 8, 0x06, 0x40, 0x04, 0xb0, 1, 1, 0x11, 0]);
  assert.deepEqual(documentKind(jpeg), { kind: 'jpeg', width: 1200, height: 1600 });
  for (const bytes of [png(10000, 10000), png(0, 800), png(20001, 1)]) assert.throws(() => documentKind(bytes), { code: 'IMAGE_SIZE' });
  assert.throws(() => documentKind(Buffer.alloc(LIMITS.fileBytes + 1)), { code: 'FILE_SIZE' });
  assert.throws(() => documentKind(Buffer.from('<html>untrusted</html>')), { code: 'FILE_TYPE' });
  assert.throws(() => documentKind(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 255, 0, 0])), { code: 'FILE_TYPE' });
});

test('OCR result validation bounds pages, text, word boxes, and strips extra payloads', () => {
  const value = page(); value.pages[0].untrusted = 'not forwarded'; value.pages[0].words[0].html = '<script>';
  assert.deepEqual(validatePages(value), page());
  const alternate = page();
  alternate.pages[0].alternative = { text: 'Other segmentation', confidence: 85, words: page().pages[0].words };
  assert.deepEqual(validatePages(alternate), alternate);
  alternate.pages[0].alternative.words[0].bbox.x1 = 1001;
  assert.throws(() => validatePages(alternate), { code: 'OUTPUT_LIMIT' });
  const cases = [
    value => { value.pageCount = 2; },
    value => { value.pages[0].text = 'x'.repeat(LIMITS.textPerPage + 1); },
    value => { value.pages[0].width = 1000000; },
    value => { value.pages[0].confidence = NaN; },
    value => { value.pages[0].words[0].bbox.x1 = 1000; },
    value => { value.pages[0].words[0].bbox.x0 = 99; },
    value => { value.pages[0].words[0].confidence = Infinity; }
  ];
  for (const change of cases) { const value = page(); change(value); assert.throws(() => validatePages(value)); }
  assert.equal(progress({ phase: 'recognizing', page: 13, total: 13 }), null);
  assert.equal(progress({ phase: 'Synthetic applicant text', page: 1, total: 1 }), null);
});

test('only exact known bundled assets can be fetched in the OCR session', () => {
  const asset = { file: '/synthetic/assets/pdf.mjs' };
  const files = new Map([['/assets/pdf/pdf.mjs', asset]]);
  assert.equal(assetPath(`${ORIGIN}/assets/pdf/pdf.mjs`, files), asset);
  for (const url of ['https://example.com/assets/pdf/pdf.mjs', 'http://secondhand-ocr.invalid/assets/pdf/pdf.mjs',
    'file:///etc/passwd', `${ORIGIN}/assets/../../private`, `${ORIGIN}/assets/pdf/pdf.mjs?url=https://example.com`,
    'https://user:password@secondhand-ocr.invalid/assets/pdf/pdf.mjs']) assert.equal(assetPath(url, files), null);
});

test('selected-file reads reject oversized files without reading their body', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-ocr-file-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const name = path.join(dir, 'synthetic.pdf');
  await fs.writeFile(name, '%PDF-1.7\nsynthetic');
  const bytes = await readSelectedFile(name);
  assert.equal(bytes.toString(), '%PDF-1.7\nsynthetic');
  await fs.truncate(name, LIMITS.fileBytes + 1);
  await assert.rejects(readSelectedFile(name), { code: 'FILE_SIZE' });
  const controller = new AbortController(); controller.abort();
  await fs.truncate(name, 20);
  await assert.rejects(readSelectedFile(name, controller.signal), { code: 'CANCELLED' });
});

function reader(overrides = {}) {
  let unlocked = true, cancels = 0, reads = 0, selected = 0;
  const bytes = Buffer.from('%PDF-1.7\nsynthetic');
  const events = [];
  const instance = createDocumentReader({
    chooseFile: async () => { selected++; return { canceled: false, filePaths: ['/synthetic/Synthetic.pdf'] }; },
    isUnlocked: () => unlocked,
    onProgress: event => events.push(event),
    readFile: async () => { reads++; return bytes; },
    createEngine: () => ({ read: async () => page(), cancel: () => { cancels++; } }),
    analyzeDocument: () => ({ type: 'unknown', fields: [], warnings: [] }),
    ...overrides
  });
  return { instance, bytes, events, lock() { unlocked = false; instance.cancel(); }, get selected() { return selected; }, get reads() { return reads; }, get cancels() { return cancels; } };
}

test('the reader requires unlock and request correlation before opening the native picker', async () => {
  const fixture = reader();
  await assert.rejects(fixture.instance.read('/arbitrary/local/file'), { code: 'INVALID_REQUEST' });
  fixture.lock();
  await assert.rejects(fixture.instance.read(ID), { code: 'LOCKED' });
  assert.equal(fixture.selected, 0); assert.equal(fixture.reads, 0);
});

test('success is a transient reviewed document, never a saved profile, and source bytes are cleared', async () => {
  const fixture = reader();
  const result = await fixture.instance.read(ID);
  assert.equal(result.cancelled, false);
  assert.equal(result.document.name, 'Synthetic.pdf');
  assert.deepEqual(result.document.pages, page().pages);
  assert.equal(result.document.analysis.type, 'unknown');
  assert.ok(fixture.bytes.every(byte => byte === 0));
  assert.equal(fixture.cancels, 1);
  assert.equal(fixture.instance.busy, false);
  assert.equal(fixture.events[0].requestId, ID);
});

test('a lock while the picker is open discards its eventual selection without reading it', async () => {
  const selection = deferred();
  const fixture = reader({ chooseFile: () => selection.promise });
  const reading = fixture.instance.read(ID);
  fixture.lock();
  selection.resolve({ canceled: false, filePaths: ['/synthetic/Synthetic.pdf'] });
  assert.deepEqual(await reading, { cancelled: true });
  assert.equal(fixture.reads, 0); assert.equal(fixture.events.length, 0);
});

test('lock/cancel invalidates late OCR text and progress and does not run the parser', async () => {
  for (const lock of [false, true]) {
    const result = deferred(); let emit, parsed = 0, terminated = 0;
    const fixture = reader({ createEngine: () => ({ read: (_bytes, options) => { emit = options.onProgress; return result.promise; }, cancel: () => { terminated++; } }),
      analyzeDocument: () => { parsed++; return {}; } });
    const reading = fixture.instance.read(ID); await tick();
    await assert.rejects(fixture.instance.read(OTHER), { code: 'BUSY' });
    if (lock) fixture.lock(); else fixture.instance.cancel(ID);
    emit({ phase: 'recognizing', page: 1, total: 1 });
    result.resolve(page());
    assert.deepEqual(await reading, { cancelled: true });
    assert.equal(parsed, 0); assert.ok(terminated > 0);
    assert.equal(fixture.events.length, 1); // Initial loading event only.
    assert.ok(fixture.bytes.every(byte => byte === 0));
  }
});

test('a stale cancel request cannot stop a newer read; native picker cancellation is harmless', async () => {
  const result = deferred();
  const fixture = reader({ createEngine: () => ({ read: () => result.promise, cancel() {} }) });
  const reading = fixture.instance.read(OTHER); await tick();
  fixture.instance.cancel(ID); result.resolve(page());
  assert.equal((await reading).cancelled, false);
  const cancelled = reader({ chooseFile: async () => ({ canceled: true, filePaths: [] }) });
  assert.deepEqual(await cancelled.instance.read(ID), { cancelled: true });
  assert.equal(cancelled.reads, 0);
});

test('document errors expose a fixed safe message rather than a source path or OCR text', async () => {
  const fixture = reader({ createEngine: () => ({ read: async () => { throw new Error('/private/Synthetic Secret.pdf: applicant text'); }, cancel() {} }) });
  await assert.rejects(fixture.instance.read(ID), error => {
    assert.equal(error.code, 'READ_FAILED'); assert.doesNotMatch(error.publicMessage, /private|Secret|applicant/); return true;
  });
  assert.ok(fixture.bytes.every(byte => byte === 0));
});

test('preload exposes correlated document actions and sanitizes progress without Electron events', () => {
  let api; const listeners = new Map(), invokes = [], events = [];
  const electron = { contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer: {
    invoke: (...args) => invokes.push(args), on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); }
  } };
  runFile('desktop/preload.cjs', { require: name => { assert.equal(name, 'electron'); return electron; } });
  api.readDocument(ID); api.cancelDocumentRead(ID);
  assert.deepEqual(invokes, [['secondhand:invoke', 'readDocument', ID], ['secondhand:invoke', 'cancelDocumentRead', ID]]);
  const unsubscribe = api.onDocumentProgress(value => events.push(JSON.parse(JSON.stringify(value))));
  const listener = listeners.get('secondhand:document-progress');
  listener({ secret: true }, { requestId: ID, phase: 'recognizing', page: 1, total: 2, text: 'never forwarded' });
  listener({}, { requestId: ID, phase: 'file name', page: 1, total: 2 });
  listener({}, { requestId: ID, phase: 'loading', page: 99, total: 99 });
  listener({}, { requestId: '/private/file', phase: 'loading', page: 0, total: 0 });
  assert.deepEqual(events, [{ requestId: ID, phase: 'recognizing', page: 1, total: 2 }]);
  unsubscribe(); assert.equal(listeners.size, 0);
});
