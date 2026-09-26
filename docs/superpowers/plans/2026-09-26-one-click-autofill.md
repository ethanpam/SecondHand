# One-Click Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the multi-step Iowa fill flow with a one-click on-page Autofill widget, backed by a one-time desktop "trust" switch. Remove guided mode and auto-Next everywhere.

**Architecture:** The desktop vault stays the only data owner. `getFields` skips its dialog when a persisted `autofillWithoutAsking` setting is on. The extension worker gets a single `autofill(tabId)` operation: one `getFields` request per click and up to 4 fill passes. The page launcher iframe becomes the widget, and the side panel becomes a simple checklist plus an Autofill button.

**Tech Stack:** Electron (CommonJS), Manifest V3 extension (plain JS), `node:test`, jsdom, Playwright (smoke test).

## Global Constraints

- No new dependencies.
- The extension must not use `chrome.storage`, and profile values must never reach the page, logs, or UI messages.
- Iowa-only host permission. Content scripts run in the top frame only. Existing answers and selected choices are never overwritten.
- Automatic navigation, consent, signatures, CAPTCHA, and submission are never performed.
- Commit as the user with no attribution to Claude, per the user's CLAUDE.md.
- Run `npm test` and `npm run check` after each task. `npm run test:extension` must pass at the end.

## File map

| File | Change |
| --- | --- |
| `desktop/main.cjs` | Trust setting, `showApp`, three-button dialog, `setAutofillTrust`; remove `AssistedSession` |
| `desktop/bridge.cjs` | Request types: `status`, `getFields`, `recordProgress`, `showApp`; own `validateFieldScope` |
| `desktop/assistance.cjs` | Delete |
| `desktop/preload.cjs`, `renderer/index.html`, `renderer/app.js` | Trust checkbox in the Chrome extension view; updated copy |
| `desktop/extension-setup.cjs` | Drop `popup.*` from `EXTENSION_FILES` |
| `extension/iowa-adapter.js` | Remove `navigationButton`, `controlState`, `sameControlState`, `captureNavigation`, `advance`, `navigationSnapshots`, `canAdvance` |
| `extension/content.js` | Remove `secondhand:next` / navigation; size the widget host by page kind |
| `extension/background.js` | Rewrite: `autofill`, `pageState`, launcher and panel message routing |
| `extension/panel.html` / `panel.js` / `panel.css` | Widget surface and simplified side panel |
| `extension/popup.*` | Delete |
| Tests | Rewrite `desktop-assistance-main`, trim `desktop-bridge` / `desktop-native-smoke` / `extension-adapter` / `extension-panel`, new `extension-autofill`, delete `desktop-assistance`, `extension-guided`, `extension-flow` |
| `scripts/smoke-extension.cjs` | Rewrite flows for the widget |
| Docs | `README.md`, `docs/iowa-portal.md`, `docs/implementation-contract.md`, `docs/security.md`, `docs/setup.md`, `website/app/page.tsx` copy |

---

### Task 1: Desktop trust switch, `showApp`, and removal of assisted sessions

**Files:**
- Modify: `desktop/main.cjs`, `desktop/bridge.cjs`
- Delete: `desktop/assistance.cjs`, `tests/desktop-assistance.test.cjs`
- Test: `tests/desktop-assistance-main.test.cjs` (rewrite tests; keep harness), `tests/desktop-bridge.test.cjs`, `tests/desktop-native-smoke.cjs`

**Interfaces:**
- Produces bridge requests:
  - `status` → `{ unlocked, applicationCount }`
  - `showApp` → `{ shown: true }`
  - `getFields { url, fields }` → `{ values }`
  - `recordProgress { url, filledCount }` → `{ recorded: true }`
- Produces renderer method `setAutofillTrust(enabled: boolean)` → status. `status()` gains `autofillWithoutAsking: boolean`.
- Dialog buttons: `['Cancel', 'Allow once', 'Always allow on this computer']`; responses 0 / 1 / 2.

- [ ] **Step 1: Harness changes and failing tests.** In `tests/desktop-assistance-main.test.cjs`:
  - `desktop(options = {})` accepts `settings` (the initial `settings.json` object, default `{ extensionId }`).
  - `readFile` returns `JSON.stringify(options.settings ?? { extensionId })`.
  - The `atomicWrite` override records `writes.push({ file, json: JSON.parse(bytes.toString()) })`.
  - `BrowserWindow.show()` increments `shows`.
  - The harness returns `writes` and `shows`.

  Replace all five tests with the following:

