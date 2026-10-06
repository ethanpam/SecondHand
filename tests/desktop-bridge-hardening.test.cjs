'use strict';
// The native bridge's own checks (#141): the session file the native host reads, the desktop socket's
// limits, how a relay to the desktop fails, the host's limit on pending requests, and the descriptors
// the host reads Chrome's messages from and writes its answers to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn, execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { FrameReader, frame, startBridge, relayRequest, runNativeHost } = require('../desktop/bridge.cjs');
const { runFile } = require('./helpers/harness.cjs');

const root = path.resolve(__dirname, '..');
const EXTENSION = 'a'.repeat(32);
const STATUS = Object.freeze({ id: 'status-1', type: 'status' });
const UNLOCKED = Object.freeze({ id: 'status-1', ok: true, data: { unlocked: false } });
const UNREACHABLE = id => ({ id, ok: false, error: 'Open SecondHand, connect this extension, and unlock SecondHand.', code: 'DESKTOP_UNREACHABLE' });
// Windows keeps the session in the user's own profile and has no mode bits or owner IDs to check.
const unixOnly = process.platform === 'win32' ? { skip: 'The session file’s owner and mode are checked on macOS and Linux only.' } : {};

const temporary = async (t, name) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Fails the test, rather than hanging it, when `promise` hasn't settled in time.
async function within(promise, what, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms.`)), ms); })]);
  } finally { clearTimeout(timer); }
}
async function until(condition, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(5);
  }
}
const sessionFile = directory => path.join(directory, 'bridge-session.json');
// A session file as the desktop writes one: readable by this user only.
async function writeSession(directory, contents) {
  const file = sessionFile(directory);
  await fs.rm(file, { force: true, recursive: true });
  await fs.writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents), { mode: 0o600 });
  return file;
}
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

// A stand-in desktop app on a local socket, and a session file that names it. `respond(envelope, socket)`
// answers each envelope as the test needs. Connections and envelopes are recorded.
async function standInDesktop(t, directory, respond) {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\secondhand-test-${crypto.randomBytes(8).toString('hex')}` : path.join(directory, 'desktop.sock');
  const desktop = { socketPath, token: crypto.randomBytes(32).toString('hex'), connections: 0, closed: 0, envelopes: [] };
  const sockets = new Set();
  const server = net.createServer(socket => {
    desktop.connections++;
    sockets.add(socket);
    socket.on('close', () => { desktop.closed++; sockets.delete(socket); });
    socket.on('error', () => {});
    const reader = new FrameReader();
    reader.on('message', envelope => { desktop.envelopes.push(envelope); respond(envelope, socket); });
    socket.on('data', chunk => reader.push(chunk));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  await writeSession(directory, { version: 1, socketPath, token: desktop.token });
  return desktop;
}
const answers = (envelope, socket) => socket.end(frame({ id: envelope.request.id, ok: true, data: { unlocked: false } }));

// One envelope, or several, written straight to the desktop's socket as one write; what comes back.
async function rawExchange(directory, envelopes) {
  const session = JSON.parse(await fs.readFile(sessionFile(directory), 'utf8'));
  return within(new Promise((resolve, reject) => {
    const socket = net.createConnection(session.socketPath);
    const reader = new FrameReader();
    const responses = [];
    reader.on('message', message => responses.push(message));
    socket.on('connect', () => socket.write(Buffer.concat(envelopes.map(envelope => frame({ token: session.token, ...envelope })))));
    socket.on('data', chunk => reader.push(chunk));
    socket.on('error', error => { if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') reject(error); });
    socket.on('close', () => resolve(responses));
  }), 'The desktop socket');
}

// One native host as Chrome runs it, with every request written at once: framed requests in, decoded answers out.
function hostWith(directory) {
  const input = new PassThrough(); const output = new PassThrough();
  const decoded = new FrameReader(); const responses = [];
  output.on('data', chunk => decoded.push(chunk));
  decoded.on('message', message => responses.push(message));
  const native = runNativeHost(directory, EXTENSION, input, output, async () => assert.fail('nothing here opens the app'));
  return { input, output, responses, native, send: requests => input.write(Buffer.concat(requests.map(frame))) };
}
const statuses = (count, prefix) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, type: 'status' }));

test('the native host reads the session only from a regular file of at most 4 KB that this user owns and no one else can open', unixOnly, async t => {
  const directory = await temporary(t, 'secondhand-session-owner-');
  let handled = 0;
  const bridge = await startBridge(directory, () => EXTENSION, async () => { handled++; return { unlocked: false }; });
  t.after(() => bridge.close());
  const file = sessionFile(directory);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'the desktop writes its session for this user only');
  const session = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(await relayRequest(directory, EXTENSION, STATUS), UNLOCKED);
  const refused = why => assert.rejects(relayRequest(directory, EXTENSION, STATUS), /^Error: Invalid local bridge session\.$/, why);

  for (const mode of [0o640, 0o604, 0o620, 0o602, 0o610, 0o601]) {
    await fs.chmod(file, mode);
    await refused(`a session with mode ${mode.toString(8)}`);
  }
  await fs.chmod(file, 0o600);
  assert.deepEqual(await relayRequest(directory, EXTENSION, STATUS), UNLOCKED);

  const uid = process.getuid();
  const otherUser = t.mock.method(process, 'getuid', () => uid + 1);
  await refused('a session another user owns');
  otherUser.mock.restore();

  await writeSession(directory, { ...session, note: 'x'.repeat(4096) });
  await refused('a well-formed session over 4 KB');

  const elsewhere = path.join(directory, 'elsewhere.json');
  await fs.writeFile(elsewhere, JSON.stringify(session), { mode: 0o600 });
  await fs.rm(file);
  await fs.symlink(elsewhere, file);
  await refused('a link to a session');
  await fs.rm(file);
  await fs.mkdir(file, { mode: 0o700 });
  await refused('a folder');
  await fs.rm(file, { recursive: true });
  // A named pipe would leave the host waiting for a writer that never comes.
  execFileSync('mkfifo', ['-m', '600', file]);
  try { await within(refused('a named pipe'), 'Reading the session from a named pipe'); }
  finally {
    // Lets a reader that is stuck opening the pipe go, so the test process can end.
    const writer = await fs.open(file, constants.O_WRONLY | constants.O_NONBLOCK).catch(error => { if (error.code === 'ENXIO') return null; throw error; });
    await writer?.close();
  }

  await writeSession(directory, session);
  assert.deepEqual(await relayRequest(directory, EXTENSION, STATUS), UNLOCKED);
  assert.equal(handled, 3, 'only the requests with a sound session reached the desktop');
});

