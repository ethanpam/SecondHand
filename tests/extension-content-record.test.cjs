'use strict';
// Real content.js + Iowa adapters on the sanitized job fixture. Native approval is
// outside this content boundary; these tests never contact a browser or native host.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { plain, evalFile, layoutElements, tick } = require('./helpers/harness.cjs');
const fixture = require('./fixtures/iowa-job-history.cjs');
const EXTENSION_ID = 'a'.repeat(32);
function tab(t) {
  const dom = new JSDOM(fixture.makeHtml(), { url: fixture.URL, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  layoutElements(window); window.Element.prototype.scrollIntoView = () => {};
  fixture.attachHandlers(document);
  let listener, now = Date.now(); window.Date.now = () => now;
  window.chrome = { runtime: { id: EXTENSION_ID, getURL: file => `chrome-extension://${EXTENSION_ID}/${file}`, onMessage: { addListener: fn => { listener = fn; } } } };
  for (const file of ['address-policy.js', 'iowa-later-adapter.js', 'iowa-record-adapter.js', 'iowa-adapter.js', 'generic-adapter.js', 'page-text.js', 'content.js']) evalFile(window, `extension/${file}`);
  function request(message, sender = { id: EXTENSION_ID }) { let value; listener(message, sender, result => { value = result; }); return value === undefined ? value : plain(value); }
  return { window, document, request, state: () => request({ type: 'secondhand:pageState' }),
    context: state => request({ type: 'secondhand:recordContext', token: state.scan.token, pageInstance: state.pageInstance }),
    selectOwner: value => { const owner = document.getElementById('answerSets0.personSelection'); owner.value = value; owner.dispatchEvent(new window.Event('change', { bubbles: true })); },
    move: url => { window.history.replaceState({}, '', url); window.dispatchEvent(new window.PopStateEvent('popstate')); },
    advanceClock: ms => { now += ms; } };
}

test('record context is private to a current extension request, while ordinary page metadata contains no owner or answers', async t => {
  const page = tab(t); await tick();
  assert.deepEqual(page.request({ type: 'secondhand:recordContext', token: 'absent', pageInstance: 'absent' }), { ok: false });
  const blank = page.state(); assert.equal(blank.page.pageKey, 'iowa-job-history');
  assert.deepEqual(page.context(blank), { ok: true }, 'an unselected person is never chosen implicitly');
  page.selectOwner('1'); await tick();
  const selected = page.state(), again = page.state();
  assert.equal(selected.scan.token, again.scan.token, 'unchanged record previews can be reused');
  assert.deepEqual(page.context(selected), { ok: true, personName: 'Jordan Sample' });
  assert.doesNotMatch(JSON.stringify(selected), /Avery|Jordan|Sample|Example|answerSets|bindings|element|personName/);
  assert.equal(page.request({ type: 'secondhand:recordContext', token: selected.scan.token, pageInstance: selected.pageInstance }, { id: 'untrusted-extension' }), undefined);
});

test('record context rejects a stale token, another document, a changed URL, expiry, and a consumed fill preview', async t => {
  const page = tab(t), other = tab(t); await tick();
  const state = page.state(), otherState = other.state();
  assert.notEqual(state.pageInstance, otherState.pageInstance);
  for (const override of [{ token: 'wrong' }, { pageInstance: otherState.pageInstance }, { pageInstance: undefined }]) {
    assert.deepEqual(page.request({ type: 'secondhand:recordContext', token: state.scan.token, pageInstance: state.pageInstance, ...override }), { ok: false });
  }
  page.window.history.replaceState({}, '', `${fixture.URL}?changed=1`);
  assert.deepEqual(page.context(state), { ok: false });
  page.window.history.replaceState({}, '', fixture.URL);
  page.advanceClock(120001);
  assert.deepEqual(page.context(state), { ok: false });
  const fresh = page.state(); assert.notEqual(fresh.scan.token, state.scan.token);
  assert.deepEqual(page.context(fresh), { ok: true });
  const wrongDocument = page.request({ type: 'secondhand:fill', token: fresh.scan.token, pageInstance: otherState.pageInstance, fields: ['person'], values: { person: 'Avery Example' } });
  assert.equal(wrongDocument.ok, false);
  assert.equal(page.document.getElementById('answerSets0.personSelection').value, '');
  assert.deepEqual(page.context(fresh), { ok: false }, 'even a refused fill consumes its preview');
  const approved = page.state();
  assert.deepEqual(page.request({ type: 'secondhand:fill', token: approved.scan.token, pageInstance: approved.pageInstance, fields: ['person'], values: { person: 'Avery Example' } }), { ok: true, filledCount: 1, skippedCount: 0 });
  assert.deepEqual(page.context(approved), { ok: false });
  assert.doesNotMatch(JSON.stringify(page.state()), /Avery|Example|personName/);
});

test('hidden payload and owner changes invalidate the adapter snapshot even without DOM events, then fresh scanning restores context', async t => {
  const page = tab(t); await tick();
  const first = page.state();
  page.document.querySelector('input[type="hidden"]').value = 'synthetic payload change';
  assert.deepEqual(page.context(first), { ok: false });
  const refreshed = page.state();
  assert.notEqual(refreshed.scan.token, first.scan.token, 'private hidden-state validation prevents reuse despite no mutation event');
  assert.deepEqual(page.context(refreshed), { ok: true });
  page.document.getElementById('answerSets0.personSelection').value = '1';
  assert.deepEqual(page.context(refreshed), { ok: false });
  const ownerChanged = page.state();
  assert.deepEqual(page.context(ownerChanged), { ok: true, personName: 'Jordan Sample' });
  assert.doesNotMatch(JSON.stringify(ownerChanged), /Jordan|Sample|synthetic payload change/);
});

test('leaving the allowed portal removes the widget and clears previews; returning does not revive an earlier approval', async t => {
  const page = tab(t); await tick();
  const original = page.state(), host = page.document.querySelector('[data-secondhand-assistant]');
  assert.ok(host?.isConnected);
  page.move('https://hhsservices.iowa.gov/unrelated');
  assert.equal(host.isConnected, false);
  assert.equal(page.request({ type: 'secondhand:pageState' }), undefined);
  assert.equal(page.context(original), undefined, 'an out-of-scope route does not answer extension requests');
  page.move(fixture.URL);
  assert.equal(host.isConnected, true);
  assert.deepEqual(page.context(original), { ok: false });
  const fresh = page.state(); assert.notEqual(fresh.scan.token, original.scan.token);
  assert.deepEqual(page.context(fresh), { ok: true });
  page.window.dispatchEvent(new page.window.PageTransitionEvent('pagehide'));
  assert.deepEqual(page.context(fresh), { ok: false }, 'pagehide revokes previews as well as its observer and timer');
});
