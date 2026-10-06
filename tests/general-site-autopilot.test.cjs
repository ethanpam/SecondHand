'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plain, tick, deferred, until, serviceWorker, nativeHost } = require('./helpers/harness.cjs');

const ORIGIN = 'https://pantry.example.org';
const PANEL = 'chrome-extension://testextension/panel.html';
const files = ['generic-adapter.js', 'generic-navigation.js', 'page-text.js', 'generic-content.js'];

// Real service worker and pure adapter helpers, with Chrome, the native host,
// and the content-script protocol simulated. No browser, applicant data, or
// network. The separate navigation tests exercise the DOM proof itself.
function worker({ fields = [{ key: 'firstName', label: 'First name' }], reason, values = { firstName: 'Synthetic' } } = {}) {
  const w = serviceWorker(), { event, events } = w;
  const tab = { id: 7, active: true, status: 'complete', url: `${ORIGIN}/intake?step=1` };
  const vault = { unlocked: true, accessRevision: 42, values, trusted: true, held: [] };
  const log = [], native = [], content = [], hooks = {}, clock = { now: 1000 };
  const state = { fields: structuredClone(fields), reason, step: 'first-page', document: 'document-1', version: 0,
    plan: 0, preview: 0, clicks: 0, advances: 0, permission: true, onAdvance: null, onNavigation: null };
  let currentPlan, navigation;
  function navigationState() {
    const reason = state.reason || (state.fields.some(field => !field.answer) ? 'missing' : 'ready');
    const canAdvance = reason === 'ready';
    const token = `navigation-${++state.preview}`;
    navigation = { token, step: state.step, document: state.document, version: state.version, canAdvance };
    return { canAdvance, reason, step: state.step, ...(canAdvance ? { token } : {}) };
  }
  const chrome = {
    tabs: {
      get: async () => { await hooks.tabGet?.(); return { ...tab }; }, query: async () => [{ ...tab }],
      onActivated: event('activated'), onUpdated: event('updated'), onRemoved: event('removed'),
      sendMessage: async (_id, message) => {
        const request = plain(message); content.push(request); log.push(`content:${request.type}`);
        if (request.type === 'secondhand:generic:navigation') { await state.onNavigation?.(); return navigationState(); }
        if (request.type === 'secondhand:generic:frames') return { origins: [] };
        if (request.type === 'secondhand:generic:formFrames') return undefined;
        if (request.type === 'secondhand:generic:plan') {
          currentPlan = { token: `plan-${++state.plan}`, fields: new Map() };
          const matched = [], unmatched = [];
          state.fields.filter(field => !field.answer).forEach((field, index) => {
            const id = `sh-${state.plan}-${index}`; currentPlan.fields.set(id, field);
            if (field.key) matched.push({ id, key: field.key, label: field.label, confidence: 'high' });
            else unmatched.push({ id, label: field.label, type: field.type || 'text', options: field.options || [], required: true });
          });
          return { token: currentPlan.token, lang: 'en', matched, unmatched };
        }
        if (request.type === 'secondhand:generic:fill') {
          assert.equal(request.token, currentPlan.token);
          const filled = [];
          for (const assignment of request.assignments) {
            const field = currentPlan.fields.get(assignment.id), value = request.values[assignment.key];
            if (field && !field.answer && value) { field.answer = value; field.mark = 'rule'; filled.push(assignment.id); state.version++; }
          }
          return { ok: true, filled, rejected: [], skipped: [] };
        }
        if (request.type === 'secondhand:generic:advance') {
          state.advances++;
          const valid = navigation?.token === request.token && navigation.canAdvance && navigation.document === state.document &&
            navigation.version === state.version && navigation.step === state.step && (!state.reason || state.reason === 'ready');
          navigation = null; // Content's one-use proof is consumed even if invalid.
          if (!valid) return { ok: true, advanced: false };
          state.clicks++; await state.onAdvance?.();
          return { ok: true, advanced: true };
        }
        if (request.type === 'secondhand:generic:answered') return { answered: [] };
        throw new Error(`Unexpected content request: ${request.type}`);
      }
    },
    permissions: { contains: async ({ origins }) => { await hooks.permission?.(); return state.permission && origins.every(origin => origin === `${ORIGIN}/*`); }, onRemoved: event('permissionsRemoved') },
    scripting: {
      getRegisteredContentScripts: async ({ ids } = {}) => (!ids || ids.includes('site-pantry.example.org')) ? [{ id: 'site-pantry.example.org', matches: [`${ORIGIN}/*`], js: files }] : [],
      executeScript: async details => {
        if (details.target.allFrames) {
          await w.send({ type: 'secondhand:frame', nonce: details.args[0] }, { id: 'testextension', url: tab.url, origin: new URL(tab.url).origin,
            tab: { id: tab.id, url: tab.url }, frameId: 0, documentId: state.document });
          return [{ frameId: 0, documentId: state.document, result: true }];
        }
        if (details.func) return [{ frameId: 0, result: { rule: state.fields.filter(field => field.mark === 'rule').length, guess: 0, layaGuess: 0, next: true } }];
        throw new Error('Unexpected script injection');
      }
    },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: { id: 'testextension', getURL: file => `chrome-extension://testextension/${file}`, onMessage: w.onMessage, onInstalled: event('installed'),
      connectNative: nativeHost({ posted: request => { native.push(plain(request)); log.push(`native:${request.type}`); }, answer: async (request, port) => {
        let result;
        if (request.type === 'status') result = { unlocked: vault.unlocked, accessRevision: vault.accessRevision, applicationCount: 0, laya: { state: 'ready' } };
        else if (request.type === 'getFields') result = { accessRevision: vault.accessRevision, values: Object.fromEntries(request.fields.filter(key => vault.values[key] && !vault.held.includes(key)).map(key => [key, vault.values[key]])), ...(vault.held.length ? { held: vault.held } : {}) };
        else if (request.type === 'authorizeSiteNavigation') result = { accessRevision: vault.accessRevision };
        else { port.fail(`Unexpected native request: ${request.type}`); return; }
        await hooks[request.type]?.(request, result);
        if (request.type !== 'status' && !vault.trusted) return port.fail('This site isn’t trusted.');
        port.reply(result);
      } }) }
  };
  w.start({ chrome, globals: { Date: { now: () => clock.now } } });
  const panel = message => w.send({ tabId: tab.id, ...message }, { id: 'testextension', url: PANEL });
  return { tab, vault, state, native, content, hooks, clock, events, log, panel, send: w.send,
    start: () => panel({ type: 'ui:fillAndContinue', confirmed: true }), stop: () => panel({ type: 'ui:stop', confirmed: true }),
    info: () => panel({ type: 'ui:pageState' }),
    move({ step = 'second-page', url = `${ORIGIN}/intake?step=2`, fields = [{ key: 'zip', label: 'ZIP code' }], reason } = {}) {
      tab.url = url; tab.status = 'loading'; events.updated(tab.id, { status: 'loading' });
      state.document += '-next'; state.step = step; state.fields = structuredClone(fields); state.reason = reason; state.version++;
      tab.status = 'complete'; events.updated(tab.id, { status: 'complete' });
    }
  };
}

