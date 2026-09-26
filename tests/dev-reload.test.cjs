'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyChange, createBatcher, syncNativeHost } = require('../scripts/dev.cjs');
const { chromeHostManifestDirectory } = require('../desktop/registration.cjs');

test('source changes map to the part of the app that must reload', () => {
  assert.equal(classifyChange('desktop/main.cjs'), 'desktop');
  assert.equal(classifyChange('desktop/preload.cjs'), 'desktop');
  assert.equal(classifyChange('shared/schema.cjs'), 'desktop');
  // Panel pages can reload on their own without disturbing the Iowa form.
  assert.equal(classifyChange('extension/panel.js'), 'panel');
  assert.equal(classifyChange('extension/panel.css'), 'panel');
  assert.equal(classifyChange('extension/panel.html'), 'panel');
  // Worker, content scripts, and manifest need a full extension reload.
  assert.equal(classifyChange('extension/manifest.json'), 'extension');
  assert.equal(classifyChange('extension/background.js'), 'extension');
  assert.equal(classifyChange('extension/iowa-adapter.js'), 'extension');
  assert.equal(classifyChange('extension\\content.js'), 'extension');
  // The desktop app reloads its own window for renderer edits.
  assert.equal(classifyChange('renderer/app.js'), null);
  assert.equal(classifyChange('tests/schema.test.cjs'), null);
  assert.equal(classifyChange('README.md'), null);
});

test('editor and OS scratch files never trigger a reload', () => {
  for (const file of ['extension/.DS_Store', 'extension/.panel.js.swp', 'desktop/main.cjs~', 'extension/4913', 'desktop/.#main.cjs']) {
    assert.equal(classifyChange(file), null, file);
  }
});

test('a burst of saves is coalesced into one reload per affected part', async () => {
  const flushes = [];
  const batcher = createBatcher(kinds => flushes.push([...kinds].sort()), 20);
  batcher.add('extension');
  batcher.add('extension');
  batcher.add('desktop');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(flushes, [['desktop', 'extension']]);
  batcher.add('extension');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(flushes, [['desktop', 'extension'], ['extension']]);
});

test('a cancelled batch does not reload', async () => {
  const flushes = [];
  const batcher = createBatcher(kinds => flushes.push(kinds), 20);
  batcher.add('desktop');
  batcher.cancel();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(flushes, []);
});

test('Chrome host manifest location matches the platform registration path', () => {
  assert.equal(chromeHostManifestDirectory('darwin', '/Users/a'), '/Users/a/Library/Application Support/Google/Chrome/NativeMessagingHosts');
  assert.equal(chromeHostManifestDirectory('linux', '/home/a'), '/home/a/.config/google-chrome/NativeMessagingHosts');
  assert.equal(chromeHostManifestDirectory('win32', 'C:\\Users\\a'), null);
});

test('the dev browser profile receives a copy of the registered native host manifest', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-dev-reload-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'chrome', 'org.secondhand.bridge.json');
  const profile = path.join(directory, 'profile');

  assert.equal(await syncNativeHost(source, profile), false);

  await fs.mkdir(path.dirname(source), { recursive: true });
  const manifest = JSON.stringify({ name: 'org.secondhand.bridge', path: '/launcher', type: 'stdio', allowed_origins: ['chrome-extension://jogldddafjfbmfjnjlbjloakjbecnjpl/'] });
  await fs.writeFile(source, manifest);
  assert.equal(await syncNativeHost(source, profile), true);
  assert.equal(await fs.readFile(path.join(profile, 'NativeMessagingHosts', 'org.secondhand.bridge.json'), 'utf8'), manifest);
});
