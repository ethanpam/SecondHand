# Autofill Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Autofill click keeps working through Iowa's application screens in that tab. It fills what it can, clicks Continue on info-only screens, and stops with a plain instruction wherever the user is needed.

**Architecture:**
- **Adapter** (`extension/iowa-adapter.js`) owns all page knowledge: a page-aware form and definition set (applicant page plus the household question), an info-screen registry with exact Continue handlers, `continuePage`, a `todo` instruction on pages that need the user, and `profileRequest` / `pageValues` to map saved profile fields to page answers.
- **Worker** (`extension/background.js`) keeps a per-tab autopilot in memory and runs one step per page load or widget poll.
- **Widget** shows Stop while autopilot is on.

**Tech Stack:** MV3 extension (plain JS), `node:test`, jsdom, Playwright smoke.

## Global Constraints

- No new dependencies, no `chrome.storage`. Autopilot state lives in worker memory only, and pages can never turn it on.
- Never click Save and Continue, Submit, Back, or anything on consent, CAPTCHA, verification, or signature screens. Auto-click only a registry Continue whose exact `onclick` was recorded live.
- The desktop bridge still allowlists profile fields. Page answers such as `householdApplyProg` are derived in the extension and never requested from the desktop.
- At most 15 automatic steps per run, and one Continue click per `url|pageKey` per run.
- Commit as the user, with no attribution to Claude.

## Recorded live controls (2026-09-26)

| Screen | Path seen | Recorded controls |
| --- | --- | --- |
| Household Application Information | `/applyForBenefits/guestLogin`, `/applyForBenefits/householdApplicationInfoBack` | `form#householdApplicationForm[action=selectHouseholdInfo]`. Radios `#householdApplyProgYes` (value `true`) and `#householdApplyProgNo` (value `false`), name `householdApplyProg`, `onclick="toggleCaptcha();"`. Labels: "Yes. At least one person is applying for SNAP, FIP/RCA, or help paying for health coverage." / "No. You will answer fewer questions but you will not get help paying for health coverage." The CAPTCHA (`#captchaDiv`, `#reCaptchaResponse`, `#simpleCaptcha`) stays hidden until a radio is clicked. Continue runs `validateMsg();`. |
| Before You Start... | `/applyForBenefits/welcome` | Continue `button.btn.btn-primary.saveButton`, `onclick="submitUrlLink('letsGetStarted');return false;"`. No named controls. |
| Let's get started | `/applyForBenefits/letsGetStarted` | `#termChkbox` in `form#welcomeForm[action=forceLogin]`. Continue runs `welcomeSubmit();`. |
| Important Information when applying and what to expect. | `/applyForBenefits/importantInfo` | Continue `submitUrlLink('instructions');return false;`. No controls. |
| Instructions | `/applyForBenefits/instructions` | Continue `submitUrlLink('aboutYou');return false;`. Illustration controls only (no id or name, `onclick=""`). |
| About you / Assisting Organization or Person | — | Recorded in Task 6 when the live session reaches them. |

---

### Task 1: Adapter: household question, info registry, `continuePage`, `todo`

**Files:** Modify `extension/iowa-adapter.js`. Test `tests/extension-adapter.test.cjs` and a new fixture `tests/fixtures/iowa-pre-applicant.cjs`.

**Interfaces (produces):**
- `probePage(doc, url)` adds:
  - `kind: 'info'` for registry info screens whose exact Continue is present;
  - `todo: string` on pages that need the user (consent, CAPTCHA, verification, assisting organization, select address, household question with no derivable answer);
  - `pageKey: 'iowa-program-intent'` for the household question, now `kind: 'fillable'` while unanswered.
- `scan` / `fill` recognize the household page with the single key `householdApplyProg` (values `yes`/`no`).
- `continuePage(doc, url) -> { continued: boolean, reason }`.
- `profileRequest(pageKey) -> string[]`, the saved profile fields to request for a page:
  - `iowa-personal-information`: the applicant keys;
  - `iowa-program-intent`: `['programSnap', 'programFip', 'programMedicaid']`.
- `pageValues(pageKey, values) -> object`:
  - `iowa-program-intent`: `{ householdApplyProg: 'yes' }` when any of the three is `yes`, else `{}`;
  - `iowa-personal-information`: values unchanged.
