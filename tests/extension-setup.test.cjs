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

test('bundled public key pins the same Chrome ID on every platform and copy location', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
  assert.equal(extensionIdFromKey(manifest.key), 'jogldddafjfbmfjnjlbjloakjbecnjpl');
  assert.throws(() => extensionIdFromKey('not a public key'));
  assert.throws(() => extensionIdFromKey(Buffer.from('not DER').toString('base64')));
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

test('missing copied files report setup incomplete and preparation repairs the same directory', async t => {
  const { app } = await fixture(t);
  const initial = await prepareBundledExtension(app);
  assert.equal(EXTENSION_FILES.some(file => file.startsWith('popup.')), false);
  for (const file of ['content.js', 'panel.html', 'panel.js', 'panel.css']) {
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
  await assert.rejects(prepareBundledExtension({ ...app, isPackaged: true }, resources));
  assert.deepEqual(await fs.readFile(path.join(initial.directory, 'manifest.json')), before);
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
