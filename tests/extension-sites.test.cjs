'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');

// Values created inside the worker's vm context have foreign prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const source = file => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
const PANEL_URL = 'chrome-extension://testextension/panel.html';
const SITE_URL = 'https://pantry.example.org/intake?step=1';
const ORIGIN = 'https://pantry.example.org';
const SCRIPT_ID = 'site-pantry.example.org';
const SITE_SCRIPT = { id: SCRIPT_ID, matches: [`${ORIGIN}/*`], js: ['generic-adapter.js', 'generic-content.js'], runAt: 'document_idle', persistAcrossSessions: true };

// Stand-in for generic-adapter.js's pure helpers; the real engine has its own tests.
const { GENERIC_KEYS } = require('../extension/generic-adapter.js');
const SENSITIVE = ['ssn', 'birthDate', 'totalMonthlyIncome', 'annualIncome', 'assetsOnHand'];
const generic = {
  GENERIC_KEYS,
  requestKeys: keys => [...new Set(keys.flatMap(key => key === 'fullName' ? ['firstName', 'lastName'] : [key]))],
  deriveValues: values => ({ ...values, ...(values.firstName && values.lastName ? { fullName: `${values.firstName} ${values.lastName}` } : {}) })
};
const PICKUP = { name: 'pickup', label: 'Preferred pickup day', type: 'select-one', options: ['Monday', 'Friday'], required: true };
const pantryFields = () => [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip' }, { name: 'size', key: 'householdSize' }, { ...PICKUP }];

// A model of generic-content.js on the page: like the site engine, every plan lists the
// unanswered fields on screen under fresh ids, and answering a field can reveal others.
function sitePage(fields, { next = false } = {}) {
  let sequence = 0, current = null;
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
      current = { token: `plan-${sequence}`, ids };
      return { token: current.token, matched, unmatched };
    },
    fill({ token, assignments, values }) {
      if (token !== current?.token) return { ok: false, filled: [], skipped: [] };
      const filled = [], rejected = [];
      for (const { id, key, guessed } of assignments) {
        const field = current.ids.get(id);
        if (!field || field.answered || field.refuses || !values[key]) continue;
        // The page flags the answer: the engine clears a text box, but a chosen option stays chosen.
        if (field.rejects) { rejected.push(id); if (field.choice) field.answered = values[key]; continue; }
        field.answered = values[key]; field.mark = guessed ? 'guess' : 'rule';
        filled.push(id);
      }
      return { ok: true, filled, skipped: assignments.map(item => item.id).filter(id => !filled.includes(id) && !rejected.includes(id)), rejected };
    },
    focus: id => Boolean(current?.ids.has(id)),
    // The id a field has in the latest plan.
    idOf: name => [...(current?.ids || [])].find(([, field]) => field.name === name)?.[0],
    answered: () => fields.filter(field => field.answered).map(field => field.name)
  };
}

function siteWorker({ url = SITE_URL, enabled = false, granted = enabled, desktop = {}, fields = pantryFields(), next, duringGetFields } = {}) {
  const tab = { id: 7, active: true, url };
  const log = [], native = [], content = [], injected = [], opened = [];
  const permissions = new Set(granted ? [`${ORIGIN}/*`] : []);
  const registered = new Map(enabled ? [[SCRIPT_ID, structuredClone(SITE_SCRIPT)]] : []);
  const page = sitePage(fields, { next });
  const tallies = [];
  const vault = { reachable: true, unlocked: true, getFieldsError: null, trustError: null,
    values: { firstName: 'Synthetic private first', lastName: 'Synthetic private last', zip: '50309' }, ...desktop };
  const events = {};
  const event = key => ({ addListener: value => { events[key] = value; } });
  let listener;
  const chrome = {
    tabs: {
      get: async () => ({ ...tab }),
      sendMessage: async (tabId, message, options) => {
        content.push({ tabId, frameId: options?.frameId, ...plain(message) });
        if (message.type === 'secondhand:generic:plan') return page.plan();
        if (message.type === 'secondhand:generic:fill') return page.fill(plain(message));
        if (message.type === 'secondhand:generic:focus') return { focused: page.focus(message.id) };
        throw new Error(`Unexpected content message ${message.type}`);
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated')
    },
    permissions: {
      contains: async ({ origins }) => { log.push('permissions.contains'); return origins.every(origin => permissions.has(origin)); },
      remove: async ({ origins }) => { log.push('permissions.remove'); origins.forEach(origin => permissions.delete(origin)); return true; },
      request: async () => { log.push('permissions.request'); throw new Error('Only the side panel may request access, inside a click.'); }
    },
    scripting: {
      executeScript: async details => {
        // A function runs in the page and answers with its result; files are only injected.
        if (details.func) {
          tallies.push({ target: plain(details.target), func: details.func });
          const dom = new JSDOM(`<!doctype html><body>${page.html()}</body>`, { runScripts: 'outside-only' });
          try { return [{ frameId: 0, result: plain(dom.window.eval(`(${details.func})()`)) }]; } finally { dom.window.close(); }
        }
        log.push('scripting.executeScript'); injected.push(plain(details));
      },
      getRegisteredContentScripts: async ({ ids }) => { log.push('scripting.getRegisteredContentScripts'); return ids.filter(id => registered.has(id)).map(id => structuredClone(registered.get(id))); },
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
              if (request.type === 'status') return reply({ unlocked: vault.unlocked, applicationCount: 0 });
              if (request.type === 'showApp') return reply({ shown: true });
              if (request.type === 'trustSite') return vault.trustError ? fail(vault.trustError) : reply({ trusted: true, origin: new URL(request.url).origin });
              if (request.type === 'getFields') {
                duringGetFields?.(tab);
                if (vault.getFieldsError) return fail(vault.getFieldsError);
                return reply({ values: Object.fromEntries(request.fields.filter(key => vault.values[key]).map(key => [key, vault.values[key]])) });
              }
              fail('Unsupported bridge request.');
            });
          }
        };
      }
    }
  };
  vm.runInNewContext(source('background.js'),
    { chrome, SecondHandIowa: adapter, SecondHandGeneric: generic, importScripts: () => {}, crypto: webcrypto, setTimeout, clearTimeout, URL, Map, Set, console });
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

