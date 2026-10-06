'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EXTENSION_FILES, extensionIdFromKey, bundledDirectory, getExtensionSetup, prepareBundledExtension } = require('../desktop/extension-setup.cjs');
const { testStoragePath } = require('../desktop/test-storage-path.cjs');
const root = path.join(__dirname, '..');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-extension-setup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const userData = path.join(directory, 'user-data');
  await fs.mkdir(userData);
  return { directory, userData, app: { isPackaged: false, getAppPath: () => root, getPath: name => { assert.equal(name, 'userData'); return userData; } } };
}

const OLD_BUILD = '2026-01-01.1';
const markerOf = source => /^const BUILD = '([^']+)';$/m.exec(source)[1];
const CURRENT_BUILD = markerOf(require('node:fs').readFileSync(path.join(root, 'extension/background.js'), 'utf8'));
// A packaged app's resources holding this extension under an older build marker.
async function olderBundle(directory) {
  const resources = path.join(directory, 'older-resources');
  await fs.cp(path.join(root, 'extension'), path.join(resources, 'extension'), { recursive: true });
  for (const file of ['background.js', 'panel.js']) {
    const target = path.join(resources, 'extension', file);
    await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace(`const BUILD = '${CURRENT_BUILD}';`, `const BUILD = '${OLD_BUILD}';`));
  }
  return resources;
}

