'use strict';

// Invoked explicitly with `node tests/desktop-native-smoke.cjs`. This starts an
// actual Electron native-host process, so Linux runners need a display/Xvfb.
// SECONDHAND_PACKAGED_EXE points to the installed/built Windows native launcher
// (the adjacent app executable also works). This exercises Chrome's exact entry.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startBridge, frame, FrameReader } = require('../desktop/bridge.cjs');

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-native-smoke-'));
  const packaged = process.env.SECONDHAND_PACKAGED_EXE;
  if (packaged && process.platform !== 'win32') throw new Error('Packaged smoke currently isolates app data on Windows only.');
  const userData = packaged ? path.join(temporary, 'SecondHand') : path.join(temporary, 'dev-data');
  const extensionId = 'a'.repeat(32);
  let bridge;
  let child;
  try {
    bridge = await startBridge(userData, () => extensionId, async request => {
      assert.equal(request.type, 'status');
      return { unlocked: false, applicationCount: 0 };
    });
    const executable = packaged ? path.join(path.dirname(path.resolve(packaged)), 'secondHand-native.exe') : require('electron');
    const args = [...(packaged ? [] : [path.resolve(__dirname, '..')]), `chrome-extension://${extensionId}/`];
    const env = { ...process.env, SECONDHAND_USER_DATA: userData, LOCALAPPDATA: temporary };
    // A Windows native host must set this before Electron starts. The packaged
    // helper does so itself; development smoke sets the equivalent child env.
    if (!packaged) env.ELECTRON_NO_ATTACH_CONSOLE = '1';
    else delete env.ELECTRON_NO_ATTACH_CONSOLE;
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
      // This isolated smoke fixture only sends synthetic status messages. Never
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
    child.stdin.end(frame({ id: 'native-smoke', type: 'status' }));
    const result = await ended;
    assert.equal(result.code, 0, `Native host failed (${result.signal || result.code}). ${stderr}`);
    assert.equal(framingInvalid, false, `Native host emitted non-protocol stdout (${stdoutBytes} bytes; bounded synthetic hex: ${stdoutPrefix.toString('hex')}). ${stderr}`);
    assert.deepEqual(messages, [{ id: 'native-smoke', ok: true, data: { unlocked: false, applicationCount: 0 } }]);
    process.stdout.write(`Native messaging subprocess smoke passed (${packaged ? 'packaged Windows launcher + app' : 'development Electron'}).\n`);
  } finally {
    if (child && child.exitCode === null) child.kill();
    if (bridge) await bridge.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
