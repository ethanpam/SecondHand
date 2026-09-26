# Any-Site Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SecondHand fills food-assistance forms on any site the user approves. Rules come first, with Chrome's on-device AI as a free backup.

**Architecture:**
- New `extension/generic-adapter.js` (scan, rule matching, filling) for approved non-Iowa sites. Iowa keeps `iowa-adapter.js` and its autopilot.
- Per-site trust has two gates: Chrome's optional host permission, and the desktop `trustedSites` list. The desktop stays the only data owner and gatekeeper.
- The AI backup runs in the widget's extension page through the Prompt API. It sees labels only.

**Tech Stack:** MV3 extension (plain JS), Electron desktop (CommonJS), `node:test`, jsdom.

## Global Constraints

- **Free and local:** no cloud services, API keys, paid APIs, or new npm dependencies.
- **Extension rules:**
  - No `chrome.storage`; values never leave the fill call.
  - Never fill passwords, `cc-*` autocomplete fields, files, or CAPTCHAs.
  - Never overwrite an existing answer.
  - Never click Next or Submit on general sites.
- **Desktop gatekeeping:** `getFields` only for Iowa or a desktop-trusted origin. Sensitive keys (`ssn`, `birthDate`, `monthlyEarnedIncome`, `monthlyOtherIncome`) on non-Iowa origins always prompt.
- **Git:** commit as the user, with no attribution to Claude.

---

### Task 1: Household counts in the profile

**Files:** `shared/schema.cjs`, `renderer/index.html`, `renderer/app.js`. Tests: `tests/schema.test.cjs`, `tests/renderer-state.test.cjs`.

**Produces:**
- Profile keys `householdAdults`, `householdChildren`, `householdSeniors` (strings `''` or `'0'`–`'30'`), plus `householdVeteran` and `householdDisability` (`''` / `'yes'` / `'no'`).
- `FIELD_LABELS`: "Adults in household", "Children in household", "Seniors (65+) in household", "Anyone in household a veteran", "Anyone in household with a disability".

- [ ] **Step 1: Failing tests.**
  - Schema: counts accept `''` and `'0'`–`'30'` and reject `'31'`, `'-1'`, `'2.5'`, `'abc'`. The yes/no fields reject `'maybe'`. `PROFILE_FIELDS` includes all five.
  - Renderer: the profile form has inputs named for the five keys and saves them.
- [ ] **Step 2:** Run and confirm they fail.
- [ ] **Step 3: Implement.**
  - Add the labels.
  - Add the two yes/no fields to `YES_NO_FIELDS`.
  - Add count validation: `/^(?:[0-9]|[12][0-9]|30)$/` when non-blank, with the message "<Label> must be a whole number from 0 to 30, or left blank."
  - Add a "Household" group to the profile form: three number inputs (`min=0`, `max=30`, `step=1`) and two Yes/No/Unknown selects matching the existing choice controls.
  - Add the keys to `profileFields` in `renderer/app.js`.
- [ ] **Step 4:** Run `npm test` and `npm run check` and confirm they pass. Then commit with the message "Add household counts to the saved profile".

### Task 2: Desktop site trust and origin-gated field release

**Files:** `desktop/bridge.cjs`, `desktop/main.cjs`, `shared/schema.cjs`. Tests: `tests/desktop-bridge.test.cjs`, `tests/desktop-assistance-main.test.cjs`.

**Produces:**
- Bridge `trustSite { url }` → `{ trusted: true, origin }`.
- `getFields` allowed when `isPortalUrl(url)` or `trustedSites.includes(origin(url))`.
- A `sensitive` dialog for non-Iowa origins.
- Renderer `status().trustedSites` and `removeTrustedSite(origin)`.

- [ ] **Step 1: Failing tests.**
  - Bridge validation: `trustSite` requires an `https` URL with no credentials or port. `getFields` accepts any `https` URL shape, and trust is enforced in main.
  - Main:
    - `trustSite` → dialog → persisted `trustedSites`.
    - `getFields` on an untrusted origin → "This site isn't trusted".
    - A trusted origin with `firstName` only and Always allow on → no dialog. A trusted origin requesting `ssn` → dialog even with Always allow on.
    - `removeTrustedSite` → later `getFields` rejected.
    - A locked vault blocks `trustSite`.
- [ ] **Step 2:** Confirm they fail.
- [ ] **Step 3: Implement.**
  - Add `siteOrigin(url)` and `isHttpsSiteUrl(url)` to `schema.cjs`.
  - Store `trustedSites` in settings (at most 50 entries).
  - Branch the dialog on `isPortalUrl` vs a trusted origin. The sensitive keys are `['ssn', 'birthDate', 'monthlyEarnedIncome', 'monthlyOtherIncome']`.
