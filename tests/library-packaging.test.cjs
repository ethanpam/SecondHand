'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../scripts/library-build-config.cjs');
const pkg = require('../package.json');

test('Library installers are separate products with the same app resources and a built-in edition flag', () => {
  assert.notEqual(config.appId, pkg.build.appId);
  assert.equal(config.productName, 'SecondHand Library');
  assert.equal(config.extraMetadata.secondHandEdition, 'library');
  assert.equal(config.artifactName, 'secondHand-library-${version}-${os}-${arch}.${ext}');
  assert.equal(config.directories.output, 'release/library');
  assert.deepEqual(config.files, pkg.build.files);
  assert.deepEqual(config.extraResources, pkg.build.extraResources);
  assert.equal(config.win.extraFiles[0].from, 'build/native-library/secondHand-native.exe');
  assert.equal(config.mac.executableName, 'SecondHand Library');
});

test('Windows Library relay uses the matching isolated data folder', () => {
  const source = fs.readFileSync(path.join(__dirname, '../desktop/native-launcher.cs'), 'utf8');
  assert.match(source, /#if LIBRARY_EDITION\s+private const string DataDirectory = "SecondHand Library";/);
  assert.match(source, /Path.Combine\(local, DataDirectory, "bridge-session.json"\)/);
  const build = fs.readFileSync(path.join(__dirname, '../scripts/build-native-host.cjs'), 'utf8');
  assert.match(build, /define:LIBRARY_EDITION/);
  assert.match(pkg.scripts['dist:library:win'], /build-native-host.cjs --library/);
});