```js
test('trusted autofill returns saved values with no dialog; lock still blocks it', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  assert.equal((await app.invoke('status')).autofillWithoutAsking, true);
  const { values } = await app.request({ type: 'getFields', fields: ['firstName', 'lastName'] });
  assert.deepEqual(values, { firstName: 'Synthetic' });
  assert.equal(app.prompts.length, 0);
  await app.invoke('lock');
  await assert.rejects(app.request({ type: 'getFields', fields: ['firstName'] }), /Unlock/);
  assert.equal(app.prompts.length, 0);
});

test('untrusted autofill asks once per click with Allow once, Always allow, and Cancel', async () => {
  const app = await desktop();
  app.answer(async () => ({ response: 1 }));
  assert.equal((await app.request({ type: 'getFields', fields: ['firstName'] })).values.firstName, 'Synthetic');
  assert.deepEqual(app.prompts[0].buttons, ['Cancel', 'Allow once', 'Always allow on this computer']);
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
  app.answer(async () => ({ response: 0 }));
  await assert.rejects(app.request({ type: 'getFields', fields: ['firstName'] }), /cancelled/);
  app.answer(async () => ({ response: 2 }));
  await app.request({ type: 'getFields', fields: ['firstName'] });
  assert.equal((await app.invoke('status')).autofillWithoutAsking, true);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: true });
  await app.request({ type: 'getFields', fields: ['firstName'] });
  assert.equal(app.prompts.length, 3, 'no dialog after Always allow');
});

test('a late approval after lock and unlock is rejected', async () => {
  const app = await desktop();
  let resolve;
  app.answer(() => new Promise(done => { resolve = done; }));
  const pending = app.request({ type: 'getFields', fields: ['firstName'] });
  await app.invoke('lock');
  await app.invoke('unlock', 'synthetic-passphrase');
  resolve({ response: 2 });
  await assert.rejects(pending, /changed/);
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
});

test('the trust switch round-trips through the renderer and resets for a new extension ID', async () => {
  const app = await desktop();
  assert.equal((await app.invoke('setAutofillTrust', true)).autofillWithoutAsking, true);
  assert.deepEqual(app.writes.at(-1).json, { extensionId, autofillWithoutAsking: true });
  await assert.rejects(app.invoke('setAutofillTrust', 'yes'), /could not be completed|Invalid/);
  await app.invoke('connectExtension', 'b'.repeat(32));
  assert.equal((await app.invoke('status')).autofillWithoutAsking, false);
  const untrusted = await desktop({ settings: { extensionId: 'c'.repeat(32), autofillWithoutAsking: true } });
  await untrusted.request({ type: 'getFields', fields: ['firstName'] });
  assert.equal(untrusted.prompts.length, 1, 'trust only applies to the stored extension ID');
});

test('showApp brings the window forward even while locked and returns no profile data', async () => {
  const app = await desktop();
  await app.invoke('lock');
  assert.deepEqual(await app.request({ type: 'showApp' }), { shown: true });
  assert.equal(app.shows, 1);
});

test('desktop releases explicit No choices but omits unknown answers', async () => {
  const app = await desktop({ settings: { extensionId, autofillWithoutAsking: true } });
  await app.invoke('saveProfile', { programSnap: 'yes', programFip: 'no', hasHomeAddress: 'no', mailingSameAsHome: 'no', mailingAddressLine1: 'PO Box 123' });
  const fields = ['programSnap', 'programFip', 'programMedicaid', 'hasHomeAddress', 'mailingSameAsHome', 'mailingAddressLine1'];
  const { values } = await app.request({ type: 'getFields', fields });
  assert.deepEqual(values, { programSnap: 'yes', programFip: 'no', hasHomeAddress: 'no', mailingSameAsHome: 'no', mailingAddressLine1: 'PO Box 123' });
});
```

  Note: `request()` uses `context = { extensionId }`. The "trust only applies to the stored extension ID" case works because that desktop's stored ID is `'c'.repeat(32)`.

- [ ] **Step 2: Run the tests and confirm they fail.** `node --test tests/desktop-assistance-main.test.cjs`. Expected: failures on the button lists, `autofillWithoutAsking`, and `showApp`.

- [ ] **Step 3: Implement in `desktop/main.cjs`:**
  - Remove the `AssistedSession` import and every `assistance.*` call (lock, `saveExtensionRegistration`, `saveProfile`, `before-quit`).
  - Remove `startAssistedSession`, `checkAssistedSession`, and `endAssistedSession`.
  - Add `let autofillWithoutAsking = false;`. At startup, after reading the config: `if (extensionId && config.autofillWithoutAsking === true) autofillWithoutAsking = true;`.
  - Add:

```js
async function saveSettings() {
  await atomicWrite(configPath, Buffer.from(JSON.stringify({ extensionId, autofillWithoutAsking })));
}
```

  - In `saveExtensionRegistration(id)`: `if (id !== extensionId) autofillWithoutAsking = false; extensionId = id; await saveSettings();`, replacing the direct `atomicWrite`.
  - Add `autofillWithoutAsking` to `status()`.
  - Add a lock generation counter: `let lockGeneration = 0;`, incremented in `lockVault()`.
  - `bridgeRequest`:

```js
if (request.type === 'status') return { unlocked: vault.unlocked, applicationCount: vault.unlocked ? vault.getData().applications.length : 0 };
if (request.type === 'showApp') { if (mainWindow) { if (mainWindow.isMinimized?.()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } return { shown: true }; }
requireUnlocked();
if (request.type === 'getFields') {
  const trusted = autofillWithoutAsking && extensionId === context.extensionId;
  if (!trusted) {
    if (fieldRequestPending) throw publicError('Another field request is waiting for your approval.');
    fieldRequestPending = true;
    const generation = lockGeneration;
    try {
      mainWindow.show(); mainWindow.focus();
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'question', title: 'Let Chrome fill Iowa’s form?',
        message: 'Fill these saved answers into Iowa’s application?',
        detail: `Website: ${PORTAL_URL}\n\n${request.fields.map(field => FIELD_LABELS[field]).join(', ')}\n\nChoose “Always allow” to let the SecondHand extension fill without asking whenever this app is unlocked. You can turn it off on the Chrome extension page. Iowa’s website may save entered information. Review every answer before continuing.`,
        buttons: ['Cancel', 'Allow once', 'Always allow on this computer'], defaultId: 1, cancelId: 0, noLink: true
      });
      if (answer.response !== 1 && answer.response !== 2) throw publicError('You cancelled this field request.');
      requireUnlocked();
      if (generation !== lockGeneration || extensionId !== context.extensionId) throw publicError('The vault or Chrome connection changed. Click Autofill again.');
      if (answer.response === 2) { autofillWithoutAsking = true; await saveSettings(); }
    } finally { fieldRequestPending = false; }
  }
  const profile = vault.getData().profile;
  const values = {};
  for (const field of request.fields) if (typeof profile[field] === 'string' && profile[field].trim()) values[field] = profile[field];
  touch();
  return { values };
}
```

  - Add the renderer method:

