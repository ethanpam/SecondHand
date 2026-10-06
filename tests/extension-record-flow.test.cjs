'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runFile } = require('./helpers/harness.cjs');
const { webcrypto } = require('node:crypto');
const adapter = require('../extension/iowa-adapter.js');
const generic = require('../extension/generic-adapter.js');
const strings = require('../extension/strings.js');
const translation = require('../extension/translation.js');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const PAGE = 'iowa-job-history';
const URL = `${adapter.PORTAL}/applyForBenefits/dynamicQuestions`;
const RECORD_ID = '11111111-2222-4333-8444-555555555555';
const PRIVATE_RECORD = Object.freeze({ person: 'Fictional Private Owner', workOrTraining: 'Work', startDate: '2026-02-03', selfEmployed: 'no',
  employer: 'Private Synthetic Employer', jobTitle: 'Clerk', monthlyHours: '120', amount: '850.50', frequency: 'Monthly',
  tipsOrCommissions: '0', incomeExpectedSame: 'yes', changedJobs30Days: 'no', stoppedWorking30Days: 'no', fewerHours30Days: 'no' });
const PHASES = [['person'], ['workOrTraining', 'startDate'], ['selfEmployed'],
  ['employer', 'jobTitle', 'monthlyHours', 'amount', 'frequency', 'tipsOrCommissions', 'incomeExpectedSame', 'changedJobs30Days', 'stoppedWorking30Days', 'fewerHours30Days']];

// Tests the actual worker's native/content protocol. This metadata stand-in reveals
// controls in stages; real DOM mapping is covered by record-adapter and browser tests.
function worker({ selectedOwner = '', values = PRIVATE_RECORD, nativeHook, contentHook, unlocked = true } = {}) {
  const model = { pageKey: PAGE, document: 'fictional-document-1', filled: [], nextCount: 0, nextToken: null, preview: 0 };
  const vault = { unlocked, revision: 417, values: { ...values } };
  const calls = { native: [], content: [] }, events = {};
  const event = key => ({ addListener: callback => { events[key] = callback; } });
  const tab = { id: 7, active: true, url: URL };
  let listener;
  const visible = () => {
    const keys = [];
    for (const phase of PHASES) { keys.push(...phase); if (phase.some(key => !model.filled.includes(key))) break; }
    return keys;
  };
  const token = () => `fill-${model.filled.length}`;
  const complete = () => PHASES.flat().every(key => model.filled.includes(key));
  const chrome = {
    tabs: { get: async () => ({ ...tab }), onActivated: event('activated'), onUpdated: event('updated'), onRemoved: event('removed'),
      sendMessage: async (_id, message) => {
        calls.content.push(plain(message));
        const override = await contentHook?.(message, { model, vault, calls });
        if (override !== undefined) return override;
        if (message.type === 'secondhand:pageState') {
          if (message.navigationPreview !== false) model.nextToken = complete() ? `next-${++model.preview}` : null;
          return { pageInstance: model.document, page: { kind: 'fillable', pageKey: model.pageKey, canAdvance: complete(),
            checklist: visible().map(key => ({ key, label: key, required: true, status: model.filled.includes(key) ? 'complete' : 'missing' })) },
          scan: { token: token(), recognizedPage: true, fields: visible().filter(key => !model.filled.includes(key)).map(key => ({ key, label: key })) },
          nextToken: message.navigationPreview === false ? null : model.nextToken };
        }
        if (message.type === 'secondhand:recordContext') return message.token === token() && message.pageInstance === model.document
          ? { ok: true, ...(selectedOwner ? { personName: selectedOwner } : {}) } : { ok: false };
        if (message.type === 'secondhand:fill') {
          if (message.token !== token() || message.pageInstance !== model.document) return { ok: false };
          const keys = message.fields.filter(key => message.values[key] && visible().includes(key) && !model.filled.includes(key));
          model.filled.push(...keys); return { ok: true, filledCount: keys.length, skippedCount: message.fields.length - keys.length };
        }
        if (message.type === 'secondhand:next') {
          if (!message.authorized || message.token !== model.nextToken || message.pageInstance !== model.document || !complete()) return { advanced: false };
          model.nextToken = null; model.nextCount++; return { advanced: true };
        }
        throw new Error(`Unexpected content or model request: ${message.type}`);
      } },
    scripting: { executeScript: async () => {}, getRegisteredContentScripts: async () => [] },
    permissions: { contains: async () => false }, sidePanel: { setPanelBehavior: async () => {} },
    runtime: { id: 'testextension', getURL: file => `chrome-extension://testextension/${file}`,
      onMessage: { addListener: callback => { listener = callback; } }, connectNative: () => {
        let reply;
        return { onMessage: { addListener: callback => { reply = callback; } }, onDisconnect: { addListener: () => {} }, disconnect: () => {},
          postMessage: request => { calls.native.push(plain(request)); queueMicrotask(async () => {
            try {
              let data;
              if (request.type === 'status') data = { unlocked: vault.unlocked, accessRevision: vault.revision };
              else if (request.type === 'getRecordFields') data = { recordId: RECORD_ID, values: { ...vault.values }, accessRevision: vault.revision };
              else if (request.type === 'getFields' && !request.fields.length) data = { values: {}, accessRevision: vault.revision };
              else if (request.type === 'recordProgress') data = { recorded: true };
              else throw new Error(`Unexpected native request: ${request.type}`);
              const override = await nativeHook?.(request, data, { model, vault, calls, tab });
              reply({ id: request.id, ok: true, data: override === undefined ? data : override });
            } catch (error) { reply({ id: request.id, ok: false, error: error.message }); }
          }); }
        };
      } }
  };
  runFile('extension/background.js', {
    chrome, SecondHandIowa: adapter, SecondHandGeneric: generic, SecondHandStrings: strings, SecondHandTranslation: translation,
    importScripts: () => {}, crypto: webcrypto, setTimeout, clearTimeout, URL: globalThis.URL, Map, Set, console
  });
  const send = message => new Promise(resolve => listener({ tabId: 7, ...message }, { id: 'testextension', url: chrome.runtime.getURL('panel.html') }, resolve));
  return { model, vault, calls, events, start: () => send({ type: 'ui:autofill', confirmed: true }), poll: () => send({ type: 'ui:pageState' }) };
}
const records = w => w.calls.native.filter(call => call.type === 'getRecordFields');