- [ ] **Step 4:** Confirm they pass. Commit with the message "Let the desktop trust specific sites and gate sensitive fields".

### Task 3: Generic adapter (rules)

**Files:** Create `extension/generic-adapter.js` and `tests/fixtures/pantry-forms.cjs`. Test: `tests/generic-adapter.test.cjs`.

**Produces** a global `SecondHandGeneric` (and `module.exports` for tests) with:
- `scanForm(doc) -> { fields: [{ id, label, type, options, required, autocomplete, name }], bindings }`, where `id` is a stable `sh-N` token kept in a WeakMap, not written to the DOM;
- `matchRules(field) -> { key, confidence: 'high' | 'medium' | null }`;
- `plan(doc) -> { matched: [{ id, key }], unmatched: [field] }`;
- `fillFields(doc, bindings, values, { guessed: Set }) -> { filled, skipped }`;
- `focusField(doc, id)`.

- [ ] **Step 1: Fixtures.** Three sanitized forms:
  - a plain pantry intake: name, address, city, ZIP, phone, email, household size, adults, children, seniors, veteran yes/no radios, monthly income, a password field, and a card-number field;
  - a Google Forms-style form: `aria-labelledby` question titles, native inputs, and a `role=radiogroup` of div options that must be skipped;
  - a Jotform-style form: split first/last name, `select` state, and a textarea for notes.
- [ ] **Step 2: Failing tests.**
  - Expected key maps per fixture.
  - Password, card, file, and CAPTCHA fields are never scanned.
  - A pre-filled field is skipped.
  - A medium-confidence partial match is not in `matched`.
  - Select by option text ("Iowa" for `IA`), radio "Yes"/"No", number fields for counts.
  - Fills dispatch `input` and `change` events.
  - A guessed-set outline class is applied.
- [ ] **Step 3: Implement** the vocabulary table and the functions. Reuse the Iowa adapter's `rendered` / `visible` logic by copying the minimal functions; the adapter is a standalone content script with no module system.
- [ ] **Step 4:** Confirm the tests pass. Commit with the message "Add a rules-based adapter for food-assistance forms on any site".

### Task 4: Extension site enablement and general autofill

**Files:** `extension/manifest.json`, `extension/background.js`, `extension/content.js` (host sizing on general sites), `extension/panel.js` / `panel.html`, `scripts/check.cjs`. Tests: `tests/extension-autofill.test.cjs`, `tests/extension-panel.test.cjs`.

- [ ] **Step 1: Failing tests.**
  - `ui:enableSite` calls `permissions.request` → native `trustSite` → `scripting.registerContentScripts` with `generic-adapter.js` + `content.js` for `origin/*`.
  - `ui:autofill` on a trusted general site → one `getFields` for the matched keys → fill → result counts, with no navigation messages.
  - An untrusted site never sends `getFields`.
  - `check.cjs` allows only `optional_host_permissions: ["https://*/*"]`.
- [ ] **Step 2: Implement.**
  - Manifest: add `optional_host_permissions` and the `permissions` usage.
  - Worker: `enableSite` and `disableSite`, and a general `autofill` path chosen by origin.
  - Content script: detect which adapter is present (`SecondHandIowa` on Iowa, `SecondHandGeneric` elsewhere).
  - Widget: an "Enable on this site" state when the site isn't enabled.
- [ ] **Step 3:** Run `npm test`, `npm run check`, and `npm run test:extension`. Commit with the message "Enable autofill on sites the user approves".

### Task 5: Chrome AI backup

**Files:** `extension/panel.js` (widget), `extension/ai-mapper.js` (new, pure parsing and validation). Test: `tests/ai-mapper.test.cjs`.

- [ ] **Step 1:** Look up the current Chrome Prompt API surface (`LanguageModel.availability`, `create`, `prompt`, and its responseConstraint / JSON schema option) in the docs before coding.
- [ ] **Step 2: Failing tests** for `buildPrompt(unmatched, keys)` (labels and options only), `parseMapping(text, unmatched, keys)` (strict JSON; an unknown key, id, or type mismatch → null), and the widget behavior when unavailable (the "AI unavailable" note, and fields stay in need-you).
- [ ] **Step 3: Implement.** The widget requests AI mapping only after rule matching, only when `availability() === 'available'`, with one prompt per click and a timeout.
- [ ] **Step 4:** Confirm the tests pass. Commit with the message "Use Chrome's built-in AI to place fields the rules miss".

### Task 6: Docs and manual check

- [ ] Update `README.md`, `docs/setup.md`, `docs/security.md`, and `docs/implementation-contract.md` for site trust, the general engine, and the AI backup.
- [ ] Run a manual pass with the user on a public pantry form or Google Form.
