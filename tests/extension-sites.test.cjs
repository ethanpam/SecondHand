'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const strings = require('../extension/strings.js');

// Values created inside the worker's vm context have foreign prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const source = file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
const PANEL_URL = 'chrome-extension://testextension/panel.html';
const SITE_URL = 'https://pantry.example.org/intake?step=1';
const ORIGIN = 'https://pantry.example.org';
const SCRIPT_ID = 'site-pantry.example.org';
const SITE_SCRIPT = { id: SCRIPT_ID, matches: [`${ORIGIN}/*`], js: ['generic-adapter.js', 'generic-content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true };

// Stand-in for generic-adapter.js's pure helpers; the real engine has its own tests.
const { GENERIC_KEYS, unsafeQuestion } = require('../extension/generic-adapter.js');
const SENSITIVE = ['ssn', 'birthDate', 'ageRange', 'totalMonthlyIncome', 'annualIncome', 'assetsOnHand', 'monthlyMedicalExpenses',
  'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare'];
const generic = {
  GENERIC_KEYS, unsafeQuestion,
  requestKeys: keys => [...new Set(keys.flatMap(key => key === 'fullName' ? ['firstName', 'lastName'] : [key]))],
  deriveValues: values => ({ ...values, ...(values.firstName && values.lastName ? { fullName: `${values.firstName} ${values.lastName}` } : {}) })
};
const PICKUP = { name: 'pickup', label: 'Preferred pickup day', type: 'select-one', options: ['Monday', 'Friday'], required: true };
const pantryFields = () => [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip' }, { name: 'size', key: 'householdSize' }, { ...PICKUP }];

const pantryPlan = () => ({
  token: 'plan-1',
  matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high' }, { id: 'sh-2', key: 'zip', confidence: 'high' }, { id: 'sh-3', key: 'householdSize', confidence: 'high' }],
  unmatched: [{ id: 'sh-4', label: 'Preferred pickup day', type: 'select-one', options: ['Monday', 'Friday'], required: true }]
});

// A model of generic-content.js on the page: like the site engine, every plan lists the
// unanswered fields on screen under fresh ids, and answering a field can reveal others.
function sitePage(fields, { next = false, tokenPrefix = 'plan', lang = 'en' } = {}) {
  let sequence = 0, current = null, listings = 0, listed = null;
  const onScreen = field => !field.hidden && (!field.revealedBy || fields.some(other => other.name === field.revealedBy && other.answered));
  const shown = field => !field.answered && onScreen(field);
  return {
    fields,
    // The page as HTML, with the engine's marks on the fields it filled.
    html: () => fields.map(field => `<div${onScreen(field) ? '' : ' style="display:none"'}><input name="${field.name}"${field.mark ? ` data-secondhand-filled="${field.mark}"` : ''}></div>`).join('') +
      (next ? '<button type="button">Next</button>' : ''),
    plan() {
      sequence++;
      const ids = new Map(), matched = [], unmatched = [];
      fields.filter(shown).forEach((field, index) => {
        const id = `sh-${sequence}-${index}`;
        ids.set(id, field);
        if (field.key) matched.push({ id, key: field.key, confidence: 'high' });
        else unmatched.push({ id, label: field.label, type: field.type, options: field.options || [], required: field.required === true });
      });
      current = { token: `${tokenPrefix}-${sequence}`, ids };
      return { token: current.token, matched, unmatched };
    },
    fill({ token, assignments, values }) {
      if (token !== current?.token) return { ok: false, filled: [], skipped: [] };
      const filled = [], rejected = [];
      for (const { id, key, option, guessed } of assignments) {
        const field = current.ids.get(id);
        // Laya's answer (#42) is one of the question's own options; everything else is a saved value.
        const answer = option !== undefined ? (field?.options || []).includes(option) && option : values[key];
        if (!field || field.answered || field.refuses || !answer) continue;
        // The page flags the answer: the engine clears a text box, but a chosen option stays chosen.
        if (field.rejects) { rejected.push(id); if (field.choice) field.answered = answer; continue; }
        field.answered = answer; field.mark = guessed ? 'guess' : 'rule';
        filled.push(id);
      }
      return { ok: true, filled, skipped: assignments.map(item => item.id).filter(id => !filled.includes(id) && !rejected.includes(id)), rejected };
    },
    // Every question on screen, answered or not, under its own ids: labels only.
    questions() {
      listings++;
      listed = new Map(fields.filter(onScreen).map((field, index) => [`sq-${listings}-${index}`, field]));
      return { lang, questions: [...listed].map(([id, field]) => ({ id, label: field.label || field.name })) };
    },
    focus: id => Boolean(current?.ids.has(id) || listed?.has(id)),
    // The id a field has in the latest plan.
    idOf: name => [...(current?.ids || [])].find(([, field]) => field.name === name)?.[0],
    answered: () => fields.filter(field => field.answered).map(field => field.name)
  };
}

function siteWorker({ url = SITE_URL, enabled = false, granted = enabled, desktop = {}, fields = pantryFields(), next, duringGetFields, duringStatus, frames = [], plan, keepAccess = false, discoveryError = false, topError, framesReply, clock } = {}) {
  const tab = { id: 7, active: true, url };
  const log = [], native = [], content = [], injected = [], opened = [];
  const permissions = new Set(granted ? [`${ORIGIN}/*`] : []);
  const registered = new Map(enabled ? [[SCRIPT_ID, structuredClone(SITE_SCRIPT)]] : []);
  for (const frame of frames) {
    if (frame.granted || frame.enabled) permissions.add(`${frame.origin}/*`);
    if (frame.enabled) { const id = `frame-pantry.example.org--${new URL(frame.origin).hostname}`; registered.set(id, { ...SITE_SCRIPT, id, matches: [`${frame.origin}/*`] }); }
  }
  const page = sitePage(fields, { next });
  for (const frame of frames) frame.page = sitePage(frame.fields || pantryFields(), { next: frame.next, tokenPrefix: `frame${frame.frameId}`, lang: frame.lang });
  const tallies = [];
  let statusChecks = 0;
  const vault = { reachable: true, unlocked: true, accessRevision: 0, getFieldsError: null, trustError: null,
    values: { firstName: 'Synthetic private first', lastName: 'Synthetic private last', zip: '50309' }, ...desktop };
  const events = {};
  const event = key => ({ addListener: value => { events[key] = value; } });
  let listener;
  const chrome = {
    tabs: {
      get: async () => ({ ...tab }),
      sendMessage: async (tabId, message, options) => {
        content.push({ tabId, frameId: options?.frameId, ...plain(message) });
        if (options?.frameId === 0 && topError) throw new Error(topError);
        if (message.type === 'secondhand:generic:frames') return framesReply === undefined ? { origins: frames.map(frame => frame.origin) } : framesReply;
        const frame = frames.find(frame => frame.frameId === options?.frameId);
        const model = frame?.page || page;
        if (message.type === 'secondhand:generic:plan') {
          if (frame?.planError) throw new Error('private frame failure');
          return frame?.plan || plan || model.plan();
        }
        if (message.type === 'secondhand:generic:fill') {
          if (frame?.fillError) throw new Error('private frame failure');
          return typeof frame?.fillResult === 'function' ? frame.fillResult(plain(message), model) : frame?.fillResult || model.fill(plain(message));
        }
        if (message.type === 'secondhand:generic:focus') return { focused: model.focus(message.id) };
        if (message.type === 'secondhand:generic:questions') return model.questions();
        throw new Error(`Unexpected content message ${message.type}`);
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated')
    },
    permissions: {
      contains: async ({ origins }) => { log.push('permissions.contains'); return origins.every(origin => permissions.has(origin)); },
      remove: async ({ origins }) => { log.push('permissions.remove'); if (!keepAccess) origins.forEach(origin => permissions.delete(origin)); return true; },
      request: async () => { log.push('permissions.request'); throw new Error('Only the side panel may request access, inside a click.'); }
    },
    scripting: {
      executeScript: async details => {
        if (details.func && details.target.allFrames) {
          if (discoveryError) throw new Error('Cannot access an unapproved frame');
          return [{ frameId: 0, result: ORIGIN }, ...frames.map(frame => ({ frameId: frame.frameId, result: frame.origin }))];
        }
        if (details.func) {
          tallies.push({ target: plain(details.target), func: details.func });
          return details.target.frameIds.map(frameId => {
            const model = frames.find(frame => frame.frameId === frameId)?.page || page;
            const dom = new JSDOM(`<!doctype html><body>${model.html()}</body>`, { runScripts: 'outside-only' });
            try { return { frameId, result: plain(dom.window.eval(`(${details.func})()`)) }; } finally { dom.window.close(); }
          });
        }
        log.push('scripting.executeScript'); injected.push(plain(details));
      },
      getRegisteredContentScripts: async ({ ids } = {}) => { log.push('scripting.getRegisteredContentScripts'); return (ids || [...registered.keys()]).filter(id => registered.has(id)).map(id => structuredClone(registered.get(id))); },
      registerContentScripts: async scripts => {
        log.push('scripting.registerContentScripts');
        for (const script of plain(scripts)) { if (registered.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`); registered.set(script.id, script); }
      },
      updateContentScripts: async scripts => {
        log.push('scripting.updateContentScripts');
        for (const script of plain(scripts)) { if (!registered.has(script.id)) throw new Error(`Nonexistent script ID '${script.id}'`); registered.set(script.id, { ...registered.get(script.id), ...script }); }
      },
      unregisterContentScripts: async ({ ids }) => {
        log.push('scripting.unregisterContentScripts');
        for (const id of ids) { if (!registered.delete(id)) throw new Error(`Nonexistent script ID '${id}'`); }
      }
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async options => { opened.push(plain(options)); } },
    runtime: {
      id: 'testextension', getURL: file => `chrome-extension://testextension/${file}`,
      onMessage: { addListener: callback => { listener = callback; } },
      connectNative: () => {
        let onMessage, onDisconnect;
        return {
          onMessage: { addListener: callback => { onMessage = callback; } },
          onDisconnect: { addListener: callback => { onDisconnect = callback; } },
          disconnect: () => {},
          postMessage: request => {
            native.push(plain(request)); log.push(`native:${request.type}`);
            queueMicrotask(() => {
              if (!vault.reachable) return onDisconnect();
              const reply = data => onMessage({ id: request.id, ok: true, data });
              const fail = error => onMessage({ id: request.id, ok: false, error });
              if (request.type === 'status') {
                duringStatus?.(vault, ++statusChecks);
                return reply({ unlocked: vault.unlocked, applicationCount: 0, accessRevision: vault.accessRevision, ...(vault.layaState ? { laya: { state: vault.layaState } } : {}) });
              }
              // Laya (#39, #42): this build's desktop has no runtime and answers "not ready", unless a test plays it.
              if (request.type === 'suggestFields' || request.type === 'answerFields') {
                const play = vault.laya?.[request.type];
                if (!play) return onMessage({ id: request.id, ok: false, error: 'Laya isn’t ready on this computer.', code: 'LAYA_NOT_READY' });
                const answer = play(plain(request), vault);
                return typeof answer === 'string' ? fail(answer) : reply(answer);
              }
              if (request.type === 'showApp') return reply({ shown: true });
              if (request.type === 'trustSite') return (vault.trustError || request.url === vault.declineOrigin) ? fail(vault.trustError || 'Declined') : reply({ trusted: true, origin: new URL(request.url).origin });
              if (request.type === 'getFields') {
                duringGetFields?.(tab);
                if (vault.getFieldsError) return fail(vault.getFieldsError);
                return reply({ accessRevision: vault.accessRevision, values: Object.fromEntries(request.fields.filter(key => vault.values[key]).map(key => [key, vault.values[key]])) });
              }
              fail('Unsupported bridge request.');
            });
          }
        };
      }
    }
  };
  // A test may run the worker's clock itself: `clock.now` is what Date.now() returns.
  vm.runInNewContext(source('background.js'),
    { chrome, SecondHandIowa: adapter, SecondHandGeneric: generic, SecondHandStrings: strings, importScripts: () => {}, crypto: webcrypto, setTimeout, clearTimeout, URL, Map, Set, console,
      ...(clock ? { Date: { now: () => clock.now } } : {}) });
  const send = (message, sender) => new Promise(resolve => { if (!listener(message, sender, resolve)) resolve(undefined); });
  return {
    tab, page, vault, log, native, content, injected, tallies, opened, permissions, registered, events, send,
    nativeTypes: () => native.map(call => call.type),
    contentTypes: () => content.map(call => call.type),
    panel: message => send({ tabId: 7, ...message }, { id: 'testextension', url: PANEL_URL }),
    launcher: message => send(message, { id: 'testextension', url: `${PANEL_URL}?surface=launcher`, frameId: 3, tab: { id: 7, url: tab.url } })
  };
}
const autofill = w => w.panel({ type: 'ui:autofill', confirmed: true });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

test('the worker loads the site engine and its text next to the Iowa adapter and refuses to start without either', () => {
  const imported = [];
  const chrome = { runtime: { onMessage: { addListener: () => {} } }, tabs: {}, sidePanel: { setPanelBehavior: async () => {} } };
  assert.throws(() => vm.runInNewContext(source('background.js'), { chrome, SecondHandIowa: adapter, importScripts: (...files) => imported.push(...files), crypto: webcrypto, URL, Map, Set }), /generic-adapter\.js/);
  assert.deepEqual(imported, ['address-policy.js', 'iowa-adapter.js', 'generic-adapter.js', 'strings.js']);
  assert.throws(() => vm.runInNewContext(source('background.js'), { chrome, SecondHandIowa: adapter, SecondHandGeneric: generic, importScripts: () => {}, crypto: webcrypto, URL, Map, Set }), /strings\.js/);
});

test('turning a site on checks Chrome access, asks the desktop, then registers and injects the site scripts', async () => {
  const w = siteWorker({ granted: true });
  const response = await w.panel({ type: 'ui:enableSite', confirmed: true });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { enabled: true, origin: ORIGIN });
  const steps = ['permissions.contains', 'native:trustSite', 'scripting.registerContentScripts', 'scripting.executeScript'];
  assert.deepEqual(w.log.filter(name => steps.includes(name)), steps);
  assert.equal(w.log.includes('permissions.request'), false);
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'trustSite', url: `${ORIGIN}/intake` }]);
  assert.deepEqual(w.registered.get(SCRIPT_ID), SITE_SCRIPT);
  assert.deepEqual(w.injected, [{ target: { tabId: 7, frameIds: [0] }, files: ['generic-adapter.js', 'generic-content.js'] }]);
  assert.deepEqual(w.contentTypes(), []);

  const again = await w.panel({ type: 'ui:enableSite', confirmed: true });
  assert.equal(again.ok, true, again.error);
  assert.equal(w.log.filter(name => name === 'scripting.registerContentScripts').length, 1);
  assert.equal(w.log.includes('scripting.updateContentScripts'), true);
  assert.deepEqual([...w.registered.keys()], [SCRIPT_ID]);
});

test('a site is only turned on by a confirmed side-panel request with Chrome access and desktop approval', async () => {
  const w = siteWorker({ granted: true });
  assert.equal(await w.panel({ type: 'ui:enableSite' }), undefined);
  assert.equal(await w.launcher({ type: 'ui:enableSite', confirmed: true }), undefined);
  assert.equal(await w.send({ type: 'ui:enableSite', confirmed: true, tabId: 7 }, { id: 'testextension', url: SITE_URL, tab: { id: 7, url: SITE_URL } }), undefined);
  assert.deepEqual(w.native, []);

  const noAccess = siteWorker();
  const refused = await noAccess.panel({ type: 'ui:enableSite', confirmed: true });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Chrome/);
  assert.deepEqual(noAccess.native, []);
  assert.equal(noAccess.registered.size, 0);

  const declined = siteWorker({ granted: true, desktop: { trustError: 'You cancelled trusting this site.' } });
  const cancelled = await declined.panel({ type: 'ui:enableSite', confirmed: true });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /cancelled trusting/);
  assert.equal(declined.registered.size, 0);
  assert.deepEqual(declined.injected, []);
  assert.equal(declined.permissions.size, 0, 'Chrome access is handed back when the desktop does not trust the site');

  for (const url of [`${adapter.PORTAL}/applyForBenefits/welcome`, 'http://pantry.example.org/intake', 'https://pantry.example.org:8443/intake', 'https://user@pantry.example.org/']) {
    const other = siteWorker({ url, granted: true });
    assert.equal((await other.panel({ type: 'ui:enableSite', confirmed: true })).ok, false, url);
    assert.deepEqual(other.native, [], url);
    assert.equal(other.registered.size, 0, url);
  }
});

test('page state tells the panel whether a site is on, with metadata only', async () => {
  const off = siteWorker({ granted: true });
  assert.deepEqual(plain((await off.panel({ type: 'ui:pageState' })).data),
    { page: { kind: 'general', pageKey: 'general' }, result: null, autopilot: false, site: { origin: ORIGIN, enabled: false, frames: [], ready: false } });
  const on = siteWorker({ enabled: true });
  assert.deepEqual(plain((await on.panel({ type: 'ui:pageState' })).data),
    { page: { kind: 'general', pageKey: 'general' }, result: null, autopilot: false, site: { origin: ORIGIN, enabled: true, frames: [], ready: true } });
  for (const w of [off, on]) assert.deepEqual(w.native, []);
  assert.deepEqual(off.content, []);
  assert.deepEqual(on.contentTypes(), ['secondhand:generic:frames']);
});

test('autofill on an approved site asks for the planned keys once and fills without navigating', async () => {
  const w = siteWorker({ enabled: true });
  const response = await autofill(w);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields', 'status']);
  assert.deepEqual(w.native[1].fields, ['firstName', 'lastName', 'zip', 'householdSize']);
  assert.equal(w.native[1].url, `${ORIGIN}/intake`);
  // The second plan finds nothing new it can fill, so the click ends there.
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:plan']);
  assert.ok(w.content.every(call => call.tabId === 7 && call.frameId === 0));
  const fill = w.content.find(call => call.type === 'secondhand:generic:fill');
  assert.equal(fill.token, 'plan-1');
  assert.deepEqual(fill.assignments, [{ id: 'sh-1-0', key: 'fullName', guessed: false }, { id: 'sh-1-1', key: 'zip', guessed: false }]);
  assert.deepEqual(fill.values, { fullName: 'Synthetic private first Synthetic private last', zip: '50309' }, 'only the values being placed reach the page');
  assert.deepEqual(plain(response.data), { state: 'done', filled: 2, guessed: 0, needYou: [w.page.idOf('pickup'), w.page.idOf('size')].map(id => `f0:${id}`),
    message: 'Filled 2 · 2 need you. Check your answers before you submit.', messageKey: 'result.siteFilledNeedYou', messageParams: { count: 2, needYou: 2 }, pageKey: 'general' });
  assert.deepEqual(plain(response.data.needYou), ['f0:sh-2-1', 'f0:sh-2-0'], 'need-you ids come from the latest plan');
  assert.doesNotMatch(JSON.stringify(response), /Synthetic private/);

  const state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.equal(state.autopilot, false);
  assert.equal(state.result.message, response.data.message);
  w.events.updated(7, { status: 'complete' }); await settle();
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:plan', 'secondhand:generic:frames'], 'nothing continues or navigates on its own');
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields', 'status']);
  assert.deepEqual(w.injected, []);
  w.events.updated(7, { status: 'loading' });
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.result, null);
});