test('a session in any other format is refused before the host connects or sends its token', async t => {
  const directory = await temporary(t, 'secondhand-session-format-');
  const desktop = await standInDesktop(t, directory, answers);
  const valid = { version: 1, socketPath: desktop.socketPath, token: desktop.token };
  assert.deepEqual(await relayRequest(directory, EXTENSION, STATUS), UNLOCKED);
  const malformed = {
    'version 2': { ...valid, version: 2 }, 'version "1"': { ...valid, version: '1' }, 'no version': without(valid, 'version'),
    'an uppercase token': { ...valid, token: valid.token.toUpperCase() }, 'a short token': { ...valid, token: valid.token.slice(1) },
    'a long token': { ...valid, token: `${valid.token}0` }, 'a token that isn’t hex': { ...valid, token: 'g'.repeat(64) },
    'a numeric token': { ...valid, token: 1 }, 'no token': without(valid, 'token'),
    'connection options for a socket': { ...valid, socketPath: { path: desktop.socketPath } }, 'a TCP port': { ...valid, socketPath: 5 },
    'no socket': without(valid, 'socketPath')
  };
  for (const [name, session] of Object.entries(malformed)) {
    await writeSession(directory, session);
    await assert.rejects(relayRequest(directory, EXTENSION, STATUS), /^Error: Invalid local bridge session\.$/, name);
  }
  for (const text of ['', 'not JSON', `${JSON.stringify(valid)},`]) {
    await writeSession(directory, text);
    await assert.rejects(relayRequest(directory, EXTENSION, STATUS), SyntaxError, JSON.stringify(text));
  }
  assert.equal(desktop.connections, 1, 'only the well-formed session reached the desktop');
});

test('the desktop serves at most 8 connections at once and refuses a 9th unanswered; a closed connection frees its place', async t => {
  const directory = await temporary(t, 'secondhand-socket-cap-');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handled = [];
  const bridge = await startBridge(directory, () => EXTENSION, async request => {
    handled.push(request.id);
    if (request.id.startsWith('held-')) { await gate; return { held: true }; }
    return { unlocked: false };
  });
  t.after(() => bridge.close());
  const held = statuses(8, 'held').map(request => relayRequest(directory, EXTENSION, request));
  await until(() => handled.length === 8, 'eight requests to reach the desktop');
  await assert.rejects(within(relayRequest(directory, EXTENSION, { id: 'ninth', type: 'status' }), 'A 9th connection'),
    error => /^(Desktop connection closed\.|.*\b(ECONNRESET|EPIPE)\b.*)$/.test(error.message), 'the 9th connection is closed unanswered');
  assert.equal(handled.length, 8, 'the 9th request never reached the desktop');
  release();
  assert.deepEqual(await within(Promise.all(held), 'The eight held requests'), statuses(8, 'held').map(({ id }) => ({ id, ok: true, data: { held: true } })));
  // The eight connections close soon after they are answered; then a new request is answered.
  const deadline = Date.now() + 5000;
  for (;;) {
    try { assert.deepEqual(await relayRequest(directory, EXTENSION, STATUS), UNLOCKED); break; }
    catch (error) { if (Date.now() > deadline) throw error; await delay(10); }
  }
});