```js
async setAutofillTrust(enabled) {
  requireUnlocked();
  if (typeof enabled !== 'boolean') throw publicError('Invalid setting.');
  autofillWithoutAsking = enabled; await saveSettings(); touch(); return status();
},
```

- [ ] **Step 4: Bridge validation.** In `desktop/bridge.cjs`:
  - Replace the `./assistance.cjs` import with `const { PROFILE_FIELDS, isPortalUrl } = require('../shared/schema.cjs');`.
  - Define `validateFieldScope` locally, with the same body as `assistance.cjs` lines 11-16.
  - Allowed request types:
    - `status` and `showApp`: `['id','type']`.
    - `getFields`: `['id','type','url','fields']`.
    - `recordProgress`: `['id','type','url','filledCount']`.
  - The URL check applies to everything except `status` and `showApp`. Remove the assistance-token checks.
  - Export `validateFieldScope`.

- [ ] **Step 5: Adjust the other tests.**
  - Delete `desktop/assistance.cjs` and `tests/desktop-assistance.test.cjs`.
  - In `tests/desktop-bridge.test.cjs`:
    - Delete the `AssistedSession` import and the two assisted tests.
    - Add a test: `showApp` validates with `{id,type}` only and rejects a `url`; `getFields` rejects `assistanceToken` as `/Unexpected/`; `startAssistedSession` is rejected as `/Unsupported/`.
  - In `tests/desktop-native-smoke.cjs`, replace the three assisted fixtures with:
    - `{ request: { id: 'show-app', type: 'showApp' }, data: { shown: true } }`
    - `{ request: { id: 'fields', type: 'getFields', url: PORTAL_URL, fields: ['firstName'] }, data: { values: { firstName: 'Synthetic' } } }`

  Also remove the `assistanceToken` const.

- [ ] **Step 6: Run** `npm test` and `npm run check`. Expected: pass.

- [ ] **Step 7: Commit** with the message "Replace desktop guided sessions with a one-time autofill trust switch".

### Task 2: Desktop renderer trust checkbox

**Files:** `desktop/preload.cjs`, `renderer/index.html`, `renderer/app.js`, test `tests/renderer-state.test.cjs`

**Interfaces:** Consumes `setAutofillTrust(enabled)` and `status().autofillWithoutAsking` from Task 1.

- [ ] **Step 1: Failing test** in `tests/renderer-state.test.cjs`:

```js
test('Chrome extension view toggles autofill trust through the desktop API', async t => {
  const calls = [];
  const view = await renderer(t, { setAutofillTrust: async enabled => { calls.push(enabled); return { exists: true, unlocked: true, extensionId: '', bridgeRunning: true, autofillWithoutAsking: enabled }; } });
  assert.equal(view.get('autofill-trust').checked, false);
  view.get('autofill-trust').checked = true;
  view.get('autofill-trust').dispatchEvent(new view.window.Event('change'));
  await tick(); await tick();
  assert.deepEqual(calls, [true]);
  assert.equal(view.get('autofill-trust').checked, true);
  assert.doesNotMatch(view.get('view-extension').textContent, /guided/i);
});
```

- [ ] **Step 2: Run it and confirm it fails.** `node --test tests/renderer-state.test.cjs`.
- [ ] **Step 3: Implement.**
  - **Preload:** `setAutofillTrust: enabled => invoke('setAutofillTrust', enabled)`.
  - **index.html:** in step 3 of `view-extension`, replace the paragraph with: "Keep this app open and unlocked, then open Iowa’s portal in Chrome and click **Autofill** on the page. You review the answers and click Iowa’s Continue yourself." Add below it:

```html
<label class="trust-toggle"><input id="autofill-trust" type="checkbox"> <span>Let Chrome autofill without asking</span></label><p class="field-hint">When SecondHand is unlocked, the extension fills your saved answers on Iowa’s supported page without a pop-up. Lock SecondHand to stop.</p><p id="autofill-trust-error" class="inline-error" role="alert" hidden></p>
```

    Change the side note's first sentence to: "Autofill asks the first time. Choose Always allow to skip the pop-up while SecondHand is unlocked."
  - **app.js:** `renderSetup()` sets `$('autofill-trust').checked = Boolean(vaultStatus.autofillWithoutAsking)`. Add a listener:

```js
$('autofill-trust').addEventListener('change', () => {
  clearError('autofill-trust-error');
  const generation = vaultGeneration; const wanted = $('autofill-trust').checked;
  $('autofill-trust').disabled = true;
  api.setAutofillTrust(wanted).then(status => {
    if (generation !== vaultGeneration) return;
    vaultStatus = { ...vaultStatus, ...status }; renderSetup();
    toast(wanted ? 'Chrome can now autofill without asking while SecondHand is unlocked.' : 'Chrome will ask before each autofill.');
  }, error => { if (generation === vaultGeneration) { $('autofill-trust').checked = !wanted; showError('autofill-trust-error', error); } })
    .finally(() => { $('autofill-trust').disabled = false; });
});
```

    Also add `'autofill-trust-error'` to the list of errors cleared on lock.
- [ ] **Step 4: Run** `npm test` and confirm it passes.
- [ ] **Step 5: Commit** with the message "Add autofill trust switch to the desktop Chrome extension view".