test('answers that reveal more questions are filled in the same click from one desktop request', async () => {
  const fields = [
    { name: 'name', key: 'fullName' }, { name: 'email', key: 'email' },
    { name: 'size', key: 'householdSize', refuses: true },               // the page rejects it every time
    { name: 'confirmEmail', key: 'email', revealedBy: 'email' },          // same key: its value was requested
    { name: 'phone', key: 'phone', revealedBy: 'name' },                  // its key was not requested
    { ...PICKUP }
  ];
  const w = siteWorker({ enabled: true, fields, desktop: { values: { firstName: 'Synthetic private first', lastName: 'Synthetic private last',
    email: 'synthetic@example.org', householdSize: '4', mobilePhone: '5155550100' } } });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields', 'status', 'status', 'status'], 'one profile request, with authorization checked before each fill pass');
  assert.deepEqual(w.native[1].fields, ['firstName', 'lastName', 'email', 'householdSize']);
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:plan', 'secondhand:generic:fill',
    'secondhand:generic:plan', 'secondhand:generic:fill'], 'the third pass fills nothing, so the click stops');
  assert.deepEqual(w.page.answered(), ['name', 'email', 'confirmEmail']);
  assert.equal(result.filled, 3);
  assert.deepEqual(result.needYou, [w.page.idOf('pickup'), w.page.idOf('size'), w.page.idOf('phone')].map(id => `f0:${id}`));
  assert.ok(result.needYou.every(id => id.startsWith('f0:sh-3-')), 'need-you ids come from the latest plan');
  assert.match(result.message, /^Filled 3 · 3 need you\./);
  assert.doesNotMatch(JSON.stringify(w.content), /5155550100/);
});

