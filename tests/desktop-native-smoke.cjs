'use strict';

// Invoked explicitly with `node tests/desktop-native-smoke.cjs`. This starts an
// actual native-host process; the Electron path on Linux needs a display/Xvfb.
// SECONDHAND_PACKAGED_EXE points to the built Windows native relay or the Mac
// .app/Contents/MacOS/secondHand binary. This exercises Chrome's exact entry.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { realpathSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startBridge, frame, FrameReader } = require('../desktop/bridge.cjs');
const { PORTAL_URL } = require('../shared/schema.cjs');

const root = path.resolve(__dirname, '..');
const extensionId = 'a'.repeat(32);

// One native host run as Chrome starts it: all requests written at once, then stdin closed.
async function runHost(executable, args, env, requests) {
  const child = spawn(executable, [...args, `chrome-extension://${extensionId}/`], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  try {
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
    child.stdin.end(Buffer.concat(requests.map(request => frame(request))));
    const result = await ended;
    assert.equal(result.code, 0, `Native host failed (${result.signal || result.code}). ${stderr}`);
    assert.equal(framingInvalid, false, `Native host emitted non-protocol stdout (${stdoutBytes} bytes; bounded synthetic hex: ${stdoutPrefix.toString('hex')}). ${stderr}`);
    return messages;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

// A stand-in at the app path. With Chrome's origin it is the real native host (desktop/main.cjs).
// Started without one, the way openApp starts SecondHand, it records how it was started and quits.
async function standInApp(directory, record) {
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'secondhand-native-smoke-stand-in', main: 'main.cjs' }));
  await fs.writeFile(path.join(directory, 'main.cjs'), `'use strict';
if (process.argv.some(argument => argument.startsWith('chrome-extension://'))) require(${JSON.stringify(path.join(root, 'desktop/main.cjs'))});
else {
  require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(1),
    userData: process.env.SECONDHAND_USER_DATA ?? null, testMode: process.env.SECONDHAND_TEST_MODE ?? null, testUserData: process.env.SECONDHAND_TEST_USER_DATA ?? null }) + '\\n');
  require('electron').app.exit(0);
}
`);
}

// How long the Windows stand-in stays running after it records its start.
const STAND_IN_STAYS_MS = 15000;

// An installed Windows app in `directory`: a copy of the relay, and beside it a stand-in secondHand.exe (this
// Node, which NODE_OPTIONS points at the returned script) that records how it was started, then stays running.
// Had it kept the relay's handles, Chrome's pipes among them, the relay's output would stay open while it runs.
async function standInExe(directory, relay, record) {
  await fs.mkdir(directory);
  await fs.copyFile(relay, path.join(directory, 'secondHand-native.exe'));
  await fs.copyFile(process.execPath, path.join(directory, 'secondHand.exe'));
  const script = path.join(directory, 'record.cjs');
  await fs.writeFile(script, `'use strict';
require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(1),
  executable: process.execPath, folder: process.cwd(), localAppData: process.env.LOCALAPPDATA ?? null,
  testMode: process.env.SECONDHAND_TEST_MODE ?? null, testUserData: process.env.SECONDHAND_TEST_USER_DATA ?? null }) + '\\n');
setTimeout(() => process.exit(0), ${STAND_IN_STAYS_MS});
`);
  return script;
}