test('setup reports the build the app ships, read from its bundled background.js', async t => {
  const { app } = await fixture(t);
  const setup = await getExtensionSetup(app);
  assert.match(CURRENT_BUILD, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.equal(setup.build, CURRENT_BUILD);
  assert.equal(setup.exists, false, 'nothing prepared yet');
  assert.equal(setup.prepared, false);
  const prepared = await prepareBundledExtension(app);
  assert.equal(prepared.build, CURRENT_BUILD);
  assert.deepEqual({ exists: (await getExtensionSetup(app)).exists, prepared: (await getExtensionSetup(app)).prepared }, { exists: true, prepared: true });
});

test('a prepared copy from another build is not prepared until it is refreshed', async t => {
  const { app, directory } = await fixture(t);
  const older = { ...app, isPackaged: true };
  const resources = await olderBundle(directory);
  assert.equal((await prepareBundledExtension(older, resources)).build, OLD_BUILD);
  assert.equal((await getExtensionSetup(older, resources)).prepared, true, 'the older app sees its own copy as current');
  const stale = await getExtensionSetup(app);
  assert.deepEqual({ build: stale.build, exists: stale.exists, prepared: stale.prepared }, { build: CURRENT_BUILD, exists: true, prepared: false });
  await prepareBundledExtension(app);
  assert.equal((await getExtensionSetup(app)).prepared, true);
  assert.equal(markerOf(await fs.readFile(path.join(stale.directory, 'background.js'), 'utf8')), CURRENT_BUILD);
});

test('an older app never replaces a copy a newer app prepared, and says why (#142)', async t => {
  const { app, directory } = await fixture(t);
  // The newer app is this repository's; the older one ships the same files under an older build marker.
  const current = await prepareBundledExtension(app);
  const snapshot = async () => Promise.all(EXTENSION_FILES.map(file => fs.readFile(path.join(current.directory, file)).catch(() => null)));
  const before = await snapshot();
  const older = { ...app, isPackaged: true };
  const resources = await olderBundle(directory);
  const setup = await getExtensionSetup(older, resources);
  assert.deepEqual({ build: setup.build, exists: setup.exists, prepared: setup.prepared, newerCopy: setup.newerCopy },
    { build: OLD_BUILD, exists: true, prepared: false, newerCopy: CURRENT_BUILD });
  await assert.rejects(prepareBundledExtension(older, resources),
    error => error.publicMessage === error.message && error.message.includes(CURRENT_BUILD) && error.message.includes(OLD_BUILD));
  assert.deepEqual(await snapshot(), before, 'not one file was written');
  assert.equal((await getExtensionSetup(app)).newerCopy, null, 'the app that prepared it sees its own build, nothing newer');
  // A newer copy missing a file isn't ready to load, and is still never repaired with older files.
  await fs.unlink(path.join(current.directory, 'panel.css'));
  assert.equal((await getExtensionSetup(older, resources)).newerCopy, null);
  await assert.rejects(prepareBundledExtension(older, resources), error => error.message.includes(CURRENT_BUILD));
  await assert.rejects(fs.lstat(path.join(current.directory, 'panel.css')), { code: 'ENOENT' });
  assert.equal(markerOf(await fs.readFile(path.join(current.directory, 'background.js'), 'utf8')), CURRENT_BUILD);
});

test('a refresh writes background.js last, so its build marker means every other file is already new', async t => {
  const { app, directory } = await fixture(t);
  const resources = await olderBundle(directory);
  const { directory: copy } = await prepareBundledExtension({ ...app, isPackaged: true }, resources);
  // A file Chrome loads that can't be replaced: the refresh stops there.
  await fs.rm(path.join(copy, 'panel.css'));
  await fs.mkdir(path.join(copy, 'panel.css'));
  await fs.writeFile(path.join(copy, 'panel.css', 'blocker'), 'synthetic');
  await assert.rejects(prepareBundledExtension(app), { message: /panel\.css/ }, 'the refresh stops at the file it can’t replace');
  assert.equal(markerOf(await fs.readFile(path.join(copy, 'background.js'), 'utf8')), OLD_BUILD, 'background.js keeps the old build while any file is old');
  assert.equal((await getExtensionSetup(app)).prepared, false);
  await fs.rm(path.join(copy, 'panel.css'), { recursive: true });
  await prepareBundledExtension(app);
  assert.equal(markerOf(await fs.readFile(path.join(copy, 'background.js'), 'utf8')), CURRENT_BUILD);
  assert.equal((await getExtensionSetup(app)).prepared, true);
});

test('a bundle without a build marker is refused before anything is copied', async t => {
  const { app, directory, userData } = await fixture(t);
  const resources = await olderBundle(directory);
  const worker = path.join(resources, 'extension', 'background.js');
  await fs.writeFile(worker, (await fs.readFile(worker, 'utf8')).replace(/^const BUILD = .*$/m, ''));
  const packaged = { ...app, isPackaged: true };
  await assert.rejects(getExtensionSetup(packaged, resources), /build marker/);
  await assert.rejects(prepareBundledExtension(packaged, resources), /build marker/);
  await assert.rejects(fs.lstat(path.join(userData, 'chrome-extension')), { code: 'ENOENT' });
});

test('bundled public key pins the same Chrome ID on every platform and copy location', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
  assert.equal(extensionIdFromKey(manifest.key), 'jogldddafjfbmfjnjlbjloakjbecnjpl');
  assert.throws(() => extensionIdFromKey('not a public key'), { message: 'The bundled extension key is invalid.' });
  assert.throws(() => extensionIdFromKey(Buffer.from('not DER').toString('base64')), { message: 'Failed to read asymmetric key' }, 'base64 that isn’t a public key is refused by the key parser');
  assert.equal(bundledDirectory({ isPackaged: false, getAppPath: () => root }), path.join(root, 'extension'));
  assert.equal(bundledDirectory({ isPackaged: true }, '/packaged/resources'), path.join('/packaged/resources', 'extension'));
});