test('answers the page refuses are listed as need-you, not filled, and not tried again in the same click', async () => {
  const fields = [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip', rejects: true }, { name: 'vet', key: 'householdVeteran', rejects: true, choice: true }, { ...PICKUP }];
  const w = siteWorker({ enabled: true, fields, desktop: { values: { firstName: 'Synthetic private first', lastName: 'Synthetic private last', zip: '5030', householdVeteran: 'no' } } });
  const result = plain((await autofill(w)).data);
  const fills = w.content.filter(call => call.type === 'secondhand:generic:fill');
  assert.equal(fills.length, 1, 'refused answers are not retried');
  assert.equal(result.filled, 1);
  // The cleared ZIP box is back in the latest plan; the chosen veteran option keeps its first id.
  assert.deepEqual(result.needYou, [w.page.idOf('pickup'), w.page.idOf('zip'), 'sh-1-2'].map(id => `f0:${id}`));
  assert.equal(result.message, 'Filled 1 · 3 need you. Check your answers before you submit.');

  const alone = siteWorker({ enabled: true, fields: [{ name: 'zip', key: 'zip', rejects: true }], desktop: { values: { zip: '5030' } } });
  const refused = plain((await autofill(alone)).data);
  assert.equal(refused.filled, 0);
  assert.deepEqual(refused.needYou, ['f0:sh-1-0']);
});

test('one click fills at most four passes of revealed questions', async () => {
  const fields = Array.from({ length: 6 }, (_, i) => ({ name: `email${i}`, key: 'email', ...(i ? { revealedBy: `email${i - 1}` } : {}) }));
  const w = siteWorker({ enabled: true, fields, desktop: { values: { email: 'synthetic@example.org' } } });
  const result = plain((await autofill(w)).data);
  assert.equal(w.contentTypes().filter(type => type === 'secondhand:generic:fill').length, 4);
  assert.deepEqual(w.page.answered(), ['email0', 'email1', 'email2', 'email3']);
  assert.equal(result.filled, 4);
  assert.deepEqual(result.needYou, [`f0:${w.page.idOf('email4')}`]);
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields', 'status', 'status', 'status', 'status']);
});

test('a second click on the next page of a multi-page form plans that page again', async () => {
  const fields = [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip', hidden: true }];
  const w = siteWorker({ enabled: true, fields });
  assert.equal((await autofill(w)).data.filled, 1);
  fields[0].hidden = true; fields[1].hidden = false;          // the form shows its second page at the same URL
  const second = plain((await autofill(w)).data);
  assert.deepEqual(w.page.answered(), ['name', 'zip']);
  assert.deepEqual(w.native.filter(call => call.type === 'getFields').map(call => call.fields), [['firstName', 'lastName'], ['zip']]);
  assert.equal(second.state, 'done');
  assert.equal(second.filled, 1, 'only this page’s answers count');
  assert.equal(second.message, 'Filled 1. Check your answers before you submit.');
});

test('another click on the same page reports the running total, not what that click added', async () => {
  const w = siteWorker({ enabled: true });
  assert.equal((await autofill(w)).data.message, 'Filled 2 · 2 need you. Check your answers before you submit.');
  const again = plain((await autofill(w)).data);
  assert.equal(again.filled, 2);
  assert.equal(again.message, 'Filled 2 · 2 need you. Check your answers before you submit.');
  assert.deepEqual(w.tallies.map(call => call.target), [{ tabId: 7, frameIds: [0] }, { tabId: 7, frameIds: [0] }]);
  assert.deepEqual(w.injected, [], 'no files are injected');
});

test('a page where nothing matches the saved profile says so instead of Filled 0', async () => {
  const unknown = siteWorker({ enabled: true, fields: [{ ...PICKUP }, { name: 'shoe', label: 'Shoe size', type: 'text' }] });
  const result = plain((await autofill(unknown)).data);
  assert.equal(result.filled, 0);
  assert.equal(result.message, 'Nothing here matches your saved profile. 2 need you.');
  const unsaved = siteWorker({ enabled: true, desktop: { values: {} } });
  const empty = plain((await autofill(unsaved)).data);
  assert.deepEqual(unsaved.nativeTypes(), ['status', 'getFields']);
  assert.equal(empty.message, 'Nothing here matches your saved profile. 4 need you.');
});

test('a page with nothing to fill points to Next when the form has one', async () => {
  const paged = siteWorker({ enabled: true, fields: [], next: true });
  assert.equal(plain((await autofill(paged)).data).message, 'Nothing to fill here. Click Next, then Autofill again.');
  const single = siteWorker({ enabled: true, fields: [] });
  assert.equal(plain((await autofill(single)).data).message, 'Nothing to fill here.');
  for (const w of [paged, single]) assert.deepEqual(w.native, []);
});

test('the page count takes each on-screen question SecondHand filled once and spots a Next button', async t => {
  const w = siteWorker({ enabled: true, fields: [] });
  await autofill(w);
  const [{ func }] = w.tallies;
  const run = html => {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only' });
    t.after(() => dom.window.close());
    return plain(dom.window.eval(`(${func})()`));
  };
  assert.deepEqual(run(`<form><input name="first" data-secondhand-filled="rule" value="Synthetic private">
    <label><input type="radio" name="vet" value="yes" data-secondhand-filled="rule">Yes</label>
    <label><input type="radio" name="vet" value="no" data-secondhand-filled="rule">No</label>
    <input name="email" data-secondhand-filled="guess"><input name="untouched"></form>
    <section style="display:none"><input name="earlier" data-secondhand-filled="rule"><button type="button">Next</button></section>
    <div hidden><input name="tucked" data-secondhand-filled="guess"></div>
    <button type="submit">Submit</button>`), { rule: 2, guess: 1, next: false });
  // Google Forms' div choices: every option is marked, but the question counts once.
  assert.deepEqual(run(`<div role="radiogroup">${['One', 'Two', 'Three'].map(label => `<div role="radio" aria-label="${label}" data-secondhand-filled="rule"></div>`).join('')}</div>
    <div role="radiogroup"><div role="radio" data-secondhand-filled="guess"></div><div role="radio" data-secondhand-filled="guess"></div></div>`), { rule: 1, guess: 1, next: false });
  assert.equal(run('<button type="button">Next</button>').next, true);
  assert.equal(run('<input type="submit" value="Next page">').next, true);
  assert.equal(run('<div role="button"><span>Next</span></div>').next, true);
  assert.equal(run('<button type="button" style="visibility:hidden">Next</button>').next, false);
  assert.doesNotMatch(JSON.stringify(run('<input name="first" data-secondhand-filled="rule" value="Synthetic private">')), /Synthetic/);
});

// Questions the rules leave open, for Chrome's on-device AI in the widget.
const openQuestions = () => [{ name: 'name', key: 'fullName' }, { ...PICKUP },
  { name: 'reach', label: 'Where can we email you?', type: 'email' }, { name: 'call', label: 'Best number to reach you', type: 'tel' }];
const plan = async w => plain((await w.launcher({ type: 'ui:plan', confirmed: true })).data);

test('the widget gets the open questions and the keys the AI may use, never sensitive ones or values', async () => {
  const w = siteWorker({ enabled: true, fields: openQuestions() });
  assert.equal(await w.launcher({ type: 'ui:plan' }), undefined, 'only a confirmed click plans');
  const planned = await plan(w);
  assert.deepEqual(planned.unmatched, [
    { id: 'f0:sh-1-1', label: 'Preferred pickup day', type: 'select-one', options: ['Monday', 'Friday'], required: true },
    { id: 'f0:sh-1-2', label: 'Where can we email you?', type: 'email', options: [], required: false },
    { id: 'f0:sh-1-3', label: 'Best number to reach you', type: 'tel', options: [], required: false }]);
  assert.deepEqual(planned.allowedKeys, GENERIC_KEYS.filter(key => !SENSITIVE.includes(key)));
  for (const key of SENSITIVE) assert.equal(planned.allowedKeys.includes(key), false, key);
  assert.deepEqual(Object.keys(planned), ['unmatched', 'allowedKeys', 'laya']);
  assert.equal(planned.laya, false, 'this desktop has no Laya, so Chrome’s AI may run');
  assert.deepEqual(w.native.map(call => Object.keys(call).sort()), [['id', 'type']], 'planning never reaches the vault: it only asks whether Laya is ready');
  assert.deepEqual(w.nativeTypes(), ['status']);
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan']);

  const off = siteWorker({ fields: openQuestions() });
  assert.equal((await off.launcher({ type: 'ui:plan', confirmed: true })).ok, false);
  assert.deepEqual(off.content, []);
});

test('AI guesses join the one desktop request and are filled with the guessed mark', async () => {
  const w = siteWorker({ enabled: true, fields: openQuestions(), desktop: { values: { firstName: 'Synthetic private first', lastName: 'Synthetic private last',
    email: 'synthetic@example.org', phone: '5155550100' } } });
  const { unmatched } = await plan(w);
  const [, reach, call] = unmatched.map(field => field.id);
  const response = await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: { [reach]: 'email', [call]: 'phone' } });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(w.nativeTypes(), ['status', 'status', 'getFields', 'status'], 'the plan’s Laya check, then the fill’s one vault request');
  assert.deepEqual(w.native[2].fields, ['firstName', 'lastName', 'email', 'phone']);
  // The fill uses the plan the AI saw, then plans again for anything revealed.
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan', 'secondhand:generic:frames', 'secondhand:generic:fill', 'secondhand:generic:plan']);
  assert.deepEqual(w.content.find(call => call.type === 'secondhand:generic:fill').assignments, [{ id: 'sh-1-0', key: 'fullName', guessed: false }, { id: reach.split(':')[1], key: 'email', guessed: true }, { id: call.split(':')[1], key: 'phone', guessed: true }]);
  assert.deepEqual(w.page.fields.map(field => field.mark), ['rule', undefined, 'guess', 'guess']);
  const result = plain(response.data);
  assert.equal(result.filled, 3);
  assert.equal(result.guessed, 2);
  assert.equal(result.message, 'Filled 3 · 2 guessed · 1 need you. Check your answers before you submit.');
  assert.doesNotMatch(JSON.stringify(result), /Synthetic private|5155550100/);
});

