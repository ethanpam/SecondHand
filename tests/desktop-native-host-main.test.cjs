'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runMain } = require('./helpers/harness.cjs');

const extensionId = 'a'.repeat(32);

// main.cjs as Chrome starts it on macOS and Linux: with the extension's origin, it runs the native host.
// The host and spawn are stand-ins; this checks what main hands them.
function nativeHost({ packaged = false, env = {} } = {}) {
  let host = null;
  const spawns = [];
  const app = { isPackaged: packaged, setName() {}, setPath() {}, getPath: () => '/synthetic-data', getAppPath: () => '/synthetic/secondHand',
    whenReady: () => new Promise(() => {}), exit: code => assert.fail(`The native host exited (${code})`),
    requestSingleInstanceLock: () => assert.fail('The native host must not take the desktop’s single-instance lock') };
  runMain({
    electron: { app },
    './test-storage-path.cjs': { testStoragePath: () => null },
    './bridge.cjs': { ...require('../desktop/bridge.cjs'), nativeStreams: () => ({ input: 'synthetic-input', output: 'synthetic-output' }),
      runNativeHost: (userData, id, input, output, launchApp) => { host = { userData, id, input, output, launchApp }; return new Promise(() => {}); } },
    'node:child_process': { spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), { unref() {} });
      process.nextTick(() => child.emit('spawn'));
      return child;
    } }
  }, { setTimeout, clearTimeout,
    process: { platform: 'darwin', execPath: '/synthetic/electron', env: { ...env },
      argv: ['/synthetic/electron', '/synthetic/secondHand', `chrome-extension://${extensionId}/`, '--parent-window=0'] } });
  assert.ok(host, 'main ran the native host');
  return { host, spawns };
}

test('the native host can start SecondHand from its own executable and app path, without Chrome’s origin or test settings', async () => {
  const env = { PATH: '/usr/bin', SECONDHAND_USER_DATA: '/synthetic-data', SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: '/tmp/synthetic-test' };
  const { host, spawns } = nativeHost({ env });
  assert.deepEqual({ ...host, launchApp: typeof host.launchApp },
    { userData: '/synthetic-data', id: extensionId, input: 'synthetic-input', output: 'synthetic-output', launchApp: 'function' });
  assert.deepEqual(spawns, [], 'nothing starts until openApp asks');
  await host.launchApp();
  assert.deepEqual(JSON.parse(JSON.stringify(spawns)), [{ command: '/synthetic/electron', args: ['/synthetic/secondHand'],
    options: { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin', SECONDHAND_USER_DATA: '/synthetic-data' } } }]);
});

test('a packaged native host starts the packaged app with no arguments', async () => {
  const { host, spawns } = nativeHost({ packaged: true, env: { PATH: '/usr/bin' } });
  await host.launchApp();
  assert.deepEqual(JSON.parse(JSON.stringify(spawns)), [{ command: '/synthetic/electron', args: [], options: { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin' } } }]);
});
