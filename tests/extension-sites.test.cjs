'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const strings = require('../extension/strings.js');
const forms = require('./fixtures/pantry-forms.cjs');
const { plain, tick, runFile, evalFile, layout, layoutElements, serviceWorker, nativeHost } = require('./helpers/harness.cjs');

const PANEL_URL = 'chrome-extension://testextension/panel.html';
const SITE_URL = 'https://pantry.example.org/intake?step=1';
const ORIGIN = 'https://pantry.example.org';
const SCRIPT_ID = 'site-pantry.example.org';
const SITE_SCRIPT = { id: SCRIPT_ID, matches: [`${ORIGIN}/*`], js: ['generic-adapter.js', 'generic-navigation.js', 'page-text.js', 'generic-content.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true };
const ALL = 'https://*/*';
const IOWA_ORIGIN = 'https://hhsservices.iowa.gov';
const IOWA_HOST = `${IOWA_ORIGIN}/*`;
// SecondHand on all websites: every https page but Iowa's site, which keeps its own scripts.
const ALL_SCRIPT = { id: 'site-all', matches: [ALL], excludeMatches: [IOWA_HOST], js: SITE_SCRIPT.js, allFrames: true, runAt: 'document_idle', persistAcrossSessions: true };

// Stand-in for generic-adapter.js's pure helpers; the real engine has its own tests.
const { GENERIC_KEYS, SAVE_KEYS, unsafeQuestion, layaQuestion, isBandKey, canCustom, canRemember, timeBound } = require('../extension/generic-adapter.js');
const SENSITIVE = ['ssn', 'birthDate', 'ageRange', 'totalMonthlyIncome', 'annualIncome', 'assetsOnHand', 'monthlyMedicalExpenses',
  'householdAllCitizens', 'householdLegalStatus', 'householdPregnant', 'householdMedicare'];
const generic = {
  GENERIC_KEYS, SAVE_KEYS, unsafeQuestion, layaQuestion, isBandKey, canCustom, canRemember, timeBound,
  requestKeys: keys => [...new Set(keys.flatMap(key => key === 'fullName' ? ['firstName', 'lastName'] : key === 'ageRange' ? ['birthDate'] : [key]))],
  deriveValues: values => ({ ...values, ...(values.firstName && values.lastName ? { fullName: `${values.firstName} ${values.lastName}` } : {}),
    ...(values.birthDate ? { ageRange: '41' } : {}) })
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
  // Laya's best guesses (#185), by the id each was filled under: the engine finds them after the next plan.
  const layaGuessed = new Set();
  const onScreen = field => !field.hidden && (!field.revealedBy || fields.some(other => other.name === field.revealedBy && other.answered));
  // A field the engine answered only in part (#184) stays in the plan, marked, until the applicant finishes it.
  const shown = field => (!field.answered || field.inPart) && onScreen(field);
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
        if (field.key) matched.push({ id, key: field.key, confidence: 'high', label: field.label || field.name, ...(field.inPart ? { partial: true } : {}) });
        else unmatched.push({ id, label: field.label, type: field.type, options: field.options || [], required: field.required === true });
      });
      current = { token: `${tokenPrefix}-${sequence}`, ids };
      return { token: current.token, lang, matched, unmatched };
    },
    fill({ token, assignments, values }) {
      if (token !== current?.token) return { ok: false, filled: [], skipped: [] };
      const filled = [], rejected = [], partial = [];
      for (const { id, key, option, guessed, layaGuess, custom } of assignments) {
        const field = current.ids.get(id);
        // Laya's answer (#42) is one of the question's own options; everything else is a saved value.
        const answer = option !== undefined ? (field?.options || []).includes(option) && option : values[custom ? id : key];
        if (!field || field.answered || field.refuses || !answer) continue;
        // The page flags the answer: the engine clears a text box, but a chosen option stays chosen.
        if (field.rejects) { rejected.push(id); if (field.choice) field.answered = answer; continue; }
        field.answered = answer; field.mark = layaGuess ? 'laya-guess' : guessed ? 'guess' : 'rule';
        if (layaGuess) layaGuessed.add(id);
        filled.push(id);
        // `partly`: a checkbox question one saved answer names several options of; the engine checks the rest and says so.
        if (field.partly) { field.inPart = true; partial.push(id); }
      }
      return { ok: true, filled, skipped: assignments.map(item => item.id).filter(id => !filled.includes(id) && !rejected.includes(id)), rejected, partial };
    },
    // Every question on screen, answered or not, under its own ids: labels only.
    questions() {
      listings++;
      listed = new Map(fields.filter(onScreen).map((field, index) => [`sq-${listings}-${index}`, field]));
      return { lang, questions: [...listed].map(([id, field]) => ({ id, label: field.label || field.name })) };
    },
    focus: id => Boolean(current?.ids.has(id) || listed?.has(id) || layaGuessed.has(id)),
    // Save to My information: the applicant types an answer the profile didn't have. The engine reports only
    // which listed boxes hold one, and reads one box after the click, for the key the rules matched to it.
    type: (name, value) => { fields.find(field => field.name === name).typed = value; },
    answeredIds: (token, ids) => token === current?.token && Array.isArray(ids) ? ids.filter(id => current.ids.get(id)?.typed) : [],
    read({ token, id, key }) {
      const field = token === current?.token ? current.ids.get(id) : null;
      if (!field || field.key !== key) return null;
      // `repeated`: the page asks the question in more than one box, as in a member's section with no heading (#142).
      if (field.repeated) return { repeated: true };
      return field.typed === undefined ? { empty: true } : field.typed === null ? { unreadable: true } : { value: field.typed };
    },
    // Remember for next time (#186): one open question's answer, read after the click.
    readOpen({ token, id }) {
      const field = token === current?.token ? current.ids.get(id) : null;
      if (!field || field.key) return null;
      if (field.repeated) return { repeated: true };
      return field.typed === undefined ? { empty: true } : field.typed === null ? { unreadable: true } : { value: field.typed };
    },
    // The id a field has in the latest plan.
    idOf: name => [...(current?.ids || [])].find(([, field]) => field.name === name)?.[0],
    answered: () => fields.filter(field => field.answered).map(field => field.name)
  };
}

// `build` runs the worker as another build, and `disk` is the build in the files Chrome would load on a reload (#85).
function siteWorker({ url = SITE_URL, enabled = false, granted = enabled, allSites = false, allGranted = allSites, desktop = {}, fields = pantryFields(), next, duringGetFields, duringStatus, frames = [], plan, keepAccess = false, discoveryError = false, topError, formFramesError, framesReply, pageText = { lang: 'en', text: '' }, clock, openTabs, lang = 'en', ai = {}, build, disk } = {}) {
  const tab = { id: 7, active: true, url };
  const log = [], native = [], content = [], injected = [], opened = [];
  let reloads = 0;
  const permissions = new Set([...(granted ? [`${ORIGIN}/*`] : []), ...(allGranted ? [ALL] : [])]);
  // Iowa's site is a manifest permission. Chrome takes it back with https://*/* until it restarts.
  const iowa = { held: true };
  function takeBack(origins) {
    origins.forEach(origin => permissions.delete(origin));
    if (origins.includes(ALL)) { for (const origin of [...permissions]) if (origin.startsWith('https://')) permissions.delete(origin); iowa.held = false; }
    setImmediate(() => events.permissionsRemoved?.({ permissions: [], origins: [...origins] }));
  }
  const registered = new Map([...(enabled ? [[SCRIPT_ID, structuredClone(SITE_SCRIPT)]] : []), ...(allSites ? [['site-all', structuredClone(ALL_SCRIPT)]] : [])]);
  for (const frame of frames) {
    if (frame.granted || frame.enabled) permissions.add(`${frame.origin}/*`);
    if (frame.enabled) { const id = `frame-pantry.example.org--${new URL(frame.origin).hostname}`; registered.set(id, { ...SITE_SCRIPT, id, matches: [`${frame.origin}/*`] }); }
  }
  const page = sitePage(fields, { next, lang });
  for (const frame of frames) frame.page = sitePage(frame.fields || pantryFields(), { next: frame.next, tokenPrefix: `frame${frame.frameId}`, lang: frame.lang });
  // Each frame's document and address as Chrome knows them. A frame can't change these, but its page says what it
  // likes about itself: `claims` is the origin its own `location` reports. A test navigates a frame by changing them.
  const topDocument = { frameId: 0, documentId: 'doc-0' };
  const documentOf = frame => frame ? { frameId: frame.frameId, documentId: frame.documentId || `doc-${frame.frameId}`, url: frame.url || `${frame.origin}/form`, claims: frame.claims }
    : { ...topDocument, url: tab.url };
  // Runs an injected function in one frame, as Chrome does: the page's own `location`, and messages Chrome sends on
  // to the worker with the frame's true id, document, and address as their sender.
  function runInFrame(details, frame) {
    const where = documentOf(frame);
    const sender = { id: 'testextension', url: where.url, origin: new URL(where.url).origin, frameId: where.frameId, documentId: where.documentId, tab: { id: tab.id, url: tab.url } };
    const location = { origin: where.claims || sender.origin, href: where.claims ? `${where.claims}/` : where.url };
    const frameChrome = { runtime: { id: 'testextension', sendMessage: message => send(plain(message), sender) } };
    return vm.runInNewContext(`(${details.func})(...args)`, { chrome: frameChrome, location, args: plain(details.args || []) });
  }
  const tallies = [];
  let statusChecks = 0;
  const vault = { reachable: true, unlocked: true, accessRevision: 0, getFieldsError: null, trustError: null, allSites,
    values: { firstName: 'Synthetic private first', lastName: 'Synthetic private last', zip: '50309' }, ...desktop };
  // With `trusted`, the app trusts only those origins, as its trusted-site list does.
  const untrusted = url => Array.isArray(vault.trusted) && !vault.trusted.includes(new URL(url).origin);
  const w = serviceWorker();
  const { events, event, send } = w;
  const chrome = {
    tabs: {
      get: async () => ({ ...tab }),
      // Without the tabs permission Chrome gives an address only where SecondHand has access.
      query: async () => (openTabs || [tab]).map(open => ({ ...open, url: covered(open.url) ? open.url : undefined })),
      sendMessage: async (tabId, message, options) => {
        content.push({ tabId, frameId: options?.frameId, ...(options?.documentId === undefined ? {} : { documentId: options.documentId }), ...plain(message) });
        // `formFramesError`: the top page fails the worker's message about its card, for a reason other than not having loaded.
        if (message.type === 'secondhand:generic:formFrames' && formFramesError) throw new Error(formFramesError);
        if (['secondhand:generic:formFrames', 'secondhand:generic:off'].includes(message.type)) return undefined;
        if (options?.frameId === 0 && topError) throw new Error(topError);
        if (message.type === 'secondhand:generic:frames') return framesReply === undefined ? { origins: frames.map(frame => frame.origin) } : framesReply;
        const frame = frames.find(frame => frame.frameId === options?.frameId);
        // A message for one document reaches its frame only while that document is still there.
        if (options?.documentId !== undefined && options.documentId !== documentOf(frame).documentId) throw new Error('Could not establish connection. Receiving end does not exist.');
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
        if (message.type === 'secondhand:generic:answered') return { answered: model.answeredIds(message.token, message.ids) };
        if (message.type === 'secondhand:generic:read') return model.read(plain(message));
        if (message.type === 'secondhand:generic:readOpen') return model.readOpen(plain(message));
        if (message.type === 'secondhand:generic:pageText') return structuredClone(frame ? frame.pageText || { lang: '', text: '' } : pageText);
        // An embedded frame says whether its page has a form SecondHand can help with (#157): `helps` on the frame.
        // `off`: SecondHand was turned off for the frame, which answers nothing. `answering`: a test holds the answer back.
        if (message.type === 'secondhand:generic:helps' && frame) { await frame.answering; return frame.off ? undefined : { helps: frame.helps === true }; }
        throw new Error(`Unexpected content message ${message.type}`);
      },
      onActivated: event('activated'), onRemoved: event('removed'), onUpdated: event('updated')
    },
    permissions: {
      contains: async ({ origins }) => { log.push('permissions.contains'); return origins.every(origin => permissions.has(origin) || (origin === IOWA_HOST ? iowa.held : permissions.has(ALL) && origin.startsWith('https://'))); },
      // As Chrome does, removing https://*/* also takes every https origin it covers, Iowa's included.
      remove: async ({ origins }) => {
        log.push('permissions.remove');
        if (keepAccess) return true;
        takeBack(origins);
        return true;
      },
      request: async () => { log.push('permissions.request'); throw new Error('Only the side panel may request access, inside a click.'); },
      // Chrome says when access goes, whoever took it back: SecondHand, the person in Chrome's settings, or Chrome.
      onRemoved: event('permissionsRemoved')
    },
    scripting: {
      executeScript: async details => {
        if (details.func && details.target.allFrames) {
          if (discoveryError) throw new Error('Cannot access an unapproved frame');
          return Promise.all([undefined, ...frames].map(async frame => ({ frameId: documentOf(frame).frameId, documentId: documentOf(frame).documentId, result: await runInFrame(details, frame) })));
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
      onMessage: w.onMessage,
      onInstalled: event('installed'),
      reload: () => { reloads++; },
      connectNative: nativeHost({ posted: request => { native.push(plain(request)); log.push(`native:${request.type}`); }, answer: async (request, { reply, fail, disconnect }) => {
        // A reply the test holds back, as the app does while its approval prompt is open.
        await vault.delay?.[request.type];
        if (!vault.reachable) return disconnect();
        if (request.type === 'status') {
          duringStatus?.(vault, ++statusChecks);
          return reply({ unlocked: vault.unlocked, applicationCount: 0, accessRevision: vault.accessRevision, allSites: vault.allSites, ...(vault.layaState ? { laya: { state: vault.layaState } } : {}),
            ...(vault.extension ? { extension: structuredClone(vault.extension) } : {}), ...(vault.customFieldsAvailable ? { customFieldsAvailable: true } : {}) });
        }
        if (request.type === 'trustAllSites') {
          if (vault.trustAllError) return fail(vault.trustAllError);
          if (vault.trustAllReply) return reply(vault.trustAllReply);
          vault.allSites = true; return reply({ allSites: true });
        }
        if (request.type === 'untrustAllSites') { if (vault.untrustError) return fail(vault.untrustError); vault.allSites = false; return reply({ allSites: false }); }
        // Laya (#39, #42): readied before a click's questions; "not ready" unless a test plays it.
        if (request.type === 'warmLaya') { vault.warming?.(); return reply({ state: vault.layaState || 'unavailable' }); }
        if (request.type === 'suggestFields' || request.type === 'answerFields') {
          if (untrusted(request.url) && !vault.allSites) return fail('This site isn’t trusted. Turn on SecondHand for it first.');
          const play = vault.laya?.[request.type];
          if (!play) return fail('Laya isn’t ready on this computer.', { code: 'LAYA_NOT_READY' });
          const answer = play(plain(request), vault);
          return typeof answer === 'string' ? fail(answer) : reply(answer);
        }
        if (request.type === 'showApp') return reply({ shown: true });
        if (request.type === 'trustSite') return (vault.trustError || request.url === vault.declineOrigin) ? fail(vault.trustError || 'Declined') : reply({ trusted: true, origin: new URL(request.url).origin });
        if (request.type === 'untrustSite') return vault.untrustSiteError ? fail(vault.untrustSiteError) : reply({ trusted: false, origin: new URL(request.url).origin });
        if (request.type === 'saveFields') {
          if (untrusted(request.url) && !vault.allSites) return fail('This site isn’t trusted. Turn on SecondHand for it first.');
          if (vault.saveError) return fail(vault.saveError);
          return reply({ saved: Object.keys(request.fields) });
        }
        if (request.type === 'getFields') {
          duringGetFields?.(tab, plain(request));
          // The app's rule: a site it doesn't trust gets nothing unless all websites is on.
          if ((vault.refuseUntrusted || untrusted(request.url)) && !vault.allSites) return fail('This site isn’t trusted. Turn on SecondHand for it first.');
          // Fill sensitive details (#176): `sensitiveError` is the app's answer to its sensitive prompt when it isn't Allow
          // (Cancel), or a function of the request that gives it for one site.
          const refusal = typeof vault.sensitiveError === 'function' ? vault.sensitiveError(plain(request)) : vault.sensitiveError;
          if (request.sensitive && refusal) return fail(refusal);
          if (vault.cancelOrigin === new URL(request.url).origin) return fail('You cancelled this field request.');
          if (vault.getFieldsError) return fail(vault.getFieldsError);
          // `fieldsReason`: why the app left saved answers out (#135), or a function of the request that says it for one site.
          const reason = typeof vault.fieldsReason === 'function' ? vault.fieldsReason(plain(request)) : vault.fieldsReason;
          // `holds`: the sensitive fields the app holds back from Autofill without Always allow (#176), or a function of
          // the request that gives the reply's `held` exactly, beside every saved answer asked for.
          const played = typeof vault.holds === 'function';
          const held = played ? vault.holds(plain(request)) : request.sensitive ? [] : request.fields.filter(key => (vault.holds || []).includes(key));
          return reply({ accessRevision: vault.accessRevision,
            values: Object.fromEntries(request.fields.filter(key => vault.values[key] && (played || !held.includes(key))).map(key => [key, vault.values[key]])),
            ...((played ? held !== undefined : held.length) ? { held } : {}), ...(reason !== undefined ? { reason } : {}) });
        }
        // Remember for next time (#186): the app's confirmation and save, as Remember, unless the test gives its refusal.
        if (request.type === 'rememberAnswers') {
          if (untrusted(request.url) && !vault.allSites) return fail('This site isn’t trusted. Turn on SecondHand for it first.');
          if (vault.rememberError) return fail(vault.rememberError);
          return reply({ remembered: request.answers.length });
        }
        if (request.type === 'getCustomFields') {
          const response = vault.custom?.(plain(request), vault, tab);
          return reply(response || { values: {}, accessRevision: vault.accessRevision });
        }
        fail('Unsupported bridge request.');
      } })
    }
  };
  // A test may run the worker's clock itself: `clock.now` is what Date.now() returns. `ai` holds the
  // stand-ins for Chrome's Translator and LanguageDetector a test gives the worker; by default it has neither.
  // The worker starts as Chrome starts it: at once, and again after Chrome stopped it (#142), when the new worker's
  // listeners replace the old one's and its memory starts empty. Chrome's records (registrations, access, tabs) stay as they were.
  w.start({ chrome, globals: { SecondHandGeneric: generic, ...ai, ...(clock ? { Date: { now: () => clock.now } } : {}) }, build, disk });
  // Whether Chrome lets SecondHand read this address.
  function covered(address) {
    try { const origin = new URL(address).origin; return permissions.has(`${origin}/*`) || (origin === IOWA_ORIGIN ? iowa.held : permissions.has(ALL) && address.startsWith('https://')); }
    catch { return false; }
  }
  return {
    tab, page, vault, log, native, content, injected, tallies, opened, permissions, registered, events, send, iowa,
    reloads: () => reloads,
    // The person removes SecondHand's access in Chrome's settings (#142).
    revoke: origins => takeBack(origins),
    restart: w.restart,
    // The events the worker listens to, its own messages included.
    listening: w.listening,
    nativeTypes: () => native.map(call => call.type),
    contentTypes: () => content.map(call => call.type),
    panel: message => send({ tabId: 7, ...message }, { id: 'testextension', url: PANEL_URL }),
    launcher: message => send(message, { id: 'testextension', url: `${PANEL_URL}?surface=launcher`, frameId: 3, tab: { id: 7, url: tab.url } })
  };
}
const autofill = w => w.panel({ type: 'ui:autofill', confirmed: true });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

test('the worker loads the site engine, its text, and its translator next to the Iowa adapter and refuses to start without any of them', () => {
  const imported = [];
  const chrome = { runtime: { onMessage: { addListener: () => {} } }, tabs: {}, sidePanel: { setPanelBehavior: async () => {} } };
  assert.throws(() => runFile('extension/background.js', { chrome, SecondHandIowa: adapter, importScripts: (...files) => imported.push(...files), crypto: webcrypto, URL, Map, Set }), /generic-adapter\.js/);
  assert.deepEqual(imported, ['address-policy.js', 'iowa-later-adapter.js', 'iowa-record-adapter.js', 'iowa-adapter.js', 'generic-adapter.js', 'strings.js', 'translation.js']);
  assert.throws(() => runFile('extension/background.js', { chrome, SecondHandIowa: adapter, SecondHandGeneric: generic, importScripts: () => {}, crypto: webcrypto, URL, Map, Set }), /strings\.js/);
  assert.throws(() => runFile('extension/background.js', { chrome, SecondHandIowa: adapter, SecondHandGeneric: generic, SecondHandStrings: strings, importScripts: () => {}, crypto: webcrypto, URL, Map, Set }),
    /translation\.js/, 'a worker that can’t translate questions for Laya doesn’t start');
  const { layaQuestion: _, ...older } = generic;
  assert.throws(() => runFile('extension/background.js', { chrome, SecondHandIowa: adapter, SecondHandGeneric: older, SecondHandStrings: strings, importScripts: () => {}, crypto: webcrypto, URL, Map, Set }),
    /generic-adapter\.js/, 'an engine without Laya’s question rule is refused');
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
  assert.deepEqual(w.injected, [{ target: { tabId: 7, frameIds: [0] }, files: SITE_SCRIPT.js }]);
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
  // The side panel's page state also asks which listed boxes (the household size, not saved) hold an answer now.
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan', 'secondhand:generic:fill', 'secondhand:generic:plan', 'secondhand:generic:frames',
    'secondhand:generic:answered'], 'nothing continues or navigates on its own');
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
    <button type="submit">Submit</button>`), { rule: 2, guess: 1, layaGuess: 0, next: false });
  // Google Forms' div choices: every option is marked, but the question counts once.
  assert.deepEqual(run(`<div role="radiogroup">${['One', 'Two', 'Three'].map(label => `<div role="radio" aria-label="${label}" data-secondhand-filled="rule"></div>`).join('')}</div>
    <div role="radiogroup"><div role="radio" data-secondhand-filled="guess"></div><div role="radio" data-secondhand-filled="guess"></div></div>`), { rule: 1, guess: 1, layaGuess: 0, next: false });
  // Laya's best guesses (#185) count apart from the other guesses, a group once.
  assert.deepEqual(run(`<label><input type="radio" name="size" data-secondhand-filled="laya-guess">1</label><label><input type="radio" name="size" data-secondhand-filled="laya-guess">2</label>
    <select name="county" data-secondhand-filled="laya-guess"></select><input name="email" data-secondhand-filled="guess">`), { rule: 0, guess: 1, layaGuess: 2, next: false });
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
  assert.deepEqual(w.native.map(call => Object.keys(call).sort()), [['id', 'type']], 'planning never reaches the vault: it only readies Laya');
  assert.deepEqual(w.nativeTypes(), ['warmLaya']);
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
  assert.deepEqual(w.nativeTypes(), ['warmLaya', 'status', 'status', 'getFields', 'status'], 'the plan readies Laya, then checks custom-answer availability before its one field release');
  assert.deepEqual(w.native.find(call => call.type === 'getFields').fields, ['firstName', 'lastName', 'email', 'phone']);
  // The fill uses the plan the AI saw, then plans again for anything revealed.
  assert.deepEqual(w.contentTypes(), ['secondhand:generic:frames', 'secondhand:generic:plan', 'secondhand:generic:frames', 'secondhand:generic:fill', 'secondhand:generic:plan']);
  assert.deepEqual(w.content.find(call => call.type === 'secondhand:generic:fill').assignments, [{ id: 'sh-1-0', key: 'fullName', guessed: false }, { id: reach.split(':')[1], key: 'email', guessed: true }, { id: call.split(':')[1], key: 'phone', guessed: true }]);
  assert.deepEqual(w.page.fields.map(field => field.mark), ['rule', undefined, 'guess', 'guess']);
  const result = plain(response.data);
  assert.equal(result.filled, 3);
  assert.equal(result.guessed, 2);
  assert.equal(result.message, 'Filled 3 · 2 suggested · 1 need you. Check your answers before you submit.');
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
    assert.deepEqual(w.nativeTypes(), ['warmLaya'], `only the plan’s Laya check: ${JSON.stringify(guesses(ids))}`);
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false);
  }
});

test('a box only the applicant answers is never shown to Chrome’s AI, and a guess for it is refused before the vault is asked (#134)', async () => {
  const applicantOnly = [{ name: 'sig', label: 'Type your full name as your electronic signature', type: 'text' }, { name: 'code', label: 'Enter the code we texted you', type: 'text' },
    { name: 'born', label: 'In what city were you born?', type: 'text' }, { name: 'user', label: 'Username', type: 'text' }];
  const fields = () => [...openQuestions(), ...applicantOnly.map(field => ({ ...field }))];
  const planned = await plan(siteWorker({ enabled: true, fields: fields() }));
  assert.deepEqual(planned.unmatched.map(field => field.label), ['Preferred pickup day', 'Where can we email you?', 'Best number to reach you']);
  for (const [name, key] of [['sig', 'fullName'], ['code', 'phone'], ['born', 'city'], ['user', 'email']]) {
    const w = siteWorker({ enabled: true, fields: fields() });
    await plan(w);
    const result = plain((await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: { [`f0:${w.page.idOf('reach')}`]: 'email', [`f0:${w.page.idOf(name)}`]: key } })).data);
    assert.equal(result.state, 'error', name);
    assert.match(result.message, /couldn’t use the on-device AI/, name);
    assert.deepEqual(w.nativeTypes(), ['warmLaya'], `${name}: only the plan’s Laya check`);
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false, name);
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
  assert.deepEqual(moved.nativeTypes(), ['warmLaya'], 'only the plan’s Laya check');
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

test('turning a site off removes its script registration and Chrome access, and the app stops trusting it', async () => {
  const w = siteWorker({ enabled: true });
  assert.equal(await w.panel({ type: 'ui:disableSite' }), undefined);
  const response = await w.panel({ type: 'ui:disableSite', confirmed: true });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { enabled: false, origin: ORIGIN });
  assert.equal(w.registered.size, 0);
  assert.equal(w.permissions.size, 0);
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'untrustSite', url: ORIGIN }]);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.enabled, false);
  assert.equal((await autofill(w)).ok, false);
  assert.deepEqual(w.nativeTypes(), ['untrustSite'], 'nothing more reaches the app');
  // The app can't be reached: SecondHand is off for the site in Chrome all the same, and says the app wasn't told.
  const closed = siteWorker({ enabled: true, desktop: { untrustSiteError: 'The request could not be completed.' } });
  const told = await closed.panel({ type: 'ui:disableSite', confirmed: true });
  assert.equal(told.errorKey, 'worker.siteStillTrustedInApp');
  assert.equal(closed.registered.size, 0);
});

// The content script that hosts the widget and runs the site engine on approved pages.
const extensionId = 'a'.repeat(32);
const extensionURL = file => `chrome-extension://${extensionId}/${file}`;
function siteContent(t, { url = SITE_URL, engine = true, settled = null, offers = () => true, framesReply = { frames: false } } = {}) {
  const dom = new JSDOM('<!doctype html><body><form><label>Your name <input id="name"></label><label>Pickup day <select id="day"><option></option><option>Monday</option></select></label></form></body>', { url, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  const frames = [];
  const create = window.document.createElement.bind(window.document);
  window.document.createElement = name => { const element = create(name); if (name === 'iframe') frames.push(element); return element; };
  let listener;
  const calls = [];
  // What the page's content script tells the worker: whether its frame has a form SecondHand can help with.
  const reports = [];
  window.chrome = { runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener: callback => { listener = callback; } },
    sendMessage: async message => { reports.push(plain(message)); return structuredClone(framesReply); } } };
  if (engine) {
    window.SecondHandGeneric = {
      offers: doc => offers(doc),
      plan: doc => {
        calls.push('plan');
        return { token: 'plan-1', element: doc.getElementById('name'),
          matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high', element: doc.getElementById('name'), value: 'Synthetic private value' }],
          unmatched: [{ id: 'sh-2', label: 'Pickup day', type: 'select-one', options: ['Monday'], required: true, element: doc.getElementById('day'), value: 'Synthetic private value' }] };
      },
      fillFields: (doc, token, assignments, values) => {
        calls.push({ token, assignments: plain(assignments), values: plain(values) });
        doc.getElementById('name').value = values.fullName;
        return { ok: true, filled: ['sh-1'], skipped: [], rejected: ['sh-2'], pending: [], partial: [], values };
      },
      // Stands in for the engine confirming choices the page marks a moment after the click.
      settle: async (doc, token, result) => { calls.push(`settle:${token}`); return settled ? settled(result) : result; },
      focusField: (doc, id) => { calls.push(`focus:${id}`); if (id !== 'sh-2') return false; doc.getElementById('day').focus(); return true; },
      // Save to My information (#98): which listed boxes hold an answer, and one box's answer after the click.
      answeredIds: (doc, token, ids) => { calls.push(`answered:${token}:${ids.join(',')}`); return token === 'plan-1' ? ids.filter(id => id === 'sh-1') : []; },
      readAnswer: (doc, token, id, key) => {
        calls.push(`read:${token}:${id}:${key}`);
        if (token === 'plan-1' && id === 'sh-3') return { repeated: true, element: doc.getElementById('name') };
        return token === 'plan-1' && id === 'sh-1' && key === 'county' ? { value: 'Story', element: doc.getElementById('name') } : null;
      },
      // Remember for next time (#186): one open question's answer, after the click.
      readOpen: (doc, token, id) => {
        calls.push(`readOpen:${token}:${id}`);
        if (token === 'plan-1' && id === 'sh-3') return { empty: true, element: doc.getElementById('day') };
        return token === 'plan-1' && id === 'sh-2' ? { value: 'Monday', element: doc.getElementById('day') } : null;
      }
    };
  }
  evalFile(window, 'extension/page-text.js');
  evalFile(window, 'extension/generic-content.js');
  return { window, frames, calls, reports,
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
  assert.equal(host.style.height, '46px');
  assert.equal(host.style.position, 'fixed');
  evalFile(page.window, 'extension/generic-content.js');
  assert.equal(page.frames.length, 1, 'injecting again keeps one widget');

  const child = page.window.document.createElement('iframe');
  page.window.document.body.append(child);
  child.contentWindow.SecondHandGeneric = page.window.SecondHandGeneric;
  child.contentWindow.chrome = page.window.chrome;
  evalFile(child.contentWindow, 'extension/generic-content.js');
  assert.equal(child.contentWindow.document.querySelector('[data-secondhand-assistant]'), null);
  assert.equal(siteContent(t, { engine: false }).host(), null);
  assert.equal(siteContent(t, { url: 'http://pantry.example.org/intake' }).host(), null);
});

test('site plans and fills answer with field metadata only, never values or elements', async t => {
  const page = siteContent(t);
  const plan = page.request({ type: 'secondhand:generic:plan' });
  assert.deepEqual(plain(plan), { token: 'plan-1', lang: '', matched: [{ id: 'sh-1', key: 'fullName', confidence: 'high' }],
    unmatched: [{ id: 'sh-2', label: 'Pickup day', type: 'select-one', options: ['Monday'], required: true }] });
  const filled = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic private name' } });
  assert.deepEqual(plain(filled), { ok: true, filled: ['sh-1'], skipped: [], rejected: ['sh-2'], partial: [] }, 'answers the page refused come back');
  assert.deepEqual(page.calls[1], { token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic private name' } });
  assert.equal(page.window.document.getElementById('name').value, 'Synthetic private name');
  assert.doesNotMatch(JSON.stringify([plan, filled]), /Synthetic private/);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-2' })), { focused: true });
  assert.equal(page.window.document.activeElement.id, 'day');
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:focus', id: 'sh-9' })), { focused: false });
  page.window.document.documentElement.lang = 'es-MX';
  assert.equal(page.request({ type: 'secondhand:generic:plan' }).lang, 'es-MX', 'the language the frame declares, for reading its questions to Laya');
});

test('a fill answers only after the engine settles choices the page confirms a moment later', async t => {
  const page = siteContent(t, { settled: result => ({ ...result, filled: [...result.filled, 'sh-3'], pending: [] }) });
  page.request({ type: 'secondhand:generic:plan' });
  const filled = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic' } });
  assert.deepEqual(plain(filled), { ok: true, filled: ['sh-1', 'sh-3'], skipped: [], rejected: ['sh-2'], partial: [] });
  assert.equal(page.calls.at(-1), 'settle:plan-1');
});

test('a fill the page interrupted by changing answers that the page changed', async t => {
  const page = siteContent(t, { settled: result => ({ ...result, ok: false, pageChanged: true, pending: [] }) });
  page.request({ type: 'secondhand:generic:plan' });
  const filled = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [{ id: 'sh-1', key: 'fullName', guessed: false }], values: { fullName: 'Synthetic' } });
  assert.deepEqual(plain(filled), { ok: false, pageChanged: true, filled: ['sh-1'], skipped: [], rejected: ['sh-2'], partial: [] });
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
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'trustSite', url: FRAME_ORIGIN }, { type: 'trustSite', url: other }, { type: 'untrustSite', url: FRAME_ORIGIN }],
    'the app forgets the form it approved before the other was declined');
  // Under Chrome's kept grant for every https site there is nothing narrower to take back: the app's answer is what shows.
  const covered = siteWorker({ enabled: true, allGranted: true, frames: [secondFrame()], desktop: { declineOrigin: FRAME_ORIGIN } });
  const declined = await covered.panel({ type: 'ui:enableFrames', confirmed: true });
  assert.equal(declined.error, 'Declined');
  assert.equal(covered.log.includes('permissions.remove'), false);
  assert.deepEqual([...covered.registered.keys()], [SCRIPT_ID]);
});
test('site fill asks once for each site and uses each frame token', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, fields: [{ name: 'zip', key: 'zip' }] })] });
  const result = (await autofill(w)).data;
  assert.equal(result.filled, 3);
  assert.deepEqual(plain(result.needYou), ['f0:sh-2-1', 'f0:sh-2-0']);
  assert.deepEqual(w.native.filter(call => call.type === 'getFields').map(({ url, fields }) => ({ url, fields })),
    [{ url: `${ORIGIN}/intake`, fields: ['firstName', 'lastName', 'zip', 'householdSize'] }, { url: `${FRAME_ORIGIN}/form`, fields: ['zip'] }]);
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
  const w = siteWorker({ enabled: true, plan: { token: 'empty', lang: 'en', matched: [], unmatched: [] }, frames: [secondFrame()] });
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
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'untrustSite', url: ORIGIN }, { type: 'untrustSite', url: FRAME_ORIGIN }]);
  const kept = siteWorker({ enabled: true, keepAccess: true });
  const refused = await kept.panel({ type: 'ui:disableSite', confirmed: true });
  assert.equal(refused.errorKey, 'worker.chromeKeptAccess', 'Chrome keeping a narrow grant nothing covers is a real failure');
});