- `definitions` stays the applicant definitions, so existing callers are unaffected.

- [ ] **Step 1: Fixture.** Create `tests/fixtures/iowa-pre-applicant.cjs` exporting `household`, `beforeYouStart`, `letsGetStarted`, `importantInfo`, and `instructions` HTML strings that mirror the recorded controls above. Include the hidden CAPTCHA block and `toggleCaptcha` behavior via an `attach(doc)` helper that shows `#captchaDiv` on radio click. The instructions fixture includes the illustration Save and Continue / Submit Application buttons with `onclick=""`.
- [ ] **Step 2: Failing tests** in `tests/extension-adapter.test.cjs`:
  - **Household:** `probePage` → `fillable`, `pageKey: 'iowa-program-intent'`, checklist row `householdApplyProg` missing. `scan` fields `['householdApplyProg']`. `fill` with `yes` clicks `#householdApplyProgYes`. After that the CAPTCHA shows, so `probePage` → `blocked` with `todo` "Solve the CAPTCHA, then click Continue." `fill` refuses `maybe`.
  - **Household matcher fails closed:** a third `householdApplyProg` radio, a changed label, or a changed `onclick` means no fields.
  - **Derived answers:** `pageValues('iowa-program-intent', { programSnap: 'yes' })` → `{ householdApplyProg: 'yes' }`. All `no` or blank → `{}`. `profileRequest` lists are exact.
  - **Info screens:** each of the three → `kind: 'info'`. `continuePage` clicks the exact button once (count clicks with a listener).
  - **Instructions decoys:** the illustration "Save and Continue" and "Submit Application" are never clicked; only the `aboutYou` Continue is.
  - **`continuePage` refuses** with a wrong `onclick`, two Continue buttons, a hidden Continue, a visible named input, an unknown heading, the consent page, or when the CAPTCHA is visible.
  - **Consent:** `blocked` with `todo` "Read and accept Iowa’s consent, then click Continue."
- [ ] **Step 3:** Run `node --test tests/extension-adapter.test.cjs` and confirm it fails.
- [ ] **Step 4: Implement.**
  - Introduce a `forms` table: `{ personal: 'form#personalInformation[action="enterPersonalInfo"]', household: 'form#householdApplicationForm[action="selectHouseholdInfo"]' }`.
  - Add a `householdDefinitions` table with the radio definition, extended with `optionNames` and `optionHandlers`, and `form: 'household'`.
  - Generalize `matchingControls(doc, definition)` to use `forms[definition.form || 'personal']`, `definition.optionNames` when present, and `definition.optionHandlers` when present.
  - Change `identifyPage(doc)` to return `'personal' | 'household' | null`. `scan` iterates the matching definition set. `fill` looks definitions up in both sets.
  - Add safe section labels for the household heading.
  - Add the info registry:

```js
const infoScreens = Object.freeze({
  'before you start...': { pageKey: 'iowa-before-start', onclick: "submitUrlLink('letsGetStarted');return false;" },
  'important information when applying and what to expect.': { pageKey: 'iowa-information', onclick: "submitUrlLink('instructions');return false;" },
  instructions: { pageKey: 'iowa-instructions', onclick: "submitUrlLink('aboutYou');return false;" }
});
```

  - `continueButton(doc)` returns the single rendered, enabled `button.saveButton` whose normalized text is `continue` and whose `onclick` equals the registry value for the visible heading. It returns `null` if there's no single such button, or if any rendered `input` / `select` / `textarea` with an id or name exists outside `#languageFormMenu`.
  - `continuePage` re-runs `probePage` (must be `info`), then `continueButton`, then `scrollToField`, then clicks once.
  - In `probePage`, the protected-step check maps its trigger to a `todo`:
    - CAPTCHA elements (`#captchaDiv`, `[name=captchaAnswer]`, `#reCaptchaResponse` rendered container) → CAPTCHA todo;
    - `#termChkbox` → consent todo;
    - password / `#securityCode` → "Sign in or verify in Iowa’s form, then continue.";
    - signature headings → "Sign or submit in Iowa’s form yourself.";
    - `[aria-modal="true"]` → "Answer Iowa’s pop-up, then continue."

    Also: Assisting Organization → "If nobody is helping you, leave this blank and click Continue." Select Address → "Pick the correct address, then click Continue." The household page with the question answered and no CAPTCHA → "Click Continue in Iowa’s form."
