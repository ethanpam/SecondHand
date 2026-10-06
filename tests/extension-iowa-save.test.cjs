'use strict';
// #142: Iowa's Save to My information path. On an Iowa page the adapter hasn't verified, content.js lets the general
// engine say which listed boxes hold an answer, and read one box after the applicant's click in the side panel. On a
// page the Iowa rules fill, or one with an Iowa instruction, it reads nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const adapter = require('../extension/iowa-adapter.js');
const personal = require('./fixtures/iowa-personal-information.cjs');
const tellUsMore = require('./fixtures/iowa-tell-us-more.cjs');
const { plain, evalFile, layout } = require('./helpers/harness.cjs');

const extensionId = 'a'.repeat(32);
const REFUSED = { ok: false, error: 'SecondHand fills this page with its Iowa rules.' };
const UNSAFE = { ok: false, error: 'This page could not be checked safely. Review it manually, then rescan.' };
const EXPENSES = `${adapter.PORTAL}/applyForBenefits/expenses`;
const expenses = '<h1>Tell us about your expenses</h1><form>' +
  '<label for="rent">Monthly rent</label><input id="rent">' +
  '<label for="dob">Date of birth (MM/DD/YYYY)</label><input id="dob">' +
  '<label for="county">County</label><input id="county">' +
  '<label for="ssn">Social Security number</label><input id="ssn"></form>';

// An Iowa tab with the content scripts the manifest loads, in its order, and the real Iowa adapter and engine. jsdom has
// no layout, so every node gets a box. `engineCalls` records what the engine was asked about saving.
function iowaTab(t, html = expenses, url = EXPENSES, { engine = true } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  layout(document);
  let listener;
  window.chrome = { runtime: { id: extensionId, getURL: file => `chrome-extension://${extensionId}/${file}`, onMessage: { addListener: callback => { listener = callback; } } } };
  for (const file of ['address-policy.js', 'iowa-adapter.js', 'generic-adapter.js', 'page-text.js']) evalFile(window, `extension/${file}`);
  const engineCalls = [];
  const real = window.SecondHandGeneric;
  window.SecondHandGeneric = engine ? { ...real,
    answeredIds: (...args) => { engineCalls.push('answeredIds'); return real.answeredIds(...args); },
    readAnswer: (...args) => { engineCalls.push('readAnswer'); return real.readAnswer(...args); } } : undefined;
  evalFile(window, 'extension/content.js');
  return {
    document, engineCalls, layout: () => layout(document),
    type(id, value) { const element = document.getElementById(id); element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); },
    request(message, sender = { id: extensionId }) { let response; listener(message, sender, value => { response = value; }); return response; }
  };
}
const planOf = tab => {
  const plan = tab.request({ type: 'secondhand:generic:plan' });
  return { token: plan.token, id: key => plan.matched.find(item => item.key === key).id, keys: plain(plan.matched.map(item => item.key)) };
};
const read = (tab, plan, key, extra = {}) => plain(tab.request({ type: 'secondhand:generic:read', token: plan.token, id: plan.id(key), key, ...extra }));

test('on an Iowa page the adapter hasn’t verified, Save reads one listed box after the click, in the profile’s format, and nothing else', t => {
  const tab = iowaTab(t);
  const plan = planOf(tab);
  assert.deepEqual(plan.keys, ['monthlyRent', 'birthDate', 'county', 'ssn']);
  const ids = ['monthlyRent', 'birthDate', 'county'].map(plan.id);
  assert.deepEqual(plain(tab.request({ type: 'secondhand:generic:answered', token: plan.token, ids })), { answered: [] });
  assert.deepEqual(read(tab, plan, 'monthlyRent'), { empty: true });
  tab.type('rent', '$1,200'); tab.type('dob', '4/12/1985'); tab.type('county', 'Story'); tab.type('ssn', '123-45-6789');
  assert.deepEqual(plain(tab.request({ type: 'secondhand:generic:answered', token: plan.token, ids })), { answered: ids }, 'ids only');
  assert.deepEqual(read(tab, plan, 'monthlyRent'), { value: '1200' });
  assert.deepEqual(read(tab, plan, 'birthDate'), { value: '1985-04-12' }, 'in the order the box asks for');
  assert.deepEqual(read(tab, plan, 'county'), { value: 'Story' }, 'the answer only, nothing else of the box');
  assert.deepEqual(read(tab, plan, 'ssn'), { readable: false }, 'never the Social Security number');
  assert.deepEqual(read(tab, plan, 'county', { key: 'city' }), { readable: false }, 'only for the field the rules matched to the box');
  assert.deepEqual(read(tab, plan, 'county', { token: 'plan-other' }), { readable: false }, 'only in the plan that listed it');
  tab.type('rent', 'about 800');
  assert.deepEqual(read(tab, plan, 'monthlyRent'), { unreadable: true });
});