test('with Chrome’s grant for every https site kept, turning one site off unregisters it and the app drops it, without asking Chrome', async () => {
  const w = siteWorker({ enabled: true, allGranted: true, frames: [secondFrame({ enabled: true })] });
  const response = await w.panel({ type: 'ui:disableSite', confirmed: true });
  assert.equal(response.ok, true, response.error);
  assert.equal(w.registered.size, 0);
  assert.equal(w.log.includes('permissions.remove'), false, 'still covered by the kept grant: expected, not an error');
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'untrustSite', url: ORIGIN }, { type: 'untrustSite', url: FRAME_ORIGIN }]);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.enabled, false, 'the site is off though Chrome still allows it');
  // Declining a site in the app leaves nothing behind either.
  const declined = siteWorker({ allGranted: true, desktop: { trustError: 'You cancelled trusting this site.' } });
  assert.equal((await declined.panel({ type: 'ui:enableSite', confirmed: true })).ok, false);
  assert.equal(declined.registered.size, 0);
  assert.equal(declined.log.includes('permissions.remove'), false);
});

// Chrome takes access back (#142): the person removed it in Chrome's settings, or Chrome did.
const untrusted = w => w.native.filter(call => call.type === 'untrustSite').map(call => call.url);
test('when Chrome takes a site back, SecondHand stops using it and the app stops trusting it', async () => {
  const w = siteWorker({ enabled: true });
  w.revoke([`${ORIGIN}/*`]);
  await settle();
  assert.equal(w.registered.size, 0, 'its script is gone');
  assert.deepEqual(untrusted(w), [ORIGIN]);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.enabled, false);
  assert.equal((await autofill(w)).ok, false);
  assert.deepEqual(w.nativeTypes(), ['untrustSite'], 'nothing more reaches the app');
  // Chrome's access given back in its settings turns nothing on: only SecondHand's own Turn on does.
  w.permissions.add(`${ORIGIN}/*`);
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.enabled, false);
});

test('Chrome taking a site back takes the embedded forms it turned on; taking an embedded form’s site back leaves the page’s site on', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true })] });
  w.revoke([`${ORIGIN}/*`]);
  await settle();
  assert.equal(w.registered.size, 0);
  assert.equal(w.permissions.size, 0, 'Chrome’s access to the embedded form goes too, as when the site is turned off');
  assert.deepEqual(untrusted(w), [ORIGIN, FRAME_ORIGIN]);

  const form = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true })] });
  form.revoke([`${FRAME_ORIGIN}/*`]);
  await settle();
  assert.deepEqual([...form.registered.keys()], [SCRIPT_ID]);
  assert.deepEqual(untrusted(form), [FRAME_ORIGIN]);
  assert.equal((await form.panel({ type: 'ui:pageState' })).data.site.enabled, true);
});

test('with the app closed when Chrome takes a site back, the site is off at once and the app hears at its next status', async () => {
  const w = siteWorker({ enabled: true, desktop: { reachable: false } });
  w.revoke([`${ORIGIN}/*`]);
  await settle();
  assert.deepEqual([...w.registered.keys()], [SCRIPT_ID], 'kept as the reminder that the app hasn’t heard');
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.site.enabled, false, 'without Chrome’s access it runs nothing');
  w.vault.reachable = true;
  assert.equal((await w.panel({ type: 'ui:desktopStatus' })).ok, true);
  assert.deepEqual(w.nativeTypes(), ['untrustSite', 'status', 'untrustSite'], 'tried while closed, then before anything else is asked');
  assert.equal(w.registered.size, 0);
  // An app that answers but doesn't say it stopped trusting the site fails loudly.
  const odd = siteWorker({ enabled: true, desktop: { reachable: false } });
  odd.revoke([`${ORIGIN}/*`]);
  await settle();
  Object.assign(odd.vault, { reachable: true, untrustSiteError: 'The request could not be completed.' });
  assert.equal((await odd.panel({ type: 'ui:desktopStatus' })).errorKey, 'worker.siteStillTrustedInApp');
  assert.deepEqual([...odd.registered.keys()], [SCRIPT_ID]);
});

test('when Chrome takes back every https site, all websites turns off and the app stops trusting every site', async () => {
  const w = siteWorker({ url: OTHER_URL, allSites: true });
  w.revoke([ALL]);
  await settle();
  assert.equal(w.registered.size, 0);
  assert.deepEqual(w.nativeTypes(), ['untrustAllSites']);
  assert.equal(w.vault.allSites, false);
  // A site turned on by itself goes too: Chrome took it back with every https site.
  const both = siteWorker({ enabled: true, allSites: true });
  both.revoke([ALL]);
  await settle();
  assert.equal(both.registered.size, 0);
  assert.deepEqual(both.native.map(({ type, url }) => url ? `${type} ${url}` : type), ['untrustAllSites', `untrustSite ${ORIGIN}`]);
});

test('Chrome taking back a site SecondHand never had on asks nothing of the app; SecondHand’s own Turn off tells the app once', async () => {
  const w = siteWorker({ granted: true });
  w.revoke([`${ORIGIN}/*`]);
  await settle();
  assert.deepEqual(w.native, []);
  // Turn off takes Chrome's access back too, and Chrome says so.
  const off = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true })] });
  assert.equal((await off.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  await settle();
  assert.deepEqual(untrusted(off), [ORIGIN, FRAME_ORIGIN]);
});

test('the Save offers and page words kept for a site Chrome took back are forgotten', async () => {
  const w = siteWorker({ enabled: true, pageText: { lang: 'en', text: 'Synthetic pantry hours' } });
  await autofill(w);
  const [read] = (await w.panel({ type: 'ui:pageText' })).data.pages;
  assert.equal((await w.panel({ type: 'ui:keepSummary', id: read.id, summary: { language: 'en', english: true, points: ['Open on Mondays.'] } })).ok, true);
  const before = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.equal(before.savable.length, 1);
  assert.equal(before.summary.point, 'Open on Mondays.');
  w.revoke([`${ORIGIN}/*`]);
  await settle();
  // The person turns the site on again in the side panel.
  w.permissions.add(`${ORIGIN}/*`);
  assert.equal((await w.panel({ type: 'ui:enableSite', confirmed: true })).ok, true);
  assert.equal(plain((await w.panel({ type: 'ui:pageState' })).data).savable, undefined);
  assert.equal(plain((await w.panel({ type: 'ui:pageState' })).data).summary, undefined);
  assert.equal(w.content.filter(call => call.type === 'secondhand:generic:answered').length, 1, 'the forgotten offer is never asked about again');
});

// A worker restart (#142): Chrome stops an idle service worker and starts it again for the next event. Chrome's
// records (registrations, access) are as they were; everything the worker held in memory is gone.
test('a restarted worker listens for every event before its first one, and the sites turned on stay on, from Chrome’s records', async () => {
  const w = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true })] });
  w.restart();
  assert.deepEqual(w.listening(), ['activated', 'installed', 'message', 'permissionsRemoved', 'removed', 'updated'],
    'registered while the worker starts, so the event that woke it is heard');
  assert.deepEqual(plain((await w.panel({ type: 'ui:pageState' })).data.site), { origin: ORIGIN, enabled: true, ready: true, frames: [{ origin: FRAME_ORIGIN, enabled: true }] });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'done', result.message);
  assert.ok(result.filled > 0);
  const all = siteWorker({ url: OTHER_URL, allSites: true });
  all.restart();
  assert.equal(plain((await all.panel({ type: 'ui:desktopStatus' })).data).allSites, true);
  assert.equal(plain((await all.panel({ type: 'ui:pageState' })).data).site.enabled, true);
});

test('a restarted worker hears Chrome take a site back, and finds one taken back while no worker listened at its next status', async () => {
  const w = siteWorker({ enabled: true });
  w.restart();
  w.revoke([`${ORIGIN}/*`]);
  await settle();
  assert.equal(w.registered.size, 0);
  assert.deepEqual(untrusted(w), [ORIGIN]);
  // Chrome's record says so all the same.
  const missed = siteWorker({ enabled: true });
  missed.permissions.delete(`${ORIGIN}/*`);
  missed.restart();
  assert.equal((await missed.panel({ type: 'ui:desktopStatus' })).ok, true);
  assert.equal(missed.registered.size, 0);
  assert.deepEqual(untrusted(missed), [ORIGIN]);
});