test('guesses outside the plan’s open questions or for sensitive keys are refused before the vault is asked', async () => {
  const bad = [ids => ({ [ids.name]: 'email' }), () => ({ 'sh-9-9': 'email' }), ids => ({ [ids.reach]: 'notAKey' }), () => [], () => 'email',
    ...SENSITIVE.map(key => ids => ({ [ids.reach]: key }))];
  for (const guesses of bad) {
    const w = siteWorker({ enabled: true, fields: openQuestions() });
    await plan(w);
    const ids = { name: `f0:${w.page.idOf('name')}`, reach: `f0:${w.page.idOf('reach')}` };
    const result = plain((await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: guesses(ids) })).data);
    assert.equal(result.state, 'error', JSON.stringify(guesses(ids)));
    assert.match(result.message, /couldn’t use the on-device AI/);
    assert.deepEqual(w.nativeTypes(), ['status'], `only the plan’s Laya check: ${JSON.stringify(guesses(ids))}`);
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false);
  }
});

test('guesses without a current plan for this page are refused', async () => {
  const unplanned = siteWorker({ enabled: true, fields: openQuestions() });
  const refused = plain((await unplanned.launcher({ type: 'ui:autofill', confirmed: true, guesses: { 'sh-1-2': 'email' } })).data);
  assert.match(refused.message, /page changed/);
  const moved = siteWorker({ enabled: true, fields: openQuestions() });
  await plan(moved);
  moved.events.updated(7, { status: 'loading' });              // a new page reuses the same ids
  assert.match(plain((await moved.launcher({ type: 'ui:autofill', confirmed: true, guesses: { 'sh-1-2': 'email' } })).data).message, /page changed/);
  const used = siteWorker({ enabled: true, fields: openQuestions() });
  await plan(used);
  await autofill(used);                                         // a fill without guesses plans afresh
  assert.match(plain((await used.launcher({ type: 'ui:autofill', confirmed: true, guesses: { 'sh-1-2': 'email' } })).data).message, /page changed/);
  assert.deepEqual(unplanned.native, []);
  assert.deepEqual(moved.nativeTypes(), ['status'], 'only the plan’s Laya check');
  assert.equal(used.nativeTypes().filter(type => type === 'getFields').length, 1);
});

test('a form with nothing SecondHand recognizes never contacts the desktop', async () => {
  const w = siteWorker({ enabled: true, fields: [{ ...PICKUP }] });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.native, []);
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan']);
  assert.equal(result.state, 'done');
  assert.equal(result.filled, 0);
  assert.deepEqual(result.needYou, ['f0:sh-1-0']);
  assert.equal(result.message, 'Nothing here matches your saved profile. 1 need you.');
});

test('sites that are not turned on never reach the vault or the page', async () => {
  for (const setup of [{ granted: true }, { enabled: true, granted: false }, {}]) {
    const w = siteWorker(setup);
    const refused = await autofill(w);
    assert.equal(refused.ok, false, JSON.stringify(setup));
    assert.match(refused.error, /Turn on SecondHand/);
    for (const type of ['ui:autofill', 'ui:pageState', 'ui:showApp']) {
      const response = await w.launcher({ type, confirmed: true });
      assert.equal(response.ok, false, type);
    }
    assert.equal((await w.launcher({ type: 'ui:focusField', key: 'sh-1-3', confirmed: true })).ok, false);
    assert.deepEqual(w.native, [], JSON.stringify(setup));
    assert.deepEqual(w.content, [], JSON.stringify(setup));
  }
});

test('the widget on an approved site is bound to its own tab and can open the side panel', async () => {
  const w = siteWorker({ enabled: true });
  assert.equal(await w.launcher({ type: 'ui:autofill' }), undefined);
  const response = await w.launcher({ type: 'ui:autofill', confirmed: true, tabId: 99 });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.data.filled, 2);
  assert.ok(w.content.every(call => call.tabId === 7));
  assert.equal(await w.launcher({ type: 'ui:desktopStatus' }), undefined);
  assert.equal(await w.launcher({ type: 'ui:disableSite', confirmed: true }), undefined);
  assert.deepEqual(plain((await w.launcher({ type: 'ui:openPanel', confirmed: true })).data), { opened: true });
  assert.deepEqual(w.opened, [{ tabId: 7 }]);
});

test('locked, offline, cancelled, and changed pages fill nothing on approved sites', async () => {
  const locked = siteWorker({ enabled: true, desktop: { unlocked: false } });
  assert.equal((await autofill(locked)).data.state, 'locked');
  assert.deepEqual(locked.nativeTypes(), ['status']);
  const offline = siteWorker({ enabled: true, desktop: { reachable: false } });
  const unreachable = (await autofill(offline)).data;
  assert.equal(unreachable.state, 'offline');
  assert.match(unreachable.message, /Open the SecondHand app/);
  const locking = siteWorker({ enabled: true, desktop: { getFieldsError: 'Unlock your local vault first.' } });
  assert.equal((await autofill(locking)).data.state, 'locked');
  const cancelled = siteWorker({ enabled: true, desktop: { getFieldsError: 'You cancelled this field request.' } });
  const declined = (await autofill(cancelled)).data;
  assert.equal(declined.state, 'error');
  assert.equal(declined.message, 'Cancelled. Nothing was filled.');
  const moved = siteWorker({ enabled: true, duringGetFields: tab => { tab.url = 'https://pantry.example.org/other'; } });
  assert.match((await autofill(moved)).data.message, /page changed/);
  for (const w of [locked, offline, locking, cancelled, moved]) {
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false);
    assert.equal(w.nativeTypes().filter(type => type === 'getFields').length <= 1, true);
  }
});

for (const change of ['locked', 'profile or trust changed', 'desktop restarted']) {
  test(`approved-site fill stops when access is ${change} after the profile request`, async () => {
    const w = siteWorker({ enabled: true, duringStatus: (vault, count) => {
      if (count !== 2) return;
      if (change === 'locked') vault.unlocked = false;
      else vault.accessRevision = change === 'desktop restarted' ? 812347891 : 1;
    } });
    const result = (await autofill(w)).data;
    assert.equal(result.state, change === 'locked' ? 'locked' : 'error');
    assert.deepEqual(w.page.answered(), []);
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false);
    assert.equal(w.nativeTypes().filter(type => type === 'getFields').length, 1);
  });
}

test('an authorization change between revealed-field passes stops remaining values', async () => {
  const fields = [
    { name: 'email', key: 'email' },
    { name: 'confirmation', key: 'email', revealedBy: 'email' }
  ];
  const w = siteWorker({ enabled: true, fields, desktop: { values: { email: 'synthetic@example.invalid' } },
    duringStatus: (vault, count) => { if (count === 3) vault.accessRevision++; } });
  const result = (await autofill(w)).data;
  assert.equal(result.state, 'error');
  assert.match(result.message, /access changed/);
  assert.deepEqual(w.page.answered(), ['email']);
  assert.equal(w.contentTypes().filter(type => type === 'secondhand:generic:fill').length, 1);
  assert.equal(w.nativeTypes().filter(type => type === 'getFields').length, 1);
});

test('need-you focus on approved sites goes to the site engine by field id', async () => {
  const w = siteWorker({ enabled: true });
  const [pickup] = (await autofill(w)).data.needYou;
  assert.deepEqual(plain((await w.launcher({ type: 'ui:focusField', key: pickup, confirmed: true })).data), { focused: true });
  assert.deepEqual(plain((await w.panel({ type: 'ui:focusField', key: 'f0:sh-9' })).data), { focused: false });
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:focus').map(({ type, id }) => ({ type, id })),
    [{ type: 'secondhand:generic:focus', id: pickup.split(':')[1] }, { type: 'secondhand:generic:focus', id: 'sh-9' }]);
  assert.equal(await w.launcher({ type: 'ui:focusField', key: 'input[type=password]', confirmed: true }), undefined);
});

test('turning a site off removes its script registration and Chrome access', async () => {
  const w = siteWorker({ enabled: true });
  assert.equal(await w.panel({ type: 'ui:disableSite' }), undefined);
  const response = await w.panel({ type: 'ui:disableSite', confirmed: true });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { enabled: false, origin: ORIGIN });
  assert.equal(w.registered.size, 0);
  assert.equal(w.permissions.size, 0);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.enabled, false);
  assert.equal((await autofill(w)).ok, false);
  assert.deepEqual(w.native, []);
});

