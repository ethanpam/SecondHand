'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { FrameReader, frame, extensionFromOrigin, validateRequest, startBridge, relayRequest, runNativeHost, MAX_MESSAGE_BYTES } = require('../desktop/bridge.cjs');
const { PORTAL_URL } = require('../shared/schema.cjs');
const EXTENSION = 'a'.repeat(32);

test('native frames handle split headers, split UTF-8, and multiple messages', () => {
  const reader = new FrameReader();
  const values = [];
  reader.on('message', value => values.push(value));
  reader.on('invalid', () => assert.fail('valid stream rejected'));
  const messages = [{ id: 'one', text: 'été' }, { id: 'two', ok: true }];
  const bytes = Buffer.concat(messages.map(frame));
  for (const byte of bytes) reader.push(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(values, messages);
});

test('native frames reject zero/oversized lengths, malformed JSON, and truncated payloads', () => {
  for (const size of [0, 1, MAX_MESSAGE_BYTES + 1, 0xffffffff]) {
    const reader = new FrameReader(); let invalid = 0;
    reader.on('invalid', () => invalid++);
    const header = Buffer.alloc(4); header.writeUInt32LE(size); reader.push(header);
    assert.equal(invalid, 1);
  }
  const reader = new FrameReader(); let invalid = 0;
  reader.on('invalid', () => invalid++);
  reader.push(Buffer.from([2, 0, 0, 0, 123, 33]));
  assert.equal(invalid, 1);
  const truncated = new FrameReader(); truncated.on('invalid', () => invalid++);
  truncated.push(frame({ id: 'x' }).subarray(0, 7)); truncated.end();
  assert.equal(invalid, 2);
});

test('Chrome native origins and Iowa portal requests use strict allowlists', () => {
  assert.equal(extensionFromOrigin(`chrome-extension://${EXTENSION}/`), EXTENSION);
  for (const origin of [`chrome-extension://${EXTENSION}/page`, `https://${EXTENSION}/`, `chrome-extension://${'z'.repeat(32)}/`, `chrome-extension://${EXTENSION}.evil/`]) assert.equal(extensionFromOrigin(origin), null);
  assert.deepEqual(validateRequest({ id: 'request-1', type: 'getFields', url: PORTAL_URL, fields: ['firstName'] }).fields, ['firstName']);
  for (const url of ['http://hhsservices.iowa.gov/apspssp/ssp.portal', `${PORTAL_URL}.evil`, 'https://hhsservices.iowa.gov.evil.test/apspssp/ssp.portal', 'https://person@hhsservices.iowa.gov/apspssp/ssp.portal', 'https://hhsservices.iowa.gov:444/apspssp/ssp.portal', 'https://hhsservices.iowa.gov/other']) {
    assert.throws(() => validateRequest({ id: 'x', type: 'getFields', url, fields: ['firstName'] }), /Iowa portal/);
  }
  for (const fields of [[], ['password'], ['firstName', 'firstName'], [null]]) assert.throws(() => validateRequest({ id: 'x', type: 'getFields', url: PORTAL_URL, fields }), /profile fields/);
  assert.throws(() => validateRequest({ id: 'x', type: 'status', profile: {} }), /Unexpected/);
  assert.throws(() => validateRequest({ id: 'x', type: 'submit' }), /Unsupported/);
  for (const filledCount of [-1, 0, 1.5, 101, '2']) assert.throws(() => validateRequest({ id: 'x', type: 'recordProgress', url: PORTAL_URL, filledCount }), /count/);
});

test('local bridge requires ephemeral token and registered extension; native host emits framed responses', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-bridge-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let handled = 0;
  const bridge = await startBridge(directory, () => EXTENSION, async () => { handled++; return { unlocked: false, applicationCount: 0 }; });
  t.after(() => bridge.close());
  const request = { id: 'status-1', type: 'status' };
  const response = await relayRequest(directory, EXTENSION, request);
  assert.deepEqual(response, { id: request.id, ok: true, data: { unlocked: false, applicationCount: 0 } });
  const rejected = await relayRequest(directory, 'b'.repeat(32), request);
  assert.equal(rejected.ok, false);
  assert.equal(handled, 1);
  const session = JSON.parse(await fs.readFile(path.join(directory, 'bridge-session.json'), 'utf8'));
  const badToken = await new Promise((resolve, reject) => {
    const socket = net.createConnection(session.socketPath);
    const reader = new FrameReader();
    socket.on('error', reject);
    socket.on('connect', () => socket.write(frame({ token: '0'.repeat(64), extensionId: EXTENSION, request })));
    socket.on('data', chunk => reader.push(chunk));
    reader.on('message', value => { socket.destroy(); resolve(value); });
  });
  assert.equal(badToken.ok, false);
  assert.equal(handled, 1);
  const input = new PassThrough(); const output = new PassThrough();
  const decoded = new FrameReader(); const nativeResponses = [];
  output.on('data', chunk => decoded.push(chunk));
  decoded.on('message', message => nativeResponses.push(message));
  const native = runNativeHost(directory, EXTENSION, input, output);
  input.end(frame(request));
  await native;
  assert.deepEqual(nativeResponses, [response]);
  output.destroy();
});
