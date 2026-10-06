import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import './support/app-modules.ts';
import { env } from './support/cloudflare-workers.ts';
import { MemoryBucket } from './support/memory-bucket.ts';
import { filenames, objectKey, PART_BYTES } from '../lib/downloads.ts';

// Loaded after the hooks above, so `cloudflare:workers` is the stand-in env.
const downloadRoute = await import('../app/download/[file]/route.ts');
const publishRoute = await import('../app/api/publish/[file]/route.ts');

// A stand-in credential; the real one lives only in the hosting secret.
const token = 'stand-in-upload-token-for-route-tests-only';
const site = 'https://site.test';
const installer = filenames[0];
let bucket: MemoryBucket;

beforeEach(() => {
  bucket = new MemoryBucket();
  env.FILES = bucket.binding;
  env.RELEASE_UPLOAD_TOKEN = token;
});

const context = (file: string) => ({ params: Promise.resolve({ file }) });
const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function download(file: string, init: RequestInit = {}) {
  const request = new Request(`${site}/download/${file}`, init);
  return downloadRoute.GET(request, context(file));
}

// Sends what the publisher sends: the bearer token, an action, and the
// content-length header an HTTP client adds to a request with a body.
function publish(
  method: 'POST' | 'PUT' | 'DELETE',
  query: Record<string, string>,
  {
    body,
    headers = {},
    credential = token,
  }: {
    body?: Uint8Array<ArrayBuffer> | string;
    headers?: Record<string, string>;
    credential?: string;
  } = {},
  file: string = installer,
) {
  const url = `${site}/api/publish/${file}?${new URLSearchParams(query)}`;
  const length =
    typeof body === 'string'
      ? Buffer.byteLength(body)
      : (body?.byteLength ?? 0);
  const request = new Request(url, {
    method,
    body,
    headers: {
      authorization: `Bearer ${credential}`,
      'content-length': String(length),
      ...headers,
    },
  });
  return publishRoute[method](request, context(file));
}

async function create(
  bytes: Uint8Array<ArrayBuffer>,
  declaredSize = bytes.length,
) {
  const response = await publish(
    'POST',
    { action: 'create' },
    {
      headers: {
        'x-checksum-sha256': sha256(bytes),
        'x-file-size': String(declaredSize),
      },
    },
  );
  assert.equal(response.status, 200);
  const { uploadId } = (await response.json()) as { uploadId: string };
  return uploadId;
}

async function uploadParts(uploadId: string, bytes: Uint8Array<ArrayBuffer>) {
  const parts = [];
  for (
    let offset = 0, partNumber = 1;
    offset < bytes.length;
    offset += PART_BYTES, partNumber++
  ) {
    const body = bytes.subarray(offset, offset + PART_BYTES);
    const response = await publish(
      'PUT',
      { action: 'part', uploadId, partNumber: String(partNumber) },
      { body },
    );
    assert.equal(response.status, 200);
    parts.push(await response.json());
  }
  return parts;
}

function complete(uploadId: string, parts: unknown[]) {
  return publish(
    'POST',
    { action: 'complete', uploadId },
    { body: JSON.stringify({ parts }) },
  );
}

void test('the download route answers only GET and HEAD, with the same handler', () => {
  assert.deepEqual(Object.keys(downloadRoute).sort(), ['GET', 'HEAD']);
  assert.equal(downloadRoute.HEAD, downloadRoute.GET);
});

void test('the publish route answers only POST, PUT and DELETE, so it cannot be browsed', () => {
  assert.deepEqual(Object.keys(publishRoute).sort(), ['DELETE', 'POST', 'PUT']);
  assert.equal(publishRoute.PUT, publishRoute.POST);
  assert.equal(publishRoute.DELETE, publishRoute.POST);
});

