'use strict';

// Invoked explicitly with `node tests/desktop-native-smoke.cjs`. This starts an
// actual native-host process; the Electron path on Linux needs a display/Xvfb.
// SECONDHAND_PACKAGED_EXE points to the built Windows native relay or the Mac
// .app/Contents/MacOS/secondHand binary. This exercises Chrome's exact entry.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startBridge, frame, FrameReader } = require('../desktop/bridge.cjs');
const { PORTAL_URL } = require('../shared/schema.cjs');

(async () => {
  const packaged = process.env.SECONDHAND_PACKAGED_EXE;
  if (process.platform === 'win32' && !packaged) throw new Error('Windows native messaging requires the compiled host. Run npm run dist:win and set SECONDHAND_PACKAGED_EXE to release/win-unpacked/secondHand-native.exe.');
  if (packaged && !['win32', 'darwin'].includes(process.platform)) throw new Error('Packaged smoke supports Windows and macOS.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-native-smoke-'));
  const userData = packaged && process.platform === 'win32' ? path.join(temporary, 'SecondHand') : path.join(temporary, 'dev-data');
  const extensionId = 'a'.repeat(32);
  const fixtures = [
    { request: { id: 'native-smoke', type: 'status' }, data: { unlocked: false, applicationCount: 0 } },
    { request: { id: 'show-app', type: 'showApp' }, data: { shown: true } },
    { request: { id: 'fields', type: 'getFields', url: PORTAL_URL, fields: ['firstName'] }, data: { values: { firstName: 'Synthetic' } } }
  ];
  let bridge;
  let child;
  try {
    bridge = await startBridge(userData, () => extensionId, async (request, context) => {
      assert.equal(context.extensionId, extensionId);
      const fixture = fixtures.find(item => item.request.id === request.id);
      assert.ok(fixture, 'Unexpected native smoke request');
      assert.deepEqual(request, fixture.request);
      return fixture.data;
    });
    const executable = packaged ? (process.platform === 'win32' ?
      path.join(path.dirname(path.resolve(packaged)), 'secondHand-native.exe') : path.resolve(packaged)) : require('electron');
    const args = [...(packaged ? [] : [path.resolve(__dirname, '..')]), `chrome-extension://${extensionId}/`];
    const env = { ...process.env, SECONDHAND_USER_DATA: userData, LOCALAPPDATA: temporary };
    if (packaged && process.platform === 'darwin') {
      env.SECONDHAND_TEST_MODE = '1';
      env.SECONDHAND_TEST_USER_DATA = userData;
    }
    // The Windows production host is independent of Electron and its console.
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let stdoutPrefix = Buffer.alloc(0);
    let stdoutBytes = 0;
    const messages = [];
    let framingInvalid = false;
    const reader = new FrameReader();
    reader.on('message', value => messages.push(value));
    reader.on('invalid', () => { framingInvalid = true; });
    child.stdout.on('data', bytes => {
      stdoutBytes += bytes.length;
      // This isolated smoke fixture only sends synthetic messages. Never
      // capture native stdout in the real application or tests with user data.
      if (stdoutPrefix.length < 256) stdoutPrefix = Buffer.concat([stdoutPrefix, bytes.subarray(0, 256 - stdoutPrefix.length)]);
      reader.push(bytes);
    });
    child.stdout.on('end', () => reader.end());
    child.stderr.on('data', bytes => { if (stderr.length < 16000) stderr += bytes.toString(); });
    const ended = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`Native host timed out. ${stderr}`)); }, 30000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.concat(fixtures.map(item => frame(item.request))));
    const result = await ended;
    assert.equal(result.code, 0, `Native host failed (${result.signal || result.code}). ${stderr}`);
    assert.equal(framingInvalid, false, `Native host emitted non-protocol stdout (${stdoutBytes} bytes; bounded synthetic hex: ${stdoutPrefix.toString('hex')}). ${stderr}`);
    assert.deepEqual(messages, fixtures.map(item => ({ id: item.request.id, ok: true, data: item.data })));
    process.stdout.write(`Native messaging subprocess smoke passed (${packaged ? `packaged ${process.platform} native host` : 'development Electron'}).\n`);
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (bridge) await bridge.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