test('the worker loads the site engine next to the Iowa adapter and refuses to start without it', () => {
  const imported = [];
  const chrome = { runtime: { onMessage: { addListener: () => {} } }, tabs: {}, sidePanel: { setPanelBehavior: async () => {} } };
  assert.throws(() => vm.runInNewContext(source('background.js'), { chrome, SecondHandIowa: adapter, importScripts: (...files) => imported.push(...files), crypto: webcrypto, URL, Map, Set }), /generic-adapter\.js/);
  assert.deepEqual(imported, ['iowa-adapter.js', 'generic-adapter.js']);
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
    { page: { kind: 'general', pageKey: 'general' }, result: null, autopilot: false, site: { origin: ORIGIN, enabled: false } });
  const on = siteWorker({ enabled: true });
  assert.deepEqual(plain((await on.panel({ type: 'ui:pageState' })).data),
    { page: { kind: 'general', pageKey: 'general' }, result: null, autopilot: false, site: { origin: ORIGIN, enabled: true } });
  for (const w of [off, on]) { assert.deepEqual(w.native, []); assert.deepEqual(w.content, []); }
});

test('autofill on an approved site asks for the planned keys once and fills without navigating', async () => {
  const w = siteWorker({ enabled: true });
  const response = await autofill(w);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields']);
  assert.deepEqual(w.native[1].fields, ['firstName', 'lastName', 'zip', 'householdSize']);
  assert.equal(w.native[1].url, `${ORIGIN}/intake`);
  // The second plan finds nothing new it can fill, so the click ends there.
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:plan']);
  assert.ok(w.content.every(call => call.tabId === 7 && call.frameId === 0));
  const fill = w.content[1];
  assert.equal(fill.token, 'plan-1');
  assert.deepEqual(fill.assignments, [{ id: 'sh-1-0', key: 'fullName', guessed: false }, { id: 'sh-1-1', key: 'zip', guessed: false }]);
  assert.deepEqual(fill.values, { fullName: 'Synthetic private first Synthetic private last', zip: '50309' }, 'only the values being placed reach the page');
  assert.deepEqual(plain(response.data), { state: 'done', filled: 2, guessed: 0, needYou: [w.page.idOf('pickup'), w.page.idOf('size')],
    message: 'Filled 2 · 2 need you. Check your answers before you submit.', pageKey: 'general' });
  assert.deepEqual(plain(response.data.needYou), ['sh-2-1', 'sh-2-0'], 'need-you ids come from the latest plan');
  assert.doesNotMatch(JSON.stringify(response), /Synthetic private/);

  const state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.equal(state.autopilot, false);
  assert.equal(state.result.message, response.data.message);
  w.events.updated(7, { status: 'complete' }); await settle();
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:plan'], 'nothing continues or navigates on its own');
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields']);
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
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields'], 'one desktop request for the whole click');
  assert.deepEqual(w.native[1].fields, ['firstName', 'lastName', 'email', 'householdSize']);
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:plan', 'secondhand:generic:fill',
    'secondhand:generic:plan', 'secondhand:generic:fill'], 'the third pass fills nothing, so the click stops');
  assert.deepEqual(w.page.answered(), ['name', 'email', 'confirmEmail']);
  assert.equal(result.filled, 3);
  assert.deepEqual(result.needYou, [w.page.idOf('pickup'), w.page.idOf('size'), w.page.idOf('phone')]);
  assert.ok(result.needYou.every(id => id.startsWith('sh-3-')), 'need-you ids come from the latest plan');
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
  assert.deepEqual(result.needYou, [w.page.idOf('pickup'), w.page.idOf('zip'), 'sh-1-2']);
  assert.equal(result.message, 'Filled 1 · 3 need you. Check your answers before you submit.');

  const alone = siteWorker({ enabled: true, fields: [{ name: 'zip', key: 'zip', rejects: true }], desktop: { values: { zip: '5030' } } });
  const refused = plain((await autofill(alone)).data);
  assert.equal(refused.filled, 0);
  assert.deepEqual(refused.needYou, ['sh-1-0']);
});