test('the last result and Save offers live in the worker’s memory only: gone after a restart, back with the next Autofill', async () => {
  const w = siteWorker({ enabled: true });
  await autofill(w);
  w.restart();
  let state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.deepEqual({ result: state.result, savable: state.savable }, { result: null, savable: undefined });
  assert.equal(state.site.enabled, true);
  await autofill(w);
  state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.deepEqual(state.result.needYou, [`f0:${w.page.idOf('pickup')}`, `f0:${w.page.idOf('size')}`]);
  assert.deepEqual(state.savable.map(item => item.label), ['size']);
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
test('a visible iframe whose address doesn’t parse is skipped, and the page’s other frames are still found', t => {
  const page = siteContent(t);
  const doc = page.window.document;
  for (const src of ['http://[bad', 'https://pantry form.example.org/', 'https://form.jotform.com/one']) {
    const frame = doc.createElement('iframe'); frame.setAttribute('src', src);
    frame.getClientRects = () => [{ width: 300, height: 200 }];
    doc.body.append(frame);
  }
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:frames' })), { origins: [FRAME_ORIGIN] });
  // Anything else that goes wrong still fails the whole scan.
  const broken = doc.createElement('iframe'); broken.src = 'https://forms.example.org/';
  broken.getClientRects = () => { throw new Error('Synthetic layout failure'); };
  doc.body.append(broken);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:frames' })), { ok: false, error: 'This page could not be checked safely. Review it manually.' });
});
test('an https subframe answers plans without creating a widget', t => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: FRAME_ORIGIN, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.reconfigure({ windowTop: {} });
  let listener;
  const reports = [];
  dom.window.chrome = { runtime: { id: extensionId, onMessage: { addListener: callback => { listener = callback; } }, sendMessage: async message => { reports.push(plain(message)); } } };
  dom.window.SecondHandGeneric = { plan: () => pantryPlan(), offers: () => true };
  evalFile(dom.window, 'extension/generic-content.js');
  assert.equal(typeof listener, 'function');
  assert.deepEqual(reports, [{ type: 'secondhand:generic:form', helps: true }]);
  let result;
  listener({ type: 'secondhand:generic:plan' }, { id: extensionId }, value => { result = value; });
  assert.equal(result.token, 'plan-1');
  assert.equal(dom.window.document.querySelector('[data-secondhand-assistant]'), null);
});
test('content fill reports rejected ids without values', async t => {
  const page = siteContent(t);
  page.window.SecondHandGeneric.fillFields = () => ({ ok: true, filled: [], skipped: [], rejected: ['sh-1'], pending: [], partial: [], values: { secret: 'private' } });
  const result = await page.requestAsync({ type: 'secondhand:generic:fill', token: 'plan-1', assignments: [], values: {} });
  assert.deepEqual(plain(result), { ok: true, filled: [], skipped: [], rejected: ['sh-1'], partial: [] });
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
test('a fill the page interrupted by changing asks for Autofill again, on the page or in an embedded form', async () => {
  const changed = { ok: false, pageChanged: true, filled: [], skipped: [], rejected: [] };
  const top = siteWorker({ enabled: true });
  top.page.fill = () => changed;
  const embedded = siteWorker({ enabled: true, frames: [secondFrame({ enabled: true, fillResult: changed })] });
  for (const w of [top, embedded]) {
    const { state, message, messageKey } = plain((await autofill(w)).data);
    assert.deepEqual({ state, message, messageKey }, { state: 'error', message: 'The page changed. Click Autofill again.', messageKey: 'worker.pageChangedAutofill' });
  }
});

test('a pending form explains approval before attempting all-frame script execution', async () => {
  const w = siteWorker({ enabled: true, plan: { token: 'empty', lang: 'en', matched: [], unmatched: [] }, frames: [secondFrame()], discoveryError: true });
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
test('disable preserves frame permission and trust while another registration uses it', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  registerOwnedFrame(w);
  const other = 'frame-other.example.org--form.jotform.com';
  registerOwnedFrame(w, other);
  assert.equal((await w.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  assert.deepEqual([...w.registered.keys()], [other]);
  assert.deepEqual([...w.permissions], [`${FRAME_ORIGIN}/*`]);
  assert.deepEqual(w.native.map(({ type, url }) => ({ type, url })), [{ type: 'untrustSite', url: ORIGIN }]);
});
test('autofill without a top receiver asks for reload', async () => {
  const w = siteWorker({ enabled: true, topError: NO_RECEIVER });
  assert.equal((await autofill(w)).data.message, 'Reload this page, then click Autofill.');
  assert.deepEqual(w.native, []);
});

test('each site’s one request serves every fill pass, while the child runs multiple fill passes', async () => {
  const child = secondFrame({ enabled: true, fields: [{ name: 'zip', key: 'zip' }, { name: 'again', key: 'zip', revealedBy: 'zip' }] });
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }], frames: [child] });
  const result = (await autofill(w)).data;
  assert.equal(result.filled, 3);
  assert.deepEqual(child.page.answered(), ['zip', 'again']);
  assert.deepEqual(w.native.filter(call => call.type === 'getFields').map(call => call.url), [`${ORIGIN}/intake`, `${FRAME_ORIGIN}/form`]);
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
const layaDesktop = ({ warming, ...play } = {}) => ({ layaState: 'ready', values: SAVED, warming, laya: {
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
  const w = siteWorker({ enabled: true, clock: { now: 0 }, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }, { ...PET }], desktop: layaDesktop({
    suggestFields: request => { suggestRequest = request; return { suggestions: { [request.fields[0].id]: 'email' } }; } }) });
  const planned = await plan(w);
  assert.equal(planned.laya, true, 'Chrome’s on-device AI stays off');
  assert.deepEqual(w.nativeTypes(), ['warmLaya'], 'planning only readies Laya');
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
  assert.equal(result.message, 'Filled 2 · 1 suggested · 1 need you. Check your answers before you submit. Suggestions came from Laya on this computer.');
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
  assert.equal(result.message, 'Filled 2 · 1 suggested · 1 need you. Check your answers before you submit. Suggestions came from Laya on this computer.');
  assert.deepEqual(w.nativeTypes().filter(type => type !== 'status'), ['warmLaya', 'answerFields', 'getFields'],
    'Laya is readied, answers the choice questions first, and the saved values follow');
  assert.doesNotMatch(JSON.stringify(layaCalls(w)), /Synthetic private|synthetic\.private|50309/, 'no saved value is ever sent to Laya');
});

test('a question whose label hides a zero-width space stays with the applicant, never sent; Laya still answers the others and the click succeeds', async () => {
  const { validateRequest } = require('../desktop/bridge.cjs');
  const DELIVERY = { name: 'delivery', label: `Do you need a home${String.fromCodePoint(0x200B)} delivery?`, type: 'radio', options: ['Yes', 'No'] };
  let answerRequest;
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...SIXTY }, { ...DELIVERY }, { ...PET }], desktop: layaDesktop({
    answerFields: (request, vault) => {
      // The desktop's own check: it refuses the whole request when any question breaks its rules.
      try { validateRequest(request); } catch (error) { return error.message; }
      answerRequest = request;
      return { answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision };
    } }) });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'done', result.message);
  assert.deepEqual(answerRequest.questions.map(question => question.label), [SIXTY.label, PET.label], 'Laya gets every other question');
  assert.deepEqual(w.page.answered(), ['name', 'sixty']);
  assert.deepEqual(result.needYou, [idOf(w, 'delivery'), idOf(w, 'pet')], 'the hidden-character question is left to the applicant');
  assert.equal(result.message, 'Filled 2 · 1 suggested · 2 need you. Check your answers before you submit. Suggestions came from Laya on this computer.');
});

test('answers alone fill under their own access receipt, which is checked before the page is touched', async () => {
  const w = siteWorker({ enabled: true, fields: [{ ...SIXTY }], desktop: layaDesktop({ answerFields: (request, vault) => ({ answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }) }) });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.nativeTypes(), ['status', 'warmLaya', 'answerFields', 'status']);
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
  const suggest = layaCalls(w).find(call => call.type === 'suggestFields');
  const answer = layaCalls(w).find(call => call.type === 'answerFields');
  assert.equal(suggest.fields.length, 40);
  assert.equal(answer.questions.length, 30);
  assert.deepEqual(suggest.fields.map(field => field.label), boxes.slice(0, 40).map(field => field.label));
  assert.deepEqual(answer.questions.map(field => field.label), choices.slice(0, 30).map(field => field.label));
});

test('Laya not ready: the widget’s plan says so after one readiness check, and the click fills exactly as it does without Laya', async () => {
  const today = siteWorker({ enabled: true, fields: openQuestions(), desktop: { values: SAVED } });
  const planned = await plan(today);
  assert.equal(planned.laya, false, 'Chrome’s on-device AI may run');
  assert.deepEqual(today.nativeTypes(), ['warmLaya']);
  const reach = idOf(today, 'reach');
  const guessed = plain((await today.launcher({ type: 'ui:autofill', confirmed: true, guesses: { [reach]: 'email' } })).data);
  assert.deepEqual(today.nativeTypes(), ['warmLaya', 'status', 'status', 'getFields', 'status'], 'custom availability is checked; Laya is not asked again in the same click');
  assert.equal(guessed.guessed, 1);
  assert.equal(guessed.laya, undefined);
  assert.equal(guessed.message, 'Filled 2 · 1 suggested · 2 need you. Check your answers before you submit.');

  const unguessed = siteWorker({ enabled: true, fields: openQuestions(), desktop: { values: SAVED } });
  await plan(unguessed);
  const plain_ = plain((await unguessed.launcher({ type: 'ui:autofill', confirmed: true })).data);
  assert.deepEqual(unguessed.nativeTypes(), ['warmLaya', 'status', 'status', 'getFields', 'status'], 'a fresh plan in the same click does not ask Laya again');
  assert.equal(plain_.message, 'Filled 1 · 3 need you. Check your answers before you submit.');

  const side = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }, { ...SIXTY }], desktop: { values: SAVED } });
  const fromPanel = plain((await autofill(side)).data);
  assert.deepEqual(side.nativeTypes(), ['status', 'warmLaya', 'status', 'getFields', 'status'], 'one "not ready" answer and Laya is left alone for the click');
  assert.equal(fromPanel.message, 'Filled 1 · 2 need you. Check your answers before you submit.');
  // Custom answers can match an otherwise unknown question, so a closed app must be opened to check either path.
  const alone = plain((await autofill(siteWorker({ enabled: true, fields: [{ ...REACH }], desktop: { reachable: false } }))).data);
  assert.equal(alone.state, 'offline');
  assert.equal(alone.message, 'Open the SecondHand app, then click Autofill again.');
  assert.equal((await autofill(siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }], desktop: { reachable: false } }))).data.state, 'offline');
});

test('with Laya ready, the widget never also sends Chrome’s guesses, and a locked vault reads as locked', async () => {
  const w = siteWorker({ enabled: true, fields: openQuestions(), desktop: layaDesktop() });
  await plan(w);
  const refused = plain((await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: { [idOf(w, 'reach')]: 'email' } })).data);
  assert.equal(refused.state, 'error');
  assert.match(refused.message, /couldn’t use the on-device AI/);
  assert.deepEqual(w.nativeTypes(), ['warmLaya']);

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
  assert.deepEqual(layaCalls(w).map(call => [call.type, (call.fields || call.questions).map(item => item.id)]), [['suggestFields', ['f4:sh-1-0']], ['answerFields', ['f4:sh-1-1']]]);
  assert.deepEqual(child.page.answered(), ['reach', 'sixty']);
  assert.equal(result.guessed, 2);
  assert.equal(w.content.find(call => call.type === 'secondhand:generic:fill').frameId, 4);
});

test('the side panel learns whether Laya is ready from the desktop status', async () => {
  for (const [desktop, laya] of [[{}, 'unavailable'], [{ layaState: 'ready' }, 'ready'], [{ layaState: 'off' }, 'off'], [{ layaState: 'downloading' }, 'downloading']]) {
    const w = siteWorker({ enabled: true, desktop });
    assert.deepEqual(plain((await w.panel({ type: 'ui:desktopStatus' })).data), { connected: true, unlocked: true, laya, allSites: false });
  }
  assert.deepEqual(plain((await siteWorker({ desktop: { reachable: false } }).panel({ type: 'ui:desktopStatus' })).data), { connected: false, unlocked: false, laya: 'unavailable', allSites: false });
  const odd = siteWorker({ desktop: { layaState: 'thinking' } });
  assert.equal((await odd.panel({ type: 'ui:desktopStatus' })).ok, false, 'a state SecondHand doesn’t know is an error, not a guess');
});

// A click whose Laya takes `answerMs` for the choice questions and `suggestMs` for the text boxes, on a clock the test runs.
async function timedClick({ answerMs = 0, suggestMs = 0, approvalMs = 0, loadMs = 0 } = {}) {
  const clock = { now: 50000 };
  const budgets = [];
  const w = siteWorker({ enabled: true, clock, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }, { ...SIXTY }], duringGetFields: () => { clock.now += approvalMs; }, desktop: layaDesktop({
    warming: () => { clock.now += loadMs; },
    answerFields: (request, vault) => { budgets.push(['answerFields', request.budgetMs]); clock.now += answerMs; return { answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }; },
    suggestFields: request => { budgets.push(['suggestFields', request.budgetMs]); clock.now += suggestMs; return { suggestions: { [request.fields[0].id]: 'email' } }; } }) });
  return { w, budgets, result: plain((await autofill(w)).data) };
}

test('with a slow Laya, the text boxes are matched first and the choice questions get only what is left of the click’s budget', async () => {
  const slow = await timedClick({ suggestMs: 2200 });
  assert.deepEqual(slow.budgets, [['suggestFields', 3000], ['answerFields', 800]], 'the choice questions get the 0.8 seconds the matches left');
  assert.deepEqual(slow.w.page.answered(), ['name', 'reach', 'sixty']);

  const spent = await timedClick({ suggestMs: 3000 });
  assert.deepEqual(spent.budgets, [['suggestFields', 3000]], 'no time is left to answer the choice question');
  assert.deepEqual(spent.w.page.answered(), ['name', 'reach'], 'the text box is still matched');
  assert.deepEqual(spent.result.needYou, [idOf(spent.w, 'sixty')], 'the choice question stays with the applicant');
  assert.equal(spent.w.nativeTypes().includes('answerFields'), false);
});

test('a long wait in the answers’ own approval prompt never takes the text boxes’ time: they are matched before it', async () => {
  const waited = await timedClick({ answerMs: 20000 });
  assert.deepEqual(waited.budgets, [['suggestFields', 3000], ['answerFields', 3000]]);
  assert.deepEqual(waited.w.page.answered(), ['name', 'reach', 'sixty']);
});

test('Laya that isn’t ready at the click’s first request is asked nothing more in that click', async () => {
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...REACH }, { ...SIXTY }], desktop: { layaState: 'ready', values: SAVED, laya: {
    answerFields: (request, vault) => ({ answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }) } } });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.nativeTypes().filter(type => type !== 'status'), ['warmLaya', 'suggestFields', 'getFields'], 'the text boxes’ request said "not ready", so the choice questions aren’t sent');
  assert.deepEqual(w.page.answered(), ['name']);
  assert.deepEqual(result.needYou, [idOf(w, 'reach'), idOf(w, 'sixty')]);
});

test('Laya gets one three-second budget per click: each request carries what is left, and loading the model and the applicant’s approval time never count', async () => {
  const quick = await timedClick({ suggestMs: 1200, approvalMs: 20000, loadMs: 6000 });
  assert.deepEqual(quick.budgets, [['suggestFields', 3000], ['answerFields', 1800]],
    'loading the model first (6 seconds) and a 20-second approval are not Laya’s time; the matches took 1.2 seconds');
  assert.deepEqual(quick.w.nativeTypes().slice(0, 4), ['status', 'warmLaya', 'suggestFields', 'answerFields'], 'Laya is warmed before the click’s budget starts');
  assert.deepEqual(quick.w.page.answered(), ['name', 'reach', 'sixty']);

  // A new click starts a new budget.
  const again = siteWorker({ enabled: true, clock: { now: 0 }, fields: [{ ...SIXTY }], desktop: layaDesktop() });
  await autofill(again);
  await autofill(again);
  assert.deepEqual(layaCalls(again).map(call => call.budgetMs), [3000, 3000]);
});

test('answers made before getFields’ approval: an Always allow there outdates them, so they aren’t filled; an empty answer changes nothing', async () => {
  const fields = [{ name: 'name', key: 'fullName' }, { ...SIXTY }];
  // Always allow in getFields' prompt moves the access receipt on after Laya answered.
  const bump = vault => { vault.accessRevision++; };
  const outdated = siteWorker({ enabled: true, fields, duringGetFields: () => bump(outdated.vault),
    desktop: layaDesktop({ answerFields: (request, vault) => ({ answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }) }) });
  const refused = plain((await autofill(outdated)).data);
  assert.equal(refused.state, 'error');
  assert.equal(refused.messageKey, 'worker.accessChanged');
  assert.deepEqual(outdated.page.answered(), [], 'nothing is filled from an outdated receipt');

  const nothing = siteWorker({ enabled: true, fields, duringGetFields: () => bump(nothing.vault),
    desktop: layaDesktop({ answerFields: (request, vault) => ({ answers: {}, accessRevision: vault.accessRevision }) }) });
  const filled = plain((await autofill(nothing)).data);
  assert.equal(filled.state, 'done', 'with no answers to fill, their receipt doesn’t matter');
  assert.deepEqual(nothing.page.answered(), ['name']);
});

// "What this page says" on a site that is on: the page's own words and those of each embedded form that is on.
// #185: Laya's best guess on a single-choice question it isn't sure of: filled with its own mark, counted in the summary,
// and listed for the side panel.
const SIZE = { name: 'size', label: 'How many people live in your household?', type: 'radio', options: ['1', '2', '3 or more'] };
const guessingDesktop = (guesses = request => ({ [request.questions.find(question => question.label === SIZE.label).id]: '1' })) => layaDesktop({
  answerFields: (request, vault) => ({ answers: { [request.questions.find(question => question.label === SIXTY.label).id]: 'No' }, guesses: guesses(request), accessRevision: vault.accessRevision }) });

test('#185: Laya’s guess fills a single-choice question with its own mark; the summary says how many Laya guessed, and the side panel gets each one to find', async () => {
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...SIZE }, { ...SIXTY }, { ...PET }], desktop: guessingDesktop() });
  const result = plain((await autofill(w)).data);
  const size = 'f0:sh-1-1';
  assert.deepEqual(w.content.find(call => call.type === 'secondhand:generic:fill').assignments, [{ id: 'sh-1-0', key: 'fullName', guessed: false },
    { id: 'sh-1-2', option: 'No', guessed: true }, { id: 'sh-1-1', option: '1', guessed: true, layaGuess: true }]);
  assert.deepEqual(w.page.fields.map(field => field.mark), ['rule', 'laya-guess', 'guess', undefined]);
  assert.deepEqual([result.filled, result.guessed, result.laya, result.layaGuessed], [3, 1, 1, 1], 'the guess is filled, apart from the sure answer');
  assert.deepEqual(result.layaGuesses, [{ id: size, label: SIZE.label }]);
  assert.deepEqual(result.needYou, [idOf(w, 'pet')]);
  assert.equal(result.message, 'Filled 3 · 1 suggested · 1 need you. Check your answers before you submit. Suggestions came from Laya on this computer. 1 guessed by Laya, check it.');
  assert.equal(result.messageKey, 'result.layaGuessed');
  assert.deepEqual(plain((await w.panel({ type: 'ui:pageState' })).data).result.layaGuesses, [{ id: size, label: SIZE.label }]);
  assert.deepEqual(plain((await w.panel({ type: 'ui:focusField', key: size })).data), { focused: true }, 'the side panel finds it after the fill planned the page again');
  assert.equal(strings.english('result.layaGuessed', { summary: { key: 'result.siteFilled', params: { count: 2 } }, count: 2 }),
    'Filled 2. Check your answers before you submit. 2 guessed by Laya, check them.');
});

test('#185: guesses alone fill under their own access receipt; a desktop from before guesses sends none', async () => {
  const only = layaDesktop({ answerFields: (request, vault) => ({ answers: {}, guesses: { [request.questions[0].id]: '1' }, accessRevision: vault.accessRevision }) });
  const w = siteWorker({ enabled: true, fields: [{ ...SIZE }], desktop: only });
  const result = plain((await autofill(w)).data);
  assert.deepEqual([result.filled, result.guessed, result.laya, result.layaGuessed], [1, 0, undefined, 1]);
  assert.equal(result.message, 'Filled 1. Check your answers before you submit. 1 guessed by Laya, check it.');
  const stale = siteWorker({ enabled: true, fields: [{ ...SIZE }], desktop: layaDesktop({ answerFields: request => ({ answers: {}, guesses: { [request.questions[0].id]: '1' }, accessRevision: 99 }) }) });
  const refused = plain((await autofill(stale)).data);
  assert.equal(refused.state, 'error');
  assert.match(refused.message, /access changed/);
  assert.deepEqual(stale.page.answered(), []);
  const older = siteWorker({ enabled: true, fields: [{ ...SIZE }, { ...SIXTY }], desktop: layaDesktop({ answerFields: (request, vault) => ({ answers: { [request.questions[1].id]: 'No' }, accessRevision: vault.accessRevision }) }) });
  const before = plain((await autofill(older)).data);
  assert.deepEqual([before.filled, before.layaGuessed, before.layaGuesses], [1, undefined, undefined]);
});

test('#185: a guess for a checkbox group, a question outside the request, one Laya also answered, or an option the question lacks fills nothing', async () => {
  const NEEDS = { name: 'needs', label: 'Which of these does your household need?', type: 'checkbox', options: ['Produce', 'Diapers'] };
  const id = (request, label) => request.questions.find(question => question.label === label).id;
  const replies = [
    request => ({ [id(request, NEEDS.label)]: 'Produce' }),
    () => ({ 'f0:sh-9-9': '1' }),
    request => ({ [id(request, SIXTY.label)]: 'Yes' }),
    request => ({ [id(request, SIZE.label)]: '4' }),
    request => ({ [id(request, SIZE.label)]: 1 }),
    () => [],
    () => null
  ];
  for (const guesses of replies) {
    const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...SIZE }, { ...SIXTY }, { ...NEEDS }], desktop: guessingDesktop(guesses) });
    const result = plain((await autofill(w)).data);
    assert.deepEqual([result.state, result.messageKey], ['error', 'worker.layaUnusable'], guesses.toString());
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false, guesses.toString());
    assert.deepEqual(w.page.answered(), []);
  }
});

test('#185: a Spanish question’s guess fills the page’s own option, found by position', async () => {
  const { ai } = workerAI();
  const w = siteWorker({ enabled: true, lang: 'es', ai, fields: [{ ...SIXTY_ES }], desktop: layaDesktop({
    answerFields: (request, vault) => ({ answers: {}, guesses: { [request.questions[0].id]: 'Yes' }, accessRevision: vault.accessRevision }) }) });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.content.find(call => call.type === 'secondhand:generic:fill').assignments, [{ id: 'sh-1-0', option: 'Sí', guessed: true, layaGuess: true }]);
  assert.deepEqual(result.layaGuesses, [{ id: 'f0:sh-1-0', label: SIXTY_ES.label }], 'the side panel lists it in the page’s own words');
});

test('#185: the guess list holds the reload, as the need-you list does', async () => {
  const w = updating({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...SIZE }], desktop: { ...layaDesktop({
    answerFields: (request, vault) => ({ answers: {}, guesses: { [request.questions[0].id]: '1' }, accessRevision: vault.accessRevision }) }), extension: UPDATE } });
  assert.equal(plain((await autofill(w)).data).layaGuessed, 1);
  await statusRow(w);
  assert.equal(w.reloads(), 0, 'Laya’s guess is still to check');
  w.events.updated(7, { status: 'loading' });
  await statusRow(w);
  assert.equal(w.reloads(), 1);
});

const sitePoints = { language: 'en', points: ['Bring a photo ID.'], english: false };

test('a site’s page text is its own words, then each embedded form’s that is on; a form that is off is never read', async () => {
  const w = siteWorker({ enabled: true, pageText: { lang: 'en-US', text: 'Riverbend pantry sign-up.\nBring a photo ID.' }, frames: [
    { origin: FRAME_ORIGIN, frameId: 4, enabled: true, pageText: { lang: 'en', text: 'Pickup is on Fridays.' } },
    { origin: 'https://other.example.org', frameId: 5, pageText: { lang: 'en', text: 'Synthetic words that are never read.' } }] });
  const reply = await w.panel({ type: 'ui:pageText' });
  assert.equal(reply.ok, true, reply.error);
  const id = reply.data.pages[0]?.id;
  assert.deepEqual(plain(reply.data), { pages: [{ id, pageKey: 'general', lang: 'en-US', current: true, text: 'Riverbend pantry sign-up.\nBring a photo ID.\nPickup is on Fridays.', unread: false, summary: null }] });
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:pageText').map(call => call.frameId), [0, 4]);
  assert.deepEqual(w.native, [], 'reading a page never reaches the desktop');
  assert.deepEqual(plain((await w.panel({ type: 'ui:keepSummary', id, summary: sitePoints })).data), { kept: true });
  assert.deepEqual(plain((await w.launcher({ type: 'ui:pageState' })).data.summary), { language: 'en', point: 'Bring a photo ID.', english: false });
  assert.deepEqual(plain((await w.panel({ type: 'ui:pageText' })).data.pages[0].summary), sitePoints, 'the same words at the same address keep their points');
  const off = await siteWorker({ pageText: { lang: 'en', text: 'Synthetic words.' } }).panel({ type: 'ui:pageText' });
  assert.equal(off.ok, false, 'a site that is not on is never read');
  assert.equal(off.errorKey, 'worker.turnOnSiteFirst');
});