test('only a confirmed side-panel action starts Fill and continue; ordinary Autofill never requests Next', async () => {
  const w = worker();
  assert.equal(await w.panel({ type: 'ui:fillAndContinue' }), undefined);
  assert.equal(await w.send({ type: 'ui:fillAndContinue', confirmed: true, tabId: 7 }, { id: 'testextension', url: `${PANEL}?surface=launcher`, frameId: 1, tab: w.tab }), undefined);
  assert.equal(await w.send({ type: 'ui:fillAndContinue', confirmed: true, tabId: 7 }, { id: 'testextension', url: w.tab.url, tab: w.tab }), undefined);
  const result = await w.panel({ type: 'ui:autofill', confirmed: true });
  assert.equal(result.ok, true); assert.equal(w.state.fields[0].answer, 'Synthetic');
  assert.equal(w.state.clicks, 0); assert.ok(!w.native.some(item => item.type === 'authorizeSiteNavigation'));
});

test('saved-only fill authorizes one ordinary Next and fills the next same-origin page without model guesses', async () => {
  const w = worker({ values: { firstName: 'Synthetic', zip: '50309' } });
  const response = await w.start();
  assert.equal(response.ok, true); assert.equal(response.data.state, 'continuing', JSON.stringify(response));
  assert.doesNotMatch(JSON.stringify(response), /Synthetic|50309/);
  assert.equal(w.state.fields[0].answer, 'Synthetic'); assert.equal(w.state.clicks, 1);
  const authorization = w.native.find(item => item.type === 'authorizeSiteNavigation');
  assert.deepEqual(Object.keys(authorization).sort(), ['id', 'type', 'url']);
  assert.equal(authorization.url, `${ORIGIN}/intake`, 'queries are not sent to the native host');
  const filled = w.log.indexOf('content:secondhand:generic:fill'), authorized = w.log.indexOf('native:authorizeSiteNavigation'), advanced = w.log.indexOf('content:secondhand:generic:advance');
  assert.ok(filled < authorized && authorized < advanced);
  w.move(); await until(() => w.state.clicks === 2, 'the second ordinary Next');
  assert.equal(w.state.fields[0].answer, '50309');
  assert.equal(w.native.filter(item => item.type === 'authorizeSiteNavigation').length, 2);
  assert.ok(!w.native.some(item => ['warmLaya', 'suggestFields', 'answerFields'].includes(item.type)));
  await w.stop();
});

