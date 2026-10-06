'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { layoutElements, evalFile, plain, tick } = require('./helpers/harness.cjs');
function content(t, { top = true, html = '<div id="host"></div>', shadow, navigation } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}`, { url: 'https://forms.example.test/apply', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  if (!top) dom.reconfigure({ windowTop: {} });
  const { window } = dom; layoutElements(window);
  const root = shadow === undefined ? null : window.document.getElementById('host').attachShadow({ mode: 'open' });
  if (root) root.innerHTML = shadow;
  const listeners = [], reports = [];
  window.chrome = { runtime: { id: 'secondhand-test', getURL: path => `chrome-extension://secondhand-test/${path}`, onMessage: { addListener: listener => listeners.push(listener) },
    sendMessage: async message => { reports.push(plain(message)); return { frames: false }; } } };
  if (navigation) window.SecondHandNavigation = navigation;
  evalFile(window, 'extension/generic-adapter.js'); evalFile(window, 'extension/generic-content.js');
  return { window, root, reports, cards: () => window.document.querySelectorAll('[data-secondhand-assistant]').length,
    tell(message, sender = 'secondhand-test') { let result; listeners[0](message, { id: sender }, value => { result = plain(value); }); return result; },
    async ask(message) { return new Promise(resolve => listeners[0](message, { id: 'secondhand-test' }, value => resolve(plain(value)))); } };
}
const changed = async t => { await tick(); t.mock.timers.tick(500); await tick(); };
const history = (page, type) => page.window.dispatchEvent(new page.window.PageTransitionEvent(type, { persisted: true }));

test('shadow labels detect text-only changes and keep one widget, then stop on a protected question', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = content(t, { shadow: '<label for="detail">Signature</label><input id="detail">' }); await tick(); assert.equal(page.cards(), 0);
  page.root.querySelector('label').firstChild.data = 'First name'; await changed(t); assert.equal(page.cards(), 1);
  page.root.querySelector('label').firstChild.data = 'Signature'; await changed(t); assert.equal(page.cards(), 0);
});

test('attaching an open root after startup is discovered without patching attachShadow, including an embedded frame', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const top of [true, false]) {
    const page = content(t, { top }); await tick(); const attach = page.window.Element.prototype.attachShadow;
    const root = page.window.document.getElementById('host').attachShadow({ mode: 'open' }); root.innerHTML = '<label for="n">Full name</label><input id="n">';
    await tick(); t.mock.timers.tick(1000); await tick();
    assert.equal(page.cards(), top ? 1 : 0); assert.equal(page.window.Element.prototype.attachShadow, attach);
    if (!top) assert.ok(page.reports.some(report => report.helps === true));
    root.innerHTML = ''; await changed(t); assert.equal(page.cards(), 0);
    if (!top) assert.equal(page.reports.at(-1).helps, false);
  }
});

test('shadow observation restores once from BFCache and remains stopped after site off', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const page = content(t, { shadow: '<p>Loading</p>' }); await tick();
  history(page, 'pagehide'); page.root.innerHTML = '<label for="name">Full name</label><input id="name">';
  t.mock.timers.tick(1500); await tick(); assert.equal(page.cards(), 0);
  history(page, 'pageshow'); history(page, 'pageshow'); await tick(); assert.equal(page.cards(), 1);
  page.tell({ type: 'secondhand:generic:off' });
  page.root.innerHTML = '<label for="zip">ZIP code</label><input id="zip">'; history(page, 'pagehide'); history(page, 'pageshow');
  t.mock.timers.tick(1500); await tick(); assert.equal(page.cards(), 0);
  assert.equal(page.tell({ type: 'secondhand:generic:plan' }), undefined);
});

test('shadow custom assignments fill through the real content boundary with metadata-only responses', async t => {
  const page = content(t, { shadow: '<div role="textbox" aria-label="Favorite quotation" contenteditable="true"></div>' });
  const plan = await page.ask({ type: 'secondhand:generic:plan' }); assert.equal(plan.unmatched[0].type, 'textarea');
  const id = plan.unmatched[0].id, secret = 'Synthetic private text\nwith two lines';
  const result = await page.ask({ type: 'secondhand:generic:fill', token: plan.token, assignments: [{ id, custom: true }], values: { [id]: secret } });
  assert.deepEqual(result.filled, [id]); assert.equal(page.root.querySelector('[contenteditable]').textContent, secret);
  assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(page.reports).includes(secret), false);
  assert.equal(page.tell({ type: 'secondhand:generic:plan' }, 'wrong-extension'), undefined);
});

test('navigation messages delegate only a valid token, hide the widget during inspection, and respect off', t => {
  const calls = []; let page;
  const navigation = { snapshot(doc) { calls.push(['snapshot', doc]); assert.equal(doc.querySelector('[data-secondhand-assistant]').style.visibility, 'hidden'); return { canAdvance: true, token: 'one', step: 'static' }; },
    advance(doc, token) { calls.push(['advance', doc, token]); return { advanced: true }; } };
  page = content(t, { html: '<label for="name">First name</label><input id="name">', navigation });
  assert.deepEqual(page.tell({ type: 'secondhand:generic:navigation' }), { canAdvance: true, token: 'one', step: 'static' });
  assert.deepEqual(page.tell({ type: 'secondhand:generic:advance', token: 4 }), { advanced: false });
  assert.deepEqual(page.tell({ type: 'secondhand:generic:advance', token: 'one' }), { advanced: true });
  assert.equal(calls.length, 2); assert.equal(calls[1][2], 'one');
  assert.equal(page.window.document.querySelector('[data-secondhand-assistant]').style.visibility, '');
  page.tell({ type: 'secondhand:generic:off' }); assert.equal(page.tell({ type: 'secondhand:generic:navigation' }), undefined); assert.equal(calls.length, 2);
});

test('absent navigation module leaves the page manual and cannot advance', t => {
  const page = content(t);
  assert.deepEqual(page.tell({ type: 'secondhand:generic:navigation' }), { canAdvance: false });
  assert.deepEqual(page.tell({ type: 'secondhand:generic:advance', token: 'unknown' }), { advanced: false });
});

test('a checkbox question answered in part says so through the content boundary, in the fill and in the next plan (#184)', async t => {
  const boxes = ['Financial Aid', 'Family Support', 'On-Campus Job', 'Off-Campus Job'].map((value, n) => `<label><input type="checkbox" name="income" id="i${n}" value="${value}"> ${value}</label>`).join('');
  const page = content(t, { html: `<form><fieldset><legend>Current Source of Income/Resources</legend>${boxes}</fieldset></form>` });
  const plan = await page.ask({ type: 'secondhand:generic:plan' });
  const [{ id, key }] = plan.matched;
  assert.equal(key, 'incomeSources');
  const result = await page.ask({ type: 'secondhand:generic:fill', token: plan.token, assignments: [{ id, key, guessed: false }], values: { incomeSources: 'job,financial-aid' } });
  assert.deepEqual([result.filled, result.partial], [[id], [id]]);
  const again = await page.ask({ type: 'secondhand:generic:plan' });
  assert.deepEqual(again.matched.map(field => ({ key: field.key, partial: field.partial })), [{ key: 'incomeSources', partial: true }]);
  const whole = await page.ask({ type: 'secondhand:generic:fill', token: again.token, assignments: [], values: {} });
  assert.deepEqual(whole.partial, []);
});