test('a site’s page text stops at the most one page sends, and a reply that is not text fails loudly', async () => {
  const long = siteWorker({ enabled: true, pageText: { lang: 'en', text: `${'A'.repeat(9000)}\n${'B'.repeat(6000)}` }, frames: [
    { origin: FRAME_ORIGIN, frameId: 4, enabled: true, pageText: { lang: 'en', text: `${'C'.repeat(500)}\n${'D'.repeat(2000)}` } }] });
  const text = (await long.panel({ type: 'ui:pageText' })).data.pages[0].text;
  assert.equal(text, `${'A'.repeat(9000)}\n${'B'.repeat(6000)}\n${'C'.repeat(500)}`, 'whole lines while they fit');
  const odd = await siteWorker({ enabled: true, pageText: { lang: 'en', text: 7 } }).panel({ type: 'ui:pageText' });
  assert.equal(odd.errorKey, 'worker.pageTextUnreadable');
  const empty = await siteWorker({ enabled: true }).panel({ type: 'ui:pageText' });
  assert.deepEqual(plain(empty.data), { pages: [] }, 'a page without words has nothing to summarize');
});

test('after an update, site registrations from an older version load the page reader too', async () => {
  const w = siteWorker({ enabled: true, frames: [{ origin: FRAME_ORIGIN, frameId: 4, enabled: true }] });
  for (const script of w.registered.values()) script.js = ['generic-adapter.js', 'generic-content.js'];
  w.events.installed({ reason: 'chrome_update' }); await settle();
  assert.equal(w.log.includes('scripting.updateContentScripts'), false, 'only SecondHand’s own update refreshes them');
  w.events.installed({ reason: 'update' }); await settle();
  assert.deepEqual([...w.registered.values()].map(script => [script.id, script.js]), [[SCRIPT_ID, SITE_SCRIPT.js], ['frame-pantry.example.org--form.jotform.com', SITE_SCRIPT.js]]);
  const log = w.log.length;
  w.events.installed({ reason: 'update' }); await settle();
  assert.equal(w.log.slice(log).includes('scripting.updateContentScripts'), false, 'current registrations are left alone');
});

test('the site widget grows by one row while it shows a message, when the worker asks for our extension', t => {
  const page = siteContent(t);
  assert.deepEqual(plain(page.request({ type: 'secondhand:widgetSize', line: true })), { sized: true });
  assert.equal(page.host().style.height, '86px');
  assert.deepEqual(plain(page.request({ type: 'secondhand:widgetSize', line: false })), { sized: true });
  assert.equal(page.host().style.height, '46px');
  assert.equal(page.request({ type: 'secondhand:widgetSize', line: true }, { id: 'b'.repeat(32) }), undefined, 'another extension gets nothing');
  assert.equal(page.host().style.height, '46px');
});

test('the site widget frame is as wide as the widget measured itself, never past 272px', t => {
  const page = siteContent(t);
  assert.match(page.host().style.width, /^min\(272px/);
  assert.deepEqual(plain(page.request({ type: 'secondhand:widgetSize', line: false, width: 152 })), { sized: true });
  assert.match(page.host().style.width, /^min\(152px, 272px/, 'never wider than the full card');
  page.request({ type: 'secondhand:widgetSize', line: true, width: 231 });
  assert.match(page.host().style.width, /^min\(231px/, 'a line keeps the widget’s width');
  assert.equal(page.host().style.height, '86px');
  page.request({ type: 'secondhand:widgetSize', line: false });
  assert.match(page.host().style.width, /^min\(272px/, 'a widget that could not measure itself gets the full card');
  for (const width of [0, 1.5, '152', 5000]) assert.equal(page.request({ type: 'secondhand:widgetSize', line: false, width }), undefined, `width ${width}`);
  assert.match(page.host().style.width, /^min\(272px/);
});

test('the site widget frame is as tall as its line needs, up to 110px, and narrow on a narrow page', t => {
  const page = siteContent(t);
  const size = { type: 'secondhand:widgetSize', line: true, width: 272, height: 108, narrowWidth: 133, narrowHeight: 140 };
  assert.deepEqual(plain(page.request(size)), { sized: true });
  assert.match(page.host().style.width, /^min\(272px/);
  assert.equal(page.host().style.height, '108px');
  Object.defineProperty(page.window, 'innerWidth', { value: 400, configurable: true });
  page.window.dispatchEvent(new page.window.Event('resize'));
  assert.match(page.host().style.width, /^min\(133px, 272px/);
  assert.equal(page.host().style.height, '110px', 'never taller than 110px');
  page.request({ type: 'secondhand:widgetSize', line: false, width: 133 });
  assert.equal(page.host().style.height, '46px');
  for (const key of ['height', 'narrowWidth', 'narrowHeight']) assert.equal(page.request({ ...size, [key]: 5000 }), undefined, key);
});

test('a site frame answers the page-text request with its declared language and its words, never an answer, for our extension only', t => {
  const page = siteContent(t);
  const doc = page.window.document;
  doc.documentElement.lang = 'en';
  doc.body.insertAdjacentHTML('afterbegin', '<p>Bring a photo ID to pickup.</p>');
  doc.getElementById('name').value = 'Synthetic private name';
  layout(doc);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:pageText' })), { lang: 'en', text: 'Bring a photo ID to pickup.\nYour name\nPickup day' });
  assert.equal(page.request({ type: 'secondhand:generic:pageText' }, { id: 'b'.repeat(32) }), undefined, 'another extension gets nothing');
  delete page.window.SecondHandPageText;
  assert.equal(page.request({ type: 'secondhand:generic:pageText' }).ok, false, 'without its page reader the frame says so');
});

// SecondHand on all websites.
const OTHER_URL = 'https://never.example.net/apply';
const OTHER = 'https://never.example.net';
const allSitesOn = w => w.panel({ type: 'ui:enableAllSites', confirmed: true });
const allSitesOff = w => w.panel({ type: 'ui:disableAllSites', confirmed: true });

test('turning on all websites registers one script only after Chrome and the app both approve, and loads it in the open page', async () => {
  const w = siteWorker({ url: OTHER_URL, allGranted: true });
  const response = await allSitesOn(w);
  assert.equal(response.ok, true, response.error);
  assert.equal(response.data.enabled, true);
  assert.equal(response.data.messageKey, 'worker.allSitesOn');
  const steps = ['permissions.contains', 'native:trustAllSites', 'scripting.registerContentScripts', 'scripting.executeScript'];
  assert.deepEqual(w.log.filter(name => steps.includes(name)), steps);
  assert.equal(w.log.includes('permissions.request'), false, 'only the side panel asks Chrome, inside the click');
  assert.deepEqual(w.native.map(({ type }) => type), ['trustAllSites']);
  assert.deepEqual(Object.keys(w.native[0]).sort(), ['id', 'type'], 'nothing about the page reaches the app');
  assert.deepEqual([...w.registered.values()], [ALL_SCRIPT]);
  assert.deepEqual(w.injected, [{ target: { tabId: 7, allFrames: true }, files: SITE_SCRIPT.js }]);

  const again = await allSitesOn(w);
  assert.equal(again.ok, true, again.error);
  assert.deepEqual([...w.registered.keys()], ['site-all'], 'turning it on twice keeps one registration');
  const iowa = siteWorker({ url: `${adapter.PORTAL}/applyForBenefits/welcome`, allGranted: true });
  assert.equal((await allSitesOn(iowa)).ok, true);
  assert.deepEqual(iowa.injected, [], 'Iowa’s portal keeps its own scripts');
});

test('only a confirmed side-panel request turns on all websites, and only with Chrome’s access', async () => {
  const w = siteWorker({ allGranted: true });
  assert.equal(await w.panel({ type: 'ui:enableAllSites' }), undefined);
  assert.equal(await w.launcher({ type: 'ui:enableAllSites', confirmed: true }), undefined);
  assert.equal(await w.send({ type: 'ui:enableAllSites', confirmed: true }, { id: 'testextension', url: SITE_URL, tab: { id: 7, url: SITE_URL }, frameId: 0 }), undefined);
  assert.equal(await w.launcher({ type: 'ui:disableAllSites', confirmed: true }), undefined);
  assert.deepEqual(w.native, []);
  const noAccess = siteWorker();
  const refused = await allSitesOn(noAccess);
  assert.equal(refused.ok, false);
  assert.equal(refused.errorKey, 'worker.chromeNotAllowedAllSites');
  assert.deepEqual(noAccess.native, []);
  assert.equal(noAccess.registered.size, 0);
});

const CHROME_STILL = 'Chrome still lists SecondHand’s access to all websites, but nothing uses it. To remove it, open chrome://extensions, then SecondHand, then Details, then Site access.';
test('when the app declines all websites or can’t be reached, nothing is registered or trusted, Chrome’s grant is left alone, and the panel says the app didn’t approve', async () => {
  const w = siteWorker({ url: OTHER_URL, allGranted: true, desktop: { trustAllError: 'You cancelled trusting all websites.' } });
  const declined = await allSitesOn(w);
  assert.equal(declined.ok, false);
  assert.equal(declined.error, `The SecondHand app did not approve all websites. You cancelled trusting all websites. ${CHROME_STILL}`);
  assert.equal(w.log.includes('permissions.remove'), false);
  assert.equal(w.permissions.has(ALL), true);
  assert.equal(w.iowa.held, true, 'Iowa’s site is never touched');
  assert.equal(w.registered.size, 0);
  assert.deepEqual(w.injected, []);
  assert.equal(w.vault.allSites, false);
  assert.equal(plain((await w.panel({ type: 'ui:pageState' })).data).site.enabled, false);
  const closed = siteWorker({ url: OTHER_URL, allGranted: true, desktop: { reachable: false } });
  const unreachable = await allSitesOn(closed);
  assert.match(unreachable.error, /^The SecondHand app did not approve all websites\. Cannot reach SecondHand\./);
  assert.equal(closed.registered.size, 0);
  assert.equal(closed.permissions.has(ALL), true);
  // A site turned on by itself stays on.
  const site = siteWorker({ enabled: true, allGranted: true, desktop: { trustAllError: 'You cancelled trusting all websites.' } });
  assert.equal((await allSitesOn(site)).ok, false);
  assert.deepEqual([...site.registered.keys()], [SCRIPT_ID]);
  assert.equal(plain((await site.panel({ type: 'ui:pageState' })).data).site.enabled, true);
  const odd = siteWorker({ allGranted: true, desktop: { trustAllReply: { allSites: 'maybe' } } });
  assert.match((await allSitesOn(odd)).error, /^The SecondHand app did not approve all websites\./);
  assert.equal(odd.registered.size, 0);
});

test('siteEnabled is true for any https origin while all websites is on, and the page fills from one desktop request', async () => {
  const w = siteWorker({ url: OTHER_URL, allSites: true });
  const state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.deepEqual(state.site, { origin: OTHER, enabled: true, frames: [], ready: true });
  const response = await autofill(w);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(w.nativeTypes(), ['status', 'getFields', 'status']);
  assert.equal(w.native[1].url, `${OTHER}/apply`);
  assert.equal(response.data.state, 'done');
  // Embedded forms are covered too: no second approval.
  const framed = siteWorker({ url: OTHER_URL, allSites: true, frames: [secondFrame()] });
  assert.deepEqual(plain((await framed.panel({ type: 'ui:pageState' })).data.site.frames), [{ origin: FRAME_ORIGIN, enabled: true }]);
  // Iowa's portal stays Iowa's.
  const iowa = siteWorker({ url: `${adapter.PORTAL}/applyForBenefits/welcome`, allSites: true });
  assert.equal(iowa.registered.has('site-all'), true);
  const off = siteWorker({ url: OTHER_URL });
  assert.equal(plain((await off.panel({ type: 'ui:pageState' })).data).site.enabled, false);
});

test('turning off all websites unregisters its script, takes the card off pages no longer on, tells the app, and leaves Chrome’s grant and Iowa alone', async () => {
  const pantryTab = { id: 7, active: true, url: SITE_URL };
  const otherTab = { id: 8, active: false, url: OTHER_URL };
  const iowaTab = { id: 9, active: false, url: `${adapter.PORTAL}/applyForBenefits/welcome` };
  const w = siteWorker({ enabled: true, allSites: true, openTabs: [pantryTab, otherTab, iowaTab] });
  assert.equal(await w.panel({ type: 'ui:disableAllSites' }), undefined);
  const response = await allSitesOff(w);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { enabled: false, message: `SecondHand is off on other websites. Sites you turned on one at a time stay on. ${CHROME_STILL}`,
    messageKey: 'joined', messageParams: { first: { key: 'worker.allSitesOff', params: {} }, second: { key: 'worker.chromeStillAllows', params: {} } } });
  assert.equal(w.registered.has('site-all'), false);
  assert.deepEqual([...w.registered.keys()], [SCRIPT_ID], 'the site turned on by itself keeps its registration');
  assert.equal(w.log.includes('permissions.remove'), false, 'Chrome’s grant is kept, unused');
  assert.equal(w.permissions.has(ALL), true);
  assert.equal(w.iowa.held, true, 'Iowa’s site is never touched');
  assert.deepEqual(w.nativeTypes(), ['untrustAllSites']);
  // The card leaves every open page that is no longer on. The site turned on by itself keeps it; Iowa's portal has its own.
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:off').map(call => call.tabId), [8]);
  assert.equal(plain((await w.panel({ type: 'ui:pageState' })).data).site.enabled, true, 'the site turned on by itself stays on');

  // With Chrome's grant already removed in Chrome's settings, there is nothing to say about it.
  const removed = siteWorker({ allSites: true });
  removed.permissions.delete(ALL);
  assert.equal((await allSitesOff(removed)).data.message, 'SecondHand is off on other websites. Sites you turned on one at a time stay on.');

  const appClosed = siteWorker({ allSites: true, desktop: { untrustError: 'The request could not be completed.' } });
  const closed = await allSitesOff(appClosed);
  assert.equal(closed.ok, false);
  assert.match(closed.error, /^SecondHand is off on other websites in Chrome, but the app couldn’t be told/);
  assert.equal(appClosed.registered.size, 0, 'Chrome’s side is off even when the app can’t be reached');
});

test('with Chrome’s grant kept and all websites off, a site the app doesn’t trust gets no script, no fill, and no app data', async () => {
  const w = siteWorker({ url: OTHER_URL, allGranted: true, desktop: { refuseUntrusted: true } });
  assert.equal(w.registered.size, 0, 'no registration: Chrome puts no script and no card on the page');
  assert.equal(plain((await w.panel({ type: 'ui:pageState' })).data).site.enabled, false);
  assert.equal((await autofill(w)).errorKey, 'worker.turnOnSiteFirst');
  for (const type of ['ui:questions', 'ui:pageText']) assert.equal((await w.panel({ type })).ok, false, type);
  assert.equal((await w.launcher({ type: 'ui:autofill', confirmed: true })).errorKey, 'worker.turnOnSiteFirst');
  assert.equal(await w.send({ type: 'secondhand:generic:form', helps: true }, { id: 'testextension', url: OTHER_URL, frameId: 0, tab: { id: 7, url: OTHER_URL } }), undefined);
  assert.deepEqual(w.native, [], 'nothing is asked of the app');
  assert.deepEqual(w.content, [], 'nothing is asked of the page');
  // The app's own gate holds even if a request got through: an untrusted site gets nothing while all websites is off.
  w.registered.set('site-all', structuredClone(ALL_SCRIPT));
  const refused = await autofill(w);
  assert.equal(refused.data.message, 'This site isn’t trusted. Turn on SecondHand for it first.');
  assert.deepEqual(w.page.answered(), []);
});

test('turning all websites back on needs no second Chrome prompt: the grant is kept', async () => {
  const w = siteWorker({ url: OTHER_URL, allGranted: true });
  for (let round = 0; round < 2; round++) {
    assert.equal((await allSitesOn(w)).ok, true, `on ${round}`);
    assert.equal(w.registered.has('site-all'), true);
    assert.equal((await allSitesOff(w)).ok, true, `off ${round}`);
    assert.equal(w.registered.has('site-all'), false);
  }
  assert.deepEqual(w.nativeTypes(), ['trustAllSites', 'untrustAllSites', 'trustAllSites', 'untrustAllSites']);
  assert.equal(w.log.includes('permissions.request'), false);
  assert.equal(w.log.includes('permissions.remove'), false);
});

test('when the app turns off all websites, the extension turns them off at its next desktop request', async () => {
  const w = siteWorker({ url: OTHER_URL, allSites: true });
  w.vault.allSites = false;
  const status = plain((await w.panel({ type: 'ui:desktopStatus' })).data);
  assert.equal(status.allSites, false);
  assert.equal(w.registered.has('site-all'), false);
  assert.equal(w.permissions.has(ALL), true, 'Chrome’s grant is kept, unused');
  assert.equal(plain((await w.panel({ type: 'ui:pageState' })).data).site.enabled, false);
  assert.deepEqual(w.nativeTypes(), ['status'], 'the app already turned itself off');

  // A click already under way: the app refuses a site it no longer trusts, and nothing is filled.
  const filling = siteWorker({ url: OTHER_URL, allSites: true, desktop: { refuseUntrusted: true } });
  filling.vault.allSites = false;
  const refused = await autofill(filling);
  assert.equal(refused.data.state, 'error');
  assert.equal(refused.data.message, 'This site isn’t trusted. Turn on SecondHand for it first.');
  assert.equal(filling.registered.has('site-all'), false);
  assert.deepEqual(filling.page.answered(), []);
});

test('the side panel learns from the desktop status whether all websites is on, never from Chrome’s grant alone', async () => {
  assert.deepEqual(plain((await siteWorker({ allSites: true }).panel({ type: 'ui:desktopStatus' })).data), { connected: true, unlocked: true, laya: 'unavailable', allSites: true });
  assert.deepEqual(plain((await siteWorker().panel({ type: 'ui:desktopStatus' })).data), { connected: true, unlocked: true, laya: 'unavailable', allSites: false });
  assert.equal((await siteWorker({ allGranted: true }).panel({ type: 'ui:desktopStatus' })).data.allSites, false, 'a kept grant without the registration is off');
  const closed = siteWorker({ allSites: true, desktop: { reachable: false } });
  assert.deepEqual(plain((await closed.panel({ type: 'ui:desktopStatus' })).data), { connected: false, unlocked: false, laya: 'unavailable', allSites: true },
    'with the app closed, Chrome’s side is still known');
});

test('a site turned on by itself can’t be turned off while all websites covers it', async () => {
  const w = siteWorker({ enabled: true, allSites: true });
  const refused = await w.panel({ type: 'ui:disableSite', confirmed: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.errorKey, 'worker.allSitesCoverSite');
  assert.deepEqual([...w.registered.keys()], [SCRIPT_ID, 'site-all']);
  assert.equal(w.permissions.has(ALL), true);
});

test('a host named "all" can’t take the all-websites registration', async () => {
  const w = siteWorker({ url: 'https://all/form', allSites: true });
  assert.equal((await w.panel({ type: 'ui:enableSite', confirmed: true })).ok, false);
  assert.equal((await w.panel({ type: 'ui:disableSite', confirmed: true })).ok, false);
  assert.deepEqual([...w.registered.values()], [ALL_SCRIPT]);
});

test('an embedded form tells the top frame to show the card, with a yes or no only', async () => {
  const w = siteWorker({ url: OTHER_URL, allSites: true, frames: [secondFrame()] });
  const report = (helps, frameId, url) => w.send({ type: 'secondhand:generic:form', helps }, { id: 'testextension', url, frameId, tab: { id: 7, url: OTHER_URL } });
  assert.deepEqual(plain(await report(false, 0, OTHER_URL)), { frames: false });
  assert.deepEqual(plain(await report(true, 4, `${FRAME_ORIGIN}/form`)), { frames: true });
  assert.deepEqual(w.content.at(-1), { tabId: 7, frameId: 0, type: 'secondhand:generic:formFrames', helps: true });
  assert.deepEqual(plain(await report(false, 0, OTHER_URL)), { frames: true }, 'a top frame that loads later asks');
  await report(false, 4, `${FRAME_ORIGIN}/form`);
  assert.deepEqual(w.content.at(-1), { tabId: 7, frameId: 0, type: 'secondhand:generic:formFrames', helps: false });
  await report(true, 4, `${FRAME_ORIGIN}/form`);
  w.events.updated(7, { status: 'loading' });
  assert.deepEqual(plain(await report(false, 0, OTHER_URL)), { frames: false }, 'a new page starts over');
  assert.equal(await report('yes', 4, `${FRAME_ORIGIN}/form`), undefined);
  assert.equal(await w.send({ type: 'secondhand:generic:form', helps: true }, { id: 'other', url: OTHER_URL, frameId: 0, tab: { id: 7, url: OTHER_URL } }), undefined);
  const off = siteWorker({ url: OTHER_URL });
  assert.equal(await off.send({ type: 'secondhand:generic:form', helps: true }, { id: 'testextension', url: OTHER_URL, frameId: 0, tab: { id: 7, url: OTHER_URL } }), undefined, 'a site that is off gets no answer');
  assert.deepEqual([...w.native, ...off.native], [], 'nothing reaches the desktop');
});

// #157: Chrome stops an idle worker and starts it again for the next event. Which embedded frames have a form was in its
// memory only, so the new worker asks the tab's frames again before it counts a report, and the top page's card stays right.
const SECOND_FORM_ORIGIN = 'https://forms.example.com';
function formReporter(w) {
  const report = (frame, helps) => w.send({ type: 'secondhand:generic:form', helps },
    { id: 'testextension', url: frame ? `${frame.origin}/form` : w.tab.url, frameId: frame ? frame.frameId : 0, tab: { id: 7, url: w.tab.url } });
  // What the worker last told the top page: whether a form in one of its frames shows the card.
  const card = () => w.content.filter(call => call.type === 'secondhand:generic:formFrames').at(-1)?.helps;
  const asked = () => w.content.filter(call => call.type === 'secondhand:generic:helps').map(call => [call.frameId, call.documentId]);
  return { report, card, asked };
}

test('after a worker restart, the card goes when the last embedded form does, and stays while another is there', async () => {
  const one = secondFrame({ helps: true });
  const w = siteWorker({ url: OTHER_URL, allSites: true, frames: [one] });
  const { report, card, asked } = formReporter(w);
  w.events.updated(7, { status: 'loading' });
  await report(one, true);
  assert.equal(card(), true);
  w.restart();
  one.helps = false;
  assert.deepEqual(plain(await report(one, false)), { frames: false });
  assert.equal(card(), false, 'the form is gone: so is the card');
  assert.deepEqual(asked(), [[4, 'doc-4']], 'the frame is asked in the document Chrome placed');

  // Two embedded forms; after the restart a third frame's form comes and goes. The first is still there.
  const first = secondFrame({ helps: true }), second = { origin: SECOND_FORM_ORIGIN, frameId: 5 };
  const two = siteWorker({ url: OTHER_URL, allSites: true, frames: [first, second] });
  const forms2 = formReporter(two);
  two.events.updated(7, { status: 'loading' });
  await forms2.report(first, true);
  two.restart();
  second.helps = true;
  assert.deepEqual(plain(await forms2.report(second, true)), { frames: true });
  second.helps = false;
  assert.deepEqual(plain(await forms2.report(second, false)), { frames: true });
  assert.equal(forms2.card(), true, 'the first form still shows the card');
  assert.deepEqual(forms2.asked(), [[4, 'doc-4'], [5, 'doc-5']], 'asked once, after the restart');
  assert.deepEqual([...w.native, ...two.native], [], 'nothing reaches the desktop');
});

test('after a worker restart, a top page that asks hears about forms already in its frames, and reports that come together share one check', async () => {
  const one = secondFrame({ helps: true }), other = { origin: SECOND_FORM_ORIGIN, frameId: 5, helps: true };
  const w = siteWorker({ url: OTHER_URL, allSites: true, frames: [one, other] });
  const { report, card, asked } = formReporter(w);
  w.events.updated(7, { status: 'loading' });
  await report(one, true);
  await report(other, true);
  w.restart();
  assert.deepEqual(plain(await report(null, false)), { frames: true }, 'the top page asks, as when SecondHand is turned on for an open page');
  w.restart();
  one.helps = false; other.helps = false;
  const sent = asked().length;
  await Promise.all([report(one, false), report(other, false)]);
  assert.deepEqual(asked().slice(sent), [[4, 'doc-4'], [5, 'doc-5']], 'each frame is asked once');
  assert.equal(card(), false);
  // A page that loads after a restart starts over: its frames report as they load, and nothing is asked.
  w.restart();
  w.events.updated(7, { status: 'loading' });
  const before = asked().length;
  assert.deepEqual(plain(await report(null, false)), { frames: false });
  assert.equal(asked().length, before);
});

test('after a worker restart, a report that waited while the tab loaded another page counts for nothing there', async () => {
  let answer;
  const one = secondFrame({ helps: true, answering: new Promise(resolve => { answer = resolve; }) });
  const w = siteWorker({ url: OTHER_URL, allSites: true, frames: [one] });
  const { report, card } = formReporter(w);
  w.restart();
  const old = report(one, true);
  await settle();
  w.events.updated(7, { status: 'loading' });
  answer();
  assert.deepEqual(plain(await old), { frames: false });
  assert.equal(card(), undefined, 'the new page isn’t told about the old page’s form');
  assert.deepEqual(plain(await report(null, false)), { frames: false }, 'the new page’s frames report as they load');
});

test('after a worker restart, only frames on sites that are on are asked about their forms, and one turned off counts for none', async () => {
  const pantry = secondFrame({ enabled: true, helps: true }), ads = { origin: 'https://ads.example.com', frameId: 6, helps: true };
  const quiet = { origin: SECOND_FORM_ORIGIN, frameId: 5, enabled: true, helps: true, off: true };
  const w = siteWorker({ enabled: true, frames: [pantry, ads, quiet] });
  const { report, card, asked } = formReporter(w);
  w.events.updated(7, { status: 'loading' });
  await report(pantry, true);
  w.restart();
  pantry.helps = false;
  assert.deepEqual(plain(await report(pantry, false)), { frames: false });
  assert.equal(card(), false, 'a frame of a site that is off never shows the card');
  assert.deepEqual(asked(), [[4, 'doc-4'], [5, 'doc-5']]);
  assert.equal(w.content.some(call => call.frameId === 6), false);
});

// #178: a report the worker can't count is answered with its error, in the shape of every other error reply.
const PORT_CLOSED = 'The message port closed before a response was received.';
const detailReply = text => ({ ok: false, error: text, errorKey: 'detail', errorParams: { detail: text } });
test('a report the worker can’t count is answered with its usual error: the top page fails its message, or the check of the tab’s frames fails (#178)', async () => {
  const one = secondFrame({ helps: true });
  const refused = siteWorker({ url: OTHER_URL, allSites: true, frames: [one], formFramesError: PORT_CLOSED });
  refused.events.updated(7, { status: 'loading' });
  assert.deepEqual(plain(await formReporter(refused).report(one, true)), detailReply(PORT_CLOSED));

  // A restarted worker that can't ask the tab's frames counts neither the top page's report nor an embedded frame's.
  const unchecked = siteWorker({ url: OTHER_URL, allSites: true, frames: [one], discoveryError: true });
  const { report, card } = formReporter(unchecked);
  assert.deepEqual(plain(await report(null, false)), detailReply('Cannot access an unapproved frame'));
  assert.deepEqual(plain(await report(one, true)), detailReply('Cannot access an unapproved frame'));
  assert.equal(card(), undefined, 'the top page is told nothing');
  assert.deepEqual([...refused.native, ...unchecked.native], [], 'nothing reaches the desktop');
});

// #137: saved answers for a form embedded from another site are asked for in that site's name, the address Chrome
// gives for the frame, and each site's answers are approved and filled apart.
const EMBED_URL = `${FRAME_ORIGIN}/pantry-signup`;
const requestsOf = w => w.native.filter(call => !['status', 'warmLaya'].includes(call.type))
  .map(call => [call.type, call.url, (call.fields || call.questions).map(item => typeof item === 'string' ? item : item.id)]);

test('with all websites on, an embedded form’s saved answers are asked for in its own site’s name, from the address Chrome gives, never the page around it', async () => {
  // The embedded page says it is the host page; Chrome says where it is.
  const child = secondFrame({ url: `${EMBED_URL}?visit=synthetic#form`, claims: OTHER, fields: [{ name: 'zip', key: 'zip' }, { name: 'size', key: 'householdSize' }] });
  const w = siteWorker({ url: OTHER_URL, allSites: true, fields: [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip' }], frames: [child], desktop: { values: SAVED } });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'done', result.message);
  assert.equal(result.filled, 4);
  assert.deepEqual(requestsOf(w), [['getFields', OTHER_URL, ['firstName', 'lastName', 'zip']], ['getFields', EMBED_URL, ['zip', 'householdSize']]],
    'one request for each site, naming the site that gets its answers');
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:fill').map(call => [call.frameId, Object.keys(call.values)]), [[0, ['fullName', 'zip']], [4, ['zip', 'householdSize']]]);
  assert.deepEqual(w.page.answered(), ['name', 'zip']);
  assert.deepEqual(child.page.answered(), ['zip', 'size']);
});

test('each site’s answers are approved apart: the host page’s approval never covers its embedded form, and a refusal for the form fills nothing', async () => {
  for (const desktop of [{ cancelOrigin: FRAME_ORIGIN }, { trusted: [ORIGIN] }]) {
    const child = secondFrame({ enabled: true, fields: [{ name: 'zip', key: 'zip' }] });
    const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }], frames: [child], desktop });
    const result = plain((await autofill(w)).data);
    assert.equal(result.state, 'error', JSON.stringify(desktop));
    assert.match(result.message, desktop.trusted ? /isn’t trusted/ : /^Cancelled/);
    assert.deepEqual(requestsOf(w), [['getFields', `${ORIGIN}/intake`, ['firstName', 'lastName']], ['getFields', `${FRAME_ORIGIN}/form`, ['zip']]]);
    assert.equal(w.contentTypes().includes('secondhand:generic:fill'), false, 'nothing is filled, not even on the host page');
    assert.deepEqual([...w.page.answered(), ...child.page.answered()], []);
  }
});

test('Laya is asked about each site’s questions in that site’s name: every site’s text boxes first, then its choice questions, within the click’s one budget', async () => {
  const budgets = [];
  const child = secondFrame({ enabled: true, fields: [{ ...REACH }, { ...SIXTY }] });
  const w = siteWorker({ enabled: true, fields: [{ ...REACH }, { ...SIXTY }], frames: [child], desktop: layaDesktop({
    suggestFields: request => { budgets.push(request.budgetMs); return { suggestions: Object.fromEntries(request.fields.map(field => [field.id, 'email'])) }; },
    answerFields: (request, vault) => { budgets.push(request.budgetMs); return { answers: Object.fromEntries(request.questions.map(question => [question.id, 'No'])), accessRevision: vault.accessRevision }; } }) });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'done', result.message);
  assert.deepEqual(requestsOf(w), [
    ['suggestFields', `${ORIGIN}/intake`, ['f0:sh-1-0']], ['suggestFields', `${FRAME_ORIGIN}/form`, ['f4:sh-1-0']],
    ['answerFields', `${ORIGIN}/intake`, ['f0:sh-1-1']], ['answerFields', `${FRAME_ORIGIN}/form`, ['f4:sh-1-1']],
    ['getFields', `${ORIGIN}/intake`, ['email']], ['getFields', `${FRAME_ORIGIN}/form`, ['email']]]);
  assert.equal(budgets.length, 4);
  assert.ok(budgets.every((budget, index) => budget <= 3000 && (index === 0 || budget <= budgets[index - 1])), 'the requests share the click’s budget');
  assert.deepEqual(w.page.answered(), ['reach', 'sixty']);
  assert.deepEqual(child.page.answered(), ['reach', 'sixty']);
});

test('a frame is placed by the address Chrome gives with its message, never by what its page says: one claiming the host page’s address gets nothing', async () => {
  const impostor = { origin: 'https://impostor.example.net', frameId: 6, claims: ORIGIN, fields: [{ name: 'zip', key: 'zip' }] };
  const w = siteWorker({ enabled: true, frames: [impostor] });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'done', result.message);
  assert.equal(w.content.some(call => call.frameId === 6), false, 'a frame on a site that is off is never asked');
  assert.deepEqual(impostor.page.answered(), []);
  assert.deepEqual(requestsOf(w), [['getFields', `${ORIGIN}/intake`, ['firstName', 'lastName', 'zip', 'householdSize']]]);
});

test('answers go only to the document Chrome placed: an embedded form that moves to another site after its approval gets nothing', async () => {
  const child = secondFrame({ enabled: true, fields: [{ name: 'zip', key: 'zip' }] });
  const away = { origin: 'https://elsewhere.example.net', url: 'https://elsewhere.example.net/form', documentId: 'doc-4-later' };
  const w = siteWorker({ url: OTHER_URL, allSites: true, fields: [], frames: [child],
    duringGetFields: (_tab, request) => { if (request.url.startsWith(FRAME_ORIGIN)) Object.assign(child, away); } });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'error');
  assert.equal(result.messageKey, 'worker.frameUnsafe');
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:fill').map(call => [call.frameId, call.documentId]), [[4, 'doc-4']], 'the fill was for the document Chrome placed');
  assert.deepEqual(child.page.answered(), [], 'nothing reaches the page now in that frame');

  // The widget's planned click: a frame whose document changed between the plan and the click is refused before anything is asked.
  const planned = secondFrame({ enabled: true, fields: [{ ...REACH }] });
  const g = siteWorker({ enabled: true, fields: [], frames: [planned], desktop: { values: SAVED } });
  await plan(g);
  planned.documentId = 'doc-4-later';
  const refused = plain((await g.launcher({ type: 'ui:autofill', confirmed: true, guesses: { 'f4:sh-1-0': 'email' } })).data);
  assert.equal(refused.messageKey, 'worker.frameUnsafe');
  assert.deepEqual(requestsOf(g), []);
  assert.deepEqual(planned.page.answered(), []);
});

// The real site engine and content script on a page, as Chrome loads them for each registration that matches.
// How long the content script waits after a page change before it checks again. A test that changes a page
// mocks setTimeout: the change arms the check, and the test's clock runs it.
const CHECK_MS = 500;
const checkAfterChange = async t => { await tick(); t.mock.timers.tick(CHECK_MS); await tick(); };
function livePage(t, html, { url = OTHER_URL, framesReply = { frames: false }, loads = 1, top = true } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  if (!top) dom.reconfigure({ windowTop: {} });
  const { window } = dom;
  layoutElements(window);
  const listeners = [], reports = [];
  window.chrome = { runtime: { id: extensionId, getURL: extensionURL, onMessage: { addListener: callback => { listeners.push(callback); } },
    sendMessage: async message => { reports.push(plain(message)); return structuredClone(framesReply); } } };
  const load = () => { for (const file of SITE_SCRIPT.js) evalFile(window, `extension/${file}`); };
  for (let i = 0; i < loads; i++) load();
  return { window, listeners, reports, load,
    cards: () => window.document.querySelectorAll('[data-secondhand-assistant]').length,
    tell(message) { for (const listener of listeners) listener(message, { id: extensionId }, () => {}); } };
}
// The errors Chrome would report as uncaught while `work` runs and the page settles. node:test fails a test on an
// unhandled rejection, so its own listener steps aside meanwhile.
async function uncaught(work) {
  const runner = process.listeners('unhandledRejection');
  const errors = [];
  const heard = error => { errors.push(error); };
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', heard);
  try { await work(); await settle(); }
  finally {
    process.off('unhandledRejection', heard);
    for (const listener of runner) process.on('unhandledRejection', listener);
  }
  return errors;
}

test('with all websites on, the card shows on a form page and stays hidden on a search-only page, a sign-in page, and a page without inputs', async t => {
  assert.equal(livePage(t, forms.plainPantry).cards(), 1);
  assert.equal(livePage(t, '<main><label for="reach">Where can we reach you?</label><input id="reach" type="email"></main>').cards(), 1, 'a question only Laya could take');
  for (const [name, html] of Object.entries({
    'search only': '<header><form role="search"><input type="search" name="q" aria-label="Search"><button>Go</button></form></header><main><p>Pantry hours</p></main>',
    'sign-in': '<form><label for="user">Email</label><input id="user" type="email"><label for="pw">Password</label><input id="pw" type="password"><button>Sign in</button></form>',
    'verification code': '<form><label for="otp">Enter the 6-digit code we sent you</label><input id="otp"></form>',
    'no inputs': '<main><h1>Our pantry</h1><p>Open Monday and Friday.</p></main>'
  })) {
    const page = livePage(t, html);
    assert.equal(page.cards(), 0, name);
    assert.deepEqual(page.reports, [{ type: 'secondhand:generic:form', helps: false }], `${name}: the top frame only asks about embedded forms`);
  }
});

test('a form that appears after the page loads brings the card, and the card goes when the form does', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = livePage(t, '<main id="app"><p>Loading…</p></main>');
  await tick();
  assert.equal(page.cards(), 0, 'the page has loaded without a form');
  page.window.document.getElementById('app').innerHTML = '<form><label for="fname">First name</label><input id="fname"><label for="zip">ZIP code</label><input id="zip"></form>';
  await tick();
  assert.equal(page.cards(), 0, 'the check waits for the page to settle');
  t.mock.timers.tick(CHECK_MS); await tick();
  assert.equal(page.cards(), 1);
  page.window.document.getElementById('fname').value = 'Typed by the applicant';
  page.window.document.getElementById('zip').value = '50309';
  page.window.document.getElementById('app').append(page.window.document.createElement('p'));
  await checkAfterChange(t);
  assert.equal(page.cards(), 1, 'a filled form keeps its card');
  page.window.document.getElementById('app').innerHTML = '<p>Thank you. We received your sign-up.</p>';
  await checkAfterChange(t);
  assert.equal(page.cards(), 0);
});

test('text-only question label changes update form detection without replacing the label or control', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = livePage(t, '<label for="detail">Signature</label><input id="detail">');
  await tick();
  const label = page.window.document.querySelector('label'), input = page.window.document.querySelector('input');
  assert.equal(page.cards(), 0);
  label.firstChild.data = 'First name';
  await checkAfterChange(t);
  assert.equal(page.cards(), 1);
  assert.equal(page.window.document.querySelector('label'), label);
  assert.equal(page.window.document.querySelector('input'), input);
  label.firstChild.data = 'Signature';
  await checkAfterChange(t);
  assert.equal(page.cards(), 0, 'the card also leaves when the only question becomes one the applicant must answer');
});

const historyEvent = (page, name, persisted = true) => page.window.dispatchEvent(new page.window.PageTransitionEvent(name, { persisted }));
test('back-forward-cache restoration restarts late-form detection, including a check canceled before the page hid', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = livePage(t, '<main id="app">Loading</main>');
  await tick();
  const app = page.window.document.getElementById('app');
  app.append(page.window.document.createElement('p'));
  await tick(); // A check is pending when the page enters the back-forward cache.
  historyEvent(page, 'pagehide');
  historyEvent(page, 'pageshow');
  assert.equal(page.cards(), 0);
  app.innerHTML = '<label for="name">First name</label><input id="name">';
  await checkAfterChange(t);
  assert.equal(page.cards(), 1);
  historyEvent(page, 'pagehide');
  app.innerHTML = '<p>Completed</p>';
  await tick();
  historyEvent(page, 'pageshow');
  assert.equal(page.cards(), 0, 'restoration checks the current DOM immediately');
  app.innerHTML = '<label for="zip">ZIP code</label><input id="zip">';
  await checkAfterChange(t);
  assert.equal(page.cards(), 1, 'a second cache cycle also rearms its observer');
});