### Task 3: Adapter without navigation

**Files:** `extension/iowa-adapter.js`, test `tests/extension-adapter.test.cjs`

**Interfaces:** Produces `probePage(doc, url)` → `{ kind, pageKey, heading, reason, fields, checklist, requiredRemaining, manualRemaining }` (no `canAdvance`). The API object no longer has `captureNavigation` or `advance`.

- [ ] **Step 1: Update the tests first.**
  - Delete the tests "Next requires a single-use…", "Next stops on answer…", and "save-and-exit, final submission…".
  - In "probe returns sanitized page facts…": remove the `canAdvance` and `captureNavigation` asserts.
  - Rename "…disable Next" to "required blank fields, unanswered choices, unknown controls, and errors need attention". Assert `r.requiredRemaining + r.manualRemaining > 0` for every change except the `formaction` one, and drop that one.
  - In the full-checklist test and Select Address: remove the `canAdvance` asserts.
  - Update the test at ~line 393 ("required conditional fields cannot disappear") to assert `manualRemaining > 0` instead of `canAdvance === false`.
  - Add `assert.equal('advance' in adapter, false); assert.equal('captureNavigation' in adapter, false);` to the probe test.
- [ ] **Step 2: Run** `node --test tests/extension-adapter.test.cjs`. Expected: FAIL (`advance` still exported).
- [ ] **Step 3: Implement.**
  - Delete `navigationSnapshots`, `navigationButton`, `controlState`, `sameControlState`, `captureNavigation`, and `advance`, and remove them from `api`.
  - In `probePage`, drop `canAdvance` from the base result and from the fillable return. The fillable `reason` becomes: `issues.manualRemaining ? 'Answer the remaining questions and correct any errors in Iowa’s form.' : issues.requiredRemaining ? 'Complete the required applicant fields in Iowa’s form.' : 'Review your answers, then click Save and Continue in Iowa’s form.'`.
- [ ] **Step 4: Run** `node --test tests/extension-adapter.test.cjs`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Remove automatic Next from the Iowa adapter". (Other extension tests may fail until Tasks 4 and 5. Commit anyway; the suite is fixed by the end of Task 5.)

### Task 4: Content script without navigation; widget host sizing

**Files:** `extension/content.js`, test `tests/extension-panel.test.cjs` (content section)

**Interfaces:**
- Consumes `probePage` (no `canAdvance`).
- Produces content messages:
  - `secondhand:pageState` → `{ page, scan }`
  - `secondhand:scan` → scan metadata
  - `secondhand:fill` → `{ ok, filledCount, skippedCount }`
  - `secondhand:focusField` → `{ focused }`
- The host is sized `244×62` when `probePage(...).kind === 'fillable'`, otherwise `46×46`. The attribute `data-secondhand-size` is `full` or `pill`.

- [ ] **Step 1: Tests.**
  - In the `content()` harness, remove `captureNavigation`, `advance`, and `advanced`. Make `probePage` configurable: `let kind = 'fillable'`, with a `setKind` helper.
  - Replace "fill invalidates prior navigation…" with:

```js
test('fill uses a fresh one-use preview and pageState carries no navigation token', t => {
  const page = content(t);
  const first = page.request({ type: 'secondhand:pageState' });
  assert.equal('nextToken' in first, false);
  const filled = page.request({ type: 'secondhand:fill', token: first.scan.token, fields: ['firstName'], values: { firstName: 'Synthetic applicant' } });
  assert.equal(filled.filledCount, 1);
  assert.equal(JSON.stringify(filled).includes('Synthetic applicant'), false);
  assert.equal(page.request({ type: 'secondhand:fill', token: first.scan.token, fields: ['firstName'], values: { firstName: 'x' } }).ok, false);
  assert.equal(page.request({ type: 'secondhand:next', token: 'anything', authorized: true }), undefined);
});
test('widget host is a full bar on fillable pages and a small pill elsewhere', async t => {
  const page = content(t);
  const host = page.window.document.querySelector('[data-secondhand-assistant]');
  assert.equal(host.getAttribute('data-secondhand-size'), 'full');
  assert.equal(host.style.height, '62px');
  page.setKind('manual');
  page.window.dispatchEvent(new page.window.Event('popstate'));
  assert.equal(host.getAttribute('data-secondhand-size'), 'pill');
  assert.equal(host.style.height, '46px');
});
```

  - In "page-state polls…", drop `assert.ok(second.nextToken)`.
  - In "only the assistant overlay is hidden…", use the method list `['scan','probePage','fill']` and remove the `secondhand:next` request.
  - In "foreign extension messages…", remove the `secondhand:panel` lines and `page.advanced`.
- [ ] **Step 2: Run** `node --test tests/extension-panel.test.cjs` and confirm the new tests fail.
- [ ] **Step 3: Implement.**
  - Remove `navigation` and the `secondhand:next` handler.
  - `pageState()` returns `{ page, scan: preview() }`.
  - Replace `sizePanel()` with:

```js
function sizePanel() {
  if (!panelHost || !panelFrame) return;
  let fillable = false;
  try { fillable = withOwnPanelHidden(() => adapter.probePage(document, location.href)).kind === 'fillable'; }
  catch { fillable = false; }
  panelHost.setAttribute('data-secondhand-size', fillable ? 'full' : 'pill');
  panelHost.style.setProperty('width', fillable ? 'min(244px, calc(100vw - 24px))' : '46px', 'important');
  panelHost.style.setProperty('height', fillable ? '62px' : '46px', 'important');
}
```

    `ensurePanel()` calls `sizePanel()` every time (it already runs every second and on `popstate`), including when the host is already connected. Move `sizePanel()` above the `isConnected` early return.