test('same semantic step and an uncertain Next response never trigger a second click', async () => {
  for (const loseResponse of [false, true]) {
    const w = worker();
    if (loseResponse) w.state.onAdvance = async () => { w.tab.status = 'loading'; throw new Error('Response lost after navigation'); };
    const result = await w.start(); assert.equal(result.ok, true); assert.equal(w.state.clicks, 1);
    w.move({ step: 'first-page', fields: [], url: `${ORIGIN}/intake?step=1` });
    await tick(); await w.info(); await tick();
    assert.equal(w.state.clicks, 1); assert.equal(w.state.advances, 1);
    w.clock.now += 16000; await w.info(); await tick();
    const info = await w.info(); assert.equal(info.data.autopilot, false); assert.equal(w.state.clicks, 1);
    assert.equal(w.native.filter(item => item.type === 'authorizeSiteNavigation').length, 1);
  }
});

for (const reason of ['missing', 'protected', 'review', 'errors', 'unknown', 'no-next', 'frames', 'unsupported']) test(`navigation pauses on ${reason} without authorizing Next`, async () => {
  const w = worker({ reason, values: reason === 'missing' ? {} : { firstName: 'Synthetic' } });
  const response = await w.start(); assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(w.state.clicks, 0); assert.equal(w.state.advances, 0);
  assert.ok(!w.native.some(item => item.type === 'authorizeSiteNavigation'));
  assert.equal((await w.info()).data.autopilot, false);
  if (['protected', 'review', 'errors', 'frames'].includes(reason)) assert.equal(w.native.length, 0, 'a protected page is inspected before releasing values');
});

test('unknown required questions receive no model guess and keep Next paused', async () => {
  const w = worker({ fields: [{ key: 'firstName', label: 'First name' }, { label: 'Preferred pickup day', type: 'select', options: ['Monday', 'Friday'] }] });
  const reply = await w.start(); assert.equal(reply.ok, true); assert.equal(reply.data.state, 'waiting');
  assert.equal(w.state.fields[0].answer, 'Synthetic'); assert.equal(w.state.fields[1].answer, undefined);
  assert.ok(!w.native.some(item => ['warmLaya', 'suggestFields', 'answerFields', 'authorizeSiteNavigation'].includes(item.type))); assert.equal(w.state.clicks, 0);
});

test('held sensitive fields pause even if the page claims its Next action is ready', async () => {
  const w = worker({ reason: 'ready' }); w.vault.held = ['firstName'];
  const result = await w.start(); assert.equal(result.ok, true); assert.equal(result.data.held, 1);
  assert.equal(w.state.fields[0].answer, undefined); assert.equal(w.state.clicks, 0);
  assert.ok(!w.native.some(item => item.type === 'authorizeSiteNavigation'));
});

