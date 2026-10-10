import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './support/app-modules.ts';
import { env } from './support/cloudflare-workers.ts';
import { MemoryBucket } from './support/memory-bucket.ts';
import { filenames, libraryFilenames, objectKey, PART_BYTES } from '../lib/downloads.ts';

// Loaded after the hooks above, so `cloudflare:workers` is the stand-in env.
const routes = {
  download: await import('../app/download/[file]/route.ts'),
  publish: await import('../app/api/publish/[file]/route.ts'),
};

// Stand-ins: the publisher never reaches this origin, and the token is not a
// real credential. Requests go straight to the route handlers instead.
const origin = 'https://publish.test';
const token = 'stand-in-upload-token-for-publisher-tests';
const installer = filenames[0];
let runs = 0;

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

// Plays the network between scripts/publish-downloads.mjs and the site. It
// refuses any other origin, adds the content-length header an HTTP client
// would, and dispatches each request to the route vinext would.
function network(bucket: MemoryBucket, log: string[]) {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, origin, `The publisher called ${url.href}`);
    assert.equal(
      init.redirect,
      'error',
      'The publisher must not follow redirects',
    );
    const headers = new Headers(init.headers);
    const { body } = init;
    if (body !== undefined && body !== null) {
      if (typeof body !== 'string' && !(body instanceof Uint8Array))
        throw new TypeError('The publisher sent an unexpected body type');
      headers.set(
        'content-length',
        String(
          typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength,
        ),
      );
    }
    const request = new Request(url, { ...init, headers });
    const match = /^\/(download|api\/publish)\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response('Not found.', { status: 404 });
    const [, area, file] = match;
    if (area === 'download')
      assert.equal(
        headers.has('authorization'),
        false,
        'The upload token must not go to download URLs',
      );
    const route = area === 'download' ? routes.download : routes.publish;
    const handler = (
      route as Record<string, typeof routes.publish.POST | undefined>
    )[request.method];
    log.push(
      `${request.method} /${area} ${url.searchParams.get('action') ?? ''}`.trim(),
    );
    env.FILES = bucket.binding;
    if (!handler) return new Response(null, { status: 405 });
    return handler(request, {
      params: Promise.resolve({ file: decodeURIComponent(file) }),
    });
  };
}

async function releaseDirectory(t: TestContext, names: readonly string[] = filenames) {
  const directory = await mkdtemp(join(tmpdir(), 'secondhand-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new Map<string, Uint8Array>();
  for (const file of names) {
    // One installer spans two parts, so the publisher's part numbering is exercised.
    const bytes =
      file === installer
        ? new Uint8Array(PART_BYTES + 5).map((_, i) => i % 253)
        : new TextEncoder().encode(`stand-in contents of ${file}\n`);
    await writeFile(join(directory, file), bytes);
    files.set(file, bytes);
  }
  return { directory, files };
}

// Runs the maintainer's publisher against the routes, with its output captured.
async function runPublisher(
  t: TestContext,
  bucket: MemoryBucket,
  directory: string,
  library = false,
) {
  const requests: string[] = [];
  const output: string[] = [];
  t.mock.method(globalThis, 'fetch', network(bucket, requests));
  t.mock.method(console, 'log', (...args: unknown[]) =>
    output.push(args.join(' ')),
  );
  const { argv } = process;
  const accessToken = process.env.SITES_ACCESS_TOKEN;
  process.argv = [argv[0], 'publish-downloads.mjs', origin, directory, ...(library ? ['--library'] : [])];
  process.env.RELEASE_UPLOAD_TOKEN = token;
  delete process.env.SITES_ACCESS_TOKEN;
  env.RELEASE_UPLOAD_TOKEN = token;
  try {
    const script = new URL(
      `../scripts/publish-downloads.mjs?run=${++runs}`,
      import.meta.url,
    );
    await import(script.href);
    return { requests, output };
  } finally {
    process.argv = argv;
    delete process.env.RELEASE_UPLOAD_TOKEN;
    if (accessToken !== undefined) process.env.SITES_ACCESS_TOKEN = accessToken;
  }
}

void test('the publisher uploads every release file through the publish API and verifies each download', async (t) => {
  const bucket = new MemoryBucket();
  const { directory, files } = await releaseDirectory(t);
  const { requests, output } = await runPublisher(t, bucket, directory);

  for (const [file, bytes] of files) {
    assert.ok(
      output.includes(`Verified download: ${file} (${bytes.length} bytes)`),
      file,
    );
    const stored = bucket.objects.get(objectKey(file));
    assert.ok(stored, `${file} is stored under its release`);
    assert.equal(sha256(stored.bytes), sha256(bytes));
    assert.equal(stored.customMetadata.sha256, sha256(bytes));
  }
  assert.equal(bucket.objects.size, filenames.length);
  assert.equal(bucket.uploads.size, 0, 'No upload is left open');
  assert.deepEqual(requests.slice(0, 6), [
    'HEAD /download',
    'POST /api/publish create',
    'PUT /api/publish part',
    'PUT /api/publish part',
    'POST /api/publish complete',
    'GET /download',
  ]);
});

void test('a second run skips files that are already published with the same bytes', async (t) => {
  const bucket = new MemoryBucket();
  const { directory } = await releaseDirectory(t);
  await runPublisher(t, bucket, directory);
  const { requests, output } = await runPublisher(t, bucket, directory);
  assert.deepEqual(
    output,
    filenames.map((file) => `Already uploaded: ${file}`),
  );
  assert.deepEqual(
    requests,
    filenames.map(() => 'HEAD /download'),
  );
});

void test('the publisher refuses to replace a published file whose bytes changed', async (t) => {
  const bucket = new MemoryBucket();
  const { directory, files } = await releaseDirectory(t);
  await runPublisher(t, bucket, directory);
  await writeFile(join(directory, installer), 'a different build');
  await assert.rejects(
    runPublisher(t, bucket, directory),
    new RegExp(`Existing file differs: ${installer}`),
  );
  const stored = bucket.objects.get(objectKey(installer));
  const original = files.get(installer);
  assert.ok(stored && original);
  assert.equal(
    sha256(stored.bytes),
    sha256(original),
    'The published file is unchanged',
  );
});

void test('the Library publisher uploads and verifies only Library artifacts', async t => {
  const bucket = new MemoryBucket();
  const { directory, files } = await releaseDirectory(t, libraryFilenames);
  const { output } = await runPublisher(t, bucket, directory, true);
  for (const [file, bytes] of files) {
    assert.ok(output.includes(`Verified download: ${file} (${bytes.length} bytes)`));
    assert.equal(sha256(bucket.objects.get(objectKey(file))!.bytes), sha256(bytes));
  }
  assert.equal(bucket.objects.size, libraryFilenames.length);
  for (const file of filenames) assert.equal(bucket.objects.has(objectKey(file)), false);
});