- [ ] **Step 4: Run** `node --test tests/extension-panel.test.cjs` (content tests) and confirm they pass.
- [ ] **Step 5: Commit** with the message "Drop navigation from the content script and size the widget by page".

### Task 5: Worker `autofill` and message routing

**Files:**
- Rewrite: `extension/background.js`
- Create: `tests/extension-autofill.test.cjs`
- Delete: `tests/extension-guided.test.cjs`, `tests/extension-flow.test.cjs`

**Interfaces:**
- Consumes the content messages from Task 4 and the bridge `status` / `getFields` / `recordProgress` / `showApp`.
- Produces UI messages, valid from the side panel (explicit `tabId`) or the launcher (tab = `sender.tab.id`):
  - `ui:pageState` → `{ page, scan, result }`. `result` is the last autofill result for the tab and page, or `null`.
  - `ui:autofill` (`confirmed: true`) → `result`.
  - `ui:focusField { key }` → `{ focused }`.
  - `ui:showApp` → `{ shown }`.
  - `ui:desktopStatus` → `{ connected, unlocked }`.
  - `ui:openPanel` (launcher only).
- `result = { state: 'done'|'locked'|'offline'|'error', filled: number, needYou: string[], message: string, pageKey: string }`.
- `needYou` = checklist keys where `(item.required && item.status === 'missing') || item.status === 'manual'`.
- `nativeRequest(type, payload)` stays a top-level `function` (the smoke test replaces it). A rejected Error has `code === 'offline'` when the host can't be reached.

- [ ] **Step 1: Write `tests/extension-autofill.test.cjs`.** Harness (same pattern as the deleted guided harness):
  - A `chrome` stub with a `tabs.get` returning `tab` and `tabs.sendMessage` handling:
    - `secondhand:pageState` → `{ page, scan }` from a mutable model.
    - `secondhand:fill` → marks the model's fields filled, then reveals `mailingCity` after `hasHomeAddress` is filled.
    - `secondhand:focusField` → `{ focused: true }`.
  - `connectNative` answers from a `desktop` model `{ reachable, unlocked, values }`, and records `calls.native`.

  Tests:

```js
test('one click makes one status and one getFields request for every definition, fills revealed fields, and records progress', async () => {
  const w = worker();
  const result = await w.panel({ type: 'ui:autofill', confirmed: true });
  assert.equal(result.ok, true);
  assert.deepEqual(w.calls.native.map(call => call.type), ['status', 'getFields', 'recordProgress']);
  assert.deepEqual(w.calls.native[1].fields, Object.keys(adapter.definitions));
  assert.deepEqual(w.filled(), ['firstName', 'hasHomeAddress', 'mailingCity']);
  assert.equal(result.data.state, 'done');
  assert.equal(result.data.filled, 3);
  assert.deepEqual(result.data.needYou, ['lastName']);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic private/);
});
test('locked and unreachable desktops map to widget states without filling', async () => {
  const locked = worker({ desktop: { unlocked: false } });
  assert.equal((await locked.panel({ type: 'ui:autofill', confirmed: true })).data.state, 'locked');
  assert.deepEqual(locked.calls.native.map(call => call.type), ['status']);
  const offline = worker({ desktop: { reachable: false } });
  assert.equal((await offline.panel({ type: 'ui:autofill', confirmed: true })).data.state, 'offline');
  assert.equal(offline.filled().length, 0);
});
test('cancelled approval or a page change mid-request fills nothing', async () => {
  const cancelled = worker({ desktop: { getFieldsError: 'You cancelled this field request.' } });
  const result = (await cancelled.panel({ type: 'ui:autofill', confirmed: true })).data;
  assert.equal(result.state, 'error'); assert.match(result.message, /Cancelled/);
  const moved = worker({ duringGetFields: tab => { tab.url = `${adapter.PORTAL}/applyForBenefits/other`; } });
  assert.match((await moved.panel({ type: 'ui:autofill', confirmed: true })).data.message, /page changed/);
  assert.equal(moved.filled().length, 0);
});
test('non-fillable pages never contact the desktop', async () => {
  const w = worker({ kind: 'manual' });
  const response = await w.panel({ type: 'ui:autofill', confirmed: true });
  assert.equal(response.ok, false); assert.match(response.error, /Nothing to fill/);
  assert.equal(w.calls.native.length, 0);
});
test('launcher is bound to its own tab, needs confirmed clicks, and cannot use unknown types', async () => {
  const w = worker();
  assert.equal(await w.launcher({ type: 'ui:autofill' }), undefined);
  assert.equal((await w.launcher({ type: 'ui:autofill', confirmed: true, tabId: 99 })).ok, true);
  assert.equal(w.calls.pageTabs.every(id => id === 7), true);
  assert.equal(await w.launcher({ type: 'ui:desktopStatus' }), undefined);
  assert.equal(await w.send({ type: 'ui:autofill', confirmed: true, tabId: 7 }, { id: 'testextension', url: `${adapter.PORTAL}/x`, tab: { id: 7 } }), undefined);
  assert.equal(await w.send({ type: 'ui:autofill', confirmed: true, tabId: 7 }, { id: 'other', url: 'chrome-extension://testextension/panel.html' }), undefined);
});
test('pageState returns the last result for the same page and forgets it after navigation', async () => {
  const w = worker();
  await w.panel({ type: 'ui:autofill', confirmed: true });
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.result.state, 'done');
  w.events.updated(7, { status: 'loading' });
  assert.equal((await w.panel({ type: 'ui:pageState' })).data.result, null);
});
test('showApp and focusField pass through; old guided and fill messages are gone', async () => {
  const w = worker();
  assert.deepEqual((await w.launcher({ type: 'ui:showApp', confirmed: true })).data, { shown: true });
  assert.deepEqual((await w.launcher({ type: 'ui:focusField', key: 'lastName', confirmed: true })).data, { focused: true });
  for (const type of ['ui:auto', 'ui:fill', 'ui:fillAndNext', 'ui:scan', 'ui:status']) assert.equal(await w.panel({ type, confirmed: true, enabled: true }), undefined, type);
});
```