test('repeated start requests during the same authorization share one fill and one Next', async () => {
  const w = worker(), waiting = deferred(); w.hooks.authorizeSiteNavigation = () => waiting.promise;
  const first = w.start(); await until(() => w.native.some(item => item.type === 'authorizeSiteNavigation'), 'first navigation approval');
  const second = w.start(); await tick();
  assert.equal(w.native.filter(item => item.type === 'authorizeSiteNavigation').length, 1);
  waiting.resolve(); const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok)); assert.equal(w.state.clicks, 1); assert.equal(w.state.advances, 1);
  assert.equal(w.content.filter(item => item.type === 'secondhand:generic:fill').length, 1);
  await w.stop();
});

for (const change of ['stop', 'inactive', 'activated-tab', 'permission', 'trust', 'lock', 'revision', 'url', 'document']) test(`pending navigation authorization is invalidated by ${change}`, async () => {
  const w = worker(), waiting = deferred();
  w.hooks.authorizeSiteNavigation = () => waiting.promise;
  const pending = w.start(); await until(() => w.native.some(item => item.type === 'authorizeSiteNavigation'), 'navigation approval');
  if (change === 'stop') await w.stop();
  if (change === 'inactive') w.tab.active = false;
  if (change === 'activated-tab') w.events.activated({ tabId: 99 });
  if (change === 'permission') w.state.permission = false;
  if (change === 'trust') { w.vault.trusted = false; w.vault.accessRevision++; }
  if (change === 'lock') w.vault.unlocked = false;
  if (change === 'revision') w.vault.accessRevision++;
  if (change === 'url') w.tab.url = `${ORIGIN}/different`;
  if (change === 'document') { w.state.document += '-reloaded'; w.state.version++; }
  waiting.resolve(); await pending;
  assert.equal(w.state.clicks, 0, change);
  if (change !== 'document') assert.equal(w.state.advances, 0, 'authorization loss is stopped before asking content to click');
});

test('Stop while saved answers are pending prevents both fill and Next; a later reply never restarts the run', async () => {
  const w = worker(), waiting = deferred(); w.hooks.getFields = () => waiting.promise;
  const pending = w.start(); await until(() => w.native.some(item => item.type === 'getFields'), 'saved field approval');
  await w.stop(); waiting.resolve(); await pending;
  assert.equal(w.state.fields[0].answer, undefined); assert.equal(w.state.clicks, 0);
  assert.ok(!w.native.some(item => item.type === 'authorizeSiteNavigation'));
  assert.equal((await w.info()).data.autopilot, false);
});

test('Stop during the initial active-tab check prevents a not-yet-started run from appearing later', async () => {
  const w = worker(), waiting = deferred(); let checking = false;
  w.hooks.tabGet = async () => { checking = true; await waiting.promise; };
  const pending = w.start(); await until(() => checking, 'initial active-tab check');
  await w.stop(); waiting.resolve(); await pending;
  assert.equal(w.state.fields[0].answer, undefined);
  assert.equal(w.state.clicks, 0); assert.equal(w.native.length, 0);
  assert.equal((await w.info()).data.autopilot, false);
});

for (const change of ['stop', 'activated-tab', 'permission-removed']) test(`startup permission check cannot revive a run after ${change}`, async () => {
  const w = worker(), waiting = deferred(); let checking = false;
  w.hooks.permission = async () => { checking = true; await waiting.promise; };
  const pending = w.start(); await until(() => checking, 'startup permission check');
  if (change === 'stop') await w.stop();
  if (change === 'activated-tab') w.events.activated({ tabId: 99 });
  if (change === 'permission-removed') w.events.permissionsRemoved({ origins: [`${ORIGIN}/*`] });
  waiting.resolve(); await pending; await tick();
  assert.equal(w.state.fields[0].answer, undefined);
  assert.equal(w.state.clicks, 0); assert.equal(w.native.length, 0);
  assert.equal((await w.info()).data.autopilot, false);
});

