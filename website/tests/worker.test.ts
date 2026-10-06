import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import './support/app-modules.ts';
import { MemoryBucket } from './support/memory-bucket.ts';
import { filenames, LATEST_RELEASE, objectKey } from '../lib/downloads.ts';

// The Worker entry imports vinext's handler, which only exists in a vinext
// build. Tests load the stand-in instead.
const standIn = new URL('./support/vinext-handler.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vinext/server/fetch-handler')
      return { url: standIn, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { default: worker } = await import('../worker.ts');
const { handled } = await import('./support/vinext-handler.ts');

const installer = filenames[0];
const bytes = new TextEncoder().encode('installer bytes');
let bucket: MemoryBucket;

beforeEach(() => {
  bucket = new MemoryBucket();
  bucket.store(objectKey(installer, LATEST_RELEASE), bytes);
  handled.length = 0;
});

function send(path: string, init: RequestInit = {}) {
  const request = new Request(`https://site.test${path}`, init);
  return worker.fetch(
    request,
    { FILES: bucket.binding },
    {} as ExecutionContext,
  );
}

void test('installer downloads come straight from R2 with their length, without vinext', async () => {
  const response = await send(`/download/${installer}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const head = await send(`/download/${installer}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  const range = await send(`/download/${installer}`, {
    headers: { range: 'bytes=0-8' },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'installer');
  assert.equal(handled.length, 0);
});

void test('unknown download names are refused by the download code, not served as pages', async () => {
  assert.equal((await send('/download/vault.json')).status, 404);
  assert.equal(handled.length, 0);
});

void test('pages, other methods, nested paths, and broken escapes go to vinext', async () => {
  for (const [path, init] of [
    ['/', {}],
    ['/faq', {}],
    [`/download/${installer}`, { method: 'POST' }],
    ['/download/a/b', {}],
    ['/download/%E0%A4%A', {}],
    ['/downloads/x', {}],
  ] as const) {
    const response = await send(path, init);
    assert.equal(await response.text(), 'page from vinext', path);
  }
  assert.equal(handled.length, 6);
});