test('the desktop takes one message per connection: a second closes it, and neither is answered', async t => {
  const directory = await temporary(t, 'secondhand-socket-once-');
  const handled = [];
  const bridge = await startBridge(directory, () => EXTENSION, async request => { handled.push(request.id); return { unlocked: false }; });
  t.after(() => bridge.close());
  const responses = await rawExchange(directory, [{ extensionId: EXTENSION, request: { id: 'first', type: 'status' } }, { extensionId: EXTENSION, request: { id: 'second', type: 'status' } }]);
  assert.deepEqual(handled, ['first'], 'the second message never reached the desktop');
  assert.deepEqual(responses, [], 'the connection closed before either was answered');
  // One message on its own connection is answered as ever.
  assert.deepEqual(await rawExchange(directory, [{ extensionId: EXTENSION, request: STATUS }]), [UNLOCKED]);
});

test('a relay the desktop never answers gives up after 125 seconds and closes its connection', async t => {
  const directory = await temporary(t, 'secondhand-relay-timeout-');
  const desktop = await standInDesktop(t, directory, () => {});
  // Socket timeouts don't use the global timers, so the relay's own timeout is captured and fired here.
  const timeouts = [];
  t.mock.method(net.Socket.prototype, 'setTimeout', function setTimeout(ms, callback) { timeouts.push({ socket: this, ms, callback }); return this; });
  const relay = relayRequest(directory, EXTENSION, STATUS);
  await until(() => desktop.envelopes.length === 1, 'the request to reach the desktop');
  assert.deepEqual(desktop.envelopes, [{ token: desktop.token, extensionId: EXTENSION, request: STATUS }]);
  const armed = timeouts.filter(({ callback }) => typeof callback === 'function');
  assert.deepEqual(armed.map(({ ms }) => ms), [125000], 'the relay arms one 125-second timeout');
  armed[0].callback();
  await assert.rejects(within(relay, 'The relay'), /^Error: Desktop request timed out\.$/);
  assert.equal(armed[0].socket.destroyed, true);
  await until(() => desktop.closed === 1, 'the desktop to see the connection close');
});

test('a relay fails when the desktop closes the connection without a complete answer', async t => {
  const directory = await temporary(t, 'secondhand-relay-closed-');
  const endings = { 'nothing': socket => socket.end(), 'half an answer': socket => socket.end(frame(UNLOCKED).subarray(0, 9)) };
  let ending = null;
  await standInDesktop(t, directory, (_envelope, socket) => endings[ending](socket));
  ending = 'nothing';
  await assert.rejects(within(relayRequest(directory, EXTENSION, STATUS), 'A relay the desktop closed'), /^Error: Desktop connection closed\.$/);
  ending = 'half an answer';
  await assert.rejects(within(relayRequest(directory, EXTENSION, STATUS), 'A relay with half an answer'), /^Error: Invalid desktop response\.$/);
});

test('a relay refuses an answer for another request or without a true or false ok; the host tells Chrome the desktop can’t be reached', async t => {
  const directory = await temporary(t, 'secondhand-relay-mismatch-');
  let reply = null;
  await standInDesktop(t, directory, (_envelope, socket) => socket.end(frame(reply)));
  const wrong = {
    'another request’s answer': { ...UNLOCKED, id: 'status-2' }, 'an answer without an id': without(UNLOCKED, 'id'),
    'ok as a string': { ...UNLOCKED, ok: 'true' }, 'no ok': without(UNLOCKED, 'ok'), 'null': null, 'a number': 7
  };
  for (const [name, value] of Object.entries(wrong)) {
    reply = value;
    await assert.rejects(within(relayRequest(directory, EXTENSION, STATUS), name), /^Error: Invalid desktop response\.$/, name);
  }
  reply = { ...UNLOCKED, id: 'status-2' };
  const host = hostWith(directory);
  host.input.end(frame(STATUS));
  await within(host.native, 'The native host');
  assert.deepEqual(host.responses, [UNREACHABLE(STATUS.id)]);
  reply = UNLOCKED;
  assert.deepEqual(await relayRequest(directory, EXTENSION, STATUS), UNLOCKED, 'the request’s own answer is accepted');
});

test('the native host holds at most 8 requests at once: a 9th stops it reading, and the 8 are still answered', async t => {
  // No desktop session here, so each request is answered as soon as its turn comes.
  const directory = await temporary(t, 'secondhand-host-pending-');
  const host = hostWith(directory);
  host.send(statuses(9, 'burst'));
  await within(host.native, 'The native host');
  assert.equal(host.input.destroyed, true, 'the host stopped reading Chrome’s messages');
  assert.deepEqual(host.responses, statuses(8, 'burst').map(({ id }) => UNREACHABLE(id)), 'the 9th was dropped unanswered');
});

