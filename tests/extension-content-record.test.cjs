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
  for (const file of ['address-policy.js', 'iowa-later-adapter.js', 'iowa-record-adapter.js', 'iowa-adapter.js', 'generic-adapter.js', 'page-text.js']) evalFile(window, `extension/${file}`);
  // jsdom sends no trusted input event for a keystroke or a pick from a list: userInput gives the person's own input
  // to content.js's input listener as Chrome sends it, trusted and from the control they used.
  const inputListeners = [], listen = document.addEventListener;
  document.addEventListener = function (type, callback, options) {
    if (type === 'input') inputListeners.push(callback);
    return listen.call(this, type, callback, options);
  };
  evalFile(window, 'extension/content.js');
  document.addEventListener = listen;
  assert.equal(inputListeners.length, 1, 'content.js listens for input once');
  function request(message, sender = { id: EXTENSION_ID }) { let value; listener(message, sender, result => { value = result; }); return value === undefined ? value : plain(value); }
  return { window, document, request, state: () => request({ type: 'secondhand:pageState' }),
    userInput: (control, value) => { control.focus(); control.value = value; inputListeners[0]({ isTrusted: true, composedPath: () => [control] }); },
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

test('page state never takes a script’s input for the person typing, so SecondHand’s own fills cannot hold Autofill back', async t => {
  const page = tab(t); await tick();
  assert.equal(page.state().typing, false);
  // The person's own keystrokes are trusted events, which only a real browser sends: the extension smoke types them.
  page.selectOwner('1'); await tick();
  const box = [...page.document.querySelectorAll('input[type="text"]')].find(input => !input.disabled);
  box.focus();
  box.value = 'Set by a script';
  box.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  assert.equal(page.document.activeElement, box);
  assert.equal(page.state().typing, false);
});

test('page state says the person is typing while they are in the text box they typed in, and not once they leave it', async t => {
  const page = tab(t); await tick();
  page.selectOwner('1'); await tick();
  const [box, other] = [...page.document.querySelectorAll('input[type="text"]')].filter(input => !input.disabled);
  page.userInput(box, 'D');
  assert.equal(page.state().typing, true, 'they may not have finished the answer');
  box.blur();
  assert.equal(page.state().typing, false, 'they left the box');
  box.focus();
  assert.equal(page.state().typing, false, 'coming back to the box is not typing in it');
  // Moving to another box leaves the first; only typing in the new one counts.
  page.userInput(box, 'Da');
  other.focus();
  assert.equal(page.state().typing, false);
  page.userInput(other, '4');
  assert.equal(page.state().typing, true);
  // A textarea is a text box too.
  const notes = page.document.createElement('textarea');
  page.document.body.append(notes);
  page.userInput(notes, 'Started in March');
  assert.equal(page.state().typing, true);
  notes.blur();
  assert.equal(page.state().typing, false);
  // A page that takes away the box the person is in sends no focusout: they are no longer in it.
  page.userInput(notes, 'Started in April');
  notes.remove();
  assert.equal(page.state().typing, false);
});

test('a choice the person makes is not typing, so Autofill need not wait for them to leave it', async t => {
  const page = tab(t); await tick();
  page.selectOwner('1'); await tick();
  const select = page.document.getElementById('answerSets0.personSelection');
  page.userInput(select, '1');
  assert.equal(page.document.activeElement, select);
  assert.equal(page.state().typing, false, 'a list');
  // jsdom's own click on a checkbox sends a trusted input event, as Chrome does.
  const checkbox = page.document.querySelector('input[type="checkbox"]');
  checkbox.focus(); checkbox.click();
  assert.equal(checkbox.checked, true);
  assert.equal(page.document.activeElement, checkbox);
  assert.equal(page.state().typing, false, 'a checkbox');
});

test('a text box inside a page component’s shadow root counts as typing while the person is in it', async t => {
  const page = tab(t); await tick();
  const host = page.document.createElement('div');
  page.document.body.append(host);
  const box = page.document.createElement('input');
  host.attachShadow({ mode: 'open' }).append(box);
  page.userInput(box, 'D');
  assert.equal(page.document.activeElement, host, 'the page sees only the component');
  assert.equal(page.state().typing, true);
  box.blur();
  assert.equal(page.state().typing, false);
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
