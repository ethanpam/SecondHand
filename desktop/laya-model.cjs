'use strict';

// The Laya model files: an opt-in download pinned by desktop/laya-model.json, stored under
// userData at models/laya/<revision>/ and never bundled with the app. Nothing is used until every
// file matches its pinned size and hash. The manifest is { "version": 1, "model": null } until a
// model is published, then:
//   { "version": 1, "model": { "revision": "<40-hex commit>", "files": [
//     { "path": "model.onnx", "url": "https://huggingface.co/<repo>/resolve/<revision>/model.onnx", "size": <bytes>, "sha256": "<hex>" }, … ] } }
// listing every path in MODEL_FILES.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const MODEL_FILES = Object.freeze(['model.onnx', 'model.onnx.data', 'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json', 'rl_agent_config.json']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DISK_ERRORS = new Set(['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EISDIR', 'ENOTDIR']);
const STALL_MS = 30000;
const MAX_REDIRECTS = 5;

class DownloadError extends Error {
  constructor(message) { super(message); this.publicMessage = message; }
}
const incomplete = () => new DownloadError('The Laya model download was incomplete, so SecondHand deleted it. Try again.');

// https, or http to this computer (which never leaves it). The pinned SHA-256 decides what is kept.
function allowedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)));
}

function validateManifest(manifest) {
  const fail = detail => { throw new Error(`The Laya model manifest is invalid: ${detail}.`); };
  if (!manifest || manifest.version !== 1) fail('it must be version 1');
  if (!Object.hasOwn(manifest, 'model')) fail('it needs a model entry, or null when no model is published');
  if (manifest.model === null) return { model: null };
  const { revision, files } = manifest.model;
  if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision)) fail('the revision must be a 40-character commit hash');
  if (!Array.isArray(files)) fail('it must list its files');
  const seen = new Set();
  for (const file of files) {
    if (!MODEL_FILES.includes(file?.path)) fail(`${JSON.stringify(file?.path)} is not a Laya model file path`);
    if (seen.has(file.path)) fail(`${file.path} must be listed once`);
    seen.add(file.path);
    if (typeof file.url !== 'string' || !URL.canParse(file.url)) fail(`${file.path} has no valid URL`);
    const { username, password } = new URL(file.url);
    if (username || password) fail(`${file.path} must not carry credentials in its URL`);
    if (!allowedUrl(file.url)) fail(`${file.path} must be downloaded over https`);
    if (!Number.isSafeInteger(file.size) || file.size <= 0) fail(`${file.path} needs its size in bytes`);
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) fail(`${file.path} needs its SHA-256`);
  }
  const missing = MODEL_FILES.filter(name => !seen.has(name));
  if (missing.length) fail(`it must list ${missing.join(', ')}`);
  const ordered = MODEL_FILES.map(name => files.find(file => file.path === name));
  return { model: Object.freeze({ revision, files: ordered.map(file => Object.freeze({ ...file })), sizeBytes: ordered.reduce((sum, file) => sum + file.size, 0) }) };
}

async function sizeOf(file) {
  try { return (await fs.stat(file)).size; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function sha256Of(file, end) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file, end === undefined ? {} : { end })) hash.update(chunk);
  return hash;
}

// GET that follows redirects (Hugging Face sends files from a CDN) to allowed URLs only.
function get(url, headers, signal, redirects = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(target, { headers: { 'User-Agent': 'SecondHand', ...headers }, signal, timeout: STALL_MS }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, target).href;
        if (!redirects || !allowedUrl(next)) { reject(new DownloadError('The Laya model download was redirected somewhere SecondHand doesn’t trust. Try again later.')); return; }
        resolve(get(next, headers, signal, redirects - 1));
        return;
      }
      resolve(response);
    });
    request.on('timeout', () => request.destroy(new DownloadError('The Laya model download stopped responding. Try again.')));
    request.on('error', error => reject(error instanceof DownloadError || signal.aborted ? error :
      new DownloadError(`The Laya model couldn’t be downloaded (${error.code || error.message}). Check the internet connection and try again.`)));
  });
}

class ModelStore {
  constructor({ userDataDir, model }) {
    this.model = model;
    this.root = path.join(userDataDir, 'models', 'laya');
    this.directory = path.join(this.root, model.revision);
    this.active = null;
    this.failure = null;
    this.received = 0;
  }

  get sizeBytes() { return this.model.sizeBytes; }