- [ ] **Step 2: Run** `node --test tests/extension-autofill.test.cjs` and confirm it fails.
- [ ] **Step 3: Rewrite `extension/background.js`.** Keep `nativeRequest` (add `error.code = 'offline'` on disconnect or connect failure), `safeUrl`, `activePortal`, `inject`, and the `sidePanel.setPanelBehavior` call. New core:

```js
const results = new Map(); // tabId -> result metadata (counts/keys only)
let busyTab = null;
async function readPage(tabId) {
  const tab = await activePortal(tabId);
  await inject(tabId);
  const state = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:pageState' }, { frameId: 0 });
  const current = await activePortal(tabId);
  if (current.url !== tab.url || !state?.page || !state.scan) throw new Error('The page changed. Wait for it to finish loading.');
  return { ...state, url: tab.url };
}
const needYou = page => (Array.isArray(page.checklist) ? page.checklist : []).filter(item => (item.required && item.status === 'missing') || item.status === 'manual').map(item => item.key);
async function autofill(tabId) {
  if (busyTab !== null) throw new Error('Autofill is already running.');
  busyTab = tabId;
  let values = null;
  let state;
  try {
    state = await readPage(tabId);
    if (state.page.kind !== 'fillable' || !state.scan.recognizedPage) throw new Error('Nothing to fill on this page.');
    const url = state.url;
    const desktop = await nativeRequest('status');
    if (!desktop?.unlocked) return remember(tabId, { state: 'locked', filled: 0, needYou: [], message: 'Unlock SecondHand to autofill.', pageKey: state.page.pageKey });
    const response = await nativeRequest('getFields', { url: safeUrl(url), fields: Object.keys(SecondHandIowa.definitions) });
    values = response?.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('The desktop did not return supported profile fields.');
    let filled = 0;
    const attempted = new Set();
    for (let pass = 0; pass < 4; pass++) {
      if ((await activePortal(tabId)).url !== url) throw new Error('The page changed. Click Autofill again.');
      const fresh = pass === 0 ? state : await readPage(tabId);
      const keys = fresh.scan.fields.map(field => field.key).filter(key => !attempted.has(key) && typeof values[key] === 'string' && values[key]);
      if (!keys.length) break;
      keys.forEach(key => attempted.add(key));
      const result = await chrome.tabs.sendMessage(tabId, { type: 'secondhand:fill', token: fresh.scan.token, fields: keys, values: Object.fromEntries(keys.map(key => [key, values[key]])) }, { frameId: 0 });
      if (!result?.ok) throw new Error('This page couldn’t be filled safely. Fill it yourself.');
      filled += result.filledCount;
      if (!result.filledCount) break;
    }
    const after = await readPage(tabId);
    if (filled > 0) await nativeRequest('recordProgress', { url: safeUrl(url), filledCount: Math.min(filled, 100) }).catch(() => {});
    const missing = needYou(after.page);
    return remember(tabId, { state: 'done', filled, needYou: missing, pageKey: after.page.pageKey,
      message: filled ? `Filled ${filled}${missing.length ? ` · ${missing.length} need you` : ''}. Review, then click Continue in Iowa’s form.` : missing.length ? `${missing.length} need you. They aren’t in your saved profile.` : 'Everything on this page is already filled.' });
  } catch (error) {
    if (error.code === 'offline') return remember(tabId, { state: 'offline', filled: 0, needYou: [], message: 'Open the SecondHand app, then click Autofill again.', pageKey: state?.page?.pageKey || '' });
    if (/Nothing to fill/.test(error.message)) throw error;
    const message = /cancelled/i.test(error.message) ? 'Cancelled. Nothing was filled.' : /Unlock/.test(error.message) ? 'Unlock SecondHand to autofill.' : error.message;
    return remember(tabId, { state: /Unlock/.test(error.message) ? 'locked' : 'error', filled: 0, needYou: [], message, pageKey: state?.page?.pageKey || '' });
  } finally { values = null; busyTab = null; }
}
function remember(tabId, result) { results.set(tabId, result); return result; }
async function pageState(tabId) {
  const state = await readPage(tabId);
  const result = results.get(tabId);
  return { page: state.page, scan: state.scan, result: result && result.pageKey === state.page.pageKey ? result : null };
}
```

  `recordProgress` failures are caught deliberately. The tracker is secondary, and the fill already happened. Its failure is not surfaced in the result message.

  Routing:

