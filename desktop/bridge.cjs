'use strict';

const net = require('node:net');
const fs = require('node:fs/promises');
const { createReadStream, writeSync } = require('node:fs');
const { Writable } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { atomicWrite } = require('./vault.cjs');
const { REQUEST_FIELDS, PORTAL_URL, isPortalUrl, isHttpsSiteUrl } = require('../shared/schema.cjs');
const { TEXT_TYPES, CHOICE_TYPES } = require('../shared/laya-prompts.cjs');

const HOST_NAME = 'org.secondhand.bridge';
const MAX_MESSAGE_BYTES = 64 * 1024;
const EXTENSION_ID = /^[a-p]{32}$/;
const IOWA_NAVIGATION_URLS = new Set(['enterPersonalInfo', 'addressValidation'].map(page => `${PORTAL_URL}/applyForBenefits/${page}`));
// Questions for Laya, the desktop's local AI: text boxes to match to a saved field (#39) and
// choice questions to answer from the saved profile (#42). Labels, types, and options only.
const LAYA_REQUESTS = Object.freeze({
  suggestFields: Object.freeze({ list: 'fields', max: 40, types: TEXT_TYPES, choices: false }),
  answerFields: Object.freeze({ list: 'questions', max: 30, types: CHOICE_TYPES, choices: true })
});
const QUESTION_ID = /^(f\d{1,6}:)?[A-Za-z][A-Za-z0-9_-]{0,59}$/;
const MAX_LABEL = 200;
const MAX_OPTIONS = 30;
const MAX_OPTION = 100;
// Laya's time per Autofill click: each request carries what its click has left.
const MAX_BUDGET_MS = 3000;
// Refusals the extension acts on. Only these codes travel back with an error.
const PUBLIC_CODES = Object.freeze(['LAYA_NOT_READY']);

function isIowaNavigationAuthorization(request) {
  return request?.type === 'getFields' && Array.isArray(request.fields) && request.fields.length === 0 && IOWA_NAVIGATION_URLS.has(request.url);
}

function extensionFromOrigin(origin) {
  if (typeof origin !== 'string') return null;
  return /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin)?.[1] || null;
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (!payload.length || payload.length > MAX_MESSAGE_BYTES) throw new Error('Message exceeds the local bridge limit.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

function nativeStreams() {
  // Electron intentionally replaces process.stdin with an EOF-only stream on
  // Windows (lib/common/init.ts). Use the inherited OS descriptors directly.
  // Raw Buffer writes also avoid console/text encoding of the binary header.
  const input = createReadStream(null, { fd: 0, autoClose: false, highWaterMark: 16384 });
  const output = new Writable({
    write(bytes, _encoding, callback) {
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(1, bytes, offset, bytes.length - offset);
          if (!written) throw new Error('Native output pipe closed.');
          offset += written;
        }
        callback();
      } catch (error) { callback(error); }
    }
  });
  return { input, output };
}

class FrameReader extends EventEmitter {
  constructor() { super(); this.buffer = Buffer.alloc(0); this.failed = false; }
  push(chunk) {
    if (this.failed) return;
    try {
      // Consume chunks incrementally; one huge chunk must not bypass the frame limit.
      let offset = 0;
      while (offset < chunk.length) {
        const target = this.buffer.length < 4 ? 4 : 4 + this.buffer.readUInt32LE(0);
        const count = Math.min(target - this.buffer.length, chunk.length - offset);
        this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + count)]);
        offset += count;
        if (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE(0);
          if (size < 2 || size > MAX_MESSAGE_BYTES) throw new Error('Invalid native message length.');
          if (this.buffer.length === size + 4) {
            const message = JSON.parse(this.buffer.subarray(4).toString('utf8'));
            this.buffer = Buffer.alloc(0);
            this.emit('message', message);
          }
        }
      }
    } catch { this.failed = true; this.buffer = Buffer.alloc(0); this.emit('invalid'); }
  }
  end() {
    if (!this.failed && this.buffer.length) { this.failed = true; this.buffer = Buffer.alloc(0); this.emit('invalid'); }
  }
}