  async state() {
    if (this.active) return { state: 'downloading', progress: this.received / this.sizeBytes };
    if (this.failure) return { state: 'error', message: this.failure };
    let stored = 0;
    let complete = true;
    for (const file of this.model.files) {
      const target = path.join(this.directory, file.path);
      const size = await sizeOf(target);
      if (size === file.size) { stored += size; continue; }
      complete = false;
      const partial = await sizeOf(`${target}.partial`);
      if (partial !== null && partial < file.size) stored += partial;
    }
    return complete ? { state: 'ready' } : { state: 'not-downloaded', progress: stored / this.sizeBytes };
  }

  // Starts (or resumes) the download. The promise settles when it stops; a failure is kept
  // for state() with a message for the person, and the bad file is deleted.
  startDownload() {
    if (this.active) return this.active.promise;
    const controller = new AbortController();
    this.failure = null;
    this.received = 0;
    const promise = this.download(controller.signal).catch(error => {
      if (controller.signal.aborted) return;
      this.failure = error.publicMessage || `The Laya model couldn’t be downloaded (${error.code || error.message}).`;
    }).finally(() => { this.active = null; });
    this.active = { controller, promise };
    return promise;
  }

  async cancel() {
    if (!this.active) return;
    const { controller, promise } = this.active;
    controller.abort();
    await promise;
  }

  async remove() {
    await this.cancel();
    this.failure = null;
    await fs.rm(this.root, { recursive: true, force: true });
  }

  // Checks every file against its pinned size and SHA-256 before the model is used.
  async verify() {
    for (const file of this.model.files) {
      const target = path.join(this.directory, file.path);
      if (await sizeOf(target) !== file.size || (await sha256Of(target)).digest('hex') !== file.sha256) {
        await fs.rm(this.directory, { recursive: true, force: true });
        this.failure = 'The Laya model files on this computer were changed or damaged, so SecondHand deleted them. Download the model again.';
        throw new DownloadError(this.failure);
      }
    }
    return this.directory;
  }

  async download(signal) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of this.model.files) {
      const target = path.join(this.directory, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const existing = await sizeOf(target);
      if (existing === file.size) { this.received += file.size; continue; }
      if (existing !== null) await fs.rm(target, { force: true });
      await this.downloadFile(file, target, signal);
    }
    // Only the pinned revision is kept; an older one is replaced once the new one is complete.
    for (const entry of await fs.readdir(this.root)) {
      if (entry !== this.model.revision) await fs.rm(path.join(this.root, entry), { recursive: true, force: true });
    }
  }

  async downloadFile(file, target, signal) {
    const partial = `${target}.partial`;
    let offset = await sizeOf(partial) ?? 0;
    if (offset >= file.size) { await fs.rm(partial, { force: true }); offset = 0; }
    let hash = offset ? await sha256Of(partial, offset - 1) : crypto.createHash('sha256');
    this.received += offset;
    const response = await get(file.url, offset ? { Range: `bytes=${offset}-` } : {}, signal);
    if (response.statusCode === 200 && offset) {
      // The server sent the whole file instead of the rest: start this file again.
      this.received -= offset;
      offset = 0;
      hash = crypto.createHash('sha256');
    } else if (response.statusCode === 206) {
      if (!offset || !new RegExp(`^bytes ${offset}-`).test(response.headers['content-range'] || '')) {
        response.resume();
        await fs.rm(partial, { force: true });
        throw incomplete();
      }
    } else if (response.statusCode !== 200) {
      response.resume();
      // The saved part no longer fits the file on the server: the next try starts it again.
      if (response.statusCode === 416) { await fs.rm(partial, { force: true }); throw incomplete(); }
      throw new DownloadError(`The Laya model couldn’t be downloaded (the server answered ${response.statusCode}). Try again later.`);
    }
    let bytes = offset;
    const store = this;
    try {
      await pipeline(response, async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > file.size) throw new DownloadError('The Laya model download was larger than expected, so SecondHand deleted it. Try again.');
          hash.update(chunk);
          store.received += chunk.length;
          yield chunk;
        }
      }, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal });
    } catch (error) {
      if (signal.aborted) throw error; // cancelled: keep the partial file to resume from
      await fs.rm(partial, { force: true });
      if (error instanceof DownloadError) throw error;
      if (DISK_ERRORS.has(error.code)) throw new DownloadError(`The Laya model couldn’t be saved on this computer (${error.code}). Free some space and try again.`);
      throw incomplete();
    }
    if (bytes !== file.size) { await fs.rm(partial, { force: true }); throw incomplete(); }
    if (hash.digest('hex') !== file.sha256) {
      await fs.rm(partial, { force: true });
      throw new DownloadError('The downloaded Laya model didn’t match its expected checksum, so SecondHand deleted it. Try again.');
    }
    await fs.rename(partial, target);
  }
}

module.exports = { MODEL_FILES, validateManifest, ModelStore };
