'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { LIMITS, fault, requestId } = require('./ocr-limits.cjs');

// Opens only the file the native picker returned, reads at most the hard limit,
// and does not create a copy, sidecar, cache, or document record.
async function readSelectedFile(filePath, signal) {
  const file = await fs.open(filePath, 'r');
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw fault('FILE_TYPE');
    if (stat.size < 8 || stat.size > LIMITS.fileBytes) throw fault('FILE_SIZE');
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      if (signal?.aborted) throw fault('CANCELLED');
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fault('READ_FAILED');
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await file.read(extra, 0, 1, offset)).bytesRead || (await file.stat()).mtimeMs !== stat.mtimeMs) throw fault('READ_FAILED');
    if (signal?.aborted) throw fault('CANCELLED');
    return bytes;
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await file.close(); }
}

function createDocumentReader({ chooseFile, createEngine, isUnlocked, onProgress = () => {}, analyzeDocument, readFile = readSelectedFile }) {
  let active = null;
  function cancel(id) {
    if (id !== undefined) requestId(id);
    if (active && (id === undefined || active.id === id)) {
      active.cancelled = true;
      active.controller.abort();
      active.engine?.cancel();
    }
    return true;
  }
  async function read(id) {
    requestId(id);
    if (!isUnlocked()) throw fault('LOCKED');
    if (active) throw fault('BUSY');
    const job = { id, cancelled: false, controller: new AbortController(), engine: null };
    active = job;
    let bytes;
    const guard = () => { if (active !== job || job.cancelled || !isUnlocked()) throw fault('CANCELLED'); };
    try {
      const selection = await chooseFile();
      guard();
      if (selection.canceled || !Array.isArray(selection.filePaths) || selection.filePaths.length !== 1) return { cancelled: true };
      const filePath = selection.filePaths[0];
      onProgress({ requestId: id, phase: 'loading', page: 0, total: 0 });
      bytes = await readFile(filePath, job.controller.signal);
      guard();
      job.engine = createEngine();
      const result = await job.engine.read(bytes, { signal: job.controller.signal, onProgress: value => {
        if (active === job && !job.cancelled && isUnlocked()) onProgress({ requestId: id, ...value });
      } });
      guard();
      const document = { name: path.basename(filePath).slice(0, 240), ...result };
      if (analyzeDocument) document.analysis = analyzeDocument(document);
      guard();
      return { cancelled: false, document };
    } catch (error) {
      if (job.cancelled || !isUnlocked() || error?.code === 'CANCELLED') return { cancelled: true };
      throw fault(error?.code);
    } finally {
      bytes?.fill(0);
      job.engine?.cancel();
      if (active === job) active = null;
    }
  }
  return { read, cancel, get busy() { return active !== null; } };
}
module.exports = { createDocumentReader, readSelectedFile };
