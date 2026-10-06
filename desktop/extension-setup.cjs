'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./vault.cjs');

// Copy application assets only. Never copy the vault, settings, or user documents.
const EXTENSION_FILES = Object.freeze([
  'background.js', 'content.js', 'address-policy.js', 'iowa-adapter.js', 'generic-adapter.js', 'generic-content.js', 'ai-mapper.js',
  'strings.js', 'translation.js', 'summary.js', 'page-text.js', 'panel.html', 'panel.css', 'panel.js', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png', 'manifest.json'
]);

function extensionIdFromKey(key) {
  if (typeof key !== 'string' || key.length > 8192) throw new Error('The bundled extension key is invalid.');
  const bytes = Buffer.from(key, 'base64');
  if (!bytes.length || bytes.toString('base64') !== key) throw new Error('The bundled extension key is invalid.');
  crypto.createPublicKey({ key: bytes, type: 'spki', format: 'der' });
  // Chromium crx_file::id_util uses the first 16 SHA-256 bytes mapped from 0-f to a-p.
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

function extensionDirectory(app) {
  return path.join(app.getPath('userData'), 'chrome-extension');
}

function bundledDirectory(app, resourcesPath = process.resourcesPath) {
  return app.isPackaged ? path.join(resourcesPath, 'extension') : path.join(app.getAppPath(), 'extension');
}

// The extension's build: the BUILD line in background.js (panel.js carries the same one). The
// extension compares it with the build the app ships to update itself (#85).
const BUILD_LINE = /^const BUILD = '(\d{4}-\d{2}-\d{2}\.\d+)';$/m;
const buildOf = source => BUILD_LINE.exec(source)?.[1] ?? null;
// background.js is written last, so its build marker also says every other file is from that build.
const MARKER_FILE = 'background.js';
// Dates, then the number after the dot, as numbers: 2026-10-03.10 is newer than 2026-10-03.9.
function newerBuild(candidate, current) {
  const [next, now] = [candidate, current].map(value => value.split(/[-.]/).map(Number));
  const at = next.findIndex((part, index) => part !== now[index]);
  return at >= 0 && next[at] > now[at];
}
// The build marker of the copy in the prepared folder, or null when there is no readable one.
async function copiedBuild(directory) {
  try {
    const [folder, marker] = await Promise.all([fs.lstat(directory), fs.lstat(path.join(directory, MARKER_FILE))]);
    if (!folder.isDirectory() || folder.isSymbolicLink() || !marker.isFile() || marker.isSymbolicLink()) return null;
    return buildOf(await fs.readFile(path.join(directory, MARKER_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function bundledExtension(app, resourcesPath) {
  const directory = bundledDirectory(app, resourcesPath);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string') throw new Error('The bundled extension is invalid.');
  const build = buildOf(await fs.readFile(path.join(directory, MARKER_FILE), 'utf8'));
  if (!build) throw new Error('The bundled extension has no build marker.');
  return { manifest, extensionId: extensionIdFromKey(manifest.key), build };
}

// `exists`: something is at the prepared folder's path. `prepared`: it is a copy of this bundle. `newerCopy`: the
// build of a whole copy a newer app prepared there, which this app never replaces with its older one (#142); else null.
async function getExtensionSetup(app, resourcesPath) {
  const { manifest, extensionId, build } = await bundledExtension(app, resourcesPath);
  const directory = extensionDirectory(app);
  let exists = false;
  let prepared = false;
  let newerCopy = null;
  try {
    const stat = await fs.lstat(directory);
    exists = true;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const installed = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
      const files = await Promise.all(EXTENSION_FILES.map(file => fs.lstat(path.join(directory, file))));
      const whole = installed.key === manifest.key && files.every(file => file.isFile() && !file.isSymbolicLink());
      const copied = buildOf(await fs.readFile(path.join(directory, MARKER_FILE), 'utf8'));
      prepared = whole && installed.version === manifest.version && copied === build;
      newerCopy = whole && copied && newerBuild(copied, build) ? copied : null;
    }
  } catch { /* Setup has not run yet, or its copied files need to be restored. */ }
  return { directory, extensionId, version: manifest.version, build, exists, prepared, newerCopy };
}

async function prepareBundledExtension(app, resourcesPath) {
  const source = bundledDirectory(app, resourcesPath);
  const { manifest, extensionId, build } = await bundledExtension(app, resourcesPath);
  const directory = extensionDirectory(app);
  // Read and validate all assets before changing the user's existing copy.
  const assets = await Promise.all(EXTENSION_FILES.map(async name => {
    const file = path.join(source, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('The bundled extension files are invalid.');
    return { name, bytes: await fs.readFile(file) };
  }));
  // A copy from a newer app stays as it is, whole or not: this older app's files would take Chrome back a build (#142).
  const copied = await copiedBuild(directory);
  if (copied && newerBuild(copied, build)) {
    const message = `The Chrome extension folder has a newer build (${copied}) than this SecondHand app (${build}), so it was left as it is. Update SecondHand to refresh it.`;
    throw Object.assign(new Error(message), { publicMessage: message });
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = await fs.lstat(directory);
  if (!target.isDirectory() || target.isSymbolicLink()) throw new Error('The extension setup directory must be a local folder.');
  // The manifest, then background.js, are last: a new version and build show only once every
  // other file is written. A refresh that stops part way leaves the old build marker.
  const order = [...assets.filter(asset => asset.name !== 'manifest.json' && asset.name !== MARKER_FILE),
    ...assets.filter(asset => asset.name === 'manifest.json'), ...assets.filter(asset => asset.name === MARKER_FILE)];
  for (const asset of order) await atomicWrite(path.join(directory, asset.name), asset.bytes);
  await removeReplacedExtensionFiles(directory);
  return { directory, extensionId, version: manifest.version, build, exists: true, prepared: true };
}

// Only top-level regular files that the current bundle no longer ships. Links and
// folders stay, and are reported, so a refresh cannot follow them outside this folder.
async function removeReplacedExtensionFiles(directory) {
  const kept = new Set(EXTENSION_FILES);
  const root = path.resolve(directory);
  const blocked = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (kept.has(entry.name)) continue;
    const target = path.resolve(directory, entry.name);
    if (path.dirname(target) !== root) throw new Error(`Refusing to touch ${entry.name} outside the extension folder.`);
    if (entry.isSymbolicLink() || entry.isDirectory() || !entry.isFile()) blocked.push(entry.name);
    else await fs.unlink(target);
  }
  if (blocked.length) {
    blocked.sort();
    throw new Error(`The extension folder still has ${blocked.join(', ')}. Remove those links or folders, then prepare the extension again.`);
  }
}

module.exports = { EXTENSION_FILES, extensionIdFromKey, extensionDirectory, bundledDirectory, getExtensionSetup, prepareBundledExtension };
