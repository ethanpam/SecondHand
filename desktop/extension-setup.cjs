'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWrite } = require('./vault.cjs');

// Copy application assets only. Never copy the vault, settings, or user documents.
const EXTENSION_FILES = Object.freeze([
  'background.js', 'content.js', 'address-policy.js', 'iowa-adapter.js', 'generic-adapter.js', 'generic-content.js', 'ai-mapper.js',
  'strings.js', 'translation.js', 'panel.html', 'panel.css', 'panel.js', 'icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png', 'manifest.json'
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

async function bundledManifest(app, resourcesPath) {
  const manifest = JSON.parse(await fs.readFile(path.join(bundledDirectory(app, resourcesPath), 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string') throw new Error('The bundled extension is invalid.');
  return { manifest, extensionId: extensionIdFromKey(manifest.key) };
}

async function getExtensionSetup(app, resourcesPath) {
  const { manifest, extensionId } = await bundledManifest(app, resourcesPath);
  const directory = extensionDirectory(app);
  let prepared = false;
  try {
    const stat = await fs.lstat(directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      const installed = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
      const files = await Promise.all(EXTENSION_FILES.map(file => fs.lstat(path.join(directory, file))));
      prepared = installed.key === manifest.key && installed.version === manifest.version && files.every(file => file.isFile() && !file.isSymbolicLink());
    }
  } catch { /* Setup has not run yet, or its copied files need to be restored. */ }
  return { directory, extensionId, version: manifest.version, prepared };
}

async function prepareBundledExtension(app, resourcesPath) {
  const source = bundledDirectory(app, resourcesPath);
  const { manifest, extensionId } = await bundledManifest(app, resourcesPath);
  const directory = extensionDirectory(app);
  // Read and validate all assets before changing the user's existing copy.
  const assets = await Promise.all(EXTENSION_FILES.map(async name => {
    const file = path.join(source, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('The bundled extension files are invalid.');
    return { name, bytes: await fs.readFile(file) };
  }));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = await fs.lstat(directory);
  if (!target.isDirectory() || target.isSymbolicLink()) throw new Error('The extension setup directory must be a local folder.');
  // Manifest is last, so the new version is exposed after its assets are written.
  for (const asset of assets) await atomicWrite(path.join(directory, asset.name), asset.bytes);
  return { directory, extensionId, version: manifest.version, prepared: true };
}

module.exports = { EXTENSION_FILES, extensionIdFromKey, extensionDirectory, bundledDirectory, getExtensionSetup, prepareBundledExtension };