// The content script that hosts the widget and runs the site engine on approved pages.
const extensionId = 'a'.repeat(32);
const extensionURL = file => `chrome-extension://${extensionId}/${file}`;
function siteContent(t, { url = SITE_URL, engine = true, settled = null } = {}) {
  const dom = new JSDOM('<!doctype html><body><form><label>Your name <input id="name"></label><label>Pickup day <select id="day"><option></option><option>Monday</option></select></label></form></body>', { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  const frames = [];
  const create = window.document.createElement.bind(window.document);
  window.document.createElement = name => { const element = create(name); if (name === 'iframe') frames.push(element); return element; };
  let listener;
  const calls = [];
  window.chrome = { runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener: callback => { listener = callback; } } } };
  if (engine) {
    window.SecondHandGeneric = {
      plan: doc => {
        calls.push('plan');
        return { token: 'plan-1', element: doc.getElementById('name'),
          matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high', element: doc.getElementById('name'), value: 'Synthetic private value' }],
          unmatched: [{ id: 'sh-2', label: 'Pickup day', type: 'select-one', options: ['Monday'], required: true, element: doc.getElementById('day'), value: 'Synthetic private value' }] };
      },
      fillFields: (doc, token, assignments, values) => {
        calls.push({ token, assignments: plain(assignments), values: plain(values) });
        doc.getElementById('name').value = values.fullName;
        return { ok: true, filled: ['sh-1'], skipped: [], rejected: ['sh-2'], pending: [], values };
      },
      // Stands in for the engine confirming choices the page marks a moment after the click.
      settle: async (doc, token, result) => { calls.push(`settle:${token}`); return settled ? settled(result) : result; },
      focusField: (doc, id) => { calls.push(`focus:${id}`); if (id !== 'sh-2') return false; doc.getElementById('day').focus(); return true; }
    };
  }
  window.eval(source('generic-content.js'));
  return { window, frames, calls,
    host: () => window.document.querySelector('[data-secondhand-assistant]'),
    request(message, sender = { id: extensionId }) { let response; listener?.(message, sender, value => { response = value; }); return response; },
    // For answers the content script sends after awaiting (fills settle their choices first).
    requestAsync(message, sender = { id: extensionId }) {
      return new Promise(resolve => { if (listener?.(message, sender, resolve) !== true) resolve(undefined); });
    } };
}

test('on approved sites the widget is a closed, full-size extension iframe in the top frame only', t => {
  const page = siteContent(t);
  const host = page.host();
  assert.ok(host);
  assert.equal(host.shadowRoot, null);
  assert.equal(page.frames.length, 1);
  assert.equal(page.frames[0].src, extensionURL('panel.html?surface=launcher'));
  assert.equal(page.frames[0].referrerPolicy, 'no-referrer');
  assert.equal(page.frames[0].getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  // Chrome's on-device AI (Prompt API) is blocked in a cross-origin iframe unless the embedder delegates it.
  assert.equal(page.frames[0].getAttribute('allow'), 'language-model; language-detector', 'the widget may use Chrome’s on-device AI and language detector');
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
  assert.equal(host.style.height, '70px');
  assert.equal(host.style.position, 'fixed');
  page.window.eval(source('generic-content.js'));
  assert.equal(page.frames.length, 1, 'injecting again keeps one widget');

  const child = page.window.document.createElement('iframe');
  page.window.document.body.append(child);
  child.contentWindow.SecondHandGeneric = page.window.SecondHandGeneric;
  child.contentWindow.chrome = page.window.chrome;
  child.contentWindow.eval(source('generic-content.js'));
  assert.equal(child.contentWindow.document.querySelector('[data-secondhand-assistant]'), null);
  assert.equal(siteContent(t, { engine: false }).host(), null);
  assert.equal(siteContent(t, { url: 'http://pantry.example.org/intake' }).host(), null);
});

test('site plans and fills answer with field metadata only, never values or elements', async t => {
  const page = siteContent(t);
  const plan = page.request({ type: 'secondhand:generic:plan' });
  assert.deepEqual(plain(plan), { token: 'plan-1', matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high' }],
    unmatched: [{ id: 'sh-2', label: 'Pickup day', type: 'select-one', options: ['Monday'], required: true }] });
  const filled = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic private name' } });
  assert.deepEqual(plain(filled), { ok: true, filled: ['sh-1'], skipped: [], rejected: ['sh-2'] }, 'answers the page refused come back');
  assert.deepEqual(page.calls[1], { token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic private name' } });
  assert.equal(page.window.document.getElementById('name').value, 'Synthetic private name');
  assert.doesNotMatch(JSON.stringify([plan, filled]), /Synthetic private/);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-2' })), { focused: true });
  assert.equal(page.window.document.activeElement.id, 'day');
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-9' })), { focused: false });
});

test('a fill answers only after the engine settles choices the page confirms a moment later', async t => {
  const page = siteContent(t, { settled: result => ({ ...result, filled: [...result.filled, 'sh-3'], pending: [] }) });
  page.request({ type: 'secondhand:generic:plan' });
  const filled = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic' } });
  assert.deepEqual(plain(filled), { ok: true, filled: ['sh-1', 'sh-3'], skipped: [], rejected: ['sh-2'] });
  assert.equal(page.calls.at(-1), 'settle:plan-1');
});

test('other extensions, malformed fills, and Iowa messages reach nothing on approved sites', t => {
  const page = siteContent(t);
  const foreign = { id: 'b'.repeat(32) };
  assert.equal(page.request({ type: 'secondhand:generic:plan' }, foreign), undefined);
  assert.equal(page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} }, foreign), undefined);
  assert.equal(page.request({ type: 'secondhand:generic:focus', id: 'sh-2' }, foreign), undefined);
  for (const message of [{ token: 'plan-1', assignments: 'sh-1', values: {} }, { token: 'plan-1', assignments: [], values: [] }, { token: 7, assignments: [], values: {} }]) {
    assert.equal(page.request({ type: 'secondhand:generic:fill', ...message }).ok, false);
  }
  for (const type of ['secondhand:pageState', 'secondhand:continue', 'secondhand:fill', 'secondhand:focusField']) assert.equal(page.request({ type }), undefined, type);
  assert.deepEqual(page.calls, []);
});

test('the widget is hidden while the site engine checks the page and restored after an engine error', t => {
  const page = siteContent(t);
  const host = page.host();
  const seen = [];
  for (const method of ['plan', 'fillFields', 'focusField']) {
    const original = page.window.SecondHandGeneric[method];
    page.window.SecondHandGeneric[method] = (...args) => { seen.push([method, host.style.visibility]); return original(...args); };
  }
  page.request({ type: 'secondhand:generic:plan' });
  page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic' } });
  page.request({ type: 'secondhand:generic:focus', id: 'sh-2' });
  assert.deepEqual(seen, [['plan', 'hidden'], ['fillFields', 'hidden'], ['focusField', 'hidden']]);
  assert.equal(host.style.visibility, '');
  page.window.SecondHandGeneric.plan = () => { throw new Error('Synthetic failure'); };
  const failed = page.request({ type: 'secondhand:generic:plan' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /could not be checked safely/);
  assert.equal(host.style.visibility, '');
});

const FRAME_ORIGIN = 'https://form.jotform.com';
const secondFrame = (extra = {}) => ({ origin: FRAME_ORIGIN, frameId: 4, ...extra });
test('pageState discovers pending frames through the approved top frame only', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame()] });
  assert.deepEqual(plain((await w.panel({ type: 'ui:pageState' })).data.site), {
    origin: ORIGIN, enabled: true, ready: true, frames: [{ origin: FRAME_ORIGIN, enabled: false }]
  });
  assert.deepEqual(w.content, [{ tabId: 7, frameId: 0, type: 'secondhand:generic:frames' }]);
  assert.deepEqual(w.injected, []);
});
test('enableFrames re-derives origins, trusts each, registers allFrames and injects', async () => {
  const other = 'https://forms.example.org';
  const w = siteWorker({ enabled: true, frames: [secondFrame({ granted: true }), { origin: other, frameId: 5, granted: true }] });
  const result = await w.panel({ type: 'ui:enableFrames', confirmed: true, origins: ['https://evil.example'] });
  assert.equal(result?.ok, true);
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'trustSite', url: FRAME_ORIGIN }, { type: 'trustSite', url: other }]);
  for (const origin of [FRAME_ORIGIN, other]) assert.equal(w.registered.get(`frame-pantry.example.org--${new URL(origin).hostname}`).allFrames, true);
  assert.ok(w.injected.some(call => call.target.allFrames && call.files.includes('generic-content.js')));
});
test('declining a frame trust returns all pending permissions and registers nothing', async () => {
  const other = 'https://forms.example.org';
  const w = siteWorker({ enabled: true, frames: [secondFrame({ granted: true }), { origin: other, frameId: 5, granted: true }], desktop: { declineOrigin: other } });
  const result = await w.panel({ type: 'ui:enableFrames', confirmed: true });
  assert.equal(result?.ok, false);
  assert.deepEqual([...w.registered.keys()], [SCRIPT_ID]);
  assert.deepEqual([...w.permissions], [`${ORIGIN}/*`]);
  assert.deepEqual(w.injected, []);
});
test('site fill requests the union once and uses each frame token', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, fields: [{ name: 'zip', key: 'zip' }] })] });
  const result = (await autofill(w)).data;
  assert.equal(result.filled, 3);
  assert.deepEqual(plain(result.needYou), ['f0:sh-2-1', 'f0:sh-2-0']);
  assert.equal(w.native.filter(call => call.type === 'getFields').length, 1);
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:fill').map(call => [call.frameId, call.token]), [[0, 'plan-1'], [4, 'frame4-1']]);
});
for (const failure of [{ planError: true }, { fillError: true }, { plan: { token: 'bad', matched: [null], unmatched: [] } }, { fillResult: { ok: true, filled: 'bad' } }]) {
  test(`frame failure is a fixed error: ${JSON.stringify(failure)}`, async () => {
    const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, ...failure })] });
    const result = (await autofill(w)).data;
    assert.equal(result.state, 'error');
    assert.equal(result.message, 'Part of this form couldn’t be filled safely. Fill it yourself.');
  });
}
test('rejected ids are need-you even when also reported filled', async () => {
  const child = secondFrame({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip', rejects: true }],
    fillResult: (message, model) => { const result = model.fill(message); result.filled.push(...result.rejected); return result; } });
  const w = siteWorker({ enabled: true, frames: [child] });
  const result = (await autofill(w)).data;
  assert.equal(result.filled, 3);
  assert.ok(result.needYou.includes(`f4:${child.page.idOf('zip')}`));
});
test('pending embedded forms explain the second approval step', async () => {
  const w = siteWorker({ enabled: true, plan: { token: 'empty', matched: [], unmatched: [] }, frames: [secondFrame()] });
  const result = (await autofill(w)).data;
  assert.equal(result.message, 'This form is inside form.jotform.com. Click “Also turn on the embedded form” in the SecondHand side panel.');
  assert.equal(w.content.some(call => call.frameId === 4), false);
  assert.deepEqual(w.native, []);
});
test('prefixed focus routes to an enabled frame and rejects malformed ids', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true })] });
  await autofill(w);
  assert.equal((await w.panel({ type: 'ui:focusField', key: 'f4:sh-2-1' }))?.data.focused, true);
  assert.deepEqual(w.content.at(-1), { tabId: 7, frameId: 4, type: 'secondhand:generic:focus', id: 'sh-2-1' });
  for (const key of ['f1234567:sh-4', 'f4:1bad', 'f4:' + 'a'.repeat(61)]) assert.equal(await w.panel({ type: 'ui:focusField', key }), undefined);
});
test('disableSite revokes enabled embedded origins and detects retained access', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true })] });
  assert.equal((await w.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  assert.equal(w.registered.size, 0);
  assert.equal(w.permissions.size, 0);
  assert.deepEqual(w.injected, []);
  const kept = siteWorker({ enabled: true, keepAccess: true });
  assert.equal((await kept.panel({ type: 'ui:disableSite', confirmed: true })).ok, false);
});