test('preparation copies bundled extension assets to a permanent local folder without copying vault data', async t => {
  const { app, userData } = await fixture(t);
  await fs.writeFile(path.join(userData, 'vault.secondhand'), 'synthetic encrypted vault placeholder');
  await fs.writeFile(path.join(userData, 'settings.json'), '{"test":"synthetic local setting"}');
  assert.equal((await getExtensionSetup(app)).prepared, false);
  const setup = await prepareBundledExtension(app);
  assert.equal(setup.prepared, true);
  assert.equal(setup.directory, path.join(userData, 'chrome-extension'));
  assert.equal(setup.extensionId, 'jogldddafjfbmfjnjlbjloakjbecnjpl');
  assert.deepEqual((await fs.readdir(setup.directory)).sort(), [...EXTENSION_FILES].sort());
  for (const filename of EXTENSION_FILES) {
    assert.deepEqual(await fs.readFile(path.join(setup.directory, filename)), await fs.readFile(path.join(root, 'extension', filename)));
  }
  assert.equal(await fs.readFile(path.join(userData, 'vault.secondhand'), 'utf8'), 'synthetic encrypted vault placeholder');
  assert.equal((await getExtensionSetup(app)).prepared, true);
  const refreshed = await prepareBundledExtension(app);
  assert.equal(refreshed.directory, setup.directory);
  assert.equal(refreshed.extensionId, setup.extensionId);
});

test('every icon the manifest names is copied with the extension', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const icons = [...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {})];
  assert.ok(icons.length > 0);
  for (const icon of icons) assert.ok(EXTENSION_FILES.includes(icon), `${icon} must be in EXTENSION_FILES`);
});

test('missing copied files report setup incomplete and preparation repairs the same directory', async t => {
  const { app } = await fixture(t);
  const initial = await prepareBundledExtension(app);
  assert.equal(EXTENSION_FILES.some(file => file.startsWith('popup.')), false);
  for (const file of ['address-policy.js', 'content.js', 'generic-adapter.js', 'generic-content.js', 'ai-mapper.js', 'panel.html', 'panel.js', 'panel.css']) {
    await fs.unlink(path.join(initial.directory, file));
    assert.equal((await getExtensionSetup(app)).prepared, false);
    assert.equal((await prepareBundledExtension(app)).directory, initial.directory);
    assert.equal((await getExtensionSetup(app)).prepared, true);
  }
});

test('a broken package fails before replacing an existing extension', async t => {
  const { app, directory } = await fixture(t);
  const initial = await prepareBundledExtension(app);
  const before = await fs.readFile(path.join(initial.directory, 'manifest.json'));
  const resources = path.join(directory, 'resources');
  await fs.mkdir(path.join(resources, 'extension'), { recursive: true });
  await fs.copyFile(path.join(root, 'extension/manifest.json'), path.join(resources, 'extension/manifest.json'));
  await assert.rejects(prepareBundledExtension({ ...app, isPackaged: true }, resources), { code: 'ENOENT', message: /background\.js/ }, 'a bundle missing its files is refused');
  assert.deepEqual(await fs.readFile(path.join(initial.directory, 'manifest.json')), before);
});

test('refresh removes leftover top-level files only after the new extension is written', async t => {
  const { app, userData } = await fixture(t);
  const initial = await prepareBundledExtension(app);
  const stale = path.join(initial.directory, 'popup.js');
  const outside = path.join(userData, 'notes.txt');
  await fs.writeFile(stale, 'old removed file');
  await fs.writeFile(outside, 'leave me');
  const resources = path.join(userData, '..', 'resources');
  await fs.mkdir(path.join(resources, 'extension'), { recursive: true });
  await fs.copyFile(path.join(root, 'extension/manifest.json'), path.join(resources, 'extension/manifest.json'));
  await assert.rejects(prepareBundledExtension({ ...app, isPackaged: true }, resources), { code: 'ENOENT', message: /background\.js/ }, 'a bundle missing its files is refused');
  assert.equal(await fs.readFile(stale, 'utf8'), 'old removed file');
  const refreshed = await prepareBundledExtension(app);
  assert.equal(refreshed.directory, initial.directory);
  await assert.rejects(fs.lstat(stale), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(initial.directory)).sort(), [...EXTENSION_FILES].sort());
  assert.equal(await fs.readFile(outside, 'utf8'), 'leave me');
});