test('restored embedded frames report fresh form state once and never create a second widget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frame = livePage(t, '<main><label for="name">First name</label><input id="name"></main>', { top: false, url: `${FRAME_ORIGIN}/form` });
  await tick();
  historyEvent(frame, 'pagehide');
  historyEvent(frame, 'pagehide');
  historyEvent(frame, 'pageshow');
  historyEvent(frame, 'pageshow');
  await tick();
  assert.deepEqual(frame.reports.map(item => item.helps), [true, false, true]);
  assert.equal(frame.cards(), 0);
  historyEvent(frame, 'pagehide');
  frame.window.document.querySelector('main').textContent = 'No form remains';
  historyEvent(frame, 'pageshow');
  await tick();
  assert.deepEqual(frame.reports.map(item => item.helps), [true, false, true, false, false], 'even a restored empty frame corrects any missed departure report');
  let reply;
  frame.listeners[0]({ type: 'secondhand:generic:helps' }, { id: extensionId }, value => { reply = plain(value); });
  assert.deepEqual(reply, { helps: false });
});

test('restoring a page refreshes embedded-form state and ignoring duplicate pageshow creates no duplicate repair timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = livePage(t, '<main>No local form</main>', { framesReply: { frames: true } });
  await tick(); assert.equal(page.cards(), 1);
  let started = 0, cleared = 0;
  const set = page.window.setInterval.bind(page.window), clear = page.window.clearInterval.bind(page.window);
  page.window.setInterval = (...args) => { started++; return set(...args); };
  page.window.clearInterval = id => { if (id !== null) cleared++; return clear(id); };
  page.window.chrome.runtime.sendMessage = async message => { page.reports.push(plain(message)); return { frames: false }; };
  historyEvent(page, 'pagehide');
  historyEvent(page, 'pageshow');
  historyEvent(page, 'pageshow');
  await tick();
  assert.equal(page.cards(), 0, 'old embedded-frame visibility is not reused after restoration');
  assert.equal(page.reports.length, 2, 'one top-level frame query per activation');
  assert.equal(started, 1); assert.equal(cleared, 1);
  historyEvent(page, 'pagehide'); historyEvent(page, 'pageshow'); await tick();
  assert.equal(started, 2); assert.equal(cleared, 2);
});

test('turning a suspended page off cannot be undone by restoration, late reports, or DOM changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = livePage(t, '<main>No local form</main>'); await tick();
  let answer;
  page.window.chrome.runtime.sendMessage = message => { page.reports.push(plain(message)); return new Promise(resolve => { answer = resolve; }); };
  historyEvent(page, 'pagehide'); historyEvent(page, 'pageshow');
  historyEvent(page, 'pagehide');
  page.tell({ type: 'secondhand:generic:off' });
  historyEvent(page, 'pageshow');
  answer?.({ frames: true });
  page.window.document.querySelector('main').innerHTML = '<label for="zip">ZIP code</label><input id="zip">';
  await checkAfterChange(t);
  assert.equal(page.cards(), 0);
  let replied = false;
  page.listeners[0]({ type: 'secondhand:generic:plan' }, { id: extensionId }, () => { replied = true; });
  assert.equal(replied, false);
  assert.equal(page.reports.length, 2);
});

test('a cached page waits for current site approval and stays off if access was revoked while it was frozen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const top of [true, false]) {
    const page = livePage(t, '<label for="name">First name</label><input id="name">', { top });
    await tick();
    historyEvent(page, 'pagehide');
    let answer;
    page.window.chrome.runtime.sendMessage = message => { page.reports.push(plain(message)); return new Promise(resolve => { answer = resolve; }); };
    historyEvent(page, 'pageshow');
    assert.equal(page.cards(), 0, 'no card until the restored site is confirmed');
    let replied = false;
    page.listeners[0]({ type: 'secondhand:generic:plan' }, { id: extensionId }, () => { replied = true; });
    assert.equal(replied, false, 'no plans or fills while current access is being checked');
    if (!top) {
      let status;
      page.listeners[0]({ type: 'secondhand:generic:helps' }, { id: extensionId }, value => { status = plain(value); });
      assert.deepEqual(status, { helps: true }, 'the worker can still count this frame without a form answer');
    }
    answer(undefined); // The worker returns nothing for a site no longer approved.
    await tick();
    historyEvent(page, 'pagehide'); historyEvent(page, 'pageshow');
    page.window.document.querySelector('label').firstChild.data = 'Last name';
    await checkAfterChange(t);
    assert.equal(page.cards(), 0);
    page.listeners[0]({ type: 'secondhand:generic:plan' }, { id: extensionId }, () => { replied = true; });
    assert.equal(replied, false, 'returning again cannot revive a revoked script');
  }
});

test('an approval report from an earlier cached activation cannot overwrite fresh restored frame state', async t => {
  const page = livePage(t, '<main>No local form</main>'); await tick();
  const replies = [];
  page.window.chrome.runtime.sendMessage = message => { page.reports.push(plain(message)); return new Promise(resolve => replies.push(resolve)); };
  historyEvent(page, 'pagehide'); historyEvent(page, 'pageshow');
  historyEvent(page, 'pagehide'); historyEvent(page, 'pageshow');
  assert.equal(replies.length, 2);
  replies[1]({ frames: false }); await tick();
  replies[0]({ frames: true }); await tick();
  assert.equal(page.cards(), 0, 'the later approved activation wins even when old replies arrive last');
});

test('newer embedded-form reports received during restoration survive the older approval reply', async t => {
  const page = livePage(t, '<main>No local form</main>'); await tick();
  historyEvent(page, 'pagehide');
  let answer;
  page.window.chrome.runtime.sendMessage = () => new Promise(resolve => { answer = resolve; });
  historyEvent(page, 'pageshow');
  page.tell({ type: 'secondhand:generic:formFrames', helps: true });
  assert.equal(page.cards(), 0, 'frame metadata alone cannot approve restoration');
  answer({ frames: false }); await tick();
  assert.equal(page.cards(), 1, 'the newer frame message wins after the worker approves the site');
  page.tell({ type: 'secondhand:generic:formFrames', helps: false });
  assert.equal(page.cards(), 0);
});