test('repeated starts share pending startup and an explicit new start works after a denied startup', async () => {
  const w = worker(), waiting = deferred(); let checks = 0;
  w.hooks.permission = async () => { checks++; await waiting.promise; };
  const first = w.start(); await until(() => checks === 1, 'startup permission check');
  const second = w.start(); await tick(); assert.equal(checks, 1);
  w.state.permission = false; waiting.resolve();
  const refused = await Promise.all([first, second]);
  assert.ok(refused.every(result => result.ok === false));
  assert.equal(w.native.length, 0); assert.equal(w.state.clicks, 0);
  w.hooks.permission = undefined; w.state.permission = true;
  const restarted = await w.start(); assert.equal(restarted.ok, true);
  assert.equal(w.state.fields[0].answer, 'Synthetic'); assert.equal(w.state.clicks, 1);
  await w.stop();
});

test('a stale stopped startup cannot cancel a newer explicitly started run', async () => {
  const w = worker(), waiting = deferred(); let checks = 0;
  w.hooks.tabGet = async () => { if (++checks === 1) await waiting.promise; };
  const stale = w.start(); await until(() => checks === 1, 'first startup');
  await w.stop();
  const current = await w.start(); assert.equal(current.ok, true); assert.equal(w.state.clicks, 1);
  waiting.resolve(); await stale;
  assert.equal(w.state.clicks, 1);
  assert.equal((await w.info()).data.autopilot, true);
  assert.equal(w.native.filter(item => item.type === 'authorizeSiteNavigation').length, 1);
  await w.stop();
});

test('cross-origin navigation ends the run before reading or filling the new site', async () => {
  const w = worker(); await w.start(); const nativeCount = w.native.length, contentCount = w.content.length;
  w.move({ url: 'https://other.example.org/form' }); await tick(); await tick();
  assert.equal(w.state.fields[0].answer, undefined); assert.equal(w.state.clicks, 1);
  assert.equal(w.native.length, nativeCount); assert.equal(w.content.length, contentCount);
  assert.equal((await w.info()).data.autopilot, false);
});

test('missing or malformed navigation receipts never reach Next', async () => {
  for (const revision of [undefined, -1, '42', Number.MAX_SAFE_INTEGER + 1]) {
    const w = worker(); w.hooks.authorizeSiteNavigation = (_request, result) => { result.accessRevision = revision; };
    const response = await w.start(); assert.equal(response.ok, true); assert.equal(w.state.clicks, 0); assert.equal(w.state.advances, 0);
    assert.equal(response.data.state, 'error');
  }
});

test('an uncertain Next response without observable navigation stops and is never retried by polling', async () => {
  const w = worker();
  w.state.onAdvance = async () => { throw new Error('Reply was lost, but this document is still active'); };
  const response = await w.start();
  assert.equal(response.ok, true); assert.equal(response.data.state, 'error');
  assert.equal(w.state.clicks, 1); assert.equal(w.state.advances, 1);
  for (let i = 0; i < 3; i++) assert.equal((await w.info()).data.autopilot, false);
  assert.equal(w.state.clicks, 1); assert.equal(w.state.advances, 1);
  assert.equal(w.native.filter(item => item.type === 'authorizeSiteNavigation').length, 1);
});

test('a step that read the address just before the next page loaded leaves that page to the next look, which fills it', async () => {
  const w = worker({ values: { firstName: 'Synthetic', zip: '50309' } });
  await w.start(); assert.equal(w.state.clicks, 1);
  // The next page loads while a step that read the old address asks for the page's navigation state, so the new page
  // answers. Its own load event finds that step still running.
  w.state.onNavigation = async () => { w.state.onNavigation = null; w.move(); };
  await w.info();
  await until(async () => !w.state.onNavigation && (await w.info()).data.autopilot === true && w.state.clicks === 2, 'the next look to fill the new page and click its Next');
  assert.equal(w.state.fields[0].answer, '50309');
  assert.equal(w.native.filter(item => item.type === 'authorizeSiteNavigation').length, 2);
  await w.stop();
});