- [ ] **Step 5:** Run the adapter tests and the full `npm test`, and confirm they pass.
- [ ] **Step 6: Commit** with the message "Map Iowa's pre-applicant screens for autofill autopilot".

### Task 2: Content script: continue message and sizing

**Files:** Modify `extension/content.js`. Test `tests/extension-panel.test.cjs` (content section).

**Interfaces (produces):** Content message `secondhand:continue` → `{ continued, reason }` (runs `adapter.continuePage` with its own overlay hidden). The host is sized `full` when `kind` is `fillable` or `info`, or `todo` is set; otherwise `pill`.

- [ ] **Step 1: Tests.**
  - The harness `probePage` returns a configurable `{ kind, todo }`.
  - `secondhand:continue` calls the stub `continuePage` once and returns its result.
  - Foreign senders get `undefined`.
  - Sizing: `info` → full, `blocked` with `todo` → full, `manual` without `todo` → pill.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement.** Add the message branch. Change `sizePanel`'s `fillable` test to:

```js
const page = withOwnPanelHidden(() => adapter.probePage(document, location.href));
const full = page.kind === 'fillable' || page.kind === 'info' || Boolean(page.todo);
```

- [ ] **Step 4:** Run them and confirm they pass.
- [ ] **Step 5: Commit** with the message "Let the content script continue info screens and size the widget for them".

### Task 3: Worker autopilot

**Files:** Modify `extension/background.js`. Test `tests/extension-autofill.test.cjs`.

**Interfaces:**
- Consumes `profileRequest`, `pageValues`, `probePage` (`kind`, `todo`, `pageKey`), and `secondhand:continue`.
- Produces:
  - `ui:autofill` (confirmed) turns autopilot on and runs a step. It returns the result.
  - `ui:stop` (confirmed) turns it off and returns `{ state: 'stopped', message: 'Autofill stopped.' }`.
  - `ui:pageState` returns `{ page, scan, result, autopilot: boolean }`. It runs a step first when autopilot is on and `url|pageKey` changed.
  - `result.state` adds `'waiting'`, `'continuing'`, and `'stopped'`.

- [ ] **Step 1: Tests.** Extend the harness page model to a sequence of pages (`info` → `info` → `fill` household → `blocked` CAPTCHA → `fill` applicant → unknown). `secondhand:continue` advances the model and fires `events.updated(7, { status: 'complete' })`.
  - One `ui:autofill` on the first info page continues through both info pages, fills the household question with one `getFields` request for `programSnap` / `programFip` / `programMedicaid`, and ends `waiting` with the CAPTCHA todo.
  - After the model moves to the applicant page (the user solved the CAPTCHA) and `updated` fires, the step fills the applicant page with one `getFields` request for the applicant keys and ends `waiting` with "Check your answers, then click Save and Continue."
  - An unknown page turns autopilot off with "SecondHand doesn't know this page yet. Fill it in, then continue."
  - `ui:stop` turns it off, and later `updated` events run nothing.
  - A locked vault turns it off with state `locked`.
  - The step cap stops at 15.
  - The same `url|pageKey` is never continued twice.
  - The launcher can send `ui:stop` but not for another tab.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement.**
  - `autopilot = new Map()` holding `{ on, steps, handled: Set, running }`.
  - `step(tabId)`: guard `running`; `readPage`; signature = `url|pageKey`; skip if already handled; add it; `steps++`; if `steps > 15`, turn off. Then by page:
    - `kind === 'info'`: send `secondhand:continue`. If continued, remember `{ state: 'continuing', message: 'Continuing…' }`; otherwise `waiting` with "Click Continue in Iowa’s form."
    - `kind === 'fillable'`: `autofillPage` (the existing `autofill` body made page-aware via `profileRequest` / `pageValues`), then a result `waiting` with the fill message plus `after.page.todo` or the applicant check text.
    - `page.todo`: `waiting` with the todo.
    - Otherwise: turn off with the unknown-page message.
  - Locked or offline results turn autopilot off.
  - Hooks:
    - `tabs.onUpdated` with `status === 'complete'` → `step` when on.
    - URL change off the portal → turn off.
    - `onRemoved` → delete.
  - Remove the per-click-only `busyTab` in favor of the per-tab `running` flag.
