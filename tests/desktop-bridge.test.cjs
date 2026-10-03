'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { FrameReader, frame, extensionFromOrigin, validateRequest, startBridge, relayRequest, runNativeHost, appLaunch, startApp, MAX_MESSAGE_BYTES } = require('../desktop/bridge.cjs');
const { PORTAL_URL, PROFILE_FIELDS, REQUEST_FIELDS } = require('../shared/schema.cjs');
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
  // Progress records stay Iowa-only; field requests are gated by desktop site trust instead.
  for (const url of ['http://hhsservices.iowa.gov/apspssp/ssp.portal', `${PORTAL_URL}.evil`, 'https://hhsservices.iowa.gov.evil.test/apspssp/ssp.portal', 'https://person@hhsservices.iowa.gov/apspssp/ssp.portal', 'https://hhsservices.iowa.gov:444/apspssp/ssp.portal', 'https://hhsservices.iowa.gov/other']) {
    assert.throws(() => validateRequest({ id: 'x', type: 'recordProgress', url, filledCount: 1 }), /Iowa portal/);
  }
  for (const fields of [[], ['password'], ['firstName', 'firstName'], [null]]) assert.throws(() => validateRequest({ id: 'x', type: 'getFields', url: PORTAL_URL, fields }), /profile fields/);
  // Whether an SSN is saved is asked for like any saved field, alone or with every other one.
  assert.deepEqual(validateRequest({ id: 'x', type: 'getFields', url: PORTAL_URL, fields: ['birthDate', 'hasSsn'] }).fields, ['birthDate', 'hasSsn']);
  assert.equal(validateRequest({ id: 'x', type: 'getFields', url: PORTAL_URL, fields: [...REQUEST_FIELDS] }).fields.length, REQUEST_FIELDS.length);
  // The household list itself is never asked for: only the answers worked out from it.
  assert.throws(() => validateRequest({ id: 'x', type: 'getFields', url: PORTAL_URL, fields: ['householdMembers'] }), /profile fields/);
  assert.throws(() => validateRequest({ id: 'x', type: 'status', profile: {} }), /Unexpected/);
  // The extension says nothing about its own build or files: the app updates its copy from its own bundle.
  assert.throws(() => validateRequest({ id: 'x', type: 'status', build: '2026-10-03.1' }), /Unexpected/);
  assert.throws(() => validateRequest({ id: 'x', type: 'submit' }), /Unsupported/);
  for (const filledCount of [-1, 0, 1.5, 101, '2']) assert.throws(() => validateRequest({ id: 'x', type: 'recordProgress', url: PORTAL_URL, filledCount }), /count/);
});

test('showApp carries no data; assisted-session requests and tokens are no longer accepted', () => {
  assert.deepEqual(validateRequest({ id: 'show', type: 'showApp' }), { id: 'show', type: 'showApp' });
  assert.throws(() => validateRequest({ id: 'show', type: 'showApp', url: PORTAL_URL }), /Unexpected/);
  assert.throws(() => validateRequest({ id: 'x', type: 'getFields', url: PORTAL_URL, fields: ['firstName'], assistanceToken: 'a'.repeat(64) }), /Unexpected/);
  for (const type of ['startAssistedSession', 'checkAssistedSession', 'endAssistedSession']) assert.throws(() => validateRequest({ id: 'x', type, url: PORTAL_URL }), /Unsupported/);
  for (const extra of [{ tabId: 1 }, { profile: {} }]) assert.throws(() => validateRequest({ id: 'x', type: 'getFields', url: PORTAL_URL, fields: ['firstName'], ...extra }), /Unexpected/);
});

test('empty field authorization is limited to the two exact verified Iowa navigation endpoints', () => {
  for (const page of ['enterPersonalInfo', 'addressValidation']) {
    const url = `${PORTAL_URL}/applyForBenefits/${page}`;
    const request = { id: 'navigation', type: 'getFields', url, fields: [] };
    assert.deepEqual(validateRequest(request), request);
    for (const altered of [`${url}/`, `${url}?step=1`, `${url}#review`, url.replace(page, page.toUpperCase())]) {
      assert.throws(() => validateRequest({ ...request, url: altered }), /profile fields/);
    }
  }
  for (const url of [PORTAL_URL, `${PORTAL_URL}/applyForBenefits/dynamicQuestions`,
    `${PORTAL_URL}/applyForBenefits/addressValidationDQfuncPage`, 'https://pantry.example.org/intake',
    'https://hhsservices.iowa.gov/other/applyForBenefits/addressValidation']) {
    assert.throws(() => validateRequest({ id: 'navigation', type: 'getFields', url, fields: [] }), /profile fields/);
  }
  assert.throws(() => validateRequest({ id: 'navigation', type: 'getFields', url: `${PORTAL_URL}/applyForBenefits/addressValidation`, fields: [], assistanceToken: 'a'.repeat(64) }), /Unexpected/);
});

