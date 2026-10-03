'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const NEEDED = 'Enter your password: it’s needed after SecondHand restarts or every 14 days.';
const PASSWORD = 'synthetic touch password';

// The desktop app's window with its preload API simulated. Touch ID itself is the main process's
// (tests/desktop-touch-id-main.test.cjs); here the renderer only shows what status says.
async function renderer(t, initial = {}, overrides = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://secondhand.invalid/' });
  t.after(() => dom.window.close());
  const window = dom.window;
  const calls = [];
  const listeners = {};
  const view = { status: { exists: true, unlocked: true, lockRevision: 0, extensionId: '', bridgeRunning: true, touchId: 'off', touchIdSupported: true, touchIdNotice: null, ...initial } };
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.secondHand = {
    status: async () => { calls.push(['status']); return structuredClone(view.status); },
    getData: async () => ({ profile: { firstName: 'Synthetic' }, applications: [] }),
    onLocked: callback => { listeners.locked = callback; return () => {}; },
    onUnlocked: callback => { listeners.unlocked = callback; return () => {}; },
    // The guided household setup (#100) has nothing in progress here.
    onProfileChanged: () => () => {},
    setupProgress: async () => null,
    lock: async () => { view.status = { ...view.status, unlocked: false, lockRevision: view.status.lockRevision + 1 }; return structuredClone(view.status); },
    unlock: async password => { calls.push(['unlock', password]); view.status = { ...view.status, unlocked: true }; return structuredClone(view.status); },
    unlockWithTouchId: async () => { calls.push(['unlockWithTouchId']); view.status = { ...view.status, unlocked: true }; return structuredClone(view.status); },
    setTouchIdUnlock: async request => {
      calls.push(['setTouchIdUnlock', structuredClone(request)]);
      view.status = { ...view.status, touchId: request.enabled ? 'ready' : 'off' };
      return structuredClone(view.status);
    },
    ...overrides
  };
  window.eval(script);
  await tick();
  const get = id => window.document.getElementById(id);
  return {
    window, get, calls, view, listeners,
    shown: id => !get(id).hidden,
    async lock() {
      view.status = { ...view.status, unlocked: false, lockRevision: view.status.lockRevision + 1 };
      listeners.locked({ lockRevision: view.status.lockRevision });
      await tick();
    },
    async click(id) { get(id).click(); await tick(); },
    async submit(id) { get(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await tick(); },
    async check(id, value) { get(id).checked = value; get(id).dispatchEvent(new window.Event('change', { bubbles: true })); await tick(); }
  };
}

test('the Touch ID setting shows only where Touch ID can be used, off by default, with its limits', async t => {
  const without = await renderer(t, { touchIdSupported: false });
  assert.equal(without.shown('touch-id-setting'), false);
  const view = await renderer(t);
  assert.equal(view.shown('touch-id-setting'), true);
  assert.equal(view.get('touch-id-toggle').checked, false);
  assert.match(view.get('touch-id-setting').textContent, /Unlock with Touch ID/);
  const hint = view.get('touch-id-setting').querySelector('.field-hint').textContent;
  assert.match(hint, /restarts and every 14 days/);
  assert.match(hint, /login password/);
  const on = await renderer(t, { touchId: 'password' });
  assert.equal(on.get('touch-id-toggle').checked, true, 'on, even while the password is needed');
});

test('turning Touch ID on asks for the password in the app, and a wrong one keeps the dialog open', async t => {
  let wrong = true;
  const view = await renderer(t);
  const setTouchIdUnlock = view.window.secondHand.setTouchIdUnlock;
  view.window.secondHand.setTouchIdUnlock = async request => {
    if (request.enabled && wrong) { view.calls.push(['setTouchIdUnlock', structuredClone(request)]); throw new view.window.Error('That password isn’t right. Check it and try again.'); }
    return setTouchIdUnlock(request);
  };
  await view.check('touch-id-toggle', true);
  assert.equal(view.get('touch-id-dialog').open, true);
  assert.equal(view.get('touch-id-toggle').checked, false, 'not on until the password is checked');
  assert.equal(view.calls.some(([name]) => name === 'setTouchIdUnlock'), false);

  view.get('touch-id-password').value = 'a wrong but long password';
  await view.submit('touch-id-form');
  assert.equal(view.get('touch-id-dialog').open, true);
  assert.equal(view.get('touch-id-error').textContent, 'That password isn’t right. Check it and try again.');
  assert.equal(view.get('touch-id-error').hidden, false);
  assert.equal(view.get('touch-id-toggle').checked, false);

  wrong = false;
  view.get('touch-id-password').value = PASSWORD;
  await view.submit('touch-id-form');
  assert.deepEqual(view.calls.filter(([name]) => name === 'setTouchIdUnlock').at(-1), ['setTouchIdUnlock', { enabled: true, password: PASSWORD }]);
  assert.equal(view.get('touch-id-dialog').open, false);
  assert.equal(view.get('touch-id-password').value, '', 'the password isn’t kept in the page');
  assert.equal(view.get('touch-id-toggle').checked, true);
  assert.match(view.get('toast').textContent, /Touch ID is on/);
});

test('cancelling the password dialog leaves Touch ID off; turning it off needs no password', async t => {
  const view = await renderer(t);
  await view.check('touch-id-toggle', true);
  view.get('touch-id-password').value = PASSWORD;
  await view.click('touch-id-cancel');
  assert.equal(view.get('touch-id-dialog').open, false);
  assert.equal(view.get('touch-id-password').value, '');
  assert.equal(view.get('touch-id-toggle').checked, false);
  assert.equal(view.calls.some(([name]) => name === 'setTouchIdUnlock'), false);

  const on = await renderer(t, { touchId: 'ready' });
  await on.check('touch-id-toggle', false);
  assert.deepEqual(on.calls.filter(([name]) => name === 'setTouchIdUnlock'), [['setTouchIdUnlock', { enabled: false }]]);
  assert.equal(on.get('touch-id-toggle').checked, false);
  assert.match(on.get('toast').textContent, /Touch ID is off/);

  const failing = await renderer(t, { touchId: 'ready' });
  failing.window.secondHand.setTouchIdUnlock = async () => { throw new failing.window.Error('Could not turn off Touch ID (synthetic). Please try again.'); };
  await failing.check('touch-id-toggle', false);
  assert.equal(failing.get('touch-id-toggle').checked, true, 'a failed change is undone');
  assert.equal(failing.get('toast').textContent, 'Could not turn off Touch ID (synthetic). Please try again.');
});

test('a lock closes the password dialog and clears what was typed', async t => {
  const view = await renderer(t);
  await view.check('touch-id-toggle', true);
  view.get('touch-id-password').value = PASSWORD;
  await view.lock();
  assert.equal(view.get('touch-id-dialog').open, false);
  assert.equal(view.get('touch-id-password').value, '');
});

test('the lock screen offers Unlock with Touch ID when it is ready, beside the password', async t => {
  const view = await renderer(t, { unlocked: false, touchId: 'ready' });
  assert.equal(view.shown('auth-view'), true);
  assert.equal(view.shown('touch-id-unlock'), true);
  assert.equal(view.get('touch-id-unlock').textContent.trim(), 'Unlock with Touch ID');
  assert.equal(view.shown('touch-id-note'), false);
  assert.equal(view.get('passphrase').closest('form'), view.get('touch-id-unlock').closest('form'), 'beside the password field');
  await view.click('touch-id-unlock');
  assert.deepEqual(view.calls.filter(([name]) => name === 'unlockWithTouchId'), [['unlockWithTouchId']]);
  assert.equal(view.shown('workspace'), true);
  assert.equal(view.shown('auth-view'), false);
});

test('the lock screen says when the password is needed, and shows no Touch ID button then or while it is off', async t => {
  const needed = await renderer(t, { unlocked: false, touchId: 'password' });
  assert.equal(needed.shown('touch-id-unlock'), false);
  assert.equal(needed.shown('touch-id-note'), true);
  assert.equal(needed.get('touch-id-note').textContent, NEEDED);
  const off = await renderer(t, { unlocked: false, touchId: 'off' });
  assert.equal(off.shown('touch-id-unlock'), false);
  assert.equal(off.shown('touch-id-note'), false);
  const fresh = await renderer(t, { exists: false, unlocked: false, touchId: 'off' });
  assert.equal(fresh.shown('touch-id-unlock'), false);
  assert.equal(fresh.shown('touch-id-note'), false);
});

test('after an auto-lock, the lock screen reads Touch ID’s state again', async t => {
  const view = await renderer(t, { touchId: 'ready' });
  view.view.status.touchId = 'password';
  await view.lock();
  assert.equal(view.shown('auth-view'), true);
  assert.equal(view.shown('touch-id-unlock'), false);
  assert.equal(view.get('touch-id-note').textContent, NEEDED);
});

test('a cancelled Touch ID prompt says why and leaves the password field ready', async t => {
  const message = 'Touch ID didn’t unlock SecondHand (Canceled by user.). Enter your password.';
  const view = await renderer(t, { unlocked: false, touchId: 'ready' });
  // Electron's IPC rejects with an Error from the page's own realm.
  view.window.secondHand.unlockWithTouchId = async () => { throw new view.window.Error(message); };
  await view.click('touch-id-unlock');
  assert.equal(view.get('auth-error').textContent, message);
  assert.equal(view.shown('auth-error'), true);
  assert.equal(view.window.document.activeElement, view.get('passphrase'));
  assert.equal(view.get('touch-id-unlock').disabled, false, 'Touch ID can be tried again');
  assert.equal(view.shown('touch-id-unlock'), true);
  assert.equal(view.shown('workspace'), false);
  view.get('passphrase').value = PASSWORD;
  await view.submit('auth-form');
  assert.deepEqual(view.calls.find(([name]) => name === 'unlock'), ['unlock', PASSWORD]);
  assert.equal(view.shown('workspace'), true);
});

test('when Touch ID is turned off because its key can’t be used, the lock screen says why and asks for the password', async t => {
  const notice = 'Touch ID was turned off because this Mac’s Keychain couldn’t open its key.';
  const view = await renderer(t, { unlocked: false, touchId: 'ready' });
  view.window.secondHand.unlockWithTouchId = async () => {
    view.view.status = { ...view.view.status, touchId: 'off', touchIdNotice: notice };
    throw new view.window.Error(`${notice} Enter your password.`);
  };
  await view.click('touch-id-unlock');
  assert.equal(view.get('auth-error').textContent, `${notice} Enter your password.`);
  assert.equal(view.shown('touch-id-unlock'), false);
  assert.equal(view.get('touch-id-note').textContent, notice);
  assert.equal(view.get('touch-id-note').classList.contains('error'), true);
  assert.equal(view.window.document.activeElement, view.get('passphrase'));
});

test('a notice from a password unlock is shown once the saved information opens', async t => {
  const notice = 'Touch ID was turned off because its key file on this Mac is damaged.';
  const view = await renderer(t, { unlocked: false, touchId: 'password' }, {
    unlock: async () => { view.view.status = { ...view.view.status, unlocked: true, touchId: 'off', touchIdNotice: notice }; return structuredClone(view.view.status); }
  });
  view.get('passphrase').value = PASSWORD;
  await view.submit('auth-form');
  assert.equal(view.shown('workspace'), true);
  assert.equal(view.get('toast').textContent, notice);
  assert.equal(view.get('toast').classList.contains('error'), true);
});

test('an unlock from Chrome’s side panel opens the saved information in the app', async t => {
  const view = await renderer(t, { unlocked: false, touchId: 'ready' });
  assert.equal(view.shown('auth-view'), true);
  view.view.status = { ...view.view.status, unlocked: true };
  view.listeners.unlocked({ lockRevision: 0 });
  await tick();
  assert.equal(view.shown('workspace'), true);
  assert.equal(view.get('firstName').value, 'Synthetic');
  // A notice for an app that is already unlocked, or a status that says locked, changes nothing.
  view.listeners.unlocked({ lockRevision: 0 });
  await tick();
  assert.equal(view.shown('workspace'), true);
  const locked = await renderer(t, { unlocked: false, touchId: 'ready' });
  locked.listeners.unlocked({ lockRevision: 0 });
  await tick();
  assert.equal(locked.shown('auth-view'), true);
});
