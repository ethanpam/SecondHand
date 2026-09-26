# One-click autofill: design

Date: 2026-09-26 · Branch: `extension-refinement`

## Problem

Filling Iowa's applicant page takes too many steps. You open the assistant, open the side panel, pick fields, tick a confirmation box, click Fill, and switch to the desktop app to approve. Guided mode adds a new desktop approval every 15 minutes. The side panel has too much text and too many controls. The goal is Simplify-style autofill: one click on the page, with the desktop vault still the only owner of applicant data.

Out of scope: mapping more Iowa pages (separate follow-up), moving the profile out of the desktop vault, and changing the 10-minute idle lock.

## Decisions

| Topic | Decision |
| --- | --- |
| Where data lives | The desktop vault stays the only owner. Values cross the native bridge only on request. |
| Approval frequency | One trust switch, turned on at first use. When it is on, fills do not prompt. |
| Fill trigger | One Autofill click. You review the page and click Iowa's Continue yourself. |
| Automatic navigation | Removed: Fill & Next, guided mode, and the desktop assisted-session code. |
| Side panel | Kept, simplified: Autofill button, desktop status, and checklist only. |
| Auto-lock | 10 minutes idle, unchanged. A locked vault shows **Unlock SecondHand**. |

## 1. Desktop app

**Trust switch.** `settings.json` in the app data folder already holds `extensionId`. It gains `autofillWithoutAsking` (boolean, default `false`). The value is non-sensitive and is not stored in the vault.

- `getFields` without a token:
  - The switch is on and `context.extensionId` equals the stored `extensionId`: return the requested nonblank values without a dialog.
  - The switch is off: show the dialog with buttons **Cancel**, **Allow once**, and **Always allow on this computer**. "Always allow" sets the switch, writes `settings.json`, and returns values. "Allow once" returns values and leaves the switch off. "Cancel" throws `You cancelled this field request.`
  - Unchanged checks: vault unlocked (`requireUnlocked`), exact Iowa origin and path, allowlisted field names, one pending dialog at a time, and `touch()` on success.
- `status()` includes `autofillWithoutAsking`.
- Renderer API `setAutofillTrust(enabled: boolean)` sets and saves the switch, then returns status. The **Chrome extension** view shows it as a checkbox labelled "Let Chrome autofill without asking", with this help text: "When SecondHand is unlocked, the extension fills your saved answers on Iowa's supported page without a pop-up. Lock SecondHand to stop."
- Registering a different extension ID (`connectExtension` / `prepareExtension` producing a new ID) resets the switch to `false`.
- New bridge request `showApp`: shows and focuses the main window and returns `{ shown: true }`. It works while locked and returns no profile data.
- Removed: `startAssistedSession`, `checkAssistedSession`, `endAssistedSession`, `desktop/assistance.cjs`, `AssistedSession` wiring (including revocation on lock and profile save), `tests/desktop-assistance.test.cjs`, and the assisted-session tests in `tests/desktop-assistance-main.test.cjs`. `recordProgress` stays.

## 2. Extension: widget and worker

**Widget.** It replaces the launcher: `panel.html?surface=launcher` in the same closed-shadow iframe at the bottom-right of the page. The content script sizes the host for each state.

| State | Display |
| --- | --- |
| `ready` (recognized fillable page) | **Autofill** button and a "Details" link |
| `filling` | "Filling…" (button disabled) |
| `done` | "Filled N" and, when M > 0, a "M need you" link. Each click focuses the next missing field. |
| `locked` | **Unlock SecondHand** button, which sends native `showApp` |
| `offline` (native host unreachable) | "Open the SecondHand app" |
| `idle` (portal page with nothing fillable) | Small "s." pill, title "Nothing to fill on this page" |
| `error` | One-line message, and the Autofill button is re-enabled |

The widget refreshes its state by sending `ui:pageState` for its own tab every 1.5 s while visible. It shows no values.

**Launcher permissions.** The worker now accepts these trusted-click messages from the launcher sender (`panel.html?surface=launcher`, `frameId > 0`, supported tab URL): `ui:openPanel`, `ui:autofill`, `ui:focusField`, `ui:showApp`, and `ui:pageState`. The tab is always `sender.tab.id`; any `tabId` in the message is ignored. The side panel (`panel.html`, no tab sender) can send the same types with an explicit `tabId`.