test('visible iframe discovery is https only, deduplicated, and excludes the page origin', t => {
  const page = siteContent(t);
  const doc = page.window.document;
  for (const [src, style] of [
    ['https://form.jotform.com/one', ''], ['https://form.jotform.com/two', ''],
    ['https://forms.example.org/', ''], [ORIGIN + '/same', ''], ['http://insecure.example/', ''],
    ['https://hidden.example/', 'display:none'], ['https://invisible.example/', 'visibility:hidden']
  ]) {
    const frame = doc.createElement('iframe'); frame.src = src; frame.style.cssText = style;
    frame.getClientRects = () => [{ width: 300, height: 200 }];
    doc.body.append(frame);
  }
  const wrapper = doc.createElement('div'); wrapper.hidden = true;
  const hidden = doc.createElement('iframe'); hidden.src = 'https://ancestor-hidden.example/';
  hidden.getClientRects = () => [{ width: 300, height: 200 }]; wrapper.append(hidden); doc.body.append(wrapper);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:frames' })), { origins: [FRAME_ORIGIN, 'https://forms.example.org'] });
});
test('an https subframe answers plans without creating a widget', t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: FRAME_ORIGIN, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.reconfigure({ windowTop: {} });
  let listener;
  dom.window.chrome = { runtime: { id: extensionId, onMessage: { addListener: callback => { listener = callback; } } } };
  dom.window.SecondHandGeneric = { plan: () => pantryPlan() };
  dom.window.eval(source('generic-content.js'));
  assert.equal(typeof listener, 'function');
  let result;
  listener({ type: 'secondhand:generic:plan' }, { id: extensionId }, value => { result = value; });
  assert.equal(result.token, 'plan-1');
  assert.equal(dom.window.document.querySelector('[data-secondhand-assistant]'), null);
});
test('content fill reports rejected ids without values', async t => {
  const page = siteContent(t);
  page.window.SecondHandGeneric.fillFields = () => ({ ok: true, filled: [], skipped: [], rejected: ['sh-1'], pending: [], values: { secret: 'private' } });
  const result = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} });
  assert.deepEqual(plain(result), { ok: true, filled: [], skipped: [], rejected: ['sh-1'] });
});

test('malformed engine fill arrays fail visibly instead of becoming an empty success', async t => {
  const page = siteContent(t);
  for (const result of [
    { ok: true, filled: 'bad', skipped: [], pending: [] },
    { ok: true, filled: [], skipped: [], rejected: null, pending: [] },
    { ok: true, filled: [42], skipped: [], pending: [] }
  ]) {
    page.window.SecondHandGeneric.fillFields = () => result;
    assert.equal((await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} })).ok, false);
  }
});
test('a malformed rejected list makes a frame fill fail', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, fillResult: { ok: true, filled: [], rejected: null } })] });
  assert.equal((await autofill(w)).data.state, 'error');
});

test('a pending form explains approval before attempting all-frame script execution', async () => {
  const w = siteWorker({ enabled: true, plan: { token: 'empty', matched: [], unmatched: [] }, frames: [secondFrame()], discoveryError: true });
  const result = (await autofill(w)).data;
  assert.match(result.message, /Click “Also turn on the embedded form”/);
  assert.deepEqual(w.injected, []);
});

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
test('missing top receiver preserves enabled page state with ready false', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  const reply = await w.panel({ type: 'ui:pageState' });
  assert.equal(reply.ok, true);
  assert.deepEqual(plain(reply.data.site), { origin: ORIGIN, enabled: true, frames: [], ready: false });
});
test('loading page state does not message the top document', async () => {
  const w = siteWorker({ enabled: true }); w.tab.status = 'loading';
  const reply = await w.panel({ type: 'ui:pageState' });
  assert.equal(reply.data.site.ready, false);
  assert.deepEqual(w.content, []);
});
test('a ready content script reports ready true', async () => {
  const w = siteWorker({ enabled: true });
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.ready, true);
});
test('malformed frames and other receiver errors still fail page state', async () => {
  for (const setup of [{ framesReply: {} }, { topError: 'The message port closed before a response was received.' }]) {
    const w = siteWorker({ enabled: true, ...setup });
    assert.equal((await w.panel({ type: 'ui:pageState' })).ok, false);
  }
});
const ownedFrameId = `frame-pantry.example.org--form.jotform.com`;
function registerOwnedFrame(w, id = ownedFrameId) {
  w.registered.set(id, { ...SITE_SCRIPT, id, matches: [`${FRAME_ORIGIN}/*`] });
  w.permissions.add(`${FRAME_ORIGIN}/*`);
}
test('enableFrames records the top site in its persistent frame registration', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ granted: true })] });
  assert.equal((await w.panel({ type: 'ui:enableFrames', confirmed: true })).ok, true);
  assert.deepEqual(w.registered.get(ownedFrameId), { ...SITE_SCRIPT, id: ownedFrameId, matches: [`${FRAME_ORIGIN}/*`] });
});
test('a frame owned by another site is enabled when permission is held', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame()] });
  registerOwnedFrame(w, 'frame-other.example.org--form.jotform.com');
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.frames[0].enabled, true);
  w.permissions.delete(`${FRAME_ORIGIN}/*`);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.frames[0].enabled, false);
});
test('disable without a receiver removes owned frame registrations and access', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  registerOwnedFrame(w);
  assert.equal((await w.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  assert.equal(w.registered.size, 0);
  assert.equal(w.permissions.size, 0);
  assert.deepEqual(w.content, []);
});
test('disable preserves frame permission while another registration uses it', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  registerOwnedFrame(w);
  const other = 'frame-other.example.org--form.jotform.com';
  registerOwnedFrame(w, other);
  assert.equal((await w.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  assert.deepEqual([...w.registered.keys()], [other]);
  assert.deepEqual([...w.permissions], [`${FRAME_ORIGIN}/*`]);
});
test('autofill without a top receiver asks for reload', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  assert.equal((await autofill(w)).data.message, 'Reload this page, then click Autofill.');
  assert.deepEqual(w.native, []);
});

test('two frames share one request while the child runs multiple fill passes', async () => {
  const child = secondFrame({ enabled: true, fields: [{ name: 'zip', key: 'zip' }, { name: 'again', key: 'zip', revealedBy: 'zip' }] });
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }], frames: [child] });
  const result = (await autofill(w)).data;
  assert.equal(result.filled, 3);
  assert.deepEqual(child.page.answered(), ['zip', 'again']);
  assert.equal(w.native.filter(call => call.type === 'getFields').length, 1);
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:fill').map(call => [call.frameId, call.token]), [[0, 'plan-1'], [4, 'frame4-1'], [4, 'frame4-2']]);
  assert.deepEqual(w.tallies.at(-1).target, { tabId: 7, frameIds: [0, 4] });
});
test('AI sees prefixed child questions and its guess fills that frame', async () => {
  const child = secondFrame({ enabled: true, fields: [{ name: 'email', label: 'Reach me', type: 'email' }] });
  const w = siteWorker({ enabled: true, fields: [], frames: [child], desktop: { values: { email: 'test@example.org' } } });
  const response = await w.launcher({ type: 'ui:plan', confirmed: true });
  assert.equal(response.data.unmatched[0]?.id, 'f4:sh-1-0');
  const result = (await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: { 'f4:sh-1-0': 'email' } })).data;
  assert.equal(result.filled, 1);
  assert.equal(result.guessed, 1);
  assert.deepEqual(child.page.answered(), ['email']);
  assert.equal(w.content.find(call => call.type === 'secondhand:generic:fill').frameId, 4);
});
test('a guess for an id absent from its child plan refuses the whole fill', async () => {
  const child = secondFrame({ enabled: true, fields: [] });
  const w = siteWorker({ enabled: true, fields: [{ ...PICKUP }], frames: [child] });
  await w.launcher({ type: 'ui:plan', confirmed: true });
  const result = (await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: { 'f4:sh-1-0': 'email' } })).data;
  assert.equal(result.state, 'error');
  assert.match(result.message, /couldn’t use the on-device AI/);
  assert.deepEqual(w.native, []);
});
test('tally counts both frames and keeps child Next guidance', async () => {
  const child = secondFrame({ enabled: true, fields: [], next: true });
  const w = siteWorker({ enabled: true, fields: [], frames: [child] });
  assert.equal((await autofill(w)).data.message, 'Nothing to fill here. Click Next, then Autofill again.');
});