test('one click fills at most four passes of revealed questions', async () => {
  const fields = Array.from({ length: 6 }, (_, i) => ({ name: `email${i}`, key: 'email', ...(i ? { revealedBy: `email${i - 1}` } : {}) }));
  const w = siteWorker({ enabled: true, fields, desktop: { values: { email: 'synthetic@example.org' } } });
  const result = plain((await autofill(w)).data);
  assert.equal(w.contentTypes().filter(type => type === 'secondhand:generic:fill').length, 4);
  assert.deepEqual(w.page.answered(), ['email0', 'email1', 'email2', 'email3']);
  assert.equal(result.filled, 4);
  assert.deepEqual(result.needYou, [w.page.idOf('email4')]);
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields']);
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
    { id: 'sh-1-1', label: 'Preferred pickup day', type: 'select-one', options: ['Monday', 'Friday'], required: true },
    { id: 'sh-1-2', label: 'Where can we email you?', type: 'email', options: [], required: false },
    { id: 'sh-1-3', label: 'Best number to reach you', type: 'tel', options: [], required: false }]);
  assert.deepEqual(planned.allowedKeys, GENERIC_KEYS.filter(key => !SENSITIVE.includes(key)));
  for (const key of SENSITIVE) assert.equal(planned.allowedKeys.includes(key), false, key);
  assert.deepEqual(Object.keys(planned), ['unmatched', 'allowedKeys']);
  assert.deepEqual(w.native, [], 'planning never reaches the vault');
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:plan']);

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
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields']);
  assert.deepEqual(w.native[1].fields, ['firstName', 'lastName', 'email', 'phone']);
  // The fill uses the plan the AI saw, then plans again for anything revealed.
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:plan']);
  assert.deepEqual(w.content[1].assignments, [{ id: 'sh-1-0', key: 'fullName', guessed: false }, { id: reach, key: 'email', guessed: true }, { id: call, key: 'phone', guessed: true }]);
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
    const ids = { name: w.page.idOf('name'), reach: w.page.idOf('reach') };
    const result = plain((await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: guesses(ids) })).data);
    assert.equal(result.state, 'error', JSON.stringify(guesses(ids)));
    assert.match(result.message, /couldn’t use the on-device AI/);
    assert.deepEqual(w.native, [], JSON.stringify(guesses(ids)));
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
  for (const w of [unplanned, moved]) assert.deepEqual(w.native, []);
  assert.equal(used.nativeTypes().filter(type => type === 'getFields').length, 1);
});

test('a form with nothing SecondHand recognizes never contacts the desktop', async () => {
  const w = siteWorker({ enabled: true, fields: [{ ...PICKUP }] });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.native, []);
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:plan']);
  assert.equal(result.state, 'done');
  assert.equal(result.filled, 0);
  assert.deepEqual(result.needYou, ['sh-1-0']);
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

test('need-you focus on approved sites goes to the site engine by field id', async () => {
  const w = siteWorker({ enabled: true });
  const [pickup] = (await autofill(w)).data.needYou;
  assert.deepEqual(plain((await w.launcher({ type: 'ui:focusField', key: pickup, confirmed: true })).data), { focused: true });
  assert.deepEqual(plain((await w.panel({ type: 'ui:focusField', key: 'sh-9' })).data), { focused: false });
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:focus').map(({ type, id }) => ({ type, id })),
    [{ type: 'secondhand:generic:focus', id: pickup }, { type: 'secondhand:generic:focus', id: 'sh-9' }]);
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
function siteContent(t, { url = SITE_URL, engine = true } = {}) {
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
        return { ok: true, filled: ['sh-1'], skipped: [], rejected: ['sh-2'], values };
      },
      focusField: (doc, id) => { calls.push(`focus:${id}`); if (id !== 'sh-2') return false; doc.getElementById('day').focus(); return true; }
    };
  }
  window.eval(source('generic-content.js'));
  return { window, frames, calls,
    host: () => window.document.querySelector('[data-secondhand-assistant]'),
    request(message, sender = { id: extensionId }) { let response; listener?.(message, sender, value => { response = value; }); return response; } };
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

test('site plans and fills answer with field metadata only, never values or elements', t => {
  const page = siteContent(t);
  const plan = page.request({ type: 'secondhand:generic:plan' });
  assert.deepEqual(plain(plan), { token: 'plan-1', matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high' }],
    unmatched: [{ id: 'sh-2', label: 'Pickup day', type: 'select-one', options: ['Monday'], required: true }] });
  const filled = page.request({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic private name' } });
  assert.deepEqual(plain(filled), { ok: true, filled: ['sh-1'], skipped: [], rejected: ['sh-2'] }, 'answers the page refused come back');
  assert.deepEqual(page.calls[1], { token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic private name' } });
  assert.equal(page.window.document.getElementById('name').value, 'Synthetic private name');
  assert.doesNotMatch(JSON.stringify([plan, filled]), /Synthetic private/);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-2' })), { focused: true });
  assert.equal(page.window.document.activeElement.id, 'day');
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-9' })), { focused: false });
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
