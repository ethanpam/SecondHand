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

test('custom answers have bounded question-only metadata and never permit Iowa, arbitrary fields or source values', () => {
  const request = { id: 'custom', type: 'getCustomFields', url: 'https://pantry.example.org/form', fields: [{ id: 'field1', label: 'Pickup location', type: 'text' }] };
  assert.deepEqual(validateRequest(request), request);
  for (const change of [{ url: PORTAL_URL }, { url: 'http://pantry.example.org' }, { url: 'https://person@pantry.example.org' }, { fields: ['customFields'] }, { values: {} }, { fields: [{ ...request.fields[0], value: 'private' }] }, { fields: [] }]) assert.throws(() => validateRequest({ ...request, ...change }));
  assert.throws(() => validateRequest({ id: 'old', type: 'getFields', url: request.url, fields: ['customFields'] }));
});

test('general navigation authorization carries only a non-Iowa HTTPS URL, never fields or click selectors', () => {
  const request = { id: 'next', type: 'authorizeSiteNavigation', url: 'https://pantry.example.org/form' };
  assert.deepEqual(validateRequest(request), request);
  for (const change of [{ url: PORTAL_URL }, { url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions` }, { url: 'http://pantry.example.org' }, { selector: 'button' }, { fields: [] }, { sensitive: true }]) assert.throws(() => validateRequest({ ...request, ...change }));
});

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

test('empty field authorization is limited to exact Iowa endpoints with separately verified navigation adapters', () => {
  for (const page of ['enterPersonalInfo', 'addressValidation', 'dynamicQuestions', 'dynamicQuestionsStart', 'ssaVerificationRender']) {
    const url = `${PORTAL_URL}/applyForBenefits/${page}`;
    const request = { id: 'navigation', type: 'getFields', url, fields: [] };
    assert.deepEqual(validateRequest(request), request);
    for (const altered of [`${url}/`, `${url}?step=1`, `${url}#review`, url.replace(page, page.toUpperCase())]) {
      assert.throws(() => validateRequest({ ...request, url: altered }), /profile fields/);
    }
  }
  for (const url of [PORTAL_URL, `${PORTAL_URL}/applyForBenefits/dynamicQuestionsResume`,
    `${PORTAL_URL}/applyForBenefits/eSignature`,
    `${PORTAL_URL}/applyForBenefits/enterPersonalInfoSummary`, `${PORTAL_URL}/applyForBenefits/iaReminderAboutYourRights`,
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

test('Fill sensitive details asks for the held fields with sensitive: true, on an https site other than Iowa’s portal (#176)', () => {
  const request = { id: 'held', type: 'getFields', url: 'https://pantry.example.org/intake', fields: ['ssn', 'birthDate'], sensitive: true };
  assert.deepEqual(validateRequest(request), request);
  for (const sensitive of [false, 'true', 1, null]) assert.throws(() => validateRequest({ ...request, sensitive }), /sensitive details/, JSON.stringify(sensitive));
  assert.throws(() => validateRequest({ ...request, fields: [] }), /profile fields/);
  assert.throws(() => validateRequest({ ...request, url: PORTAL_URL }), /sensitive details/, 'Iowa’s portal holds nothing back');
  assert.throws(() => validateRequest({ ...request, url: `${PORTAL_URL}/applyForBenefits/enterPersonalInfo`, fields: [] }), /sensitive details/, 'nor is it a navigation authorization');
  for (const type of ['saveFields', 'trustSite', 'answerFields']) assert.throws(() => validateRequest({ ...request, type }), /Unexpected|answers|questions/, type);
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

// Characters that reorder, hide, or break the words around them. A label or option is shown in the desktop's
// approval dialog (“label”: option), and an option is the exact text the extension fills.
const UNSEEN = Object.freeze({
  'right-to-left override': '\u202E', 'left-to-right override': '\u202D', 'right-to-left embedding': '\u202B', 'pop directional formatting': '\u202C',
  'right-to-left isolate': '\u2067', 'first strong isolate': '\u2068', 'pop directional isolate': '\u2069',
  'right-to-left mark': '\u200F', 'left-to-right mark': '\u200E', 'Arabic letter mark': '\u061C',
  'zero-width space': '\u200B', 'word joiner': '\u2060', 'invisible separator': '\u2063',
  'byte order mark': '\uFEFF', 'soft hyphen': '\u00AD', 'combining grapheme joiner': '\u034F', 'Hangul filler': '\u3164', 'variation selector': '\uFE0F',
  'interlinear annotation anchor': '\uFFF9', 'tag letter': '\u{E0041}', 'language tag': '\u{E0001}',
  'line separator': '\u2028', 'paragraph separator': '\u2029', 'next line (C1)': '\u0085', 'control sequence introducer (C1)': '\u009B'
});

test('labels and options with bidi controls, invisible characters, or line breaks are refused, so a page can’t reorder or hide words in a desktop dialog', () => {
  for (const [name, character] of Object.entries(UNSEEN)) {
    assert.throws(() => validateRequest(suggest([box({ label: `Where can we email you?${character}` })])), /question label/, name);
    assert.throws(() => validateRequest(answer([choice({ label: `${character}Is anyone in your household 60 or older?` })])), /question label/, name);
    assert.throws(() => validateRequest(answer([choice({ options: ['Yes', `N${character}o`] })])), /question options/, name);
    assert.throws(() => validateRequest(suggest([box({ options: [`Home${character}`] })])), /question options/, name);
  }
  // Words in any language, with accents, typographic punctuation, no-break spaces, and emoji, are asked as they are.
  for (const text of ['¿Cuántas personas viven en su hogar?', 'Số người trong hộ gia đình', 'كم عدد الأشخاص في أسرتك؟', 'כמה אנשים גרים בבית?',
    'Household size\u00A0(people)', '“Monthly” income – before taxes', '📧 Email']) {
    assert.equal(validateRequest(suggest([box({ label: text })])).fields[0].label, text, text);
    assert.deepEqual(validateRequest(answer([choice({ options: [text, 'No'] })])).questions[0].options, [text, 'No'], text);
  }
});

// Words that need U+200C ZERO WIDTH NON-JOINER or U+200D ZERO WIDTH JOINER to be written right.
const JOINED = Object.freeze({
  'Persian, with a non-joiner': 'می\u200Cخواهید', 'a Persian name, with a non-joiner': 'زهرا\u200Cسادات',
  'Hindi, with a joiner': 'क्\u200Dष', 'an emoji family, with joiners': '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
});

test('the non-joiner and joiner that Persian, Arabic, and Indic words need are allowed in labels, options, and saved answers', () => {
  for (const [name, text] of Object.entries(JOINED)) {
    assert.equal(validateRequest(suggest([box({ label: `${text}?` })])).fields[0].label, `${text}?`, name);
    assert.deepEqual(validateRequest(answer([choice({ options: [text, 'No'] })])).questions[0].options, [text, 'No'], name);
    assert.deepEqual(validateRequest({ id: 'x', type: 'saveFields', url: 'https://pantry.example.org/intake', fields: { firstName: text } }).fields, { firstName: text }, name);
  }
});

test('saved answers with bidi controls, invisible characters, or line breaks are refused, so a page can’t disguise what the save dialog shows', () => {
  const save = value => validateRequest({ id: 'x', type: 'saveFields', url: 'https://pantry.example.org/intake', fields: { city: value } });
  for (const [name, character] of Object.entries(UNSEEN)) {
    assert.throws(() => save(`Ames${character}`), /answers to save/, name);
    assert.throws(() => save(`${character}Ames`), /answers to save/, name);
  }
  assert.deepEqual(save('Ames').fields, { city: 'Ames' });
});

test('the extension leaves to the applicant exactly the labels and options the bridge refuses, character for character', () => {
  const { layaQuestion } = require('../extension/generic-adapter.js');
  const bridgeTakes = text => { try { validateRequest(answer([choice({ label: text, options: [text, 'No'] })])); return true; } catch { return false; } };
  const extensionTakes = text => layaQuestion({ label: text, type: 'radio', options: [text, 'No'] }) === 'choice';
  const differ = [];
  for (const [first, last] of [[0, 0xFFFF], [0x1D100, 0x1D1FF], [0x1BC00, 0x1BCFF], [0xE0000, 0xE0FFF]]) {
    for (let code = first; code <= last; code++) {
      const text = `Pickup ${String.fromCodePoint(code)} day`;
      if (bridgeTakes(text) !== extensionTakes(text)) differ.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  assert.deepEqual(differ, []);
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
  const env = { PATH: '/usr/bin', HOME: '/synthetic-home', SECONDHAND_USER_DATA: '/synthetic-data', SECONDHAND_TEST_MODE: '1', SECONDHAND_TEST_USER_DATA: '/tmp/synthetic-test',
    SECONDHAND_TEST_TOUCH_ID: 'approve' };
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

test('field requests may name age-band counts and the student answer, read strictly; never the household list', () => {
  const ask = fields => validateRequest({ id: 'x', type: 'getFields', url: 'https://pantry.example.org/intake', fields });
  assert.deepEqual(ask(['householdCount:0-17', 'householdCount:18-59', 'householdCount:60+', 'studentNameGrade']).fields,
    ['householdCount:0-17', 'householdCount:18-59', 'householdCount:60+', 'studentNameGrade']);
  for (const fields of [['householdCount:10-5'], ['householdCount:05-10'], ['householdCount:121+'], ['householdCount:'], ['householdCount:0–5'], ['householdMembers'],
    ['householdCount:0-5', 'householdCount:0-5']]) assert.throws(() => ask(fields), /profile fields/, JSON.stringify(fields));
  const bands = Array.from({ length: 20 }, (_, n) => `householdCount:${n}+`);
  assert.equal(ask([...REQUEST_FIELDS, ...bands]).fields.length, REQUEST_FIELDS.length + 20);
  assert.throws(() => ask([...bands, 'householdCount:20+']), /profile fields/, 'at most 20 band counts in one request');
});

test('saveFields carries an https site and answers for saved profile fields only, each a short plain string', () => {
  const save = (fields, extra = {}) => validateRequest({ id: 'x', type: 'saveFields', url: 'https://pantry.example.org/intake', fields, ...extra });
  assert.deepEqual(save({ addressLine2: 'Unit 5' }).fields, { addressLine2: 'Unit 5' });
  assert.deepEqual(validateRequest({ id: 'x', type: 'saveFields', url: `${PORTAL_URL}/applyForBenefits/enterPersonalInfo`, fields: { county: 'Story' } }).fields, { county: 'Story' });
  assert.deepEqual(Object.keys(save({ city: 'Ames', zip: '50011', birthDate: '1985-04-12', householdVeteran: 'no' }).fields), ['city', 'zip', 'birthDate', 'householdVeteran']);
  const refused = {
    'no answers': {}, 'an array': [['city', 'Ames']], 'a string': 'city=Ames', 'nothing': null,
    'a Social Security number': { ssn: '123-45-6789' }, 'a derived answer': { hasSsn: 'yes' }, 'a band count': { 'householdCount:0-5': '1' },
    'the household list': { householdMembers: '[]' }, 'an unknown field': { password: 'secret' }, 'a composite': { fullName: 'Avery Example' },
    'a number': { householdSize: 3 }, 'an empty answer': { city: '   ' }, 'a long answer': { city: 'x'.repeat(201) }, 'a control character': { city: 'Am\u0000es' },
    'a nested value': { city: { name: 'Ames' } }, 'an inherited object': Object.create({ city: 'Ames' })
  };
  for (const [name, fields] of Object.entries(refused)) assert.throws(() => save(fields), /answers to save/, name);
  for (const url of ['http://pantry.example.org/intake', 'https://user@pantry.example.org/', 'https://pantry.example.org:8443/', 'not a url']) {
    assert.throws(() => validateRequest({ id: 'x', type: 'saveFields', url, fields: { city: 'Ames' } }), /https site/, url);
  }
  assert.throws(() => save({ city: 'Ames' }, { values: { city: 'Ames' } }), /Unexpected/);
  assert.throws(() => save({ city: 'Ames' }, { confirmed: true }), /Unexpected/, 'a request can’t say it was confirmed: only the app asks');
});

test('unlockWithTouchId carries nothing but its id: the app shows its own Touch ID prompt, and no password ever comes from Chrome', () => {
  assert.deepEqual(validateRequest({ id: 'touch-1', type: 'unlockWithTouchId' }), { id: 'touch-1', type: 'unlockWithTouchId' });
  for (const extra of [{ url: PORTAL_URL }, { password: 'synthetic password' }, { reason: 'unlock SecondHand' }, { fields: ['firstName'] }]) {
    assert.throws(() => validateRequest({ id: 'touch-1', type: 'unlockWithTouchId', ...extra }), /Unexpected/, JSON.stringify(extra));
  }
});

test('the app’s unlockWithTouchId answer reaches the extension as it is, through the bridge and the native host', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'secondhand-bridge-touch-id-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const answers = [{ unlocked: false, reason: 'cancelled' }, { unlocked: true }];
  const bridge = await startBridge(directory, () => EXTENSION, async request => {
    assert.equal(request.type, 'unlockWithTouchId');
    return answers.shift();
  });
  t.after(() => bridge.close());
  assert.deepEqual(await relayRequest(directory, EXTENSION, { id: 'touch-1', type: 'unlockWithTouchId' }), { id: 'touch-1', ok: true, data: { unlocked: false, reason: 'cancelled' } });
  const responses = await hostSession(directory, [{ id: 'touch-2', type: 'unlockWithTouchId' }]);
  assert.deepEqual(responses, [{ id: 'touch-2', ok: true, data: { unlocked: true } }]);
});

// One envelope written straight to the desktop's socket, as a host that skipped its own checks would send it.
async function unchecked(directory, request) {
  const session = JSON.parse(await fs.readFile(path.join(directory, 'bridge-session.json'), 'utf8'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(session.socketPath);
    const reader = new FrameReader();
    socket.on('error', reject);
    socket.on('connect', () => socket.write(frame({ token: session.token, extensionId: EXTENSION, request })));
    socket.on('data', chunk => reader.push(chunk));
    reader.on('message', value => { socket.destroy(); resolve(value); });
  });
}

test('the desktop refuses a label or option with a bidi control or invisible character even when the host let it through', async t => {
  const directory = await temporary(t, 'secondhand-bridge-unseen-');
  let reached = 0;
  const bridge = await startBridge(directory, () => EXTENSION, async () => { reached++; return { answers: {}, accessRevision: 1 }; });
  t.after(() => bridge.close());
  const refused = { id: 'laya-2', ok: false, error: 'The request could not be completed. Check the desktop app.' };
  assert.deepEqual(await unchecked(directory, answer([choice({ label: 'Can we share your answers?\u202E' })])), refused);
  assert.deepEqual(await unchecked(directory, answer([choice({ options: ['Yes', 'Ye\u200Bs'] })])), refused);
  assert.equal(reached, 0);
  assert.deepEqual(await unchecked(directory, answer([choice()])), { id: 'laya-2', ok: true, data: { answers: {}, accessRevision: 1 } });
});

test('a request too large to reach the desktop beside the session token is refused with its reason, never thrown from the relay', async t => {
  const directory = await temporary(t, 'secondhand-bridge-oversized-');
  const seen = [];
  const bridge = await startBridge(directory, () => EXTENSION, async request => { seen.push(request.id); return { trusted: true }; });
  t.after(() => bridge.close());
  // The host sends each request to the desktop with the session token and the extension ID beside it.
  const envelope = Buffer.byteLength(JSON.stringify({ token: '0'.repeat(64), extensionId: EXTENSION, request: {} })) - '{}'.length;
  const sized = (id, bytes) => {
    const request = { id, type: 'trustSite', url: 'https://pantry.example.org/?q=' };
    request.url += 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(request)));
    return request;
  };
  const largest = sized('largest', MAX_MESSAGE_BYTES - envelope);
  const over = sized('over', MAX_MESSAGE_BYTES - envelope + 1);
  assert.equal(Buffer.byteLength(JSON.stringify(over)), MAX_MESSAGE_BYTES - envelope + 1);
  assert.deepEqual(validateRequest(largest), largest);
  assert.throws(() => validateRequest(over), /^Error: Request exceeds the local bridge limit\.$/);
  // Chrome can send either one: both fit in a native message. The host relays the first and answers the other itself.
  const responses = await hostSession(directory, [over, largest]);
  assert.deepEqual(responses, [{ id: 'over', ok: false, error: 'Request exceeds the local bridge limit.' }, { id: 'largest', ok: true, data: { trusted: true } }]);
  assert.deepEqual(seen, ['largest']);
});

test('record requests require the exact captured job page, explicit owner field, and narrow projection', () => {
  const request = { id: 'job', type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`,
    pageKey: 'iowa-job-history', recordType: 'jobs', fields: ['person', 'employer', 'monthlyHours'], personName: ' Avery  Example ' };
  assert.deepEqual(validateRequest(request), request);
  assert.doesNotThrow(() => validateRequest({ ...request, personName: '' }));
  for (const change of [
    { url: PORTAL_URL }, { url: `${request.url}/` }, { url: `${request.url}?step=1` }, { url: `${request.url}#job` },
    { url: request.url.replace('dynamicQuestions', 'dynamicQuestionsStart') }, { url: 'https://pantry.example.org/intake' },
    { pageKey: 'iowa-income' }, { pageKey: '__proto__' }, { recordType: 'taxStatements' }, { recordType: 'assets' },
    { fields: [] }, { fields: ['employer'] }, { fields: ['person', 'person'] }, { fields: ['person', 'ssn'] },
    { fields: ['person', 'hoursPerWeek'] }, { fields: ['person', 'annualIncome'] }, { fields: ['person', 'householdMembers'] },
    { personName: null }, { personName: 2 }, { personName: 'x'.repeat(201) }, { personName: 'Other\u202Eperson' }, { personName: 'Avery\nExample' },
    { recordId: 'chosen-by-browser' }, { records: [] }, { profile: {} }
  ]) assert.throws(() => validateRequest({ ...request, ...change }), JSON.stringify(change));
  for (const field of ['jobs', 'jobs.person', 'taxStatements']) {
    assert.throws(() => validateRequest({ id: 'ordinary', type: 'getFields', url: request.url, fields: [field] }), /profile fields/);
  }
});

test('retirement requests permit only the observed owner/type/amount/frequency projection', () => {
  const request = { id: 'pension', type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`,
    pageKey: 'iowa-retirement-income', recordType: 'otherIncomeSources', fields: ['person', 'type', 'amount', 'frequency'] };
  assert.deepEqual(validateRequest(request), request);
  for (const change of [{ pageKey: 'iowa-job-history' }, { recordType: 'jobs' }, { recordType: 'taxStatements' },
    { fields: ['person', 'source'] }, { fields: ['person', 'startDate'] }, { fields: ['person', 'annualIncome'] },
    { fields: ['type', 'amount'] }, { url: `${request.url}?type=pension` }]) assert.throws(() => validateRequest({ ...request, ...change }));
});

test('housing requests permit only captured responsibility fields, not a landlord or household total', () => {
  const request = { id: 'rent', type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`,
    pageKey: 'iowa-housing-expenses', recordType: 'housingExpenses', fields: ['person', 'type', 'amount', 'frequency'] };
  assert.deepEqual(validateRequest(request), request);
  for (const fields of [['person', 'paidTo'], ['person', 'startDate'], ['person', 'monthlyRent'], ['person', 'currentValue']]) {
    assert.throws(() => validateRequest({ ...request, fields }));
  }
});

test('utility records allow only the captured person and nine explicit utility answers', () => {
  const request = { id: 'record-utilities', type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-utility-expenses', recordType: 'utilityExpenses',
    fields: ['person', 'gas', 'electricity', 'waterSewage', 'telephone', 'petFees', 'garageRent', 'landlordExtra', 'garbage', 'heatingCooling'] };
  assert.doesNotThrow(() => validateRequest(request));
  for (const fields of [['gas'], ['person', 'utilityGas'], ['person', 'amount'], ['person', 'monthlyUtilities']]) assert.throws(() => validateRequest({ ...request, fields }));
});

test('liquid asset projection is exact-route, explicit-owner, and excludes description, shared ownership and inferred cash', () => {
  const request = { id: 'record-asset', type: 'getRecordFields', url: `${PORTAL_URL}/applyForBenefits/dynamicQuestions`, pageKey: 'iowa-liquid-assets', recordType: 'assets',
    fields: ['person', 'type', 'currentValue', 'amountOwed', 'accountOrPolicy', 'institution', 'acquiredDate'] };
  assert.doesNotThrow(() => validateRequest(request));
  for (const fields of [['currentValue'], ['person', 'description'], ['person', 'sharedWith'], ['person', 'ownershipShare'], ['person', 'cashOnHand'], ['person', 'ssn'], ['person', 'person']]) {
    assert.throws(() => validateRequest({ ...request, fields }));
  }
  for (const suffix of ['?page=2', '#review', '/']) assert.throws(() => validateRequest({ ...request, url: request.url + suffix }));
  for (const extra of [{ recordId: 'arbitrary' }, { recordType: 'taxStatements' }, { pageKey: 'iowa-other-assets' }, { personName: 'Avery\nExample' }]) assert.throws(() => validateRequest({ ...request, ...extra }));
});