test('content rejects a missing rejected list instead of manufacturing a valid reply', async t => {
  const page = siteContent(t);
  page.window.SecondHandGeneric.fillFields = () => ({ ok: true, filled: [], skipped: [], pending: [] });
  assert.equal((await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} })).ok, false);
});

test('site results and errors name their catalog key, and the key renders the same English', async () => {
  const guessed = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip' }, { name: 'email', label: 'Where can we email you?' }, { ...PICKUP }] });
  await guessed.launcher({ type: 'ui:plan', confirmed: true });
  const result = (await guessed.launcher({ type: 'ui:autofill', confirmed: true, guesses: { [`f0:${guessed.page.idOf('email')}`]: 'email' } })).data;
  assert.equal(strings.text('en', result.messageKey, result.messageParams), result.message);
  assert.ok(strings.text('es', result.messageKey, result.messageParams));
  const off = await siteWorker().panel({ type: 'ui:autofill', confirmed: true });
  assert.equal(off.ok, false);
  assert.equal(off.errorKey, 'worker.turnOnSiteFirst');
  assert.equal(strings.text('en', off.errorKey, off.errorParams), off.error);
});

test('the site question list covers the page and every embedded form that is on, answered or not, as labels only', async () => {
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName', label: 'Full name' }, { ...PICKUP }], frames: [
    { origin: FRAME_ORIGIN, frameId: 4, enabled: true, lang: 'en-US', fields: [{ name: 'size', key: 'householdSize', label: 'Household size' },
      { name: 'later', label: 'Hidden question', hidden: true }, { name: 'note', label: 'Anything else?' }, { name: 'day', label: 'Which day works?' }] },
    { origin: 'https://other.example.org', frameId: 5 }] });
  w.page.fields[0].answered = 'Synthetic private answer';
  const reply = await w.panel({ type: 'ui:questions' });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(plain(reply.data), { lang: 'en-US', pending: 1, questions: [
    { id: 'f0:sq-1-0', label: 'Full name' }, { id: 'f0:sq-1-1', label: 'Preferred pickup day' },
    { id: 'f4:sq-1-0', label: 'Household size' }, { id: 'f4:sq-1-1', label: 'Anything else?' }, { id: 'f4:sq-1-2', label: 'Which day works?' }] },
    'the page language is the one declared by the frame with the most questions');
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:questions').map(call => call.frameId), [0, 4], 'a frame that is not on is never asked');
  assert.deepEqual(w.native, [], 'listing questions never reaches the desktop');
  assert.doesNotMatch(JSON.stringify(reply), /Synthetic private/);
  assert.deepEqual(plain((await w.panel({ type: 'ui:focusField', key: 'f4:sq-1-1' })).data), { focused: true }, 'a row click uses the existing focus route');
  assert.deepEqual(plain((await w.launcher({ type: 'ui:questions' })).data.questions.length), 5, 'the widget on the site gets the same list');
  const off = await siteWorker().launcher({ type: 'ui:questions' });
  assert.equal(off.ok, false, 'a site that is not on is never read');
});

test('a site frame answers the question request with its declared language and each question’s label, for our extension only', t => {
  const page = siteContent(t);
  page.window.document.documentElement.lang = 'es';
  let visibility;
  page.window.SecondHandGeneric.questions = doc => {
    visibility = page.host().style.visibility;
    return [{ id: 'sq-1-0', label: 'Your name', element: doc.getElementById('name'), value: 'Synthetic private value' }];
  };
  const reply = page.request({ type: 'secondhand:generic:questions' });
  assert.deepEqual(plain(reply), { lang: 'es', questions: [{ id: 'sq-1-0', label: 'Your name' }] });
  assert.equal(visibility, 'hidden', 'the widget is hidden while the engine reads the page');
  assert.doesNotMatch(JSON.stringify(reply), /Synthetic private/);
  assert.equal(page.request({ type: 'secondhand:generic:questions' }, { id: 'b'.repeat(32) }), undefined, 'another extension gets nothing');
});

// Laya, the desktop's local AI: text boxes it matches to saved fields (#39) and choice questions it
// answers from the saved profile (#42). The desktop plays it here; its requests carry labels and options only.
const { MATCH_CANDIDATES } = require('../shared/laya-prompts.cjs');
const SIXTY = { name: 'sixty', label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'], required: true };
const PET = { name: 'pet', label: 'Do you have a pet?', type: 'radio', options: ['Yes', 'No'] };
const REACH = { name: 'reach', label: 'Where can we reach you?', type: 'email' };
const SAVED = { firstName: 'Synthetic private first', lastName: 'Synthetic private last', email: 'synthetic.private@example.org', zip: '50309', householdSize: '1' };
const layaDesktop = (play = {}) => ({ layaState: 'ready', values: SAVED, laya: {
  suggestFields: () => ({ suggestions: {} }), answerFields: (_, vault) => ({ answers: {}, accessRevision: vault.accessRevision }), ...play } });
const idOf = (w, name) => `f0:${w.page.idOf(name)}`;
const layaCalls = w => w.native.filter(call => ['suggestFields', 'answerFields'].includes(call.type));

test('the desktop’s Laya can only match text boxes to saved fields the worker lets a guess use', async () => {
  const w = siteWorker({ enabled: true, fields: openQuestions() });
  const { allowedKeys } = await plan(w);
  assert.ok(MATCH_CANDIDATES.every(key => allowedKeys.includes(key)), 'every Laya candidate is a key AI may guess');
});

test('with Laya ready, the widget’s plan says so, and its match fills a text box as a guess from the one vault request', async () => {
  let suggestRequest;
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }, { ...PET }], desktop: layaDesktop({
    suggestFields: request => { suggestRequest = request; return { suggestions: { [request.fields[0].id]: 'email' } }; } }) });
  const planned = await plan(w);
  assert.equal(planned.laya, true, 'Chrome’s on-device AI stays off');
  assert.deepEqual(w.nativeTypes(), ['status'], 'planning only checks whether Laya is ready');
  const reach = idOf(w, 'reach');
  const result = plain((await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: {} })).data);
  assert.deepEqual(suggestRequest, { id: suggestRequest.id, type: 'suggestFields', url: `${ORIGIN}/intake`, fields: [{ id: reach, label: 'Where can we reach you?', type: 'email', options: [] }], budgetMs: 3000 },
    'the text box’s label, type, and options only, and the click’s time for Laya');
  assert.deepEqual(w.native.find(call => call.type === 'getFields').fields, ['firstName', 'lastName', 'email'], 'Laya’s match joins the one vault request');
  assert.deepEqual(w.content.find(call => call.type === 'secondhand:generic:fill').assignments,
    [{ id: 'sh-1-0', key: 'fullName', guessed: false }, { id: reach.split(':')[1], key: 'email', guessed: true }]);
  assert.deepEqual(w.page.fields.map(field => field.mark), ['rule', 'guess', undefined]);
  assert.equal(result.filled, 2);
  assert.equal(result.guessed, 1);
  assert.equal(result.laya, 1);
  assert.equal(result.message, 'Filled 2 · 1 guessed · 1 need you. Check your answers before you submit. Guesses were suggested by Laya on this computer.');
  assert.equal(result.messageKey, 'result.suggestedByLaya');
  assert.doesNotMatch(JSON.stringify(layaCalls(w)), /Synthetic private|synthetic\.private|50309/, 'no saved value is ever sent to Laya');
});

test('Laya answers a choice question from the saved profile: the option is picked as a guess and the rest stay with the applicant', async () => {
  let answerRequest;
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...SIXTY }, { ...PET }], desktop: layaDesktop({
    answerFields: (request, vault) => { answerRequest = request; return { answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }; } }) });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(answerRequest.questions, [
    { id: 'f0:sh-1-1', label: SIXTY.label, type: 'radio', options: ['Yes', 'No'] }, { id: 'f0:sh-1-2', label: PET.label, type: 'radio', options: ['Yes', 'No'] }]);
  assert.deepEqual(Object.keys(answerRequest).sort(), ['budgetMs', 'id', 'questions', 'type', 'url']);
  assert.equal(answerRequest.budgetMs, 3000);
  assert.deepEqual(w.content.find(call => call.type === 'secondhand:generic:fill').assignments,
    [{ id: 'sh-1-0', key: 'fullName', guessed: false }, { id: 'sh-1-1', option: 'No', guessed: true }]);
  assert.deepEqual(w.page.answered(), ['name', 'sixty']);
  assert.equal(w.page.fields[1].mark, 'guess');
  assert.deepEqual(result.needYou, [idOf(w, 'pet')], '"Do you have a pet?" stays under need you');
  assert.equal(result.guessed, 1);
  assert.equal(result.message, 'Filled 2 · 1 guessed · 1 need you. Check your answers before you submit. Guesses were suggested by Laya on this computer.');
  assert.deepEqual(w.nativeTypes().filter(type => type !== 'status'), ['getFields', 'answerFields'],
    'answers are asked after the saved values, so an approval in between can’t outdate them');
  assert.doesNotMatch(JSON.stringify(layaCalls(w)), /Synthetic private|synthetic\.private|50309/, 'no saved value is ever sent to Laya');
});

test('answers alone fill under their own access receipt, which is checked before the page is touched', async () => {
  const w = siteWorker({ enabled: true, fields: [{ ...SIXTY }], desktop: layaDesktop({ answerFields: (request, vault) => ({ answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }) }) });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.nativeTypes(), ['answerFields', 'status']);
  assert.equal(result.filled, 1);
  assert.equal(result.guessed, 1);
  const stale = siteWorker({ enabled: true, fields: [{ ...SIXTY }], desktop: layaDesktop({ answerFields: request => ({ answers: { [request.questions[0].id]: 'No' }, accessRevision: 99 }) }) });
  const refused = plain((await autofill(stale)).data);
  assert.equal(refused.state, 'error');
  assert.match(refused.message, /access changed/);
  assert.deepEqual(stale.page.answered(), []);
});