```js
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || Array.isArray(message)) return;
  const panel = sender.url === chrome.runtime.getURL('panel.html') && !sender.tab;
  const launcher = sender.url === chrome.runtime.getURL('panel.html?surface=launcher') && sender.frameId > 0 && Number.isInteger(sender.tab?.id) && SecondHandIowa.isSupportedUrl(sender.tab.url);
  if (!panel && !launcher) return;
  if (launcher && message.type === 'ui:openPanel' && message.confirmed === true) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => respond({ ok: true, data: { opened: true } }), () => respond({ ok: false, error: 'Use the SecondHand toolbar icon to open the side panel.' }));
    return true;
  }
  const tabId = launcher ? sender.tab.id : message.tabId;
  if (!Number.isInteger(tabId)) return;
  let work;
  if (message.type === 'ui:pageState') work = pageState(tabId);
  else if (message.type === 'ui:autofill' && message.confirmed === true) work = autofill(tabId);
  else if (message.type === 'ui:focusField' && typeof message.key === 'string' && /^[A-Za-z][A-Za-z0-9]{0,59}$/.test(message.key)) work = activePortal(tabId).then(() => chrome.tabs.sendMessage(tabId, { type: 'secondhand:focusField', key: message.key }, { frameId: 0 }));
  else if (message.type === 'ui:showApp' && message.confirmed === true) work = nativeRequest('showApp');
  else if (panel && message.type === 'ui:desktopStatus') work = nativeRequest('status').then(data => ({ connected: true, unlocked: Boolean(data?.unlocked) }), error => { if (error.code === 'offline') return { connected: false, unlocked: false }; throw error; });
  else return;
  work.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || 'SecondHand could not complete the request.' }));
  return true;
});
chrome.tabs.onRemoved?.addListener(tabId => results.delete(tabId));
chrome.tabs.onUpdated?.addListener((tabId, change) => { if (change.status === 'loading') results.delete(tabId); });
```

- [ ] **Step 4: Run** `npm test`. Delete `tests/extension-guided.test.cjs` and `tests/extension-flow.test.cjs`. Expected: the autofill tests pass. The panel tests for the old side panel UI still fail until Task 6.
- [ ] **Step 5: Commit** with the message "Rewrite the extension worker around one-click autofill".

### Task 6: Widget surface and simplified side panel

**Files:** `extension/panel.html`, `extension/panel.js`, `extension/panel.css`, test `tests/extension-panel.test.cjs` (panel section)

**Interfaces:** Consumes the `ui:*` messages from Task 5. Widget element IDs:
- `#launcher` section, with `#autofill` (button), `#widget-text` (status span), `#need-you` (button), `#details` (button), `#unlock` (button), and `#pill` (button).

Side panel IDs:
- `#desktop-status`, `#desktop-action` (button)
- `#panel-autofill` (button)
- `#status`
- `#checklist-section`, `#page-checklist`, `#checklist-summary`

- [ ] **Step 1: Tests.** Rewrite the panel section of `tests/extension-panel.test.cjs`:
  - The harness's `sendMessage` returns:
    - `ui:pageState`: `{ page, scan, result }`.
    - `ui:autofill`: a configurable result.
    - `ui:desktopStatus`: `{ connected: true, unlocked: true }`.
    - `ui:focusField`: `{ focused: true }`.
    - `ui:showApp`: `{ shown: true }`.

  Tests:
  - The side panel's first requests are `ui:pageState` and `ui:desktopStatus`. There are no `#start-auto`, `#fill-page`, or `#confirm` elements.
  - A trusted click on `#panel-autofill` sends `{ type: 'ui:autofill', confirmed: true, tabId: 7 }`. An untrusted `.click()` sends nothing.
  - The checklist renders the labels Done / Needs you / Optional / Do it yourself, and the summary reads `1 of 4 done`. Clicking a row sends `ui:focusField`.
  - The desktop line reads `Unlocked`. When `{ connected: false }` it reads `Not connected · Open the SecondHand app`. When locked, the text is `Locked` and the `#desktop-action` button (Unlock) sends `ui:showApp`.
  - Launcher on a fillable page: `#autofill` is visible. A trusted click sends `{ type: 'ui:autofill', confirmed: true }` and then renders `Filled 3 · 1 need you`. A trusted click on `#need-you` sends `{ type: 'ui:focusField', key: 'lastName', confirmed: true }`. `#details` sends `ui:openPanel`.
  - Launcher on a non-fillable page shows `#pill` and hides `#autofill`.
  - A launcher result with `state: 'locked'` shows `#unlock`, which sends `ui:showApp`.
  - Tab activation and a late old-tab response still clear the checklist (keep the existing tests, adapted to the new IDs).
- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
  - **`panel.html` body:**