**Autofill in the worker** (`autofill(tabId)`):
1. `readPage(tabId)`. If the page is not recognized as fillable, throw `Nothing to fill on this page.`
2. Request every key in `SecondHandIowa.definitions` (all of them belong to the one recognized applicant page), not only the visible ones, in one native `getFields`. That way conditional branches revealed by earlier answers need no second request. The desktop returns only nonblank saved values.
3. Fill in up to 4 passes. Each pass rescans, then fills the currently visible empty keys that have values and haven't been attempted. It stops when a pass fills nothing.
4. "Need you" = checklist rows that are required and still `missing`, or `manual`, after the last pass. The result is `{ state, filled, needYou: [keys], message, pageKey }`.
5. If `filled > 0`, send `recordProgress`.
6. Values live only inside this function call and are released in `finally`.

**Removed from the extension:** `ui:fill`, `ui:fillAndNext`, `ui:auto`, the assistance state and polling loop, `nextPage`, the content script's `secondhand:next`, the adapter's `captureNavigation` / `advance` / `navigationButton`, `popup.html` / `popup.js` / `popup.css` (unreachable), and their entries in `desktop/extension-setup.cjs`. `tests/extension-guided.test.cjs` is removed. Autofill coverage moves to a new `tests/extension-autofill.test.cjs`.

**Unchanged:** Iowa-only host permission and content-script matches, top frame only, no overwriting of existing answers or selected choices, no extension storage, and no values in logs or messages to the page.

## 3. Side panel

The side panel shows, from top to bottom:
- A header ("SecondHand") and a desktop line: `Unlocked`, `Locked · Unlock`, or `Not connected · Open app`.
- A large **Autofill this page** button, which sends the same `ui:autofill`.
- A result line (the same message as the widget).
- The checklist: rows marked **Done**, **Needs you**, **Optional**, or **Do it yourself** (manual). Clicking a row focuses that field. A summary reads "N of M done".
- A one-line footer: "You review and click Continue. SecondHand never submits."

Removed: the guided section, the field checkboxes, the confirm checkbox, the Fill / Fill & Next buttons, and the long help paragraphs.

## 4. Errors

Every failure shows a short fixed message in the widget and the panel. Nothing is retried automatically and nothing falls back silently.

| Cause | Message / state |
| --- | --- |
| Vault locked (`requireUnlocked` error) | `locked` state |
| Native host unreachable | `offline` state |
| Dialog cancelled | "Cancelled. Nothing was filled." |
| Tab URL changed mid-fill | "The page changed. Click Autofill again." |
| Unrecognized page | `idle` state |
| Adapter/page error | "This page couldn't be filled safely. Fill it yourself." |

## 5. Testing

- **Desktop** (`tests/desktop-assistance-main.test.cjs`, vm harness):
  - Trusted `getFields` returns values with no prompt.
  - Untrusted `getFields` prompts. "Always allow" persists the switch, "Allow once" doesn't, and "Cancel" throws.
  - A new extension ID resets trust.
  - A locked vault rejects even when trusted.
  - `showApp` works while locked.
  - `setAutofillTrust` round-trips through `status()`.
- **Worker** (new `tests/extension-autofill.test.cjs`, same harness style as the removed guided tests):
  - One native `getFields` per click.
  - Conditional fields are filled on a later pass.
  - Missing keys are reported.
  - Locked and offline errors map to the right states.
  - Launcher sender rules: its own tab only, and non-trusted types are rejected.
- **Panel/widget** (`tests/extension-panel.test.cjs`, jsdom): each widget state renders, "need you" cycles focus, and the panel has no guided controls.
- **Adapter:** remove the advance and navigation tests. Keep scan, fill, probe, and focus.
- **Smoke** (`scripts/smoke-extension.cjs`): the widget Autofill fills the synthetic page, the "need you" jump works, the locked state shows Unlock, and no Next is clicked.
- **Docs:** update `README.md`, `docs/iowa-portal.md`, `docs/implementation-contract.md`, `docs/security.md`, and `docs/setup.md` for the trust switch and the removed guided mode.
