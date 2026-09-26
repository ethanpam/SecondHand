# Autofill on any food-assistance form: design

Date: 2026-09-26 · Branch: `extension-refinement` · Builds on the one-click and autopilot designs.

## Goal

SecondHand fills food-assistance forms on any site you approve: other states' SNAP portals, WIC, and food pantry sign-ups (Google Forms, Jotform, pantry software).
- It fills confident matches.
- It flags guesses.
- It lists what still needs you.

Everything is free and local, with no cloud, API key, or paid dependency. Iowa keeps its verified adapter and autopilot.

## Decisions

| Topic | Decision |
| --- | --- |
| Target | Food-assistance forms, not every web form |
| Recognition | Rules first. Chrome's built-in on-device AI (Gemini Nano, Prompt API) places leftovers when available. |
| Site access | You approve each site once, in Chrome (optional host permission) and in the desktop app (trusted site list). |
| Sensitive fields | SSN, birth date, and income on a non-verified site always need a desktop confirmation naming the site. |
| Navigation | General sites: fill only. Never click Next, Submit, or anything similar. |
| Profile | Adds household counts: adults, children, seniors (65+), plus "anyone a veteran" and "anyone with a disability" (yes/no). |
| Cost | $0. No cloud services or paid APIs. |

## Build order

Each step works on its own.

1. **Household counts** in the schema, the vault validation, and the desktop profile form.
2. **General engine with per-site trust**, rules only.
3. **Chrome AI backup** for unplaced fields.

## 1. Household counts

In `shared/schema.cjs`, add:
- `householdAdults`, `householdChildren`, and `householdSeniors`: whole numbers 0–30 stored as strings, blank for unknown;
- `householdVeteran` and `householdDisability`: `''`, `'yes'`, or `'no'`, like the other yes/no fields.

The desktop profile form gets a "Household" group with these fields. No defaults and no inference: blank means unknown. Iowa's adapter doesn't use them.

## 2. General engine with per-site trust

**Site access.**
- `manifest.json` keeps its static Iowa host permission and content script, and adds `"optional_host_permissions": ["https://*/*"]`. `scripts/check.cjs` allows exactly that optional pattern and still requires the static content script to be Iowa-only.
- A toolbar or side-panel click on a non-Iowa `https` page sends `ui:enableSite`. The worker calls `chrome.permissions.request({ origins: [origin + '/*'] })` inside the user gesture. It then sends the native request `trustSite { url }`: the desktop dialog "Let SecondHand fill forms on pantry.example.org?" adds the origin to `trustedSites` in `settings.json`.
- Finally the worker registers the content scripts for that origin with `chrome.scripting.registerContentScripts`, persisted across restarts, and injects them into the current tab.
- `ui:disableSite` and the desktop settings list remove a site: the permission, the registration, and the desktop trust.

**Desktop gatekeeping.**
- `getFields` accepts a URL whose origin is Iowa's portal or is in `trustedSites`. Everything else is rejected.
- On a trusted non-Iowa origin, a request containing `ssn`, `birthDate`, `monthlyEarnedIncome`, or `monthlyOtherIncome` always shows a dialog naming the site and those fields, regardless of `autofillWithoutAsking`.
- `trustSite` requires an unlocked vault and a user dialog. It returns `{ trusted: true, origin }` and is validated like other bridge requests: `https` only, no credentials, no port.

**Recognition** (`extension/generic-adapter.js`, a new file, content-script world):
- `scanForm(doc)` finds visible, editable `input` / `select` / `textarea` controls and radio or checkbox groups. For each it builds a descriptor: label text (from `<label>`, `aria-label`, `aria-labelledby`, fieldset legend, or a nearby question heading), `name`, `id`, `autocomplete`, `type`, `placeholder`, and select or radio option texts. Passwords, `cc-*` autocomplete fields, files, hidden fields, CAPTCHAs, and already-filled controls are skipped.
- `matchRules(descriptor)` returns `{ key, confidence }` from an allowlisted vocabulary table covering:
  - `autocomplete` tokens (`given-name`, `family-name`, `street-address`, `address-line1`, `postal-code`, `tel`, `email`, `bday`);
  - normalized label phrases ("first name", "last name", "zip code", "how many people live in your household", "number of children", "seniors", "veteran", "monthly income", and so on);
  - name and id hints (`fname`, `lname`, `zip`, `hhsize`).

  An `autocomplete` token or exact phrase counts as confident. A partial word match is medium confidence and is not filled by rules.
- `fillFields(doc, bindings, values)` reuses the Iowa adapter's safety rules: rendered and visible only, never overwrite, native value setter plus input and change events, select matched by option text or value, radio or checkbox chosen by option text ("Yes"/"No", or numbers for counts). It returns `{ filled, skipped }`.
- Filled controls get an outline through an injected, namespaced style: green for rules, amber for AI guesses.

**Widget and worker.** On trusted non-Iowa sites the widget shows Autofill. `ui:autofill` there runs one fill:
- scan, match rules, request the matched keys through `getFields` (one request), fill;
- result `{ state: 'done', filled, guessed: [], needYou: [descriptor ids], message }`.

No autopilot and no navigation on general sites. "Need you" jumps focus to each unmatched required-looking field.

## 3. Chrome AI backup

- The widget (an extension page) checks `LanguageModel.availability()`. When the model is available, it sends one prompt listing only the unmatched fields' descriptors (label, type, options; never values) and the allowed profile keys, and asks for strict JSON `{ fieldId: key | null }`.
- Suggested keys are validated against the allowlist and the field type. Valid ones become "guessed" bindings, filled with the same `getFields` request, outlined amber, and listed in the widget's guessed list.
- When the model is unavailable, downloading, or returns invalid JSON, the widget shows "AI unavailable. Rule matches only." and those fields become "need you". It never blocks or retries in a loop.

## Testing

- **Schema and renderer:** household fields validate, save, and clear.
- **Generic adapter:** jsdom fixtures for a plain pantry intake form, a Google Forms-style form (`aria-labelledby`, div radios with `role=radio` are skipped unless they're native inputs), and a Jotform-style form. Rule matches and confidence; never overwriting; skipping passwords and card fields; select, radio, and count filling.
- **Worker:** `ui:enableSite` requests permission and trust, then registers scripts; untrusted origins never request values; sensitive-field requests are flagged.
- **Desktop:** `trustSite` dialog and persistence, `getFields` origin checks, and the sensitive-field dialog.
- **AI:** mapping parser and validation, with the model stubbed in tests only.
- **Manual:** a real public pantry or Google Form with the user.