- [ ] **Step 4:** Run `npm test` and confirm it passes.
- [ ] **Step 5: Commit** with the message "Keep autofill working across Iowa's screens until the user is needed".

### Task 4: Widget and side panel for autopilot

**Files:** Modify `extension/panel.html`, `panel.js`, `panel.css`. Test `tests/extension-panel.test.cjs`.

**Interfaces:** Consumes `ui:stop`, and `autopilot` / `result.state` in `ui:pageState`.

- [ ] **Step 1: Tests.**
  - With `autopilot: true`, the widget shows `#stop` and hides `#autofill`, and `#widget-text` shows the result message. A trusted `#stop` click sends `{ type: 'ui:stop', confirmed: true }`.
  - Polls adopt the worker result while autopilot is on, since the worker advances between polls.
  - The pill is fixed-size: computed `width` and `height` are `46px` in CSS.
  - The side panel shows "Stop autofill" while on.
- [ ] **Step 2:** Confirm they fail.
- [ ] **Step 3: Implement.**
  - Add `<button id="stop" class="widget-primary" hidden>Stop</button>`. While autopilot is on, render `result.message` (truncated) in `#widget-text`.
  - The widget always adopts the polled result while autopilot is on, and only when it has no local result otherwise.
  - CSS: `.pill{width:46px;height:46px;flex:none}` and `#launcher{display:flex;align-items:center;justify-content:center}`.
  - In the side panel, `#panel-autofill` toggles to "Stop autofill" while on.
- [ ] **Step 4:** Confirm they pass.
- [ ] **Step 5: Commit** with the message "Show autopilot progress and a Stop button in the widget".

### Task 5: Smoke test for the multi-screen walk

**Files:** Modify `scripts/smoke-extension.cjs`.

- [ ] **Step 1: Routes.** Serve the Task 1 fixtures at the recorded paths:
  - `/applyForBenefits/welcome` (Before You Start);
  - `/applyForBenefits/importantInfo`;
  - `/applyForBenefits/instructions`, whose Continue navigates to `/applyForBenefits/enterPersonalInfo` in place of About you until it's recorded.

  Each fixture's `submitUrlLink(target)` sets `location.href` to the matching fixture path.
- [ ] **Step 2: Flow.** Start at Before You Start and click the widget's `#autofill` once. Expect the applicant page to load and be filled (`lastName` has its value), `#widget-text` to contain "Check your answers", `#stop` to be visible, and `__nextClicks === 0`.
- [ ] **Step 3: Household flow.** Serve the household fixture. One Autofill click checks Yes and the widget shows "Solve the CAPTCHA".
- [ ] **Step 4:** Run `npm run test:extension` and confirm every flow passes.
- [ ] **Step 5: Commit** with the message "Smoke test the autofill autopilot across screens".

### Task 6: Record About you and Assisting Organization live, then document

**Files:** `extension/iowa-adapter.js` (registry), `tests/fixtures/iowa-pre-applicant.cjs`, docs.

- [ ] **Step 1:** When the live guest session reaches About you and Assisting Organization or Person, run the read-only inspector and record headings, controls, and the Continue `onclick`.
- [ ] **Step 2:**
  - Add About you to `infoScreens` if it has no named controls; otherwise map it as a todo page.
  - Assisting Organization stays a todo page.
  - Add fixtures and tests for both.
  - Point the instructions fixture's Continue back at the real `aboutYou` path.
- [ ] **Step 3: Docs.** Update `README.md`, `docs/setup.md`, `docs/iowa-portal.md` (registry table and recorded controls), and `docs/implementation-contract.md` (`ui:stop`, autopilot, `secondhand:continue`).
- [ ] **Step 4:** Run `npm test`, `npm run check`, and `npm run test:extension`. Then commit with the message "Record About you and Assisting Organization and document autopilot".
