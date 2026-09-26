'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { checkManifest } = require('../scripts/check.cjs');
const manifest = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));

test('the extension asks for https sites only as an optional permission and keeps static access Iowa-only', () => {
  const current = manifest();
  assert.deepEqual(current.optional_host_permissions, ['https://*/*']);
  assert.deepEqual(current.host_permissions, ['https://hhsservices.iowa.gov/*']);
  // The widget iframe must load on approved sites, so only the panel files are exposed to https pages.
  assert.deepEqual(current.web_accessible_resources, [{ resources: ['panel.html', 'panel.js', 'panel.css'], matches: ['https://*/*'] }]);
  assert.doesNotThrow(() => checkManifest(current));
});

test('the check rejects any other optional or static host pattern', () => {
  for (const optional of [['<all_urls>'], ['http://*/*'], ['*://*/*'], ['https://*.example.org/*'], ['https://*/*', 'http://*/*']]) {
    assert.throws(() => checkManifest({ ...manifest(), optional_host_permissions: optional }), /Unexpected optional host permission/, optional.join());
  }
  assert.throws(() => checkManifest({ ...manifest(), host_permissions: ['https://hhsservices.iowa.gov/*', 'https://*/*'] }), /Unexpected host permission/);
  const withoutOptional = manifest();
  delete withoutOptional.optional_host_permissions;
  assert.doesNotThrow(() => checkManifest(withoutOptional));
});

test('the static content script stays on Iowa top frames and only the assistant panel is web accessible', () => {
  const broad = manifest();
  broad.content_scripts[0].matches = ['https://*/*'];
  assert.throws(() => checkManifest(broad), /exact Iowa portal/);
  const extra = manifest();
  extra.content_scripts.push({ matches: ['https://*/*'], js: ['generic-content.js'] });
  assert.throws(() => checkManifest(extra), /exact Iowa portal/);
  const leaked = manifest();
  leaked.web_accessible_resources[0].resources.push('background.js');
  assert.throws(() => checkManifest(leaked), /web accessible/);
  const everywhere = manifest();
  everywhere.web_accessible_resources[0].matches = ['<all_urls>'];
  assert.throws(() => checkManifest(everywhere), /web accessible/);
  assert.throws(() => checkManifest({ ...manifest(), permissions: [...manifest().permissions, 'storage'] }), /storage/);
});