test('refresh leaves symlinks and subfolders in place and reports them', async t => {
  const { app, directory } = await fixture(t);
  const initial = await prepareBundledExtension(app);
  const subfolder = path.join(initial.directory, 'old-folder');
  await fs.mkdir(subfolder);
  await fs.writeFile(path.join(subfolder, 'kept.txt'), 'inside');
  const linkTarget = path.join(directory, 'link-target.txt');
  await fs.writeFile(linkTarget, 'outside target');
  await fs.symlink(linkTarget, path.join(initial.directory, 'old-link'));
  await fs.writeFile(path.join(initial.directory, 'popup.css'), 'stale stylesheet');
  await assert.rejects(prepareBundledExtension(app), /old-folder/);
  await assert.rejects(prepareBundledExtension(app), /old-link/);
  assert.equal(await fs.readFile(path.join(subfolder, 'kept.txt'), 'utf8'), 'inside');
  assert.equal((await fs.lstat(path.join(initial.directory, 'old-link'))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(linkTarget, 'utf8'), 'outside target');
  await assert.rejects(fs.lstat(path.join(initial.directory, 'popup.css')), { code: 'ENOENT' });
  for (const filename of EXTENSION_FILES) {
    assert.equal((await fs.lstat(path.join(initial.directory, filename))).isFile(), true);
  }
});

test('preparation refuses a redirected extension directory', async t => {
  const { app, directory, userData } = await fixture(t);
  const unrelated = path.join(directory, 'unrelated');
  await fs.mkdir(unrelated);
  await fs.symlink(unrelated, path.join(userData, 'chrome-extension'), 'junction');
  await assert.rejects(prepareBundledExtension(app), /local folder/);
  assert.deepEqual(await fs.readdir(unrelated), []);
});

test('packaged test storage requires both explicit test mode and a temporary descendant', () => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const isolated = path.join(temporaryRoot, 'secondhand-native-smoke-example', 'SecondHand');
  assert.equal(testStoragePath({}, temporaryRoot), null);
  assert.equal(testStoragePath({ SECONDHAND_TEST_USER_DATA: isolated }, temporaryRoot), null);
  assert.equal(testStoragePath({ SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: isolated }, temporaryRoot), isolated);
  for (const value of ['', 'relative-folder', temporaryRoot, path.join(temporaryRoot, '..', 'outside')]) {
    assert.throws(() => testStoragePath({ SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: value }, temporaryRoot), /temporary directory/);
  }
});

test('every file the extension loads ships with the prepared extension', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { EXTENSION_FILES } = require('../desktop/extension-setup.cjs');
  const dir = path.join(__dirname, '..', 'extension');
  const read = file => fs.readFileSync(path.join(dir, file), 'utf8');
  const manifest = JSON.parse(read('manifest.json'));
  const loaded = new Set([manifest.background.service_worker, manifest.side_panel?.default_path,
    ...manifest.content_scripts.flatMap(script => script.js || [])]);
  for (const page of ['panel.html']) for (const [, src] of read(page).matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) loaded.add(src);
  for (const [, list] of read('background.js').matchAll(/importScripts\(([^)]*)\)/g)) for (const [, file] of list.matchAll(/'([^']+)'/g)) loaded.add(file);
  for (const [, list] of read('background.js').matchAll(/js: \[([^\]]*)\]/g)) for (const [, file] of list.matchAll(/'([^']+)'/g)) loaded.add(file);
  for (const [, list] of read('background.js').matchAll(/files: \[([^\]]*)\]/g)) for (const [, file] of list.matchAll(/'([^']+)'/g)) loaded.add(file);
  loaded.delete(undefined);
  const missing = [...loaded].filter(file => !EXTENSION_FILES.includes(file.split('?')[0]));
  assert.deepEqual(missing, [], 'a file the extension loads is missing from EXTENSION_FILES, so prepared extensions would break');
});
