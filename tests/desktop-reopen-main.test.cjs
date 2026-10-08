'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const realLaya = require('../desktop/laya.cjs');
const { startMain, tick } = require('./helpers/harness.cjs');

// The real main process against a temporary folder, with Electron simulated. `secondInstance` is
// Electron telling it that SecondHand was opened again while this copy holds the single-instance lock.
async function desktop(t) {
  const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'secondhand-reopen-main-'));
  t.after(() => fsp.rm(userData, { recursive: true, force: true }));
  const main = await startMain({ userData, modules: {
    // The real Laya runtime, minus its background download and update checks (tests/desktop-laya-main.test.cjs covers those).
    './laya.cjs': { ...realLaya, createLaya: options => ({ ...realLaya.createLaya(options), startUpdates() {}, update() {} }) }
  } });
  return Object.assign(main, { secondInstance: () => main.appEvents.get('second-instance')() });
}

test('opening SecondHand again while it runs brings its window forward', async t => {
  const app = await desktop(t);
  const before = app.shows;
  app.secondInstance();
  assert.equal(app.shows, before + 1);
  assert.equal(app.focuses, 1);
  assert.equal(app.relaunches, 0);
});

test('opening SecondHand again while it quits starts it again once, after it has quit (#256)', async t => {
  const app = await desktop(t);
  app.quit();
  // Asked while the password lock, the bridge and Laya are still closing, and again once they have.
  app.secondInstance();
  for (let i = 0; i < 5; i++) await tick();
  app.secondInstance();
  assert.equal(app.relaunches, 1, 'one new copy, started by Electron after this one exits');
  assert.equal(app.shows, 0, 'the closing window is not brought back');
  assert.equal(app.focuses, 0);
});
