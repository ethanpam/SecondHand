'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../extension/iowa-adapter.js');
const { plain, serviceWorker, nativeHost } = require('./helpers/harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

const START_KEYS = ['gender', 'birthDate', 'hasSsn', 'usCitizen', 'maritalStatus', 'militaryOrVeteran', 'hasDisability', 'blind', 'healthLimits', 'hasMedicare'];

// A metadata-only content model. DOM/selector/first-suggestion safety is covered
// separately by adapter fixtures. Native replies here are mocked, not Electron.
function worker({ pageKey = 'iowa-personal-information', complete = false, todo, nativeHook } = {}) {
  const path = { 'iowa-select-address': 'addressValidation', 'iowa-self-details': 'dynamicQuestions', 'iowa-tell-us-more': 'dynamicQuestionsStart' }[pageKey] || 'enterPersonalInfo';
  const tab = { id: 7, active: true, url: `${adapter.PORTAL}/applyForBenefits/${path}` };
  const model = { pageKey, complete, todo, revealed: [], filled: [], nextCount: 0, nextToken: null, preview: 0 };
  const vault = { unlocked: true, accessRevision: 872313042, values: { firstName: 'Synthetic private first', birthDate: '1985-04-12' } };
  const calls = { native: [], content: [] };
  const w = serviceWorker();
  function pageState(message) {
    const address = model.pageKey === 'iowa-select-address';
    const self = model.pageKey === 'iowa-self-details', start = model.pageKey === 'iowa-tell-us-more';
    const unverified = /unverified/.test(model.pageKey);
    // On Tell Us More, Iowa shows the Social Security card name question after Yes to having a number.
    const keys = address || unverified ? [] : self ? ['birthDate'] : start ? [...START_KEYS, ...(model.filled.includes('hasSsn') ? ['ssnCardName'] : [])] : ['firstName', 'lastName', ...model.revealed];
    const canAdvance = !self && !start && !unverified && (address || model.complete);
    if (message.navigationPreview !== false) model.nextToken = canAdvance ? `next-${++model.preview}` : null;
    return { page: { kind: unverified ? 'manual' : 'fillable', pageKey: model.pageKey, canAdvance, todo: model.todo,
      checklist: keys.map(key => ({ key, label: key, required: true, status: model.complete || model.filled.includes(key) ? 'complete' : 'missing' })) },
      scan: { recognizedPage: !unverified, token: 'fill-preview', fields: keys.filter(key => (!model.complete || model.revealed.includes(key)) && !model.filled.includes(key)).map(key => ({ key, label: key })) },
      nextToken: message.navigationPreview === false ? null : model.nextToken };
  }
  const chrome = {
    tabs: { get: async () => ({ ...tab }), onActivated: w.event('activated'), onUpdated: w.event('updated'), onRemoved: w.event('removed'),
      sendMessage: async (_id, message) => {
        calls.content.push(plain(message));
        if (message.type === 'secondhand:pageState') return pageState(message);
        if (message.type === 'secondhand:fill') {
          message.fields.forEach(key => { if (message.values[key]) model.filled.push(key); });
          return { ok: true, filledCount: message.fields.length, skippedCount: 0 };
        }
        if (message.type === 'secondhand:next') {
          if (!message.authorized || message.token !== model.nextToken) return { advanced: false, reason: 'Stale navigation preview.' };
          model.nextToken = null; model.nextCount++;
          return { advanced: true };
        }
        throw new Error(`Unexpected page mutation or generic fallback: ${message.type}`);
      } },
    scripting: { executeScript: async () => {}, getRegisteredContentScripts: async () => [] },
    permissions: { contains: async () => false },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { id: 'testextension', getURL: file => `chrome-extension://testextension/${file}`, onMessage: w.onMessage,
      connectNative: nativeHost({ posted: request => { calls.native.push(plain(request)); }, answer: async (request, port) => {
        try {
          let data;
          if (request.type === 'status') data = { unlocked: vault.unlocked, accessRevision: vault.accessRevision };
          else if (request.type === 'getFields') data = { accessRevision: vault.accessRevision, values: Object.fromEntries(request.fields.filter(key => vault.values[key]).map(key => [key, vault.values[key]])) };
          else if (request.type === 'recordProgress') data = { recorded: true };
          else throw new Error(`Unexpected native method: ${request.type}`);
          const override = await nativeHook?.(request, data, { model, vault, tab, calls });
          if (override?.disconnect) { port.disconnect(); return; }
          port.reply(override === undefined ? data : override);
        } catch (error) { port.fail(error.message); }
      } }) }
  };
  w.start({ chrome });
  const send = message => w.send({ tabId: 7, ...message }, { id: 'testextension', url: chrome.runtime.getURL('panel.html') });
  return { model, vault, tab, calls, events: w.events, start: () => send({ type: 'ui:autofill', confirmed: true }), stop: () => send({ type: 'ui:stop', confirmed: true }), poll: () => send({ type: 'ui:pageState' }) };
}
const requests = w => w.calls.native.filter(call => call.type === 'getFields');

test('a complete verified applicant advances once with a revision receipt, including a nonzero revision', async () => {
  const w = worker({ complete: true });
  assert.equal((await w.start()).data.state, 'continuing');
  assert.equal(w.model.nextCount, 1);
  assert.equal(requests(w).length, 1);
  assert.deepEqual(requests(w)[0].fields, adapter.profileRequest('iowa-personal-information'));
  await w.poll(); await w.poll();
  w.events.updated(7, { status: 'complete' }); await tick();
  assert.equal(w.model.nextCount, 1);
  assert.equal(requests(w).length, 1);
});

test('missing required answers wait, then manual completion authorizes Next without rereading profile values', async () => {
  const w = worker();
  const result = await w.start();
  assert.equal(result.data.state, 'done');
  assert.deepEqual(w.model.filled, ['firstName']);
  assert.equal(w.model.nextCount, 0);
  await w.poll(); await w.poll();
  assert.equal(requests(w).length, 1, 'missing saved answers do not trigger repeated requests');
  w.model.complete = true;
  await w.poll(); await tick();
  assert.equal((await w.poll()).data.result.state, 'continuing');
  assert.equal(w.model.nextCount, 1);
  assert.deepEqual(requests(w)[1].fields, []);
  await w.poll();
  assert.equal(requests(w).length, 2);
  assert.equal(w.model.nextCount, 1);
});

test('verified address uses no-data authorization and polling cannot replace its final navigation snapshot', async () => {
  const held = deferred(), reached = deferred();
  const w = worker({ pageKey: 'iowa-select-address', nativeHook: async (request, _data, { calls }) => {
    if (request.type === 'status' && calls.native.some(call => call.type === 'getFields')) { reached.resolve(); await held.promise; }
  } });
  const run = w.start(); await reached.promise;
  const token = w.model.nextToken;
  const poll = await w.poll();
  assert.equal(poll.data.autopilot, true);
  assert.equal(w.model.nextToken, token);
  assert.equal(w.calls.content.at(-1).navigationPreview, false);
  held.resolve();
  assert.equal((await run).data.state, 'continuing');
  assert.equal(w.model.nextCount, 1);
  assert.deepEqual(requests(w).map(request => request.fields), [[]]);
  assert.equal(requests(w)[0].url, `${adapter.PORTAL}/applyForBenefits/addressValidation`);
  assert.equal(w.calls.content.some(message => message.type === 'secondhand:fill'), false);
});

test('self details only requests DOB and never advances; strict rejected pages cannot use the general engine', async () => {
  const w = worker({ pageKey: 'iowa-self-details', todo: 'Answer the other questions and continue yourself.' });
  assert.equal((await w.start()).data.state, 'done');
  assert.deepEqual(requests(w).map(request => request.fields), [['birthDate']]);
  assert.deepEqual(w.model.filled, ['birthDate']);
  assert.equal(w.model.nextCount, 0);
  for (const pageKey of ['iowa-personal-unverified', 'iowa-self-details-unverified', 'iowa-select-address-unverified']) {
    const unknown = worker({ pageKey, todo: 'This changed page needs your review.' });
    assert.equal((await unknown.start()).data.state, 'waiting');
    assert.equal(unknown.calls.native.length, 0);
    assert.equal(unknown.calls.content.some(message => message.type.includes('generic')), false);
  }
});

test('Tell Us More at dynamicQuestionsStart asks for the applicant’s answers and the household facts that can settle them, sends only settled answers, and never advances', async () => {
  const w = worker({ pageKey: 'iowa-tell-us-more', todo: 'Answer the remaining questions, then click Save and Continue in Iowa’s form yourself.' });
  Object.assign(w.vault.values, { ssn: '999-99-9999', hasSsn: 'yes', householdAllCitizens: 'no', householdDisability: 'no', householdMedicare: 'yes' });
  const result = (await w.start()).data;
  assert.equal(result.state, 'done');
  assert.equal(result.todoKey, 'iowa.startDetailsTodo');
  assert.deepEqual(requests(w).map(request => [request.url, request.fields]),
    [[`${adapter.PORTAL}/applyForBenefits/dynamicQuestionsStart`, ['sex', 'birthDate', 'hasSsn', 'ssn', 'ssnCardNameMatches', 'ssnCardFirstName', 'ssnCardMiddleName', 'ssnCardLastName', 'usCitizen', 'householdAllCitizens',
      'maritalStatus', 'militaryOrVeteran', 'disabled', 'householdDisability', 'blind', 'healthLimitation', 'medicare', 'householdMedicare']]]);
  assert.deepEqual(w.calls.content.filter(message => message.type === 'secondhand:fill').map(message => message.values),
    [{ birthDate: '1985-04-12', hasSsn: 'yes', hasDisability: 'no' }]);
  assert.deepEqual(w.model.filled, ['birthDate', 'hasSsn', 'hasDisability']);
  // Every question still open had no saved answer, including the card question Iowa showed after Yes.
  const open = ['gender', 'usCitizen', 'maritalStatus', 'militaryOrVeteran', 'blind', 'healthLimits', 'hasMedicare', 'ssnCardName'];
  assert.deepEqual([...result.needYou].sort(), [...open].sort());
  assert.deepEqual([...result.notSaved].sort(), [...open].sort());
  assert.equal(w.model.nextCount, 0);
  assert.equal(w.calls.content.some(message => message.type === 'secondhand:next'), false);
  assert.doesNotMatch(JSON.stringify(w.calls.content), /999-99-9999/);
  assert.doesNotMatch(JSON.stringify(result), /1985|Female|Never Married/);
});

test('with every answer saved, Tell Us More fills them all, and the card question Iowa shows after Yes on the next pass', async () => {
  const w = worker({ pageKey: 'iowa-tell-us-more', todo: 'Answer the remaining questions, then click Save and Continue in Iowa’s form yourself.' });
  Object.assign(w.vault.values, { sex: 'Female', hasSsn: 'yes', ssnCardNameMatches: 'yes', usCitizen: 'yes', maritalStatus: 'Never Married',
    militaryOrVeteran: 'no', disabled: 'no', blind: 'no', healthLimitation: 'no', medicare: 'no' });
  const result = (await w.start()).data;
  assert.equal(result.state, 'done');
  const fills = w.calls.content.filter(message => message.type === 'secondhand:fill');
  assert.deepEqual(fills.map(message => message.fields), [START_KEYS, ['ssnCardName']]);
  assert.deepEqual(fills[0].values, { gender: 'Female', birthDate: '1985-04-12', hasSsn: 'yes', usCitizen: 'yes', maritalStatus: 'Never Married',
    militaryOrVeteran: 'no', hasDisability: 'no', blind: 'no', healthLimits: 'no', hasMedicare: 'no' });
  assert.deepEqual(fills[1].values, { ssnCardName: 'yes' });
  assert.equal(result.filled, 11);
  assert.deepEqual(result.needYou, []);
  assert.deepEqual(result.notSaved, []);
  assert.equal(w.model.nextCount, 0);
});

test('lock, revocation, desktop restart and malformed receipts stop values or Next before mutation', async () => {
  for (const address of [false, true]) for (const change of ['lock', 'revision', 'restart', 'missing', 'negative']) {
    const w = worker({ pageKey: address ? 'iowa-select-address' : 'iowa-personal-information', nativeHook: (request, data, { vault }) => {
      if (request.type !== 'getFields') return;
      if (change === 'lock') vault.unlocked = false;
      if (change === 'revision') vault.accessRevision++;
      if (change === 'restart') vault.accessRevision = 87313128;
      if (change === 'missing') return { values: data.values };
      if (change === 'negative') return { values: data.values, accessRevision: -1 };
    } });
    const result = (await w.start()).data;
    assert.ok(['error', 'locked'].includes(result.state), `${address}/${change}`);
    assert.equal(w.model.filled.length, 0);
    assert.equal(w.model.nextCount, 0);
    const state = (await w.poll()).data;
    assert.equal(state.autopilot, false);
    assert.equal(state.result.message, result.message, 'failure persists across polls');
    assert.equal(requests(w).length, 1);
  }
});

test('native rejection stays visible across polls without retaining private values', async () => {
  const w = worker({ nativeHook: request => { if (request.type === 'getFields') throw new Error('You cancelled this field request.'); } });
  assert.equal((await w.start()).data.message, 'Cancelled. Nothing was filled.');
  for (let index = 0; index < 3; index++) {
    const state = await w.poll();
    assert.equal(state.data.result.message, 'Cancelled. Nothing was filled.');
    assert.equal(state.data.autopilot, false);
    assert.doesNotMatch(JSON.stringify(state), /Synthetic private/);
  }
  assert.equal(requests(w).length, 1);
});

test('Stop revokes a pending native request and late approval or rejection cannot overwrite it', async () => {
  for (const reject of [false, true]) {
    const reached = deferred(), release = deferred();
    const w = worker({ nativeHook: async request => {
      if (request.type === 'getFields') { reached.resolve(); await release.promise; if (reject) throw new Error('You cancelled this field request.'); }
    } });
    const run = w.start(); await reached.promise;
    assert.equal((await w.stop()).data.state, 'stopped');
    release.resolve(); await run;
    const state = (await w.poll()).data;
    assert.equal(state.result.message, 'Autofill stopped. Nothing was erased.');
    assert.equal(state.autopilot, false);
    assert.equal(w.model.filled.length, 0);
    assert.equal(w.model.nextCount, 0);
  }
});

test('an old rejected request cannot overwrite a replacement run or cancel its navigation', async () => {
  const reached = deferred(), release = deferred(); let count = 0;
  const w = worker({ pageKey: 'iowa-select-address', nativeHook: async request => {
    if (request.type === 'getFields' && ++count === 1) { reached.resolve(); await release.promise; throw new Error('You cancelled this field request.'); }
  } });
  const old = w.start(); await reached.promise;
  await w.stop();
  assert.equal((await w.start()).data.state, 'continuing');
  release.resolve(); await old;
  assert.equal((await w.poll()).data.result.state, 'continuing');
  assert.equal(w.model.nextCount, 1);
});

test('switching tabs or changing the active URL while approval is pending prevents page mutation', async () => {
  for (const method of ['switch', 'url']) {
    const reached = deferred(), release = deferred();
    const w = worker({ nativeHook: async request => { if (request.type === 'getFields') { reached.resolve(); await release.promise; } } });
    const run = w.start(); await reached.promise;
    if (method === 'switch') { w.tab.active = false; w.events.activated({ tabId: 8 }); }
    else w.tab.url = `${adapter.PORTAL}/applyForBenefits/other`;
    release.resolve(); await run;
    assert.equal(w.model.filled.length, 0);
    assert.equal(w.model.nextCount, 0);
  }
});


test('a poll remains responsive while newly reached address authorization is pending', async () => {
  const reached = deferred(), release = deferred();
  const w = worker({ nativeHook: async request => { if (request.type === 'getFields' && request.fields.length === 0) { reached.resolve(); await release.promise; } } });
  await w.start();
  w.model.pageKey = 'iowa-select-address';
  w.tab.url = `${adapter.PORTAL}/applyForBenefits/addressValidation`;
  const state = await w.poll();
  assert.equal(state.data.page.pageKey, 'iowa-select-address');
  assert.equal(state.data.autopilot, true);
  await reached.promise;
  assert.equal(w.model.nextCount, 0);
  release.resolve(); await tick();
  assert.equal(w.model.nextCount, 1);
});

test('required manual completion fills newly revealed optional saved fields before Next', async () => {
  const w = worker();
  w.vault.values.bestContactTime = 'Weekdays after 4 pm';
  await w.start();
  w.model.complete = true;
  w.model.revealed.push('bestContactTime');
  await w.poll(); await tick();
  assert.ok(w.model.filled.includes('bestContactTime'));
  assert.equal(w.model.nextCount, 1);
  const fillIndex = w.calls.content.findIndex(message => message.type === 'secondhand:fill' && message.fields.includes('bestContactTime'));
  const nextIndex = w.calls.content.findIndex(message => message.type === 'secondhand:next');
  assert.ok(fillIndex >= 0 && nextIndex > fillIndex);
});