```html
<section id="launcher" hidden>
  <div id="widget" class="widget">
    <span class="brand" aria-hidden="true">s.</span>
    <div class="widget-copy"><button id="autofill" class="widget-primary" type="button">Autofill</button><button id="unlock" class="widget-primary" type="button" hidden>Unlock SecondHand</button><span id="widget-text" role="status" aria-live="polite">Iowa SNAP</span></div>
    <button id="need-you" class="widget-link" type="button" hidden></button>
    <button id="details" class="widget-link" type="button" title="Open details in Chrome’s side panel">Details</button>
  </div>
  <button id="pill" class="pill" type="button" title="Nothing to fill on this page" hidden><span class="brand" aria-hidden="true">s.</span></button>
</section>
<div id="sidepanel" hidden>
  <header class="panel-header"><span class="brand" aria-hidden="true">s.</span><div class="header-copy"><strong>SecondHand</strong><span>IOWA SNAP</span></div></header>
  <main id="panel-body">
    <div class="desktop-row"><span id="desktop-status">Checking SecondHand…</span><button id="desktop-action" class="text-button" type="button" hidden>Unlock</button></div>
    <button id="panel-autofill" class="button primary full" type="button" disabled>Autofill this page</button>
    <div id="status" class="status" role="status" aria-live="polite">Open Iowa’s application in this tab.</div>
    <section id="checklist-section" class="checklist-section" hidden aria-labelledby="checklist-title">
      <div class="fields-heading"><h2 id="checklist-title">On this page</h2><span id="checklist-summary"></span></div>
      <div id="page-checklist" class="page-checklist"></div>
    </section>
    <footer><p>You review and click Continue. SecondHand never submits.</p></footer>
  </main>
</div>
```

  - **`panel.js`:**
    - **Launcher branch** (`?surface=launcher`): poll `ui:pageState` every 1.5 s while visible, and render:
      - `page.kind !== 'fillable'`: show `#pill`, hide `#widget`.
      - `result?.state === 'locked'`: show `#unlock`, hide `#autofill`.
      - `result?.state === 'done'`: `#widget-text` = `Filled N`. `#need-you` shows `M need you` when M > 0; each trusted click cycles through `result.needYou` and sends `ui:focusField`.
      - `result?.state === 'offline'` or `'error'`: `#widget-text` = `result.message`.
      - Otherwise: `Iowa SNAP · ready`.
    - Trusted handlers:
      - `#autofill`: set text to `Filling…`, send `ui:autofill`, render.
      - `#unlock`: `ui:showApp`.
      - `#details`: `ui:openPanel`.
      - `#pill`: `ui:openPanel`.
    - **Side-panel branch:** keep the active-tab tracking (`refresh`, `invalidateTarget`, the `onActivated` / `onUpdated` listeners, `schedulePoll`). Render the checklist with the new labels. `#panel-autofill` is enabled when `page.kind === 'fillable'` and not working. Call `ui:desktopStatus` on start and after each autofill. Remove all guided, preview, and confirm code.
  - **`panel.css`:** remove the guided, fields, confirm, and launcher-button rules. Add:
    - `.widget` — flex row, 62px high, green `#28543f` background, radius 14px.
    - `.widget-primary` — white button with dark text.
    - `.widget-link` — underlined light text.
    - `.pill` — 46×46 round green.
    - `.full` — width 100%.
- [ ] **Step 4: Run** `npm test` and `npm run check`. Expected: all pass.
- [ ] **Step 5: Commit** with the message "One-click Autofill widget and simplified side panel".

### Task 7: Remove the unreachable popup

**Files:** delete `extension/popup.html` / `popup.js` / `popup.css`; modify `desktop/extension-setup.cjs` (`EXTENSION_FILES`), `scripts/dev.cjs` (`PANEL_PAGE` → `/^panel\.(html|css|js)$/`), `tests/dev-reload.test.cjs` (drop the popup assertion), and `tests/extension-setup.test.cjs` (the file list at line 52 without `popup.js`).

- [ ] **Step 1:** Update the tests (`extension-setup` expects no `popup.*` in `EXTENSION_FILES`; drop the `dev-reload` popup line). Run them and confirm they fail.
- [ ] **Step 2:** Delete the files and update the lists. Run `npm test` and `npm run check` and confirm they pass.
- [ ] **Step 3: Commit** with the message "Remove the unused extension popup".

### Task 8: Extension smoke test for the widget

**Files:** `scripts/smoke-extension.cjs`

- [ ] **Step 1: Rewrite `installNativeStub`** to handle `status`, `getFields`, `recordProgress`, and `showApp`, with `state.locked`, and to record calls.
- [ ] **Step 2: Rewrite the flows.** Each flow loads the fixture, waits for the launcher frame's `#autofill`, and clicks it with a Playwright locator in the launcher frame (a trusted click). Flows:
  1. **Full profile:** every mapped field fills (`lastName`, `addressLine1`, `mailingAddressLine1`, `snap` checked, `bestTime`). `#widget-text` contains `Filled`. `window.__nextClicks === 0`. Exactly one `getFields` call.
  2. **Missing first name:** `#need-you` reads `1 need you`. Clicking it focuses `#firstName`.
  3. **Conditional branches (the existing four profile variants):** `__lastAnswers` isn't produced without Next, so read the DOM state directly with the same assertions.
  4. **Locked:** `#unlock` is visible, no fields are filled, and clicking it produces a `showApp` call.
  5. **Consent fixture page** (`?next=consent`, rendered directly): the widget shows `#pill` and nothing is filled.
  6. **Side panel:** open it via `#details`, attach with `attachNativePanel`, confirm the checklist shows `Done` rows, and confirm the panel text has no profile values.

  Take the screenshots `artifacts/extension-assistant.png` (page with widget) and `artifacts/extension-native-sidebar.png`.
- [ ] **Step 3: Run** `npm run test:extension` and confirm every flow passes.
- [ ] **Step 4: Commit** with the message "Smoke test the one-click Autofill widget".

### Task 9: Documentation and copy

**Files:** `README.md`, `docs/iowa-portal.md`, `docs/implementation-contract.md`, `docs/security.md`, `docs/setup.md`, `website/app/page.tsx`

- [ ] **Step 1:** Remove every guided-mode, Fill & Next, 15-minute session, and `startAssistedSession` / `checkAssistedSession` / `endAssistedSession` / `assistanceToken` reference. Describe instead:
  - the Autofill widget and one-click flow;
  - the trust switch (off by default, "Always allow on this computer", lock stops it, reset on a new extension ID);
  - `showApp`;
  - that the user clicks Iowa's Save and Continue.
- [ ] **Step 2:** `grep -rn "guided\|Guided\|Fill & Next\|AssistedSession\|assistanceToken" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=ios . | grep -v docs/superpowers` returns nothing.
- [ ] **Step 3:** Run `npm test`, `npm run check`, and `npm run test:extension` one last time.
- [ ] **Step 4: Commit** with the message "Document one-click autofill and the trust switch".
