// Maintainer-only uploader. Never run in a browser or ship a credential to visitors.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { filenames, PART_BYTES } from '../lib/downloads.ts';
const [origin, directory] = process.argv.slice(2);
const token = process.env.RELEASE_UPLOAD_TOKEN;
if (!origin?.startsWith('https://') || !directory || !token || token.length < 32) throw new Error('Usage: RELEASE_UPLOAD_TOKEN=... node scripts/publish-downloads.mjs https://site.example release-directory');
const site = new URL(origin);
const accessHeaders = process.env.SITES_ACCESS_TOKEN ? {'OAI-Sites-Authorization': `Bearer ${process.env.SITES_ACCESS_TOKEN}`} : {};
if (site.username || site.password || site.search || site.hash || site.pathname !== '/') throw new Error('Use the site origin only.');
async function call(file, action, init = {}, query = {}) {
  const url = new URL(`/api/publish/${file}`, site);
  url.search = new URLSearchParams({action, ...query}).toString();
  const response = await fetch(url, { ...init, redirect: 'error', headers: { ...accessHeaders, ...init.headers, Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${file}: ${action} returned ${response.status}: ${(await response.text()).slice(0,200)}`);
  return response.status === 204 ? null : response.json();
}
for (const file of filenames) {
  const path = resolve(directory, file);
  const size = (await stat(path)).size;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const existing = await fetch(new URL(`/download/${file}`, site), { method: 'HEAD', redirect: 'error', headers: { ...accessHeaders, 'accept-encoding': 'identity' } });
  if (existing.ok) {
    if (existing.headers.get('x-checksum-sha256') !== sha256 || Number(existing.headers.get('content-length')) !== size) throw new Error(`Existing file differs: ${file}. Publish a new version.`);
    console.log(`Already uploaded: ${file}`); continue;
  }
  const { uploadId } = await call(file, 'create', { method: 'POST', headers: { 'x-checksum-sha256': sha256, 'x-file-size': String(size) } });
  const handle = await open(path, 'r');
  try {
    const parts = [];
    for (let offset = 0, partNumber = 1; offset < size; offset += PART_BYTES, partNumber++) {
      const data = Buffer.alloc(Math.min(PART_BYTES, size-offset));
      await handle.read(data, 0, data.length, offset);
      parts.push(await call(file, 'part', { method: 'PUT', body: data }, { uploadId, partNumber: String(partNumber) }));
      console.log(`${basename(file)}: ${Math.min(100, Math.round((offset+data.length)/size*100))}%`);
    }
    await call(file, 'complete', { method: 'POST', body: JSON.stringify({parts}), headers: { 'Content-Type':'application/json' } }, { uploadId });
  } catch (error) {
    await call(file, 'abort', { method:'DELETE' }, {uploadId}).catch(()=>{});
    throw error;
  } finally { await handle.close(); }
  // Read the actual published bytes back, not just the metadata, before declaring success.
  const response = await fetch(new URL(`/download/${file}`, site), { redirect:'error', headers: accessHeaders });
  if (!response.ok || !response.body) throw new Error(`Cannot verify ${file}`);
  const check = createHash('sha256');
  let count = 0;
  for await (const chunk of response.body) { check.update(chunk); count += chunk.length; }
  if (count !== size || check.digest('hex') !== sha256) throw new Error(`Published checksum mismatch: ${file}`);
  console.log(`Verified download: ${file} (${size} bytes)`);
}