test('a Laya reply naming a sensitive key, a question outside the request, or an option the question lacks fills nothing and shows a fixed error', async () => {
  const unusable = 'worker.layaUnusable';
  const replies = [
    ['suggestFields', request => ({ suggestions: { [request.fields[0].id]: 'ssn' } }), unusable],
    ['suggestFields', request => ({ suggestions: { [request.fields[0].id]: 'birthDate' } }), unusable],
    ['suggestFields', () => ({ suggestions: { 'f0:sh-9-9': 'email' } }), unusable],
    ['suggestFields', () => ({ suggestions: [] }), unusable],
    ['suggestFields', () => ({}), unusable],
    ['answerFields', (request, vault) => ({ answers: { [request.questions[0].id]: 'Maybe' }, accessRevision: vault.accessRevision }), unusable],
    ['answerFields', (request, vault) => ({ answers: { 'f0:sh-9-9': 'No' }, accessRevision: vault.accessRevision }), unusable],
    ['answerFields', (request, vault) => ({ answers: { [request.questions[0].id]: 7 }, accessRevision: vault.accessRevision }), unusable],
    ['answerFields', () => ({ answers: {} }), 'worker.authorizationOutdated']
  ];
  for (const [type, reply, key] of replies) {
    const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }, { ...SIXTY }], desktop: layaDesktop({ [type]: reply }) });
    const result = plain((await autofill(w)).data);
    assert.equal(result.state, 'error', reply.toString());
    assert.equal(result.messageKey, key, reply.toString());
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false, reply.toString());
    assert.deepEqual(w.page.answered(), []);
    if (type === 'suggestFields') assert.equal(w.nativeTypes().includes('getFields'), false, 'a bad match stops the click before the vault is asked');
  }
  assert.equal(strings.english('worker.layaUnusable'), 'SecondHand couldn’t use Laya’s answers. Nothing was filled.');
});

test('Laya never sees consent or SSN questions, over-long questions, or more than 40 text boxes and 30 choice questions', async () => {
  const boxes = Array.from({ length: 45 }, (_, index) => ({ name: `box${index}`, label: `Question number ${index}`, type: 'text' }));
  const choices = Array.from({ length: 35 }, (_, index) => ({ name: `pick${index}`, label: `Choice number ${index}`, type: 'radio', options: ['Yes', 'No'] }));
  const skipped = [{ name: 'consent', label: 'I consent to share my information', type: 'radio', options: ['Yes', 'No'] }, { name: 'ssn', label: 'Social Security Number', type: 'text' },
    { name: 'long', label: 'L'.repeat(201), type: 'text' }, { name: 'agree', label: 'Pantry rules', type: 'radio', options: ['I agree', 'I do not agree'] },
    { name: 'many', label: 'Pick a state', type: 'select', options: Array.from({ length: 31 }, (_, index) => `State ${index}`) }, { name: 'blank', label: '  ', type: 'text' },
    { name: 'listbox', label: 'County', type: 'listbox', options: ['Polk'] }, { name: 'twice', label: 'Pick one', type: 'radio', options: ['Yes', 'Yes'] }];
  const w = siteWorker({ enabled: true, fields: [...skipped, ...boxes, ...choices], desktop: layaDesktop() });
  await autofill(w);
  const [suggest, answer] = layaCalls(w);
  assert.equal(suggest.fields.length, 40);
  assert.equal(answer.questions.length, 30);
  assert.deepEqual(suggest.fields.map(field => field.label), boxes.slice(0, 40).map(field => field.label));
  assert.deepEqual(answer.questions.map(field => field.label), choices.slice(0, 30).map(field => field.label));
});

test('Laya not ready: the widget’s plan says so after one status check, and the click fills exactly as it does without Laya', async () => {
  const today = siteWorker({ enabled: true, fields: openQuestions(), desktop: { values: SAVED } });
  const planned = await plan(today);
  assert.equal(planned.laya, false, 'Chrome’s on-device AI may run');
  assert.deepEqual(today.nativeTypes(), ['status']);
  const reach = idOf(today, 'reach');
  const guessed = plain((await today.launcher({ type: 'ui:autofill', confirmed: true, guesses: { [reach]: 'email' } })).data);
  assert.deepEqual(today.nativeTypes(), ['status', 'status', 'getFields', 'status'], 'Laya is not asked again in the same click');
  assert.equal(guessed.guessed, 1);
  assert.equal(guessed.laya, undefined);
  assert.equal(guessed.message, 'Filled 2 · 1 guessed · 2 need you. Check your answers before you submit.');

  const unguessed = siteWorker({ enabled: true, fields: openQuestions(), desktop: { values: SAVED } });
  await plan(unguessed);
  const plain_ = plain((await unguessed.launcher({ type: 'ui:autofill', confirmed: true })).data);
  assert.deepEqual(unguessed.nativeTypes(), ['status', 'status', 'getFields', 'status'], 'a fresh plan in the same click does not ask Laya again');
  assert.equal(plain_.message, 'Filled 1 · 3 need you. Check your answers before you submit.');

  const side = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }, { ...SIXTY }], desktop: { values: SAVED } });
  const fromPanel = plain((await autofill(side)).data);
  assert.deepEqual(side.nativeTypes(), ['suggestFields', 'status', 'getFields', 'status'], 'one "not ready" answer and Laya is left alone for the click');
  assert.equal(fromPanel.message, 'Filled 1 · 2 need you. Check your answers before you submit.');
  // A closed desktop app reads as today: nothing to fill without the rules, "open the app" with them.
  const alone = plain((await autofill(siteWorker({ enabled: true, fields: [{ ...REACH }], desktop: { reachable: false } }))).data);
  assert.equal(alone.state, 'done');
  assert.equal(alone.message, 'Nothing here matches your saved profile. 1 need you.');
  assert.equal((await autofill(siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }], desktop: { reachable: false } }))).data.state, 'offline');
});

test('with Laya ready, the widget never also sends Chrome’s guesses, and a locked vault reads as locked', async () => {
  const w = siteWorker({ enabled: true, fields: openQuestions(), desktop: layaDesktop() });
  await plan(w);
  const refused = plain((await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: { [idOf(w, 'reach')]: 'email' } })).data);
  assert.equal(refused.state, 'error');
  assert.match(refused.message, /couldn’t use the on-device AI/);
  assert.deepEqual(w.nativeTypes(), ['status']);

  const locked = siteWorker({ enabled: true, fields: openQuestions(), desktop: { ...layaDesktop({ suggestFields: () => 'Unlock SecondHand first.' }), unlocked: false } });
  await plan(locked);
  const result = plain((await locked.launcher({ type: 'ui:autofill', confirmed: true, guesses: {} })).data);
  assert.equal(result.state, 'locked');
  assert.equal(result.messageKey, 'worker.unlockToAutofill');
});

test('Laya’s match and answer land in the embedded form they came from', async () => {
  const child = secondFrame({ enabled: true, fields: [{ ...REACH }, { ...SIXTY }] });
  const w = siteWorker({ enabled: true, fields: [], frames: [child], desktop: layaDesktop({
    suggestFields: request => ({ suggestions: { [request.fields[0].id]: 'email' } }),
    answerFields: (request, vault) => ({ answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }) }) });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(layaCalls(w).map(call => (call.fields || call.questions).map(item => item.id)), [['f4:sh-1-0'], ['f4:sh-1-1']]);
  assert.deepEqual(child.page.answered(), ['reach', 'sixty']);
  assert.equal(result.guessed, 2);
  assert.equal(w.content.find(call => call.type === 'secondhand:generic:fill').frameId, 4);
});

test('the side panel learns whether Laya is ready from the desktop status', async () => {
  for (const [desktop, laya] of [[{}, 'unavailable'], [{ layaState: 'ready' }, 'ready'], [{ layaState: 'off' }, 'off'], [{ layaState: 'downloading' }, 'downloading']]) {
    const w = siteWorker({ enabled: true, desktop });
    assert.deepEqual(plain((await w.panel({ type: 'ui:desktopStatus' })).data), { connected: true, unlocked: true, laya });
  }
  assert.deepEqual(plain((await siteWorker({ desktop: { reachable: false } }).panel({ type: 'ui:desktopStatus' })).data), { connected: false, unlocked: false, laya: 'unavailable' });
  const odd = siteWorker({ desktop: { layaState: 'thinking' } });
  assert.equal((await odd.panel({ type: 'ui:desktopStatus' })).ok, false, 'a state SecondHand doesn’t know is an error, not a guess');
});

test('Laya gets one three-second budget per click: each request carries what is left, the applicant’s approval time never counts, and nothing is asked once it is spent', async () => {
  const run = async ({ suggestMs, approvalMs = 0 }) => {
    const clock = { now: 50000 };
    const budgets = [];
    const w = siteWorker({ enabled: true, clock, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }, { ...SIXTY }], duringGetFields: () => { clock.now += approvalMs; }, desktop: layaDesktop({
      suggestFields: request => { budgets.push(['suggestFields', request.budgetMs]); clock.now += suggestMs; return { suggestions: { [request.fields[0].id]: 'email' } }; },
      answerFields: (request, vault) => { budgets.push(['answerFields', request.budgetMs]); return { answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }; } }) });
    return { w, budgets, result: plain((await autofill(w)).data) };
  };
  const quick = await run({ suggestMs: 1200, approvalMs: 20000 });
  assert.deepEqual(quick.budgets, [['suggestFields', 3000], ['answerFields', 1800]], 'the match took 1.2 seconds; a 20-second approval in between is the applicant’s time');
  assert.deepEqual(quick.w.page.answered(), ['name', 'reach', 'sixty']);

  const spent = await run({ suggestMs: 3000 });
  assert.deepEqual(spent.budgets, [['suggestFields', 3000]], 'no time is left to answer');
  assert.deepEqual(spent.w.page.answered(), ['name', 'reach']);
  assert.deepEqual(spent.result.needYou, [idOf(spent.w, 'sixty')], 'the choice question stays with the applicant');

  // A new click starts a new budget.
  const again = siteWorker({ enabled: true, clock: { now: 0 }, fields: [{ ...SIXTY }], desktop: layaDesktop() });
  await autofill(again);
  await autofill(again);
  assert.deepEqual(layaCalls(again).map(call => call.budgetMs), [3000, 3000]);
});