test('local bridge requires ephemeral token and registered extension; native host emits framed responses', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-bridge-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let handled = 0;
  const bridge = await startBridge(directory, () => EXTENSION, async (_request, context) => {
    assert.deepEqual(context, { extensionId: EXTENSION });
    handled++; return { unlocked: false, applicationCount: 0 };
  });
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

test('site trust requests carry only an https site URL; the desktop decides which sites are trusted', () => {
  const site = 'https://pantry.example.org/intake?x=1';
  assert.deepEqual(validateRequest({ id: 'trust', type: 'trustSite', url: site }), { id: 'trust', type: 'trustSite', url: site });
  for (const url of ['http://pantry.example.org/', 'https://a:b@pantry.example.org/', 'https://pantry.example.org:8443/', 'javascript:alert(1)', 'not a url']) {
    assert.throws(() => validateRequest({ id: 'trust', type: 'trustSite', url }), /https site/, url);
    assert.throws(() => validateRequest({ id: 'x', type: 'getFields', url, fields: ['firstName'] }), /https site/, url);
  }
  assert.throws(() => validateRequest({ id: 'trust', type: 'trustSite', url: site, fields: ['ssn'] }), /Unexpected/);
  assert.deepEqual(validateRequest({ id: 'off', type: 'untrustSite', url: site }), { id: 'off', type: 'untrustSite', url: site });
  for (const url of ['http://pantry.example.org/', 'https://pantry.example.org:8443/', 'not a url']) assert.throws(() => validateRequest({ id: 'off', type: 'untrustSite', url }), /https site/, url);
  assert.throws(() => validateRequest({ id: 'off', type: 'untrustSite', url: site, fields: ['ssn'] }), /Unexpected/);
  assert.deepEqual(validateRequest({ id: 'x', type: 'getFields', url: site, fields: ['firstName'] }).fields, ['firstName']);
  assert.throws(() => validateRequest({ id: 'x', type: 'recordProgress', url: site, filledCount: 1 }), /Iowa portal/);
});

test('turning all websites on or off carries nothing but the request itself', () => {
  for (const type of ['trustAllSites', 'untrustAllSites']) {
    assert.deepEqual(validateRequest({ id: 'all', type }), { id: 'all', type });
    for (const extra of [{ url: 'https://pantry.example.org/' }, { fields: ['ssn'] }, { origins: ['https://*/*'] }]) {
      assert.throws(() => validateRequest({ id: 'all', type, ...extra }), /Unexpected/, `${type} ${Object.keys(extra)}`);
    }
  }
});

const LAYA_SITE = 'https://pantry.example.org/intake?step=2';
const box = (extra = {}) => ({ id: 'f0:sh-1-2', label: 'Where can we email you?', type: 'email', options: [], ...extra });
const choice = (extra = {}) => ({ id: 'f4:sh-2-0', label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'], ...extra });
const suggest = (fields, extra = {}) => ({ id: 'laya-1', type: 'suggestFields', url: LAYA_SITE, fields, budgetMs: 3000, ...extra });
const answer = (questions, extra = {}) => ({ id: 'laya-2', type: 'answerFields', url: LAYA_SITE, questions, budgetMs: 2400, ...extra });
const many = (count, make) => Array.from({ length: count }, (_, index) => make({ id: `sh-1-${index}` }));

test('suggestFields carries up to 40 text-box labels, types, and options; answerFields up to 30 choice questions', () => {
  assert.deepEqual(validateRequest(suggest([box()])), suggest([box()]));
  assert.deepEqual(validateRequest(answer([choice()])), answer([choice()]));
  assert.equal(validateRequest(suggest(many(40, box))).fields.length, 40);
  assert.throws(() => validateRequest(suggest(many(41, box))), /questions/);
  assert.equal(validateRequest(answer(many(30, choice))).questions.length, 30);
  assert.throws(() => validateRequest(answer(many(31, choice))), /questions/);
  for (const type of ['text', 'textarea', 'number', 'date', 'email', 'tel']) assert.equal(validateRequest(suggest([box({ type })])).fields[0].type, type);
  for (const type of ['radio', 'select', 'checkbox']) assert.equal(validateRequest(answer([choice({ type })])).questions[0].type, type);
  assert.equal(validateRequest(suggest([box({ id: 'sh-1-2' })])).fields[0].id, 'sh-1-2', 'Iowa’s general engine ids have no frame prefix');
  assert.equal(validateRequest(suggest([box({ label: 'L'.repeat(200) })])).fields.length, 1);
  assert.equal(validateRequest(answer([choice({ options: Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, '0')}${'O'.repeat(98)}`) })])).questions.length, 1);
});

test('Laya requests outside the limits, with the wrong question type, or with anything but labels and options are refused', () => {
  const refused = [
    suggest([]), answer([]), suggest('email'), answer([null]),
    suggest([box({ label: 'L'.repeat(201) })]), suggest([box({ label: '   ' })]), suggest([box({ label: 'Email\u0000' })]),
    answer([choice({ options: [...many(31, () => 'x').map((_, index) => `Option ${index}`)] })]), answer([choice({ options: ['Yes', 'N'.repeat(101)] })]),
    answer([choice({ options: [] })]), answer([choice({ options: ['Yes', 'Yes'] })]), answer([choice({ options: ['Yes', ''] })]), answer([choice({ options: 'Yes' })]),
    suggest([box({ type: 'radio' })]), suggest([box({ type: 'password' })]), answer([choice({ type: 'text' })]), answer([choice({ type: 'listbox' })]),
    suggest([box(), box()]), suggest([box({ id: 'input[type=password]' })]), suggest([box({ id: 'f1234567:sh-1' })]), suggest([box({ id: 7 })])
  ];
  for (const request of refused) assert.throws(() => validateRequest(request), /question/i, JSON.stringify(request).slice(0, 160));
  // A saved answer can never ride along: not on a question, and not on the request.
  for (const extra of [{ value: 'Synthetic private' }, { key: 'email' }, { values: {} }, { facts: 'The applicant is 41 years old.' }, { required: true }]) {
    assert.throws(() => validateRequest(suggest([box(extra)])), /Unexpected question field/, JSON.stringify(extra));
    assert.throws(() => validateRequest(answer([choice(extra)])), /Unexpected question field/, JSON.stringify(extra));
  }
  for (const extra of [{ values: { email: 'synthetic@example.org' } }, { profile: {} }, { fields: [box()] }, { facts: 'x' }]) {
    assert.throws(() => validateRequest(answer([choice()], extra)), /Unexpected request field/, JSON.stringify(extra));
  }
  assert.throws(() => validateRequest(suggest([box()], { questions: [choice()] })), /Unexpected request field/);
});

test('each Laya request carries the milliseconds its Autofill click has left: a whole number from 1 to 3000', () => {
  for (const budgetMs of [1, 1500, 3000]) {
    assert.equal(validateRequest(suggest([box()], { budgetMs })).budgetMs, budgetMs);
    assert.equal(validateRequest(answer([choice()], { budgetMs })).budgetMs, budgetMs);
  }
  for (const budgetMs of [0, -1, 3001, 1.5, '3000', null, undefined, NaN]) {
    assert.throws(() => validateRequest(suggest([box()], { budgetMs })), /time budget/, String(budgetMs));
    assert.throws(() => validateRequest(answer([choice()], { budgetMs })), /time budget/, String(budgetMs));
  }
  const { budgetMs, ...without } = suggest([box()]);
  assert.equal(budgetMs, 3000);
  assert.throws(() => validateRequest(without), /time budget/);
});

test('Laya requests name an https site or Iowa’s portal; the desktop checks that the site is trusted', () => {
  assert.equal(validateRequest(answer([choice()], { url: `${PORTAL_URL}/applyForBenefits/financialInfo` })).url, `${PORTAL_URL}/applyForBenefits/financialInfo`);
  for (const url of ['http://pantry.example.org/', 'https://a:b@pantry.example.org/', 'https://pantry.example.org:8443/', 'javascript:alert(1)', 'not a url', undefined]) {
    assert.throws(() => validateRequest(suggest([box()], { url })), /https site/, String(url));
    assert.throws(() => validateRequest(answer([choice()], { url })), /https site/, String(url));
  }
});

test('a "Laya not ready" refusal keeps its code through the local bridge; other failures carry no code', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-bridge-laya-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bridge = await startBridge(directory, () => EXTENSION, async request => {
    if (request.type === 'suggestFields') throw Object.assign(new Error('Laya isn’t ready on this computer.'), { publicMessage: 'Laya isn’t ready on this computer.', publicCode: 'LAYA_NOT_READY' });
    if (request.type === 'answerFields') throw Object.assign(new Error('internal'), { publicCode: 'LAYA_NOT_READY' });
    throw Object.assign(new Error('Unlock SecondHand first.'), { publicMessage: 'Unlock SecondHand first.', publicCode: 'SOMETHING_ELSE' });
  });
  t.after(() => bridge.close());
  assert.deepEqual(await relayRequest(directory, EXTENSION, suggest([box()])), { id: 'laya-1', ok: false, error: 'Laya isn’t ready on this computer.', code: 'LAYA_NOT_READY' });
  assert.deepEqual(await relayRequest(directory, EXTENSION, answer([choice()])), { id: 'laya-2', ok: false, error: 'The request could not be completed. Check the desktop app.' },
    'only a public refusal carries a code');
  assert.deepEqual(await relayRequest(directory, EXTENSION, { id: 'status-1', type: 'status' }), { id: 'status-1', ok: false, error: 'Unlock SecondHand first.' });
});

test('warmLaya carries nothing but its id: it only readies Laya’s model before a click’s questions are asked', () => {
  assert.deepEqual(validateRequest({ id: 'warm-1', type: 'warmLaya' }), { id: 'warm-1', type: 'warmLaya' });
  for (const extra of [{ url: LAYA_SITE }, { fields: [box()] }, { questions: [choice()] }, { budgetMs: 3000 }]) {
    assert.throws(() => validateRequest({ id: 'warm-1', type: 'warmLaya', ...extra }), /Unexpected/, JSON.stringify(extra));
  }
});

// One native host session as Chrome runs it: framed requests in, decoded responses out.
async function hostSession(directory, requests, launchApp) {
  const input = new PassThrough(); const output = new PassThrough();
  const decoded = new FrameReader(); const responses = [];
  output.on('data', chunk => decoded.push(chunk));
  decoded.on('message', message => responses.push(message));
  const native = runNativeHost(directory, EXTENSION, input, output, launchApp);
  input.end(Buffer.concat(requests.map(frame)));
  await native;
  output.destroy();
  return responses;
}
// Stand-in for child_process.spawn: records each call. The child starts, or fails with `failure`.
function fakeSpawn(failure) {
  const calls = [];
  const spawn = (command, args, options) => {
    const call = { command, args, options, unref: false };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), { unref: () => { call.unref = true; } });
    process.nextTick(() => failure ? child.emit('error', failure) : child.emit('spawn'));
    return child;
  };
  return { spawn, calls };
}
const temporary = async (t, name) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
};

test('openApp carries nothing but its id: no command, path, or argument can ride along', () => {
  assert.deepEqual(validateRequest({ id: 'open-1', type: 'openApp' }), { id: 'open-1', type: 'openApp' });
  for (const extra of [{ url: PORTAL_URL }, { command: '/bin/sh' }, { args: ['--inspect'] }, { path: '/Applications/Other.app' }, { env: { SECONDHAND_USER_DATA: '/elsewhere' } }]) {
    assert.throws(() => validateRequest({ id: 'open-1', type: 'openApp', ...extra }), /Unexpected/, JSON.stringify(extra));
  }
});

test('the host starts SecondHand as its own executable: packaged with no arguments, in development with the app path, keeping the data folder and dropping test settings', () => {
  const env = { PATH: '/usr/bin', HOME: '/synthetic-home', SECONDHAND_USER_DATA: '/synthetic-data', SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: '/tmp/synthetic-test' };
  const kept = { PATH: '/usr/bin', HOME: '/synthetic-home', SECONDHAND_USER_DATA: '/synthetic-data' };
  assert.deepEqual(appLaunch({ execPath: '/Applications/secondHand.app/Contents/MacOS/secondHand', appPath: '/Applications/secondHand.app/Contents/Resources/app.asar', packaged: true, env }),
    { command: '/Applications/secondHand.app/Contents/MacOS/secondHand', args: [], options: { detached: true, stdio: 'ignore', env: kept } });
  assert.deepEqual(appLaunch({ execPath: '/synthetic/electron', appPath: '/synthetic/secondHand', packaged: false, env }),
    { command: '/synthetic/electron', args: ['/synthetic/secondHand'], options: { detached: true, stdio: 'ignore', env: kept } });
  assert.equal(env.SECONDHAND_TEST_MODE, '1', 'the host’s own environment is left as it was');
});

test('startApp resolves once the app process has started and lets it outlive the host; a failed start rejects', async () => {
  const launch = { command: '/synthetic/electron', args: ['/synthetic/secondHand'], options: { detached: true, stdio: 'ignore', env: {} } };
  const started = fakeSpawn();
  await startApp(launch, started.spawn);
  assert.deepEqual(started.calls, [{ ...launch, unref: true }]);
  const failed = fakeSpawn(Object.assign(new Error('spawn /synthetic/electron ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(startApp(launch, failed.spawn), { code: 'ENOENT' });
});

test('openApp brings a running SecondHand forward through the bridge and starts nothing', async t => {
  const directory = await temporary(t, 'secondhand-open-shown-');
  const seen = [];
  const bridge = await startBridge(directory, () => EXTENSION, async request => { seen.push(request); return { shown: true }; });
  t.after(() => bridge.close());
  let launches = 0;
  const responses = await hostSession(directory, [{ id: 'open-1', type: 'openApp' }], async () => { launches++; });
  assert.deepEqual(seen, [{ id: 'open-1', type: 'showApp' }]);
  assert.deepEqual(responses, [{ id: 'open-1', ok: true, data: { opened: 'shown' } }]);
  assert.equal(launches, 0);
});

test('a running SecondHand that refuses to come forward answers for itself, and nothing is started', async t => {
  const directory = await temporary(t, 'secondhand-open-refused-');
  const bridge = await startBridge(directory, () => 'b'.repeat(32), async () => assert.fail('an unregistered extension reached the handler'));
  t.after(() => bridge.close());
  let launches = 0;
  const responses = await hostSession(directory, [{ id: 'open-1', type: 'openApp' }], async () => { launches++; });
  assert.deepEqual(responses, [{ id: 'open-1', ok: false, error: 'The extension is not connected to this desktop app.' }]);
  assert.equal(launches, 0);
});

test('openApp starts SecondHand when it isn’t running, and only once per host however often it is asked', async t => {
  const directory = await temporary(t, 'secondhand-open-launch-');
  const { spawn, calls } = fakeSpawn();
  const launch = appLaunch({ execPath: '/synthetic/electron', appPath: '/synthetic/secondHand', packaged: false, env: { SECONDHAND_USER_DATA: directory, SECONDHAND_TEST_MODE: '1' } });
  const responses = await hostSession(directory, [{ id: 'open-1', type: 'openApp' }, { id: 'open-2', type: 'openApp' }], () => startApp(launch, spawn));
  assert.deepEqual(responses, [{ id: 'open-1', ok: true, data: { opened: 'launched' } }, { id: 'open-2', ok: true, data: { opened: 'launched' } }]);
  assert.deepEqual(calls, [{ command: '/synthetic/electron', args: ['/synthetic/secondHand'], options: { detached: true, stdio: 'ignore', env: { SECONDHAND_USER_DATA: directory } }, unref: true }]);
});

test('a launch that fails answers a plain failure without local paths, never success', async t => {
  const directory = await temporary(t, 'secondhand-open-failed-');
  const { spawn, calls } = fakeSpawn(Object.assign(new Error('spawn /synthetic/electron ENOENT'), { code: 'ENOENT' }));
  const launch = appLaunch({ execPath: '/synthetic/electron', appPath: '/synthetic/secondHand', packaged: false, env: {} });
  const responses = await hostSession(directory, [{ id: 'open-1', type: 'openApp' }, { id: 'open-2', type: 'openApp' }], () => startApp(launch, spawn));
  assert.deepEqual(responses, [{ id: 'open-1', ok: false, error: 'SecondHand could not be started (ENOENT).' }, { id: 'open-2', ok: false, error: 'SecondHand could not be started (ENOENT).' }]);
  assert.equal(calls.length, 1, 'a failed start is not retried by the same host');
});

test('without a running app, requests answer that SecondHand can’t be reached, with a code the extension acts on; malformed ones say what was wrong', async t => {
  const directory = await temporary(t, 'secondhand-host-closed-');
  let launches = 0;
  const responses = await hostSession(directory, [{ id: 'status-1', type: 'status' }, { id: 'show-1', type: 'showApp' }, { id: 'bad-1', type: 'status', profile: {} }, { id: 'bad-2', type: 'submit' }],
    async () => { launches++; });
  const unreachable = id => ({ id, ok: false, error: 'Open SecondHand, connect this extension, and unlock SecondHand.', code: 'DESKTOP_UNREACHABLE' });
  assert.deepEqual(responses, [unreachable('status-1'), unreachable('show-1'),
    { id: 'bad-1', ok: false, error: 'Unexpected request field.' }, { id: 'bad-2', ok: false, error: 'Unsupported bridge request.' }]);
  assert.equal(launches, 0, 'only openApp starts the app');
});