async function launches(record) {
  try { return (await fs.readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// The apps a host started, once the first has run. Their process IDs go in `started` so they are ended.
async function startedApps(record, started) {
  const deadline = Date.now() + 20000;
  while (!(await launches(record)).length) {
    if (Date.now() > deadline) throw new Error('The host answered launched, but the app it started never ran.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // A second start would have recorded by now; the host starts the app once.
  await new Promise(resolve => setTimeout(resolve, 2000));
  const recorded = await launches(record);
  started.push(...recorded.map(item => item.pid));
  return recorded;
}

(async () => {
  const packaged = process.env.SECONDHAND_PACKAGED_EXE;
  if (process.platform === 'win32' && !packaged) throw new Error('Windows native messaging requires the compiled host. Run npm run dist:win and set SECONDHAND_PACKAGED_EXE to release/win-unpacked/secondHand-native.exe.');
  if (packaged && !['win32', 'darwin'].includes(process.platform)) throw new Error('Packaged smoke supports Windows and macOS.');
  const windowsRelay = Boolean(packaged) && process.platform === 'win32';
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-native-smoke-'));
  const userData = windowsRelay ? path.join(temporary, 'SecondHand') : path.join(temporary, 'dev-data');
  // openApp reaches a running app as showApp from the macOS/Linux host; the Windows relay passes it on as it is.
  const fixtures = [
    { request: { id: 'native-smoke', type: 'status' }, data: { unlocked: false, applicationCount: 0 } },
    { request: { id: 'show-app', type: 'showApp' }, data: { shown: true } },
    { request: { id: 'fields', type: 'getFields', url: PORTAL_URL, fields: ['firstName'] }, data: { values: { firstName: 'Synthetic' } } },
    { request: { id: 'one-record', type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-job-history',
      recordType: 'jobs', fields: ['person', 'employer'], personName: 'Synthetic Owner' },
    data: { recordId: '11111111-2222-4333-8444-555555555555', values: { person: 'Synthetic Owner', employer: 'Synthetic Employer' }, accessRevision: 37 } },
    windowsRelay ? { request: { id: 'open-app', type: 'openApp' }, data: { opened: 'shown' } }
      : { request: { id: 'open-app', type: 'openApp' }, received: { id: 'open-app', type: 'showApp' }, data: { shown: true }, answer: { opened: 'shown' } }
  ];
  let bridge;
  const started = [];
  try {
    bridge = await startBridge(userData, () => extensionId, async (request, context) => {
      assert.equal(context.extensionId, extensionId);
      const fixture = fixtures.find(item => item.request.id === request.id);
      assert.ok(fixture, 'Unexpected native smoke request');
      assert.deepEqual(request, fixture.received || fixture.request);
      return fixture.data;
    });
    const executable = packaged ? (windowsRelay ?
      path.join(path.dirname(path.resolve(packaged)), 'secondHand-native.exe') : path.resolve(packaged)) : require('electron');
    const env = { ...process.env, SECONDHAND_USER_DATA: userData, LOCALAPPDATA: temporary };
    if (packaged && process.platform === 'darwin') {
      env.SECONDHAND_TEST_MODE = '1';
      env.SECONDHAND_TEST_USER_DATA = userData;
    }
    // The Windows production host is independent of Electron and its console.
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    delete env.ELECTRON_RUN_AS_NODE;
    const messages = await runHost(executable, packaged ? [] : [root], env, fixtures.map(item => item.request));
    assert.deepEqual(messages, fixtures.map(item => ({ id: item.request.id, ok: true, data: item.answer || item.data })));
    process.stdout.write(`Native messaging subprocess smoke passed (${packaged ? `packaged ${process.platform} native host` : 'development Electron'}): status, showApp, getFields, getRecordFields, and openApp with the app running.\n`);

    // With the app closed, openApp starts it. A packaged Mac host would start the real packaged app, so on a
    // Mac this runs with development Electron; the Windows relay starts a stand-in beside a copy of itself.
    if (packaged && !windowsRelay) {
      process.stdout.write('Skipped openApp with the app closed: on a Mac it runs with development Electron only.\n');
      return;
    }
    await bridge.close();
    bridge = null;
    const record = path.join(temporary, 'launches.jsonl');
    const closedEnv = { ...env, SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: userData };
    const opens = [{ id: 'open-1', type: 'openApp' }, { id: 'open-2', type: 'openApp' }];
    const launched = opens.map(({ id }) => ({ id, ok: true, data: { opened: 'launched' } }));
    if (windowsRelay) {
      const installed = path.join(temporary, 'installed');
      const script = await standInExe(installed, executable, record);
      const began = Date.now();
      // NODE_OPTIONS reaches the stand-in as part of the relay's own environment; node reads its quoted, escaped path.
      const answers = await runHost(path.join(installed, 'secondHand-native.exe'), [], { ...closedEnv, NODE_OPTIONS: `--require ${JSON.stringify(script)}` }, opens);
      assert.deepEqual(answers, launched);
      assert.ok(Date.now() - began < STAND_IN_STAYS_MS / 2, 'The relay’s output stayed open while the app it started ran: the app kept the relay’s handles.');
      const recorded = await startedApps(record, started);
      // Compared as real paths: the temporary folder may be named in its short 8.3 form.
      const real = file => realpathSync.native(file);
      assert.deepEqual(recorded.map(({ pid, executable, folder, ...launch }) => ({ ...launch, executable: real(executable), folder: real(folder) })),
        [{ args: [], localAppData: temporary, testMode: null, testUserData: null, executable: real(path.join(installed, 'secondHand.exe')), folder: real(installed) }]);
    } else {
      const standIn = path.join(temporary, 'stand-in');
      await standInApp(standIn, record);
      assert.deepEqual(await runHost(executable, [standIn], closedEnv, opens), launched);
      const recorded = await startedApps(record, started);
      assert.deepEqual(recorded.map(({ pid, ...launch }) => launch), [{ args: [standIn], userData, testMode: null, testUserData: null }]);
    }
    process.stdout.write(windowsRelay
      ? 'Native messaging subprocess smoke passed: with the app closed, the Windows relay started the secondHand.exe beside it once, with no arguments, without its handles or test settings.\n'
      : 'Native messaging subprocess smoke passed: with the app closed, openApp started it once, with the app path and data folder, without Chrome’s origin or test settings.\n');
  } finally {
    for (const pid of started) {
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (bridge) await bridge.close();
    // A Windows stand-in just ended may hold its file for a moment.
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10 });
  }
})().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
