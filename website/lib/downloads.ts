// Only application distribution artifacts are stored online. No applicant data.
export const RELEASE = '0.4.0';
export const LATEST_RELEASE = '0.4.0';
const releases = ['0.2.0', '0.3.0', '0.4.0'] as const;
export const filenames = [
  `secondHand-${RELEASE}-win-x64.exe`,
  `secondHand-${RELEASE}-mac-arm64.dmg`,
  `secondHand-${RELEASE}-mac-x64.dmg`,
  'secondHand-extension.zip',
  'SHA256SUMS.txt',
] as const;
export function allowedFile(file: string) { return (filenames as readonly string[]).includes(file); }
export function objectKey(file: string, release: string = RELEASE) { return `releases/${release}/${file}`; }
function downloadRelease(request: Request, file: string) {
  const explicit = new URL(request.url).searchParams.get('release');
  if (explicit !== null && !(releases as readonly string[]).includes(explicit)) return null;
  if (file === 'secondHand-extension.zip' || file === 'SHA256SUMS.txt') return explicit ?? LATEST_RELEASE;
  for (const version of releases) {
    if ([`secondHand-${version}-win-x64.exe`, `secondHand-${version}-mac-arm64.dmg`, `secondHand-${version}-mac-x64.dmg`].includes(file)) {
      return !explicit || explicit === version ? version : null;
    }
  }
  return null;
}
export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_BYTES = 512 * 1024 * 1024;
export function contentType(file: string) {
  return file.endsWith('.txt') ? 'text/plain; charset=utf-8' : file.endsWith('.zip') ? 'application/zip' : 'application/octet-stream';
}
export function error(message: string, status: number) {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
}
export async function authorized(request: Request, secret?: string) {
  if (!secret || secret.length < 32) return false;
  const actual = request.headers.get('authorization') ?? '';
  const encode = new TextEncoder();
  const [left, right] = await Promise.all([actual, `Bearer ${secret}`].map(x => crypto.subtle.digest('SHA-256', encode.encode(x))));
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function download(request: Request, file: string, bucket: R2Bucket) {
  const release = downloadRelease(request, file);
  if (!release) return error('Download not found.', 404);
  const key = objectKey(file, release);
  const info = await bucket.head(key);
  if (!info) return error('This download is not available yet. Please try again shortly.', 503);
  const headers = new Headers({
    'Content-Type': contentType(file),
    'Content-Disposition': `attachment; filename="${file}"`,
    'Content-Length': String(info.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'ETag': info.httpEtag,
  });
  if (info.customMetadata?.sha256) headers.set('X-Checksum-SHA256', info.customMetadata.sha256);
  if (request.headers.get('if-none-match') === info.httpEtag) return new Response(null, { status: 304, headers });
  if (request.method === 'HEAD') return new Response(null, { headers });
  let range: { offset: number; length: number } | undefined;
  const rawRange = request.headers.get('range');
  if (rawRange && (!request.headers.has('if-range') || request.headers.get('if-range') === info.httpEtag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
    const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    const end = match[1] ? (match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1) : info.size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size || Number(match[2]) === 0 && !match[1]) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
    range = { offset: start, length: end - start + 1 };
    headers.set('Content-Length', String(range.length));
    headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  const object = await bucket.get(key, range ? { range } : undefined);
  if (!object) return error('Download unavailable.', 503);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function publish(request: Request, file: string, bucket: R2Bucket, secret?: string) {
  if (!await authorized(request, secret)) return error('Not found.', 404);
  if (!allowedFile(file)) return error('Unknown release file.', 400);
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const key = objectKey(file);
  const uploadId = url.searchParams.get('uploadId');
  const json = (data: unknown) => Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
  try {
    if (request.method === 'POST' && action === 'create') {
      if (await bucket.head(key)) return error('Release file already exists; versioned files are immutable.', 409);
      const sha256 = request.headers.get('x-checksum-sha256') ?? '';
      const size = Number(request.headers.get('x-file-size'));
      if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) return error('Invalid file metadata.', 400);
      const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: contentType(file) }, customMetadata: { sha256, size: String(size) } });
      return json({ uploadId: upload.uploadId });
    }
    if (!uploadId || uploadId.length > 500) return error('Missing upload ID.', 400);
    const upload = bucket.resumeMultipartUpload(key, uploadId);
    if (request.method === 'PUT' && action === 'part') {
      const number = Number(url.searchParams.get('partNumber'));
      const size = Number(request.headers.get('content-length'));
      if (!Number.isInteger(number) || number < 1 || number > 64 || !size || size > PART_BYTES || !request.body) return error('Invalid part.', 400);
      return json(await upload.uploadPart(number, request.body));
    }
    if (request.method === 'POST' && action === 'complete') {
      if (Number(request.headers.get('content-length')) > 16000) return error('Request too large.', 413);
      if (await bucket.head(key)) return error('Release file already exists.', 409);
      const body = await request.json() as { parts?: R2UploadedPart[] };
      if (!Array.isArray(body.parts) || body.parts.length < 1 || body.parts.length > 64 || body.parts.some((part, i) => part.partNumber !== i + 1 || typeof part.etag !== 'string' || part.etag.length > 256)) return error('Invalid parts.', 400);
      await upload.complete(body.parts);
      // Multipart completion responses may omit custom metadata. Read the stored
      // object before verifying its declared size or returning its checksum.
      const object = await bucket.head(key);
      if (!object || object.size !== Number(object.customMetadata?.size)) {
        await bucket.delete(key);
        return error('Size mismatch.', 400);
      }
      return json({ size: object.size, sha256: object.customMetadata?.sha256 });
    }
    if (request.method === 'DELETE' && action === 'abort') { await upload.abort(); return new Response(null, { status: 204 }); }
    return error('Invalid operation.', 400);
  } catch { return error('Release upload failed.', 400); }
}