test('on an Iowa page, a typed date with no order on its box is read only when one order fits, and a question asked twice is never read', t => {
  const page = tab => { const plan = planOf(tab); return typed => { tab.type('dob', typed); return read(tab, plan, 'birthDate'); }; };
  const once = page(iowaTab(t, '<h1>Other household information</h1><form><label for="dob">Date of birth</label><input id="dob"></form>', `${adapter.PORTAL}/applyForBenefits/otherInfo`));
  assert.deepEqual(once('04/12/1985'), { unreadable: true }, 'April 12 or December 4: never guessed');
  assert.deepEqual(once('13/04/1985'), { value: '1985-04-13' });
  // Iowa's household page, with a member's section that has no heading of its own.
  const members = iowaTab(t, '<h1>Household Members</h1><form><label for="dob">Date of birth (MM/DD/YYYY)</label><input id="dob">' +
    '<div class="member"><label for="dob2">Date of birth (MM/DD/YYYY)</label><input id="dob2"></div></form>', `${adapter.PORTAL}/applyForBenefits/householdMembers`);
  const plan = planOf(members);
  members.type('dob', '04/12/1985'); members.type('dob2', '09/03/2015');
  assert.deepEqual(read(members, plan, 'birthDate'), { repeated: true }, 'whose date it is can’t be told');
});

test('on a page the Iowa rules fill, or one with an Iowa instruction, Save reads nothing and the engine is never asked', t => {
  const personalUrl = `${adapter.PORTAL}/applyForBenefits/enterPersonalInfo`;
  for (const [html, url] of [[personal.html, personalUrl], [tellUsMore.html, tellUsMore.URL],
    ['<h1>Security check</h1><div id="captchaDiv"><input name="captchaAnswer"></div>', `${adapter.PORTAL}/applyForBenefits/guestLogin`]]) {
    const tab = iowaTab(t, html, url);
    assert.deepEqual(plain(tab.request({ type: 'secondhand:generic:answered', token: 'plan-1', ids: ['sh-1-0'] })), REFUSED, url);
    assert.deepEqual(plain(tab.request({ type: 'secondhand:generic:read', token: 'plan-1', id: 'sh-1-0', key: 'firstName' })), REFUSED, url);
    assert.deepEqual(tab.engineCalls, [], url);
  }
  // A page that shows an Iowa pop-up after the plan: the adapter takes it over, and the box listed before isn't read.
  const tab = iowaTab(t);
  const plan = planOf(tab);
  tab.type('county', 'Story');
  tab.document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true">Are you sure?</div>');
  tab.layout();
  assert.deepEqual(read(tab, plan, 'county'), REFUSED);
  assert.deepEqual(tab.engineCalls, []);
});

test('Save messages refuse other extensions, malformed requests and a missing engine', t => {
  const tab = iowaTab(t);
  const plan = planOf(tab);
  tab.type('county', 'Story');
  assert.equal(tab.request({ type: 'secondhand:generic:read', token: plan.token, id: plan.id('county'), key: 'county' }, { id: 'b'.repeat(32) }), undefined);
  assert.equal(tab.request({ type: 'secondhand:generic:answered', token: plan.token, ids: [plan.id('county')] }, { id: 'b'.repeat(32) }), undefined);
  for (const message of [{ type: 'secondhand:generic:answered', token: plan.token, ids: plan.id('county') }, { type: 'secondhand:generic:answered', token: 7, ids: [] },
    { type: 'secondhand:generic:answered', token: plan.token, ids: [7] }, { type: 'secondhand:generic:read', token: plan.token, id: plan.id('county') },
    { type: 'secondhand:generic:read', token: plan.token, id: [plan.id('county')], key: 'county' }]) {
    assert.deepEqual(plain(tab.request(message)), UNSAFE, JSON.stringify(message));
  }
  assert.deepEqual(tab.engineCalls, [], 'nothing malformed reaches the engine');
  const missing = iowaTab(t, expenses, EXPENSES, { engine: false });
  assert.deepEqual(plain(missing.request({ type: 'secondhand:generic:read', token: 'plan-1', id: 'sh-1-0', key: 'county' })), REFUSED);
});