void test('the download route serves the requested file from the FILES binding', async () => {
  const bytes = new TextEncoder().encode('installer bytes');
  bucket.store(objectKey(installer), bytes, { sha256: sha256(bytes) });
  const response = await download(installer);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-disposition'),
    `attachment; filename="${installer}"`,
  );
  assert.equal(response.headers.get('x-checksum-sha256'), sha256(bytes));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.deepEqual(bucket.lookups, [
    objectKey(installer),
    objectKey(installer),
  ]);

  const head = await downloadRoute.HEAD(
    new Request(`${site}/download/${installer}`, { method: 'HEAD' }),
    context(installer),
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
});

void test('the download route refuses files outside the release list without reading the bucket', async () => {
  for (const file of [
    'vault.json',
    '../SHA256SUMS.txt',
    'SHA256SUMS.txt/..',
    '.env',
  ]) {
    assert.equal((await download(file)).status, 404, file);
  }
  assert.deepEqual(bucket.lookups, []);
});

void test('the download route says when a release file is not uploaded yet', async () => {
  const response = await download(installer);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

void test('the publish route is closed when the upload token is missing or short', async () => {
  for (const configured of [undefined, '', 'too-short-for-a-token']) {
    env.RELEASE_UPLOAD_TOKEN = configured;
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const response = await publish(
        method,
        { action: 'create' },
        { credential: configured ?? 'undefined' },
      );
      assert.equal(response.status, 404, `${method} with token ${configured}`);
    }
  }
  assert.deepEqual(bucket.lookups, []);
  assert.equal(bucket.uploads.size, 0);
});

void test('the publish route checks the bearer against the token in the environment', async () => {
  const bytes = new TextEncoder().encode('release');
  const headers = {
    'x-checksum-sha256': sha256(bytes),
    'x-file-size': String(bytes.length),
  };
  assert.equal(
    (
      await publish(
        'POST',
        { action: 'create' },
        { headers, credential: `${token}-wrong` },
      )
    ).status,
    404,
  );
  assert.equal(
    (await publish('POST', { action: 'create' }, { headers, credential: '' }))
      .status,
    404,
  );
  assert.equal(bucket.uploads.size, 0);
  assert.equal(typeof (await create(bytes)), 'string');
  assert.equal(bucket.uploads.size, 1);
});

void test('a file uploaded in parts through the publish route downloads intact', async () => {
  const bytes = new Uint8Array(PART_BYTES + 3).map((_, i) => i % 251);
  const uploadId = await create(bytes);
  const parts = await uploadParts(uploadId, bytes);
  assert.equal(parts.length, 2);
  const completed = await complete(uploadId, parts);
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), {
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(bucket.uploads.size, 0);

  const response = await download(installer);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-checksum-sha256'), sha256(bytes));
  assert.equal(
    sha256(new Uint8Array(await response.arrayBuffer())),
    sha256(bytes),
  );

  const again = await publish(
    'POST',
    { action: 'create' },
    {
      headers: {
        'x-checksum-sha256': sha256(bytes),
        'x-file-size': String(bytes.length),
      },
    },
  );
  assert.equal(again.status, 409, 'Published files cannot be replaced');
});

void test('an upload whose bytes differ from the declared size is removed', async () => {
  const bytes = new TextEncoder().encode('nine byte');
  const uploadId = await create(bytes, bytes.length + 1);
  const response = await complete(uploadId, await uploadParts(uploadId, bytes));
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'Size mismatch.');
  assert.equal(bucket.objects.size, 0);
  assert.equal((await download(installer)).status, 503);
});

void test('an aborted upload leaves nothing behind and takes no more parts', async () => {
  const bytes = new TextEncoder().encode('release');
  const uploadId = await create(bytes);
  const aborted = await publish('DELETE', { action: 'abort', uploadId });
  assert.equal(aborted.status, 204);
  assert.equal(bucket.uploads.size, 0);
  const part = await publish(
    'PUT',
    { action: 'part', uploadId, partNumber: '1' },
    { body: bytes },
  );
  assert.equal(part.status, 400);
  assert.equal(bucket.objects.size, 0);
});