test('one named record fills conditional passes, never invokes a model, and continues once without exposing private data', async () => {
  const w = worker({ selectedOwner: PRIVATE_RECORD.person });
  const result = await w.start();
  assert.equal(result.data.state, 'continuing', JSON.stringify(result));
  assert.equal(w.model.nextCount, 1);
  assert.deepEqual(records(w).map(({ id, ...request }) => request), [{ type: 'getRecordFields', url: URL, pageKey: PAGE,
    ...plain(adapter.recordRequest(PAGE)), personName: PRIVATE_RECORD.person }]);
  assert.equal(w.calls.native.some(call => ['getFields', 'warmLaya', 'suggestFields', 'answerFields'].includes(call.type)), false);
  assert.equal(w.calls.content.filter(call => call.type === 'secondhand:fill').length, 4);
  assert.ok(w.calls.content.filter(call => call.type === 'secondhand:fill').every(call => call.pageInstance === 'fictional-document-1'));
  assert.deepEqual(w.model.filled, PHASES.flat());
  for (const response of [result, await w.poll()]) assert.doesNotMatch(JSON.stringify(response), /Fictional Private Owner|Private Synthetic Employer|850\.50|11111111-2222|2026-02-03/);
  w.model.document = 'fictional-document-2'; // An uncertain same-step server reload is not another approval.
  w.events.updated(7, { status: 'complete' }); await tick(); await w.poll();
  assert.equal(records(w).length, 1); assert.equal(w.model.nextCount, 1);
});

test('an unselected owner stays absent from the native request rather than becoming the first person', async () => {
  const w = worker(); await w.start();
  assert.equal(Object.hasOwn(records(w)[0], 'personName'), false);
  assert.equal(w.model.nextCount, 1);
});

test('a locked desktop releases no record or owner context', async () => {
  const w = worker({ unlocked: false });
  assert.equal((await w.start()).data.state, 'locked');
  assert.equal(records(w).length, 0);
  assert.equal(w.calls.content.some(call => call.type === 'secondhand:recordContext'), false);
});

for (const failure of ['lock', 'revision', 'document']) test(`a ${failure} change during record approval prevents every fill and Next`, async () => {
  const w = worker({ nativeHook: (request, _data, { model, vault }) => {
    if (request.type !== 'getRecordFields') return;
    if (failure === 'lock') vault.unlocked = false;
    if (failure === 'revision') vault.revision++;
    if (failure === 'document') model.document = 'different-document';
  } });
  assert.ok(['locked', 'error'].includes((await w.start()).data.state));
  assert.deepEqual(w.model.filled, []); assert.equal(w.model.nextCount, 0);
});

for (const mutate of [data => ({ ...data, recordId: 'not-a-record-id' }), data => ({ ...data, values: { ...data.values, ssn: '999-99-9999' } })]) {
  test('a malformed or overbroad record response fills nothing', async () => {
    const w = worker({ nativeHook: (request, data) => request.type === 'getRecordFields' ? mutate(data) : undefined });
    assert.equal((await w.start()).data.state, 'error');
    assert.deepEqual(w.model.filled, []); assert.equal(w.model.nextCount, 0);
  });
}

test('a missing record waits without retrying or exposing any record list', async () => {
  const w = worker({ nativeHook: (request, data) => request.type === 'getRecordFields' ? { values: {}, reason: 'recordMissing', accessRevision: data.accessRevision } : undefined });
  const result = await w.start();
  assert.equal(result.data.state, 'waiting'); assert.equal(result.data.messageKey, 'worker.recordMissing');
  await w.poll(); await w.poll();
  assert.equal(records(w).length, 1); assert.deepEqual(w.model.filled, []); assert.equal(w.model.nextCount, 0);
});

test('missing record data stops Next; manual completion gets a no-data authorization and honors the original record revision', async () => {
  const values = { ...PRIVATE_RECORD }; delete values.amount;
  const w = worker({ values });
  const result = await w.start(); assert.equal(result.data.state, 'done');
  assert.deepEqual(plain(result.data.notSaved), ['amount']); assert.equal(w.model.nextCount, 0);
  await w.poll(); assert.equal(records(w).length, 1);
  w.model.filled.push('amount');
  await w.poll(); await tick(); await w.poll();
  assert.equal(w.model.nextCount, 1);
  assert.deepEqual(w.calls.native.filter(call => call.type === 'getFields').map(call => call.fields), [[]]);
  assert.equal(records(w).length, 1);
  const stale = worker({ values }); await stale.start(); stale.model.filled.push('amount'); stale.vault.revision++;
  await stale.poll(); await tick(); await stale.poll();
  assert.equal(stale.model.nextCount, 0);
  assert.equal(stale.calls.native.some(call => call.type === 'getFields'), false);
});

test('locking between the final filled page and Continue prevents navigation', async () => {
  const w = worker({ nativeHook: (request, _data, { vault }) => { if (request.type === 'recordProgress') vault.unlocked = false; } });
  assert.equal((await w.start()).data.state, 'locked');
  assert.deepEqual(w.model.filled, PHASES.flat()); assert.equal(w.model.nextCount, 0);
});