test('the scripts run once when a site’s own registration and all websites both match the page', async t => {
  const page = livePage(t, forms.plainPantry, { loads: 2 });
  assert.equal(page.cards(), 1);
  assert.equal(page.listeners.length, 1, 'one content script answers the worker');
  assert.equal(page.reports.length, 1);
  const engine = page.window.SecondHandGeneric;
  page.load();
  assert.equal(page.window.SecondHandGeneric, engine, 'the engine, and the plan it holds, are made once per frame');
  let plan;
  page.listeners[0]({ type: 'secondhand:generic:plan' }, { id: extensionId }, value => { plan = value; });
  page.load();
  let filled;
  const lastName = plan.matched.find(item => item.key === 'lastName');
  await new Promise(resolve => page.listeners[0]({ type: 'secondhand:generic:fill', token: plan.token, assignments: [{ id: lastName.id, key: 'lastName', guessed: false }], values: { lastName: 'Synthetic' } },
    { id: extensionId }, value => { filled = value; resolve(); }));
  assert.deepEqual(plain(filled), { ok: true, filled: [lastName.id], skipped: [], rejected: [], partial: [] }, 'a later load keeps the plan in use valid');
});

test('an embedded form reports whether it has a form and never makes a card of its own', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frame = livePage(t, '<form><label for="fname">First name</label><input id="fname"></form>', { url: `${FRAME_ORIGIN}/form`, top: false });
  assert.equal(frame.cards(), 0);
  await tick();
  assert.deepEqual(frame.reports, [{ type: 'secondhand:generic:form', helps: true }], 'the frame has loaded with its form');
  frame.window.document.querySelector('form').remove();
  await checkAfterChange(t);
  assert.deepEqual(frame.reports.at(-1), { type: 'secondhand:generic:form', helps: false });
  const empty = livePage(t, '<p>Advertisement</p>', { url: 'https://ads.example.com/frame', top: false });
  assert.deepEqual(empty.reports, [], 'a frame without a form says nothing');
});

test('an embedded frame tells the worker whether its page has a form when the worker asks, with a yes or no only (#157)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ask = (page, sender = { id: extensionId }) => {
    let reply;
    for (const listener of page.listeners) listener({ type: 'secondhand:generic:helps' }, sender, value => { reply = value; });
    return reply === undefined ? undefined : plain(reply);
  };
  const frame = livePage(t, '<form><label for="fname">First name</label><input id="fname" value="Synthetic typed answer"></form>', { url: `${FRAME_ORIGIN}/form`, top: false });
  assert.deepEqual(ask(frame), { helps: true });
  assert.equal(ask(frame, { id: 'b'.repeat(32) }), undefined, 'another extension gets nothing');
  await tick();
  assert.deepEqual(ask(frame), { helps: true }, 'the frame has loaded with its form');
  frame.window.document.querySelector('form').remove();
  await checkAfterChange(t);
  assert.deepEqual(ask(frame), { helps: false });
  assert.deepEqual(ask(livePage(t, '<p>Advertisement</p>', { url: 'https://ads.example.com/frame', top: false })), { helps: false });
  assert.equal(ask(livePage(t, forms.plainPantry)), undefined, 'the top page places its own card');
  const off = livePage(t, '<form><label for="fname">First name</label><input id="fname"></form>', { url: `${FRAME_ORIGIN}/form`, top: false });
  off.tell({ type: 'secondhand:generic:off' });
  assert.equal(ask(off), undefined, 'a frame SecondHand was turned off for answers nothing');
});

test('the top page shows the card for an embedded form the worker tells it about', async t => {
  const page = siteContent(t, { offers: () => false, framesReply: { frames: true } });
  assert.equal(page.host(), null);
  await tick();
  assert.ok(page.host(), 'a form embedded before the page loaded');
  page.request({ type: 'secondhand:generic:formFrames', helps: false });
  assert.equal(page.host(), null);
  page.request({ type: 'secondhand:generic:formFrames', helps: true });
  assert.ok(page.host());
  page.request({ type: 'secondhand:generic:formFrames', helps: true }, { id: 'b'.repeat(32) });
  page.request({ type: 'secondhand:generic:formFrames', helps: false }, { id: 'b'.repeat(32) });
  assert.ok(page.host(), 'another extension changes nothing');
});

test('a form report the worker answers with an error is reported as uncaught, on the top page and from an embedded frame (#178)', async t => {
  const reported = errors => errors.map(item => ({ message: item.message, messageKey: item.messageKey, messageParams: plain(item.messageParams) }));
  const thrown = reply => ({ message: reply.error, messageKey: reply.errorKey, messageParams: reply.errorParams });
  // The top page's report: the worker couldn't check the tab's frames, as when one answers in a way it can't trust.
  const unchecked = { ok: false, error: strings.english('worker.frameUnsafe'), errorKey: 'worker.frameUnsafe', errorParams: {} };
  let page, frame;
  assert.deepEqual(reported(await uncaught(() => { page = livePage(t, forms.plainPantry, { framesReply: unchecked }); })), [thrown(unchecked)]);
  assert.equal(page.cards(), 1, 'the page’s own form keeps its card');
  // An embedded frame's report: the top page failed the worker's message about its card.
  const refused = detailReply(PORT_CLOSED);
  const form = '<form><label for="fname">First name</label><input id="fname"></form>';
  assert.deepEqual(reported(await uncaught(() => { frame = livePage(t, form, { url: `${FRAME_ORIGIN}/form`, top: false, framesReply: refused }); })), [thrown(refused)]);
  assert.deepEqual(reported(await uncaught(() => { frame.window.dispatchEvent(new frame.window.Event('pagehide')); })), [thrown(refused)], 'and as the frame goes');
  assert.deepEqual(frame.reports, [{ type: 'secondhand:generic:form', helps: true }, { type: 'secondhand:generic:form', helps: false }]);
});

test('when SecondHand is turned off for the page, its card goes and the page answers nothing more', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = siteContent(t);
  assert.ok(page.host());
  page.request({ type: 'secondhand:generic:off' }, { id: 'b'.repeat(32) });
  assert.ok(page.host(), 'only SecondHand turns itself off');
  page.request({ type: 'secondhand:generic:off' });
  assert.equal(page.host(), null);
  assert.equal(page.request({ type: 'secondhand:generic:plan' }), undefined);
  page.request({ type: 'secondhand:generic:formFrames', helps: true });
  page.window.document.body.append(page.window.document.createElement('p'));
  await checkAfterChange(t);
  assert.equal(page.host(), null, 'nothing brings it back');
  assert.deepEqual(page.calls, []);
});

// Laya reads English (#84): a Spanish form's questions reach it translated by Chrome on this computer.
const en = (key, params) => strings.english(key, params);
const SPANISH = new Map([['¿Hay alguien en su hogar de 60 años o más?', 'Is anyone in your household 60 or older?'], ['Sí', 'Yes'], ['No', 'No'],
  ['¿Dónde podemos contactarle?', 'Where can we reach you?'], ['Número de Seguro Social', 'Social Security number'],
  [`Describa ${'muy '.repeat(40)}brevemente su hogar`, `Describe ${'very '.repeat(40)}briefly your household, please`]]);
// Chrome's Translator and LanguageDetector in the worker, as a test table. Every call is recorded.
function workerAI({ translator = 'available', detected = null } = {}) {
  const calls = { availability: [], create: [], translate: [] };
  const ai = { Translator: {
    async availability(options) { calls.availability.push(plain(options)); return translator; },
    async create(options) {
      calls.create.push({ sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage });
      return { async translate(text) { calls.translate.push(text); if (!SPANISH.has(text)) throw new Error(`Synthetic table has no ${text}`); return SPANISH.get(text); } };
    } } };
  if (detected) ai.LanguageDetector = { availability: async () => 'available', create: async () => ({ detect: async () => detected }) };
  return { ai, calls };
}
const SIXTY_ES = { name: 'sixty', label: '¿Hay alguien en su hogar de 60 años o más?', type: 'radio', options: ['Sí', 'No'], required: true };

test('Laya gets a Spanish form’s question in English, and its answer fills the page’s own option, found by position', async () => {
  let asked;
  const { ai, calls } = workerAI();
  const w = siteWorker({ enabled: true, lang: 'es', ai, fields: [{ name: 'name', key: 'fullName' }, { ...SIXTY_ES }], desktop: layaDesktop({
    answerFields: (request, vault) => { asked = request.questions; return { answers: { [request.questions[0].id]: 'Yes' }, accessRevision: vault.accessRevision }; } }) });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(asked, [{ id: asked[0].id, label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] }]);
  assert.deepEqual(w.content.find(call => call.type === 'secondhand:generic:fill').assignments,
    [{ id: 'sh-1-0', key: 'fullName', guessed: false }, { id: 'sh-1-1', option: 'Sí', guessed: true }], 'the page’s own option, at the position Laya chose');
  assert.deepEqual(w.page.answered(), ['name', 'sixty']);
  assert.deepEqual([result.filled, result.guessed, result.laya, result.needYou], [2, 1, 1, []]);
  // Only the page's question words went to Chrome's translator, before any saved value was read.
  assert.deepEqual(calls.availability, [{ sourceLanguage: 'es', targetLanguage: 'en' }]);
  assert.deepEqual(calls.translate.sort(), ['¿Hay alguien en su hogar de 60 años o más?', 'Sí', 'No'].sort());
  assert.deepEqual(w.nativeTypes(), ['status', 'warmLaya', 'answerFields', 'status', 'getFields', 'status']);
});

test('a Spanish question Chrome can’t translate yet stays under need you, Laya is asked nothing, and the result says why', async () => {
  const { ai, calls } = workerAI({ translator: 'downloadable' });
  const w = siteWorker({ enabled: true, lang: 'es', ai, fields: [{ name: 'name', key: 'fullName' }, { ...SIXTY_ES }], desktop: layaDesktop() });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(layaCalls(w), []);
  assert.deepEqual(calls.create, [], 'nothing is downloaded without the applicant asking');
  assert.deepEqual([result.filled, result.guessed, result.needYou], [1, 0, [idOf(w, 'sixty')]]);
  assert.equal(result.message, `${en('result.siteFilledNeedYou', { count: 1, needYou: 1 })} ${en('translate.layaNeedsDownload')}`);
  assert.deepEqual([result.messageKey, plain(result.messageParams.reason)], ['result.withReason', { key: 'translate.layaNeedsDownload', params: {} }]);
});

test('Spanish words with no detector and no declared language never reach Laya as if they were English', async () => {
  const { ai, calls } = workerAI();
  const w = siteWorker({ enabled: true, lang: '', ai, fields: [{ ...SIXTY_ES }, { name: 'reach', label: '¿Dónde podemos contactarle?', type: 'email' }], desktop: layaDesktop() });
  const result = plain((await autofill(w)).data);
  assert.deepEqual(layaCalls(w), [], 'Laya gets nothing');
  assert.deepEqual([calls.availability, calls.translate], [[], []]);
  assert.deepEqual(result.needYou.sort(), [idOf(w, 'sixty'), idOf(w, 'reach')].sort());
  assert.equal(result.message, `${en('result.nothingMatchesNeedYou', { count: 2 })} ${en('translate.layaUnknownLanguage')}`);
});

test('English pages make no translator calls, and a detector reading Spanish under an English declaration translates', async () => {
  const english = workerAI({ detected: [{ detectedLanguage: 'en', confidence: 0.98 }] });
  let asked;
  const w = siteWorker({ enabled: true, ai: english.ai, fields: [{ name: 'name', key: 'fullName' }, { name: 'sixty', label: 'Is anyone in your household 60 or older?', type: 'radio', options: ['Yes', 'No'] }],
    desktop: layaDesktop({ answerFields: (request, vault) => { asked = request.questions; return { answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision }; } }) });
  assert.equal(plain((await autofill(w)).data).laya, 1);
  assert.deepEqual(asked.map(({ label, options }) => ({ label, options })), [{ label: 'Is anyone in your household 60 or older?', options: ['Yes', 'No'] }]);
  assert.deepEqual(english.calls, { availability: [], create: [], translate: [] });

  const templated = workerAI({ detected: [{ detectedLanguage: 'es', confidence: 0.93 }] });
  const t = siteWorker({ enabled: true, lang: 'en', ai: templated.ai, fields: [{ ...SIXTY_ES }], desktop: layaDesktop({
    answerFields: (request, vault) => { asked = request.questions; return { answers: {}, accessRevision: vault.accessRevision }; } }) });
  await autofill(t);
  assert.deepEqual(asked.map(question => question.options), [['Yes', 'No']]);
});

test('a translated question meets Laya’s question rule as a written one does: an SSN question, or one too long in English, stays with the applicant', async () => {
  const { ai } = workerAI();
  const long = `Describa ${'muy '.repeat(40)}brevemente su hogar`;
  assert.ok(long.length <= 200 && SPANISH.get(long).length > 200, 'fits in Spanish, not in English');
  const w = siteWorker({ enabled: true, lang: 'es', ai, fields: [{ ...SIXTY_ES }, { name: 'ssn', label: 'Número de Seguro Social', type: 'text' }, { name: 'about', label: long, type: 'text' }],
    desktop: layaDesktop({ answerFields: (request, vault) => ({ answers: {}, accessRevision: vault.accessRevision }) }) });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'done');
  assert.deepEqual(layaCalls(w).map(call => call.type), ['answerFields'], 'no text box is sent to Laya');
  assert.deepEqual(layaCalls(w)[0].questions.map(question => question.label), ['Is anyone in your household 60 or older?']);
  assert.equal(result.message, en('result.nothingMatchesNeedYou', { count: 3 }), 'like a written question of the same kind, with no translation reason');
});

test('a frame’s plan must say which language it declares', async () => {
  const w = siteWorker({ enabled: true, plan: { token: 'plan-1', matched: [], unmatched: [] } });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'error');
  assert.equal(result.messageKey, 'worker.frameUnsafe');
});

// Updating itself (#85): a newer build from the app waits for what is under way on a site.
const UPDATE = { build: '2026-10-04.1', copy: 'ready' };
const updating = (options = {}) => siteWorker({ build: '2026-10-03.9', disk: UPDATE.build, ...options, desktop: { extension: UPDATE, ...options.desktop } });
const statusRow = async w => { await w.panel({ type: 'ui:desktopStatus' }); await settle(); };

// Pages whose click leaves nothing for the applicant: a need-you list or a Save offer holds the reload too (#142).
const answeredByClick = () => [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip' }];
const reachable = { firstName: 'Synthetic private first', lastName: 'Synthetic private last', email: 'synthetic@example.org', phone: '5155550100' };

test('a site fill waiting on its approval holds the reload; it reloads once the fill is answered', async () => {
  let approve;
  const w = updating({ enabled: true, fields: answeredByClick(), desktop: { delay: { getFields: new Promise(resolve => { approve = resolve; }) } } });
  const click = autofill(w);
  await settle();
  await statusRow(w);
  assert.equal(w.reloads(), 0);
  approve();
  assert.equal((await click).ok, true);
  await settle();
  assert.equal(w.reloads(), 1);
});

test('a widget’s planned fill holds the reload between its plan and its Autofill', async () => {
  const w = updating({ enabled: true, fields: openQuestions().filter(field => field.name !== 'pickup'), desktop: { values: reachable } });
  const [reach, call] = (await plan(w)).unmatched.map(field => field.id);
  await statusRow(w);
  assert.equal(w.reloads(), 0, 'Chrome’s AI is reading the plan in the widget');
  assert.equal((await w.launcher({ type: 'ui:autofill', confirmed: true, guesses: { [reach]: 'email', [call]: 'phone' } })).ok, true);
  await settle();
  assert.equal(w.reloads(), 1);
});

test('the app’s prompt to trust all websites holds the reload until it is answered', async () => {
  let answer;
  const w = updating({ url: OTHER_URL, allGranted: true, desktop: { delay: { trustAllSites: new Promise(resolve => { answer = resolve; }) } } });
  const click = allSitesOn(w);
  await settle();
  await statusRow(w);
  assert.equal(w.reloads(), 0);
  answer();
  assert.equal((await click).ok, true);
  await settle();
  assert.equal(w.reloads(), 1);
});

test('after a click, the need-you list and Save offers stay: the reload waits until the tab moves on or closes (#142)', async () => {
  const w = updating({ enabled: true });
  assert.equal((await autofill(w)).data.state, 'done');
  await statusRow(w);
  assert.equal(w.reloads(), 0, 'the click left two questions for the applicant');
  const size = `f0:${w.page.idOf('size')}`;
  const state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.deepEqual(state.result.needYou, [`f0:${w.page.idOf('pickup')}`, size]);
  assert.deepEqual(state.savable, [{ id: size, label: 'size', answered: false }]);
  // Saving one answer leaves the need-you list: still no reload.
  w.page.type('size', '3');
  assert.equal((await w.panel({ type: 'ui:saveAnswer', id: size, confirmed: true })).ok, true);
  await statusRow(w);
  assert.equal(w.reloads(), 0);
  assert.equal(plain((await w.panel({ type: 'ui:pageState' })).data).result.needYou.length, 2);
  await settle();
  assert.equal(w.reloads(), 0);
  // The tab moves on: nothing is left to keep, and the next message reloads.
  w.events.updated(7, { status: 'loading' });
  await statusRow(w);
  assert.equal(w.reloads(), 1);

  const closed = updating({ enabled: true });
  await autofill(closed);
  await statusRow(closed);
  assert.equal(closed.reloads(), 0);
  closed.events.removed(7);
  await statusRow(closed);
  assert.equal(closed.reloads(), 1, 'a closed tab keeps nothing');
});

// Save to My information (#98).
const saveAnswer = (w, id) => w.panel({ type: 'ui:saveAnswer', id, confirmed: true });
const savable = async w => plain((await w.panel({ type: 'ui:pageState' })).data).savable;

test('after Autofill, the side panel lists each matched question with no saved answer by its label, and whether it is answered now', async () => {
  const w = siteWorker({ enabled: true });
  await autofill(w);
  const size = `f0:${w.page.idOf('size')}`;
  assert.deepEqual(await savable(w), [{ id: size, label: 'size', answered: false }]);
  const asked = w.content.filter(call => call.type === 'secondhand:generic:answered');
  assert.deepEqual(asked.map(({ frameId, token, ids }) => ({ frameId, token, ids })), [{ frameId: 0, token: 'plan-2', ids: [w.page.idOf('size')] }], 'only the listed boxes, by id');
  assert.equal(plain((await w.launcher({ type: 'ui:pageState' })).data).savable, undefined, 'the on-page widget never gets the list');
  w.page.type('size', '3');
  assert.deepEqual(await savable(w), [{ id: size, label: 'size', answered: true }]);
  assert.equal(w.contentTypes().includes('secondhand:generic:read'), false, 'no box is read before the click');
  assert.equal(w.nativeTypes().includes('saveFields'), false);
});

test('only saved profile fields are offered: never a composite, a band count, or a question without a saved field', async () => {
  const fields = [{ name: 'name', key: 'fullName' }, { name: 'zip', key: 'zip' }, { name: 'kids', key: 'householdCount:0-5' }, { name: 'student', key: 'studentNameGrade' }, { ...PICKUP }];
  const w = siteWorker({ enabled: true, fields, desktop: { values: {} } });
  await autofill(w);
  assert.deepEqual((await savable(w)).map(item => item.label), ['zip']);
  const filled = siteWorker({ enabled: true, desktop: { values: { firstName: 'A', lastName: 'B', zip: '50309', householdSize: '3' } } });
  await autofill(filled);
  assert.equal(await savable(filled), undefined, 'everything had a saved answer: nothing to offer');
});

test('Save to My information reads that one box only after the side panel’s click, then the app saves it after its own confirmation', async () => {
  const w = siteWorker({ enabled: true });
  await autofill(w);
  const size = `f0:${w.page.idOf('size')}`;
  w.page.type('size', '3');
  assert.equal(await w.panel({ type: 'ui:saveAnswer', id: size }), undefined, 'only a confirmed click');
  assert.equal(await w.launcher({ type: 'ui:saveAnswer', id: size, confirmed: true }), undefined, 'only the side panel');
  assert.equal(w.contentTypes().includes('secondhand:generic:read'), false);
  const response = await saveAnswer(w, size);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { saved: true });
  const reads = w.content.filter(call => call.type === 'secondhand:generic:read');
  assert.deepEqual(reads.map(({ frameId, token, id, key }) => ({ frameId, token, id, key })), [{ frameId: 0, token: 'plan-2', id: w.page.idOf('size'), key: 'householdSize' }]);
  assert.deepEqual(w.native.filter(call => call.type === 'saveFields').map(({ url, fields }) => ({ url, fields })), [{ url: `${ORIGIN}/intake`, fields: { householdSize: '3' } }]);
  assert.equal(await savable(w), undefined, 'a saved answer leaves the list');
  assert.equal((await saveAnswer(w, size)).errorKey, 'worker.answerGone', 'and can’t be saved twice');
});

test('an unanswered or unreadable box, an unknown question, or the app’s refusal saves nothing and says why', async () => {
  const w = siteWorker({ enabled: true, desktop: { values: {} } });
  await autofill(w);
  const zip = `f0:${w.page.idOf('zip')}`, size = `f0:${w.page.idOf('size')}`;
  assert.equal((await saveAnswer(w, zip)).errorKey, 'worker.answerFirst');
  w.page.type('zip', null);
  assert.equal((await saveAnswer(w, zip)).errorKey, 'worker.answerUnreadable');
  for (const id of ['f0:sh-9-9', 'f3:sh-2-1', 'zip', 42]) {
    const reply = await saveAnswer(w, id);
    assert.ok(reply === undefined || reply.errorKey === 'worker.answerGone', JSON.stringify(id));
  }
  w.page.type('size', '3');
  w.vault.saveError = 'You cancelled saving to My information.';
  const refused = await saveAnswer(w, size);
  assert.equal(refused.ok, false);
  assert.equal(refused.errorKey, 'worker.saveCancelled');
  assert.ok((await savable(w)).some(item => item.id === size), 'a refused answer stays on the list');
  assert.equal(w.nativeTypes().filter(type => type === 'saveFields').length, 1);
});

test('a question the page asks in more than one box, as in a member’s section with no heading, saves nothing and says why (#142)', async () => {
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { name: 'dob', key: 'birthDate', repeated: true }] });
  await autofill(w);
  const dob = `f0:${w.page.idOf('dob')}`;
  w.page.type('dob', '1985-04-12');
  const refused = await saveAnswer(w, dob);
  assert.equal(refused.ok, false);
  assert.equal(refused.errorKey, 'worker.answerRepeated');
  assert.equal(refused.error, strings.english('worker.answerRepeated'));
  assert.equal(w.nativeTypes().includes('saveFields'), false, 'nothing reaches the app');
});

test('a page that changed, or a site turned off, forgets the list and reads nothing', async () => {
  const w = siteWorker({ enabled: true });
  await autofill(w);
  const size = `f0:${w.page.idOf('size')}`;
  w.page.type('size', '3');
  w.events.updated(7, { status: 'loading' });
  assert.equal(await savable(w), undefined);
  assert.equal((await saveAnswer(w, size)).errorKey, 'worker.answerGone');
  const moved = siteWorker({ enabled: true });
  await autofill(moved);
  moved.page.type('size', '3');
  moved.tab.url = `${ORIGIN}/intake?step=2`;
  assert.equal((await saveAnswer(moved, `f0:${moved.page.idOf('size')}`)).errorKey, 'worker.answerGone', 'another address on the same site');
  const off = siteWorker({ enabled: true });
  await autofill(off);
  off.page.type('size', '3');
  off.registered.clear(); off.permissions.clear();
  assert.equal((await saveAnswer(off, `f0:${off.page.idOf('size')}`)).ok, false);
  for (const each of [w, moved, off]) assert.equal(each.contentTypes().includes('secondhand:generic:read'), false);
});