test('the native host answers 8 requests at once, and 8 more once those are answered', async t => {
  const directory = await temporary(t, 'secondhand-host-eight-');
  const host = hostWith(directory);
  for (const batch of ['first', 'second']) {
    const expected = host.responses.length + 8;
    host.send(statuses(8, batch));
    await until(() => host.responses.length === expected, `the ${batch} eight answers`);
    // The answered requests leave the count once their writes finish.
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(host.input.destroyed, false);
  host.input.end();
  await within(host.native, 'The native host');
  assert.deepEqual(host.responses, [...statuses(8, 'first'), ...statuses(8, 'second')].map(({ id }) => UNREACHABLE(id)));
});

// bridge.cjs loaded with stand-ins for node:fs, to see what nativeStreams does with descriptors 0 and 1.
function bridgeWithFs(stand) {
  const module = { exports: {} };
  runFile('desktop/bridge.cjs', {
    module, exports: module.exports, Buffer, process,
    require: name => name === 'node:fs' ? { ...require('node:fs'), ...stand } : require(name.startsWith('.') ? path.join(root, 'desktop', name) : name)
  });
  return module.exports;
}

test('nativeStreams reads Chrome’s messages from descriptor 0 and never closes it', () => {
  const calls = [];
  const input = new PassThrough();
  const { nativeStreams } = bridgeWithFs({ createReadStream: (...args) => { calls.push(args); return input; }, writeSync: () => assert.fail('nothing was written') });
  assert.equal(nativeStreams().input, input);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[null, { fd: 0, autoClose: false, highWaterMark: 16384 }]]);
});

test('nativeStreams writes every byte to descriptor 1 as it is, however little each write takes', async () => {
  const writes = [];
  const { nativeStreams } = bridgeWithFs({ createReadStream: () => new PassThrough(), writeSync: (fd, bytes, offset, length) => {
    const count = Math.min(length, 5);
    writes.push({ fd, bytes: Buffer.from(bytes.subarray(offset, offset + count)) });
    return count;
  } });
  const { output } = nativeStreams();
  const message = frame({ id: 'reply', ok: true, data: { text: 'été', size: 'x'.repeat(300) } });
  await new Promise((resolve, reject) => output.write(message, error => error ? reject(error) : resolve()));
  assert.deepEqual(new Set(writes.map(({ fd }) => fd)), new Set([1]));
  assert.equal(writes.length, Math.ceil(message.length / 5));
  assert.ok(Buffer.concat(writes.map(({ bytes }) => bytes)).equals(message), 'the frame arrived whole and in order');
});

test('nativeStreams ends with an error when a write takes nothing or fails, and never throws from the write itself', async () => {
  let calls = 0;
  const closed = bridgeWithFs({ createReadStream: () => new PassThrough(), writeSync: () => {
    if (calls++) throw new Error('writeSync was called again after it wrote nothing.');
    return 0;
  } }).nativeStreams().output;
  const closedError = once(closed, 'error');
  closed.write(frame(UNLOCKED));
  assert.match((await closedError)[0].message, /^Native output pipe closed\.$/);
  assert.equal(calls, 1);

  const broken = bridgeWithFs({ createReadStream: () => new PassThrough(), writeSync: () => { throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }); } }).nativeStreams().output;
  const brokenError = once(broken, 'error');
  assert.doesNotThrow(() => broken.write(frame(UNLOCKED)));
  assert.equal((await brokenError)[0].code, 'EPIPE');
});

test('a native host on real descriptors 0 and 1 relays Chrome’s messages byte for byte', async t => {
  const directory = await temporary(t, 'secondhand-native-streams-');
  const long = 'é'.repeat(30000);
  const bridge = await startBridge(directory, () => EXTENSION, async request => request.id === 'long' ? { text: long } : { unlocked: false });
  t.after(() => bridge.close());
  const script = `const { nativeStreams, runNativeHost } = require(${JSON.stringify(path.join(root, 'desktop/bridge.cjs'))});
const { input, output } = nativeStreams();
runNativeHost(${JSON.stringify(directory)}, ${JSON.stringify(EXTENSION)}, input, output).then(() => process.exit(0), () => process.exit(1));`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const stdout = []; let stderr = '';
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'close');
  child.stdin.end(Buffer.concat([frame(STATUS), frame({ id: 'long', type: 'status' })]));
  const [code] = await within(exited, 'The native host process', 15000);
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  const expected = Buffer.concat([frame(UNLOCKED), frame({ id: 'long', ok: true, data: { text: long } })]);
  assert.ok(Buffer.concat(stdout).equals(expected), 'the answers arrived as exact frames, nothing else on the output');
});