function validateFieldScope(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > REQUEST_FIELDS.length ||
      fields.some(field => typeof field !== 'string' || !REQUEST_FIELDS.includes(field)) ||
      new Set(fields).size !== fields.length) throw new Error('Invalid requested profile fields.');
  return fields;
}

const questionText = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
function validateQuestions(items, { max, types, choices }) {
  if (!Array.isArray(items) || !items.length || items.length > max) throw new Error('Invalid questions for Laya.');
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid question for Laya.');
    if (Object.keys(item).some(key => !['id', 'label', 'type', 'options'].includes(key))) throw new Error('Unexpected question field.');
    if (typeof item.id !== 'string' || !QUESTION_ID.test(item.id) || ids.has(item.id)) throw new Error('Invalid question id.');
    ids.add(item.id);
    if (!questionText(item.label, MAX_LABEL)) throw new Error('Invalid question label.');
    if (!types.includes(item.type)) throw new Error('Unsupported question type for Laya.');
    if (!Array.isArray(item.options) || item.options.length > MAX_OPTIONS || item.options.some(option => !questionText(option, MAX_OPTION)) ||
        new Set(item.options).size !== item.options.length || (choices && !item.options.length)) throw new Error('Invalid question options.');
  }
  return items;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(request.id)) throw new Error('Invalid request identifier.');
  let allowed;
  if (request.type === 'status' || request.type === 'showApp' || request.type === 'warmLaya') allowed = ['id', 'type'];
  else if (request.type === 'getFields') allowed = ['id', 'type', 'url', 'fields'];
  else if (request.type === 'trustSite') allowed = ['id', 'type', 'url'];
  else if (request.type === 'recordProgress') allowed = ['id', 'type', 'url', 'filledCount'];
  else if (Object.hasOwn(LAYA_REQUESTS, request.type)) allowed = ['id', 'type', 'url', LAYA_REQUESTS[request.type].list, 'budgetMs'];
  else throw new Error('Unsupported bridge request.');
  if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error('Unexpected request field.');
  // Field requests, site trust, and Laya may name any HTTPS site; the desktop decides whether it is trusted.
  if (request.type === 'getFields' || request.type === 'trustSite' || Object.hasOwn(LAYA_REQUESTS, request.type)) {
    if (!isHttpsSiteUrl(request.url)) throw new Error('Only an https site without credentials or a custom port is allowed.');
  } else if (!['status', 'showApp', 'warmLaya'].includes(request.type) && !isPortalUrl(request.url)) throw new Error('Only the supported Iowa portal is allowed.');
  if (request.type === 'getFields' && !isIowaNavigationAuthorization(request)) validateFieldScope(request.fields);
  if (Object.hasOwn(LAYA_REQUESTS, request.type)) {
    validateQuestions(request[LAYA_REQUESTS[request.type].list], LAYA_REQUESTS[request.type]);
    if (!Number.isInteger(request.budgetMs) || request.budgetMs < 1 || request.budgetMs > MAX_BUDGET_MS) throw new Error('Invalid time budget for Laya.');
  }
  if (request.type === 'recordProgress' && (!Number.isInteger(request.filledCount) || request.filledCount < 1 || request.filledCount > 100)) {
    throw new Error('Invalid filled field count.');
  }
  return request;
}

function failure(id, message, code) {
  return { id: typeof id === 'string' && id.length <= 64 ? id : '', ok: false, error: message, ...(PUBLIC_CODES.includes(code) ? { code } : {}) };
}