test('Save to My information saves an embedded form’s answer in that form’s own site’s name, from the address Chrome gives, and the app’s trust follows it', async () => {
  // The embedded page says it is the host page; Chrome says where it is.
  const child = secondFrame({ url: `${EMBED_URL}?visit=synthetic`, claims: OTHER, fields: [{ name: 'zip', key: 'zip' }, { name: 'size', key: 'householdSize' }] });
  const w = siteWorker({ url: OTHER_URL, allSites: true, fields: [{ name: 'name', key: 'fullName' }], frames: [child] });
  await autofill(w);
  const size = `f4:${child.page.idOf('size')}`;
  assert.deepEqual(await savable(w), [{ id: size, label: 'size', answered: false }]);
  child.page.type('size', '3');
  assert.deepEqual(await savable(w), [{ id: size, label: 'size', answered: true }]);
  const response = await saveAnswer(w, size);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(w.native.filter(call => call.type === 'saveFields').map(({ url, fields }) => ({ url, fields })), [{ url: EMBED_URL, fields: { householdSize: '3' } }],
    'saved in the name of the site the answer came from');
  assert.deepEqual(w.content.filter(call => ['secondhand:generic:answered', 'secondhand:generic:read'].includes(call.type)).map(call => [call.type, call.frameId, call.documentId]),
    [['secondhand:generic:answered', 4, 'doc-4'], ['secondhand:generic:answered', 4, 'doc-4'], ['secondhand:generic:read', 4, 'doc-4']], 'only the document Chrome placed is asked');

  // Turned on one site at a time: once the app no longer trusts the form's site, the host page's trust doesn't save its answer.
  const form = secondFrame({ enabled: true, fields: [{ name: 'size', key: 'householdSize' }] });
  const site = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }], frames: [form] });
  await autofill(site);
  form.page.type('size', '3');
  site.vault.trusted = [ORIGIN];
  const refused = await saveAnswer(site, `f4:${form.page.idOf('size')}`);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /isn’t trusted/);
  assert.deepEqual(site.native.filter(call => call.type === 'saveFields').map(call => call.url), [`${FRAME_ORIGIN}/form`]);
});

test('an embedded form that moved on to another page takes its questions with it: the list forgets them and nothing is read or saved', async () => {
  const child = secondFrame({ enabled: true, fields: [{ name: 'size', key: 'householdSize' }] });
  const w = siteWorker({ enabled: true, fields: [], frames: [child] });
  await autofill(w);
  const size = `f4:${child.page.idOf('size')}`;
  child.page.type('size', '3');
  assert.deepEqual(await savable(w), [{ id: size, label: 'size', answered: true }]);
  child.documentId = 'doc-4-next';
  assert.equal(await savable(w), undefined, 'the list forgets it');
  assert.equal((await saveAnswer(w, size)).errorKey, 'worker.answerGone');
  assert.equal(w.contentTypes().includes('secondhand:generic:read'), false);
  assert.equal(w.nativeTypes().includes('saveFields'), false);
});

test('a site frame says which listed boxes hold an answer, by id, and reads one box only when the worker asks for it', t => {
  const page = siteContent(t);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:answered', token: 'plan-1', ids: ['sh-1', 'sh-2'] })), { answered: ['sh-1'] });
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:read', token: 'plan-1', id: 'sh-1', key: 'county' })), { value: 'Story' }, 'the value only, nothing else of the box');
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:read', token: 'plan-1', id: 'sh-2', key: 'county' })), { readable: false });
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:read', token: 'plan-1', id: 'sh-3', key: 'birthDate' })), { repeated: true }, 'a question the page asks twice (#142)');
  for (const message of [{ type: 'secondhand:generic:answered', token: 'plan-1', ids: 'sh-1' }, { type: 'secondhand:generic:answered', token: 7, ids: [] },
    { type: 'secondhand:generic:read', token: 'plan-1', id: 'sh-1' }, { type: 'secondhand:generic:read', token: 'plan-1', id: ['sh-1'], key: 'county' }]) {
    assert.deepEqual(plain(page.request(message)), { ok: false, error: 'This page could not be checked safely. Review it manually.' }, JSON.stringify(message));
  }
  assert.equal(page.request({ type: 'secondhand:generic:read', token: 'plan-1', id: 'sh-1', key: 'county' }, { id: 'another-extension' }), undefined);
  assert.deepEqual(page.calls.filter(call => typeof call === 'string' && call.startsWith('read:')), ['read:plan-1:sh-1:county', 'read:plan-1:sh-2:county', 'read:plan-1:sh-3:birthDate']);
});

test('a site frame reads one open question’s answer only when the worker asks for it, and sends the answer alone (#186)', t => {
  const page = siteContent(t);
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:readOpen', token: 'plan-1', id: 'sh-2' })), { value: 'Monday' }, 'the value only, nothing else of the box');
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:readOpen', token: 'plan-1', id: 'sh-3' })), { empty: true });
  assert.deepEqual(plain(page.request({ type: 'secondhand:generic:readOpen', token: 'plan-1', id: 'sh-1' })), { readable: false });
  for (const message of [{ type: 'secondhand:generic:readOpen', token: 'plan-1' }, { type: 'secondhand:generic:readOpen', token: 7, id: 'sh-2' }, { type: 'secondhand:generic:readOpen', token: 'plan-1', id: ['sh-2'] }]) {
    assert.deepEqual(plain(page.request(message)), { ok: false, error: 'This page could not be checked safely. Review it manually.' }, JSON.stringify(message));
  }
  assert.equal(page.request({ type: 'secondhand:generic:readOpen', token: 'plan-1', id: 'sh-2' }, { id: 'another-extension' }), undefined);
  assert.deepEqual(page.calls.filter(call => typeof call === 'string' && call.startsWith('readOpen:')), ['readOpen:plan-1:sh-2', 'readOpen:plan-1:sh-3', 'readOpen:plan-1:sh-1']);
});

// #135: answers the app left out because a saved date of birth is after today or more than 130 years ago.
const BIRTH_DATE_REASON = 'SecondHand left the answers that need a date of birth for you: a date of birth in My information is after today or more than 130 years ago. Check it in the SecondHand app.';
test('when the app leaves answers out because of a saved date of birth, the click still fills the rest and says why', async () => {
  const w = siteWorker({ enabled: true, desktop: { fieldsReason: 'birthDate' } });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'done');
  assert.equal(result.filled, 2);
  assert.equal(result.message, `Filled 2 · 2 need you. Check your answers before you submit. ${BIRTH_DATE_REASON}`);
  assert.equal(strings.english('worker.birthDateUnusable'), BIRTH_DATE_REASON);
  for (const language of ['es', 'vi', 'zh', 'fr', 'ar']) assert.notEqual(strings.text(language, 'worker.birthDateUnusable'), BIRTH_DATE_REASON, language);
});

test('when Laya answers without a saved date of birth it can’t use, the click says why, once, with the app’s own reason too', async () => {
  const play = { answerFields: (request, vault) => ({ answers: { [request.questions[0].id]: 'No' }, accessRevision: vault.accessRevision, reason: 'birthDate' }) };
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...SIXTY }, { ...PET }], desktop: layaDesktop(play) });
  const result = plain((await autofill(w)).data);
  assert.equal(result.filled, 2);
  assert.equal(result.message, `Filled 2 · 1 suggested · 1 need you. Check your answers before you submit. Suggestions came from Laya on this computer. ${BIRTH_DATE_REASON}`);
  const both = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...SIXTY }, { ...PET }], desktop: { ...layaDesktop(play), fieldsReason: 'birthDate' } });
  assert.equal(plain((await autofill(both)).data).message.split(BIRTH_DATE_REASON).length, 2, 'the same reason is said once');
});

test('an embedded site’s reason for answers the app left out is said for the click, once even when every site gives it', async () => {
  const fromForm = reason => request => new URL(request.url).origin === FRAME_ORIGIN ? reason : undefined;
  const click = fieldsReason => {
    const child = secondFrame({ enabled: true, fields: [{ name: 'zip', key: 'zip' }] });
    return { child, w: siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }], frames: [child], desktop: { fieldsReason } }) };
  };
  const { w, child } = click(fromForm('birthDate'));
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'done', result.message);
  assert.equal(result.filled, 2);
  assert.equal(result.messageKey, 'result.withReason');
  assert.ok(result.message.endsWith(` ${BIRTH_DATE_REASON}`), result.message);
  assert.deepEqual(requestsOf(w).map(([type, url]) => [type, url]), [['getFields', `${ORIGIN}/intake`], ['getFields', `${FRAME_ORIGIN}/form`]], 'the reason came with the embedded form’s own request');
  assert.deepEqual(child.page.answered(), ['zip']);

  const both = click('birthDate').w;
  assert.equal(plain((await autofill(both)).data).message.split(BIRTH_DATE_REASON).length, 2, 'the same reason from both sites is said once');

  // Laya's answers for the embedded form carry the reason too.
  const form = secondFrame({ enabled: true, fields: [{ ...SIXTY }] });
  const laya = siteWorker({ enabled: true, fields: [{ ...SIXTY }], frames: [form], desktop: layaDesktop({ answerFields: (request, vault) => ({
    answers: Object.fromEntries(request.questions.map(question => [question.id, 'No'])), accessRevision: vault.accessRevision, ...fromForm('birthDate')(request) && { reason: 'birthDate' } }) }) });
  const answered = plain((await autofill(laya)).data);
  assert.equal(answered.filled, 2);
  assert.equal(answered.message.split(BIRTH_DATE_REASON).length, 2, answered.message);

  // A reason the worker doesn't know, from the embedded form's request, fills nothing anywhere.
  const odd = click(fromForm('somethingElse'));
  const refused = plain((await autofill(odd.w)).data);
  assert.equal(refused.messageKey, 'worker.desktopUnexpected');
  assert.deepEqual([...odd.w.page.answered(), ...odd.child.page.answered()], []);
});

test('a reason the worker doesn’t know fills nothing and shows a fixed error', async () => {
  const w = siteWorker({ enabled: true, desktop: { fieldsReason: 'somethingElse' } });
  const result = plain((await autofill(w)).data);
  assert.equal(result.state, 'error');
  assert.equal(result.messageKey, 'worker.desktopUnexpected');
  assert.deepEqual(w.page.answered(), []);
  const laya = siteWorker({ enabled: true, fields: [{ ...SIXTY }], desktop: layaDesktop({ answerFields: (request, vault) => ({ answers: {}, accessRevision: vault.accessRevision, reason: 7 }) }) });
  assert.equal(plain((await autofill(laya)).data).messageKey, 'worker.desktopUnexpected');
});

test('when the app refuses to save because of a saved date of birth, the side panel shows its words: whose date, and to fix it in My information', async () => {
  const w = siteWorker({ enabled: true, desktop: { values: {} } });
  await autofill(w);
  const size = `f0:${w.page.idOf('size')}`;
  w.page.type('size', '3');
  const refusal = 'Person 3’s date of birth can’t be after today (2026-10-05 on this computer). Fix the date in My information, then save this answer again.';
  w.vault.saveError = refusal;
  const refused = plain(await saveAnswer(w, size));
  assert.equal(refused.ok, false);
  assert.deepEqual([refused.errorKey, refused.errorParams], ['detail', { detail: refusal }], 'the app’s own words, not a fixed error');
  assert.equal(strings.text('en', refused.errorKey, refused.errorParams), refusal);
  assert.ok((await savable(w)).some(item => item.id === size), 'the answer stays on the list to save once the date is fixed');
});

// #176: without Always allow, the app holds back the sensitive details that would need its own prompt. Autofill fills
// everything else at once, and those questions wait under need-you and in the side panel's list for one Fill sensitive
// details click, which asks the app for them alone.
const SENSITIVE_SAVED = { firstName: 'Synthetic private first', lastName: 'Synthetic private last', birthDate: '1985-04-12', ssn: '123-45-6789' };
const sensitiveForm = () => [{ name: 'name', key: 'fullName' }, { name: 'dob', key: 'birthDate', label: 'Date of birth' }, { name: 'ssn', key: 'ssn', label: 'Social Security number' }, { ...PICKUP }];
const holding = (options = {}) => siteWorker({ enabled: true, fields: sensitiveForm(), ...options, desktop: { values: SENSITIVE_SAVED, holds: ['birthDate', 'ssn'], ...options.desktop } });
const fillHeld = w => w.panel({ type: 'ui:fillHeld', confirmed: true });
const heldList = async w => plain((await w.panel({ type: 'ui:pageState' })).data).held;
const WAITING = 'Check your answers before you submit. 2 sensitive details wait until you click Fill sensitive details in the side panel.';

test('without Always allow, Autofill fills everything else at once; the held questions count as need-you and wait in the side panel’s list (#176)', async () => {
  const w = holding();
  const result = plain((await autofill(w)).data);
  assert.deepEqual(w.native.filter(call => call.type === 'getFields').map(({ fields, sensitive }) => ({ fields, sensitive })), [{ fields: ['firstName', 'lastName', 'birthDate', 'ssn'], sensitive: undefined }],
    'one request, as before');
  assert.deepEqual(w.page.answered(), ['name']);
  const fills = w.content.filter(call => call.type === 'secondhand:generic:fill');
  assert.deepEqual(fills.map(call => Object.keys(call.values)), [['fullName']], 'only the answers the app gave reach the page');
  const [dob, ssn, pickup] = ['dob', 'ssn', 'pickup'].map(name => `f0:${w.page.idOf(name)}`);
  assert.deepEqual(result, { state: 'done', filled: 1, guessed: 0, needYou: [pickup, dob, ssn], held: 2, pageKey: 'general',
    message: `Filled 1 · 3 need you. ${WAITING}`, messageKey: 'result.withHeld',
    messageParams: { summary: { key: 'result.siteFilledNeedYou', params: { count: 1, needYou: 3 } }, count: 2 } });
  assert.doesNotMatch(JSON.stringify(result), /1985|123-45/);

  // The side panel lists them by their own words. Date of birth is a saved field, but its answer was held back,
  // not missing: it is never offered to Save to My information.
  const state = plain((await w.panel({ type: 'ui:pageState' })).data);
  assert.deepEqual(state.held, [{ id: dob, label: 'Date of birth' }, { id: ssn, label: 'Social Security number' }]);
  assert.equal(state.savable, undefined);
  assert.equal(plain((await w.launcher({ type: 'ui:pageState' })).data).held, undefined, 'the on-page widget never gets the list');
  assert.equal(w.contentTypes().includes('secondhand:generic:read'), false);

  // Nothing waits when nothing was held: everything filled in one go.
  const allowed = holding({ desktop: { holds: [] } });
  const everything = plain((await autofill(allowed)).data);
  assert.deepEqual([everything.filled, everything.held, everything.message], [3, undefined, 'Filled 3 · 1 need you. Check your answers before you submit.']);
  assert.equal(await heldList(allowed), undefined);
});

test('a page whose only saved answers were held back says how many wait, not that nothing matched (#176)', async () => {
  const w = holding({ fields: sensitiveForm().filter(field => field.name !== 'name') });
  const result = plain((await autofill(w)).data);
  assert.equal(result.filled, 0);
  assert.equal(result.message, '3 need you. 2 sensitive details wait until you click Fill sensitive details in the side panel.');
  assert.deepEqual(w.contentTypes().filter(type => type === 'secondhand:generic:fill'), [], 'nothing was filled');
  const one = holding({ fields: [{ name: 'ssn', key: 'ssn', label: 'Social Security number' }] });
  assert.equal(plain((await autofill(one)).data).message, '1 need you. 1 sensitive detail waits until you click Fill sensitive details in the side panel.');
});

test('Fill sensitive details asks the app for the held fields alone, in the site’s name, and fills only those questions (#176)', async () => {
  const w = holding();
  await autofill(w);
  const [dob, ssn, pickup] = ['dob', 'ssn', 'pickup'].map(name => w.page.idOf(name));
  // The plan the click's last pass made, which the page still holds.
  const token = 'plan-2';
  assert.equal(await w.panel({ type: 'ui:fillHeld' }), undefined, 'only a confirmed click');
  assert.equal(await w.launcher({ type: 'ui:fillHeld', confirmed: true }), undefined, 'only the side panel');
  const asked = w.native.length;
  const response = await fillHeld(w);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(w.native.slice(asked).map(({ type, url, fields, sensitive }) => ({ type, url, fields, sensitive })),
    [{ type: 'getFields', url: `${ORIGIN}/intake`, fields: ['birthDate', 'ssn'], sensitive: true }, { type: 'status', url: undefined, fields: undefined, sensitive: undefined }],
    'the held fields alone, then the access check before the page is touched');
  const fill = w.content.at(-1);
  assert.deepEqual({ type: fill.type, frameId: fill.frameId, token: fill.token, assignments: fill.assignments, values: fill.values }, { type: 'secondhand:generic:fill', frameId: 0, token,
    assignments: [{ id: dob, key: 'birthDate', guessed: false }, { id: ssn, key: 'ssn', guessed: false }], values: { birthDate: '1985-04-12', ssn: '123-45-6789' } });
  assert.deepEqual(w.page.answered(), ['name', 'dob', 'ssn']);
  const result = plain(response.data);
  assert.deepEqual(result, { state: 'done', filled: 3, guessed: 0, needYou: [`f0:${pickup}`], pageKey: 'general',
    message: 'Filled 3 · 1 need you. Check your answers before you submit.', messageKey: 'result.siteFilledNeedYou', messageParams: { count: 3, needYou: 1 } });
  assert.deepEqual(plain((await w.panel({ type: 'ui:pageState' })).data).result, result, 'the tab’s result says so too');
  assert.equal(await heldList(w), undefined, 'nothing waits now');
  assert.equal((await fillHeld(w)).errorKey, 'worker.heldGone', 'and nothing is asked twice');
  assert.equal(w.nativeTypes().filter(type => type === 'getFields').length, 2);
});

test('Cancel in the app’s sensitive prompt leaves everything filled in place and keeps the held questions listed (#176)', async () => {
  const w = holding({ desktop: { sensitiveError: 'You cancelled this field request.' } });
  const result = plain((await autofill(w)).data);
  const list = await heldList(w);
  const cancelled = plain(await fillHeld(w));
  assert.deepEqual([cancelled.ok, cancelled.errorKey, cancelled.error], [false, 'worker.heldCancelled', 'Cancelled. The sensitive details weren’t filled, and they are still listed.']);
  assert.deepEqual(w.page.answered(), ['name'], 'what was filled stays, and nothing more is');
  assert.deepEqual(await heldList(w), list);
  assert.deepEqual(plain((await w.panel({ type: 'ui:pageState' })).data).result, result);
  // Any other refusal says what it was, and keeps them listed too.
  w.vault.sensitiveError = 'Unlock SecondHand first.';
  assert.deepEqual(plain(await fillHeld(w)).errorParams, { detail: 'Unlock SecondHand first.' });
  w.vault.reachable = false;
  assert.equal((await fillHeld(w)).errorKey, 'worker.desktopOffline');
  assert.deepEqual(await heldList(w), list);
  // Allow once, later, fills them.
  w.vault.reachable = true; w.vault.sensitiveError = null;
  assert.equal(plain((await fillHeld(w)).data).filled, 3);
  assert.deepEqual(w.page.answered(), ['name', 'dob', 'ssn']);
});

test('a question worked out from a held detail waits for it, and fills from the same one request (#176)', async () => {
  const fields = [{ name: 'name', key: 'fullName' }, { name: 'dob', key: 'birthDate', label: 'Date of birth' }, { name: 'age', key: 'ageRange', label: 'Age range' }];
  const w = holding({ fields, desktop: { holds: ['birthDate'] } });
  const result = plain((await autofill(w)).data);
  assert.equal(result.held, 2);
  assert.deepEqual((await heldList(w)).map(item => item.label), ['Date of birth', 'Age range']);
  await fillHeld(w);
  assert.deepEqual(w.native.filter(call => call.sensitive).map(call => call.fields), [['birthDate']]);
  assert.deepEqual(w.content.at(-1).values, { birthDate: '1985-04-12', ageRange: '41' });
  assert.deepEqual(w.page.answered(), ['name', 'dob', 'age']);
});

test('a held question with no saved answer stays with the applicant after Fill sensitive details (#176)', async () => {
  const w = holding({ desktop: { values: { ...SENSITIVE_SAVED, ssn: '' } } });
  await autofill(w);
  const response = plain((await fillHeld(w)).data);
  assert.deepEqual(w.page.answered(), ['name', 'dob']);
  assert.deepEqual(response.needYou, ['pickup', 'ssn'].map(name => `f0:${w.page.idOf(name)}`));
  assert.equal(response.held, undefined);
  assert.equal(await heldList(w), undefined, 'the app answered: nothing waits for it');
});

test('the held list is forgotten when the page changes or its site goes, and a new Autofill makes it again (#176)', async () => {
  const loaded = holding();
  await autofill(loaded);
  loaded.events.updated(7, { status: 'loading' });
  assert.equal(await heldList(loaded), undefined);
  assert.equal((await fillHeld(loaded)).errorKey, 'worker.heldGone');
  const moved = holding();
  await autofill(moved);
  moved.tab.url = `${ORIGIN}/intake?step=2`;
  assert.equal(await heldList(moved), undefined);
  assert.equal((await fillHeld(moved)).errorKey, 'worker.heldGone');
  const off = holding();
  await autofill(off);
  off.registered.clear(); off.permissions.clear();
  assert.equal((await fillHeld(off)).ok, false);
  const revoked = holding();
  await autofill(revoked);
  revoked.revoke([`${ORIGIN}/*`]); await settle();
  assert.equal((await fillHeld(revoked)).errorKey, 'worker.heldGone', 'Chrome took the site back');
  const turnedOff = holding();
  await autofill(turnedOff);
  assert.equal((await turnedOff.panel({ type: 'ui:disableSite', confirmed: true })).ok, true);
  assert.equal((await fillHeld(turnedOff)).errorKey, 'worker.heldGone');
  const closed = holding();
  await autofill(closed);
  closed.events.removed(7);
  assert.equal((await fillHeld(closed)).errorKey, 'worker.heldGone');
  const planned = holding();
  await autofill(planned);
  await plan(planned);
  assert.equal(await heldList(planned), undefined, 'the widget’s next click plans the page again');
  for (const each of [loaded, moved, off, revoked, turnedOff, closed, planned]) assert.equal(each.native.some(call => call.sensitive), false, 'the app is asked nothing');

  const again = holding();
  await autofill(again);
  again.vault.holds = ['ssn'];
  await autofill(again);
  assert.deepEqual((await heldList(again)).map(item => item.label), ['Social Security number'], 'the new click’s list replaces the old one');
  again.vault.holds = [];
  again.vault.values = { ...SENSITIVE_SAVED };
  await autofill(again);
  assert.equal(await heldList(again), undefined);
});

test('an embedded form’s held details are asked for in that form’s own site’s name, and fill only that frame; a Cancel there keeps them (#176)', async () => {
  const child = secondFrame({ enabled: true, fields: [{ name: 'ssn', key: 'ssn', label: 'Social Security number' }] });
  const w = holding({ fields: [{ name: 'name', key: 'fullName' }, { name: 'dob', key: 'birthDate', label: 'Date of birth' }], frames: [child],
    desktop: { sensitiveError: request => request.url.startsWith(FRAME_ORIGIN) ? 'You cancelled this field request.' : undefined } });
  const result = plain((await autofill(w)).data);
  assert.equal(result.held, 2);
  const dob = `f0:${w.page.idOf('dob')}`, ssn = `f4:${child.page.idOf('ssn')}`;
  assert.deepEqual(await heldList(w), [{ id: dob, label: 'Date of birth' }, { id: ssn, label: 'Social Security number' }]);
  assert.equal((await fillHeld(w)).errorKey, 'worker.heldCancelled');
  assert.deepEqual(w.native.filter(call => call.sensitive).map(({ url, fields }) => [url, fields]), [[`${ORIGIN}/intake`, ['birthDate']], [`${FRAME_ORIGIN}/form`, ['ssn']]],
    'one request for each site, in its own name');
  assert.deepEqual([w.page.answered(), child.page.answered()], [['name', 'dob'], []], 'the host page’s allowed detail filled; the form’s waits');
  assert.deepEqual(await heldList(w), [{ id: ssn, label: 'Social Security number' }]);
  const kept = plain((await w.panel({ type: 'ui:pageState' })).data).result;
  assert.deepEqual([kept.filled, kept.held, kept.needYou], [2, 1, [ssn]], 'the tab’s result counts what filled, and what still waits');
  w.vault.sensitiveError = null;
  assert.equal(plain((await fillHeld(w)).data).filled, 3);
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:fill' && call.frameId === 4).map(call => [call.documentId, call.values]), [['doc-4', { ssn: '123-45-6789' }]]);
  assert.deepEqual(child.page.answered(), ['ssn']);
});

test('an embedded form that moved on takes its held questions with it; nothing is asked for them (#176)', async () => {
  const child = secondFrame({ enabled: true, fields: [{ name: 'ssn', key: 'ssn', label: 'Social Security number' }] });
  const w = holding({ fields: [{ name: 'name', key: 'fullName' }], frames: [child] });
  await autofill(w);
  assert.equal((await heldList(w)).length, 1);
  child.documentId = 'doc-4-next';
  assert.equal(await heldList(w), undefined, 'the list forgets it');
  const response = plain(await fillHeld(w));
  assert.equal(response.errorKey, 'worker.heldGone');
  assert.equal(w.native.some(call => call.sensitive), false);
});

test('Fill sensitive details fills under the access receipt the app gave it, on the page it was made for (#176)', async () => {
  const w = holding({ duringStatus: (vault, count) => { if (count === 3) vault.accessRevision++; } });
  await autofill(w);
  const changed = plain(await fillHeld(w));
  assert.equal(changed.errorKey, 'worker.accessChanged');
  assert.deepEqual(w.page.answered(), ['name'], 'nothing reaches the page');
  assert.equal((await heldList(w)).length, 2, 'they still wait');
  const locked = holding();
  await autofill(locked);
  locked.vault.unlocked = false;
  assert.equal((await fillHeld(locked)).errorKey, 'worker.unlockToAutofill');
  assert.deepEqual(locked.page.answered(), ['name']);
});

test('a held list the desktop gets wrong fills nothing and shows a fixed error (#176)', async () => {
  // A field it wasn't asked for, one named twice, one it also answered, an empty list, or not a list.
  for (const holds of [() => ['zip'], () => ['ssn', 'ssn'], () => ['ssn'], () => [], () => 'ssn']) {
    const w = holding({ desktop: { holds } });
    const result = plain((await autofill(w)).data);
    assert.deepEqual([result.state, result.messageKey], ['error', 'worker.desktopUnexpected'], holds.toString());
    assert.deepEqual(w.page.answered(), [], holds.toString());
    assert.equal(await heldList(w), undefined);
  }
  // The reply to Fill sensitive details never holds anything back.
  const w = holding();
  await autofill(w);
  w.vault.holds = request => request.sensitive ? ['ssn'] : undefined;
  assert.equal((await fillHeld(w)).errorKey, 'worker.desktopUnexpected');
  assert.deepEqual(w.page.answered(), ['name']);
  assert.equal((await heldList(w)).length, 2, 'they still wait');
});

test('the held list holds the reload, as the need-you list does (#176)', async () => {
  const w = updating({ enabled: true, fields: sensitiveForm(), desktop: { values: SENSITIVE_SAVED, holds: ['birthDate', 'ssn'] } });
  await autofill(w);
  await statusRow(w);
  assert.equal(w.reloads(), 0);
  assert.equal(plain((await fillHeld(w)).data).filled, 3);
  await statusRow(w);
  assert.equal(w.reloads(), 0, 'the pickup day still needs the applicant');
});

const customQuestion = { name: 'membership', label: 'Membership number', type: 'text' };
test('saved custom answers use exact question IDs, precede model guesses, and request no catalog', async () => {
  const w = siteWorker({ enabled: true, fields: [{ ...customQuestion }, { name: 'name', key: 'firstName' }], desktop: {
    customFieldsAvailable: true,
    custom: request => ({ values: { [request.fields[0].id]: 'MEM-2042' }, accessRevision: 0 })
  } });
  const reply = await w.panel({ type: 'ui:autofill', confirmed: true });
  assert.equal(reply.ok, true); assert.equal(reply.data.state, 'done');
  assert.equal(w.page.fields[0].answered, 'MEM-2042');
  assert.equal(w.page.fields[1].answered, 'Synthetic private first');
  const requests = w.native.filter(item => item.type === 'getCustomFields');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].fields, [{ id: 'sh-1-0', label: 'Membership number', type: 'text', options: [] }]);
  assert.doesNotMatch(JSON.stringify(reply), /MEM-2042|Synthetic private first/);
});
test('a desktop with no custom-answer capability receives no custom request', async () => {
  const w = siteWorker({ enabled: true, fields: [{ ...customQuestion }] });
  await w.panel({ type: 'ui:autofill', confirmed: true });
  assert.equal(w.native.some(item => item.type === 'getCustomFields'), false);
  assert.equal(w.page.fields[0].answered, undefined);
});
test('canceled, unrelated, malformed or stale custom replies never fill an answer', async () => {
  for (const custom of [() => ({ values: {}, accessRevision: 0 }),
    () => ({ values: { invented: 'secret' }, accessRevision: 0 }),
    request => ({ values: { [request.fields[0].id]: 'x'.repeat(1001) }, accessRevision: 0 }),
    request => ({ values: { [request.fields[0].id]: 'secret' }, accessRevision: 1 }),
    (request, vault, tab) => { tab.url = `${ORIGIN}/changed`; return { values: { [request.fields[0].id]: 'secret' }, accessRevision: 0 }; }]) {
    const w = siteWorker({ enabled: true, fields: [{ ...customQuestion }], desktop: { customFieldsAvailable: true, custom } });
    await w.panel({ type: 'ui:autofill', confirmed: true });
    assert.equal(w.page.fields[0].answered, undefined);
  }
});
test('custom questions in an embedded form are released only under its own approved origin', async () => {
  const embedded = { frameId: 4, origin: 'https://forms.example.net', enabled: true, fields: [{ ...customQuestion }] };
  const w = siteWorker({ enabled: true, fields: [], frames: [embedded], desktop: { customFieldsAvailable: true,
    custom: request => ({ values: { [request.fields[0].id]: 'FRAME-ONLY' }, accessRevision: 0 }) } });
  await w.panel({ type: 'ui:autofill', confirmed: true });
  assert.equal(embedded.page.fields[0].answered, 'FRAME-ONLY');
  assert.deepEqual(w.native.filter(item => item.type === 'getCustomFields').map(item => item.url), ['https://forms.example.net/form']);
  assert.equal(w.page.fields.length, 0);
});


test('custom question batches stay below native byte and count limits and continue after successful fills', async () => {
  const fields = Array.from({ length: 45 }, (_, i) => ({ name: `member${i}`, label: `Preferred option ${i}`, type: 'select', options: Array.from({ length: 30 }, (_, n) => '界'.repeat(90) + n) }));
  const w = siteWorker({ enabled: true, fields, desktop: { customFieldsAvailable: true,
    custom: request => ({ values: Object.fromEntries(request.fields.map(field => [field.id, field.options[0]])), accessRevision: 0 }) } });
  const result = await autofill(w);
  assert.equal(result.data.state, 'done');
  const requests = w.native.filter(call => call.type === 'getCustomFields');
  assert.ok(requests.length > 1 && requests.length <= 4);
  assert.ok(requests.every(call => call.fields.length <= 40 && Buffer.byteLength(JSON.stringify(call)) <= 48 * 1024));
  assert.equal(w.page.fields.filter(field => field.answered).length, requests.reduce((n, request) => n + request.fields.length, 0));
});

test('partial custom rejection replans successful answers and never repeats the rejected assignment in that pass', async () => {
  const w = siteWorker({ enabled: true, fields: [{ ...customQuestion }, { name: 'badge', label: 'Badge code', type: 'text', rejects: true }], desktop: {
    customFieldsAvailable: true, custom: request => ({ values: Object.fromEntries(request.fields.map(field => [field.id, 'SAVED-42'])), accessRevision: 0 })
  } });
  const reply = await autofill(w);
  assert.equal(reply.data.state, 'done'); assert.equal(reply.data.filled, 1);
  assert.equal(w.page.fields[0].answered, 'SAVED-42'); assert.equal(w.page.fields[1].answered, undefined);
  assert.equal(w.native.filter(call => call.type === 'getCustomFields').length, 1);
  assert.equal(reply.data.needYou.length, 1);
});

// #186: Remember for next time keeps the applicant's answers to open questions as custom answers, and a custom answer about
// a sensitive subject waits for Fill sensitive details.
const EMPLID_Q = { name: 'emplid', label: 'EMPLID', type: 'text' };
const HEARD_Q = { name: 'heard', label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer'] };
const DAY_Q = { name: 'day', label: 'Preferred pickup day', type: 'select', options: ['Monday', 'Friday'] };
const INCOME_Q = { name: 'income', label: 'Monthly income', type: 'number' };
const rememberAnswers = (w, ids) => w.panel({ type: 'ui:rememberAnswers', ids, confirmed: true });
const rememberable = async w => plain((await w.panel({ type: 'ui:pageState' })).data).rememberable;
const remembering = (fields = [{ ...EMPLID_Q }, { ...HEARD_Q }, { ...DAY_Q }, { name: 'name', key: 'fullName' }, { name: 'sign', label: 'Signature', type: 'text' }], options = {}) =>
  siteWorker({ enabled: true, fields, ...options });

test('the summary says how many answers came from custom answers (#186)', async () => {
  const w = siteWorker({ enabled: true, fields: [{ ...EMPLID_Q }, { name: 'name', key: 'fullName' }], desktop: { customFieldsAvailable: true,
    custom: request => ({ values: { [request.fields[0].id]: 'SYN-4471' }, accessRevision: 0 }) } });
  const result = plain((await autofill(w)).data);
  assert.deepEqual([result.filled, result.custom, result.messageKey], [2, 1, 'result.fromCustom']);
  assert.equal(result.message, 'Filled 2. Check your answers before you submit. 1 from your custom answers.');
  assert.equal(strings.text('es', result.messageKey, result.messageParams).includes('1'), true);
  const none = plain((await autofill(siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }] }))).data);
  assert.equal(none.custom, undefined);
});

test('a custom answer the app holds back for its sensitive subject waits for Fill sensitive details, and no AI guesses it (#186)', async () => {
  const held = request => request.fields.filter(field => field.label === 'Monthly income').map(field => field.id);
  const custom = request => request.sensitive ? { values: Object.fromEntries(request.fields.map(field => [field.id, '1200'])), accessRevision: 0 }
    : { values: {}, held: held(request), accessRevision: 0 };
  const suggested = [];
  const w = siteWorker({ enabled: true, fields: [{ ...INCOME_Q }, { name: 'name', key: 'fullName' }], desktop: { ...layaDesktop({ suggestFields: request => { suggested.push(...request.fields.map(field => field.label)); return { suggestions: {} }; } }),
    customFieldsAvailable: true, custom } });
  const result = plain((await autofill(w)).data);
  const income = idOf(w, 'income');
  assert.deepEqual([result.filled, result.held, result.needYou], [1, 1, [income]]);
  assert.equal(result.message, 'Filled 1 · 1 need you. Check your answers before you submit. 1 sensitive detail waits until you click Fill sensitive details in the side panel.');
  assert.equal(w.page.fields[0].answered, undefined);
  assert.deepEqual(suggested, [], 'Laya never guesses a question whose custom answer waits');
  assert.deepEqual(plain((await w.panel({ type: 'ui:pageState' })).data).held, [{ id: income, label: 'Monthly income' }]);
  assert.equal(await rememberable(w), undefined, 'its answer is saved: it is never offered to remember');

  const asked = w.native.length;
  const filled = plain((await w.panel({ type: 'ui:fillHeld', confirmed: true })).data);
  const request = w.native.slice(asked).find(call => call.type === 'getCustomFields');
  assert.deepEqual({ url: request.url, fields: request.fields, sensitive: request.sensitive }, { url: `${ORIGIN}/intake`, fields: [{ id: w.page.idOf('income'), label: 'Monthly income', type: 'number', options: [] }], sensitive: true });
  assert.equal(w.page.fields[0].answered, '1200');
  assert.deepEqual([filled.filled, filled.held, filled.needYou], [2, undefined, []]);
  assert.equal(filled.message, 'Filled 2. Check your answers before you submit. 1 from your custom answers.');

  // A held list naming a question the worker didn't ask about, or one it was given an answer for, fills nothing.
  for (const odd of [request => ({ values: {}, held: ['sh-9-9'], accessRevision: 0 }), request => ({ values: { [request.fields[0].id]: '1200' }, held: [request.fields[0].id], accessRevision: 0 }),
    () => ({ values: {}, held: [], accessRevision: 0 })]) {
    const refused = siteWorker({ enabled: true, fields: [{ ...INCOME_Q }], desktop: { customFieldsAvailable: true, custom: odd } });
    assert.equal(plain((await autofill(refused)).data).messageKey, 'worker.desktopUnexpected');
    assert.equal(refused.page.fields[0].answered, undefined);
  }
});

test('after Autofill, the side panel offers Remember for next time for the open questions a custom answer may fill, unchecked when they change over time (#186)', async () => {
  const w = remembering();
  await autofill(w);
  const [emplid, heard, day] = ['emplid', 'heard', 'day'].map(name => idOf(w, name));
  assert.deepEqual(await rememberable(w), [{ id: emplid, label: 'EMPLID', timeBound: false, answered: false }, { id: heard, label: 'How did you hear about us?', timeBound: false, answered: false },
    { id: day, label: 'Preferred pickup day', timeBound: true, answered: false }], 'never the signature, nor a question the rules filled');
  assert.equal(plain((await w.launcher({ type: 'ui:pageState' })).data).rememberable, undefined, 'the on-page widget never gets the list');
  w.page.type('emplid', 'SYN-4471');
  assert.deepEqual((await rememberable(w)).map(item => item.answered), [true, false, false]);
  assert.equal(w.contentTypes().includes('secondhand:generic:readOpen'), false, 'no box is read before the click');
  assert.equal(w.nativeTypes().includes('rememberAnswers'), false);
});

test('Remember reads only the boxes the applicant chose, after the side panel’s click, and the app keeps them after its confirmation (#186)', async () => {
  const w = remembering();
  await autofill(w);
  const [emplid, heard, day] = ['emplid', 'heard', 'day'].map(name => idOf(w, name));
  w.page.type('emplid', 'SYN-4471'); w.page.type('heard', 'Church'); w.page.type('day', 'Friday');
  assert.equal(await w.panel({ type: 'ui:rememberAnswers', ids: [emplid] }), undefined, 'only a confirmed click');
  assert.equal(await w.launcher({ type: 'ui:rememberAnswers', ids: [emplid], confirmed: true }), undefined, 'only the side panel');
  const response = await rememberAnswers(w, [emplid, heard]);
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(plain(response.data), { remembered: 2 });
  assert.deepEqual(w.content.filter(call => call.type === 'secondhand:generic:readOpen').map(({ frameId, id }) => ({ frameId, id })),
    [{ frameId: 0, id: w.page.idOf('emplid') }, { frameId: 0, id: w.page.idOf('heard') }], 'only the chosen boxes');
  assert.deepEqual(w.native.filter(call => call.type === 'rememberAnswers').map(({ url, answers }) => ({ url, answers })), [{ url: `${ORIGIN}/intake`, answers: [
    { label: 'EMPLID', type: 'text', options: [], answer: 'SYN-4471' }, { label: 'How did you hear about us?', type: 'radio', options: ['Friend', 'Church', 'Flyer'], answer: 'Church' }] }]);
  assert.deepEqual((await rememberable(w)).map(item => item.id), [day], 'remembered answers leave the list');
  assert.equal((await rememberAnswers(w, [emplid])).errorKey, 'worker.answerGone', 'and can’t be remembered twice');
  for (const ids of [[], 'emplid', [emplid, emplid], [42], Array.from({ length: 21 }, () => day)]) {
    const reply = await rememberAnswers(w, ids);
    assert.ok(reply === undefined || reply.errorKey === 'worker.answerGone', JSON.stringify(ids));
  }
});

test('an empty, unreadable or repeated answer, or the app’s refusal, remembers nothing and says why (#186)', async () => {
  const w = remembering();
  await autofill(w);
  const emplid = idOf(w, 'emplid');
  assert.equal((await rememberAnswers(w, [emplid])).errorKey, 'worker.rememberEmpty');
  w.page.type('emplid', null);
  assert.equal((await rememberAnswers(w, [emplid])).errorKey, 'worker.rememberUnreadable');
  w.page.fields[0].repeated = true;
  assert.equal((await rememberAnswers(w, [emplid])).errorKey, 'worker.rememberRepeated');
  delete w.page.fields[0].repeated;
  w.page.type('emplid', 'SYN-4471');
  w.vault.rememberError = 'You cancelled. Nothing was remembered.';
  const cancelled = await rememberAnswers(w, [emplid]);
  assert.deepEqual([cancelled.ok, cancelled.errorKey], [false, 'worker.rememberCancelled']);
  const full = 'You have 50 custom answers, the most SecondHand keeps. Remove one in My information, then remember this answer again.';
  w.vault.rememberError = full;
  assert.deepEqual(plain((await rememberAnswers(w, [emplid])).errorParams), { detail: full }, 'the app’s own words when its list is full');
  assert.ok((await rememberable(w)).some(item => item.id === emplid), 'a refused answer stays on the list');
  assert.equal(w.nativeTypes().filter(type => type === 'rememberAnswers').length, 2);
});

test('an embedded form’s answer is remembered in that form’s own site’s name, and the list goes with the page or the site (#186)', async () => {
  const child = secondFrame({ enabled: true, url: EMBED_URL, fields: [{ ...EMPLID_Q }] });
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }], frames: [child] });
  await autofill(w);
  const emplid = `f4:${child.page.idOf('emplid')}`;
  child.page.type('emplid', 'SYN-4471');
  assert.deepEqual(await rememberable(w), [{ id: emplid, label: 'EMPLID', timeBound: false, answered: true }]);
  assert.equal((await rememberAnswers(w, [emplid])).ok, true);
  assert.deepEqual(w.native.filter(call => call.type === 'rememberAnswers').map(call => call.url), [EMBED_URL]);

  const moved = remembering();
  await autofill(moved);
  moved.page.type('emplid', 'SYN-4471');
  moved.events.updated(7, { status: 'loading' });
  assert.equal(await rememberable(moved), undefined);
  assert.equal((await rememberAnswers(moved, [idOf(moved, 'emplid')])).errorKey, 'worker.answerGone');
  const off = remembering();
  await autofill(off);
  off.registered.clear(); off.permissions.clear();
  assert.equal((await rememberAnswers(off, [idOf(off, 'emplid')])).ok, false);
  for (const each of [moved, off]) assert.equal(each.contentTypes().includes('secondhand:generic:readOpen'), false);
});

// #184: a saved answer that names several options of a checkbox question (On-Campus Job and Off-Campus Job are both a job)
// leaves those unchecked. The rest are checked, and the question stays under need-you until the applicant finishes it.
const INCOME = { name: 'income', key: 'incomeSources', label: 'Current Source of Income/Resources', partly: true };

test('a question the rules answered in part counts as filled, stays under need-you, and is never filled again (#184)', async () => {
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...INCOME }],
    desktop: { values: { firstName: 'Synthetic', lastName: 'Applicant', incomeSources: 'job,financial-aid,family-support' } } });
  const result = plain((await autofill(w)).data);
  const income = `f0:${w.page.idOf('income')}`;
  assert.deepEqual([result.filled, result.needYou, result.message], [2, [income], 'Filled 2 · 1 need you. Check your answers before you submit.']);
  const fills = w.content.filter(call => call.type === 'secondhand:generic:fill');
  assert.deepEqual(fills.map(call => call.assignments.map(item => item.key)), [['fullName', 'incomeSources']], 'filled once, never again');
  assert.equal((await w.panel({ type: 'ui:focusField', key: income, confirmed: true })).ok, true, 'the need-you list can show it');
  // The next click leaves it as it is, still under need-you.
  const again = plain((await autofill(w)).data);
  assert.deepEqual(again.needYou, [`f0:${w.page.idOf('income')}`]);
  assert.equal(w.content.filter(call => call.type === 'secondhand:generic:fill').length, 1);
});

test('held income sources answered in part by Fill sensitive details count as filled and stay under need-you; the next click holds nothing for them (#184)', async () => {
  const w = siteWorker({ enabled: true, fields: [{ name: 'name', key: 'fullName' }, { ...INCOME }],
    desktop: { values: { firstName: 'Synthetic', lastName: 'Applicant', incomeSources: 'job,financial-aid' }, holds: ['incomeSources'] } });
  const first = plain((await autofill(w)).data);
  const income = `f0:${w.page.idOf('income')}`;
  assert.deepEqual([first.filled, first.needYou, first.held], [1, [income], 1]);
  const response = await w.panel({ type: 'ui:fillHeld', confirmed: true });
  assert.equal(response.ok, true, response.error);
  const result = plain(response.data);
  assert.deepEqual([result.filled, result.needYou, result.held, result.message], [2, [income], undefined, 'Filled 2 · 1 need you. Check your answers before you submit.']);
  assert.equal(await heldList(w), undefined);
  const asked = w.native.filter(call => call.type === 'getFields').length;
  const again = plain((await autofill(w)).data);
  assert.deepEqual([again.needYou, again.held], [[`f0:${w.page.idOf('income')}`], undefined], 'answered in part, it waits for the applicant, not for the sensitive prompt');
  assert.equal(w.native.filter(call => call.type === 'getFields').length, asked, 'and nothing is asked of the app for it');
});