async function startBridge(userData, getExtensionId, handleRequest) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(userData).digest('hex').slice(0, 24);
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\secondhand-${hash}` :
    path.join(os.tmpdir(), `secondhand-${process.getuid?.() || 0}-${hash}.sock`);
  const sessionPath = path.join(userData, 'bridge-session.json');
  const sockets = new Set();
  if (process.platform !== 'win32') await fs.unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const server = net.createServer(socket => {
    if (sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(120000, () => socket.destroy());
    const reader = new FrameReader();
    let seen = false;
    reader.on('invalid', () => socket.destroy());
    reader.on('message', async envelope => {
      if (seen) { socket.destroy(); return; }
      seen = true;
      try {
        if (!envelope || typeof envelope.token !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.token) ||
            !crypto.timingSafeEqual(Buffer.from(envelope.token), Buffer.from(token)) ||
            !EXTENSION_ID.test(envelope.extensionId || '') || envelope.extensionId !== getExtensionId()) {
          socket.end(frame(failure(envelope?.request?.id, 'The extension is not connected to this desktop app.'))); return;
        }
        const request = validateRequest(envelope.request);
        const data = await handleRequest(request, Object.freeze({ extensionId: envelope.extensionId }));
        if (!socket.destroyed) socket.end(frame({ id: request.id, ok: true, data }));
      } catch (error) {
        if (!socket.destroyed) socket.end(frame(error.publicMessage ? failure(envelope?.request?.id, error.publicMessage, error.publicCode)
          : failure(envelope?.request?.id, 'The request could not be completed. Check the desktop app.')));
      }
    });
    socket.on('data', chunk => reader.push(chunk));
    socket.on('end', () => reader.end());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  if (process.platform !== 'win32') await fs.chmod(socketPath, 0o600);
  await atomicWrite(sessionPath, Buffer.from(JSON.stringify({ version: 1, socketPath, token })));
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await fs.unlink(sessionPath).catch(() => {});
      if (process.platform !== 'win32') await fs.unlink(socketPath).catch(() => {});
    }
  };
}

async function readSession(userData) {
  const sessionPath = path.join(userData, 'bridge-session.json');
  const stat = await fs.lstat(sessionPath);
  if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error('Invalid local bridge session.');
  const session = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
  if (session.version !== 1 || !/^[0-9a-f]{64}$/.test(session.token) || typeof session.socketPath !== 'string') {
    throw new Error('Invalid local bridge session.');
  }
  return session;
}

async function relayRequest(userData, extensionId, request) {
  validateRequest(request);
  if (!EXTENSION_ID.test(extensionId)) throw new Error('Invalid extension origin.');
  const session = await readSession(userData);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(session.socketPath);
    const reader = new FrameReader();
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; socket.destroy(); error ? reject(error) : resolve(value);
    };
    socket.setTimeout(125000, () => finish(new Error('Desktop request timed out.')));
    socket.on('connect', () => socket.write(frame({ token: session.token, extensionId, request })));
    socket.on('data', chunk => reader.push(chunk));
    socket.on('end', () => { reader.end(); if (!finished) finish(new Error('Desktop connection closed.')); });
    socket.on('error', error => finish(error));
    reader.on('invalid', () => finish(new Error('Invalid desktop response.')));
    reader.on('message', response => {
      if (!response || response.id !== request.id || typeof response.ok !== 'boolean') finish(new Error('Invalid desktop response.'));
      else finish(null, response);
    });
  });
}

function runNativeHost(userData, extensionId, input = process.stdin, output = process.stdout) {
  const reader = new FrameReader();
  let queue = Promise.resolve();
  let pending = 0;
  reader.on('invalid', () => { input.destroy(); });
  reader.on('message', request => {
    if (++pending > 8) { input.destroy(); return; }
    queue = queue.then(async () => {
      let response;
      try { response = await relayRequest(userData, extensionId, request); }
      catch { response = failure(request?.id, 'Open SecondHand, connect this extension, and unlock SecondHand.'); }
      if (!output.destroyed) await new Promise((resolve, reject) => {
        output.write(frame(response), error => error ? reject(error) : resolve());
      });
    }).catch(() => {}).finally(() => { pending--; });
  });
  input.on('data', chunk => reader.push(chunk));
  input.on('end', () => reader.end());
  input.on('error', () => {});
  output.on('error', () => { input.destroy(); });
  return new Promise(resolve => {
    input.on('close', () => queue.finally(resolve));
    input.on('end', () => queue.finally(resolve));
  });
}

module.exports = { HOST_NAME, EXTENSION_ID, MAX_MESSAGE_BYTES, LAYA_REQUESTS, extensionFromOrigin, frame, FrameReader, nativeStreams, isIowaNavigationAuthorization,
  validateRequest, startBridge, relayRequest, runNativeHost };
