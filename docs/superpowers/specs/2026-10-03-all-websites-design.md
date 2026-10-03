# SecondHand on all websites

## Goal
SecondHand works on any food-assistance form, not only on Iowa's portal and on sites turned on one at a time. One switch turns it on for every https site. Filling still happens only after the applicant clicks Autofill. The per-site rules for sensitive details stay as they are.

## Today
A site other than Iowa's portal needs three things before SecondHand can fill it:
1. Chrome's optional host permission for that origin (`https://<host>/*`). The side panel asks for it inside the user's click.
2. The desktop app's approval. The `trustSite` native request shows a dialog and adds the origin to `trustedSites` in `settings.json`.
3. A registered content script for that origin: `siteScript(origin)` in `extension/background.js`. An embedded form needs its own frame approval (`enableFrames`).

The side panel shows `panel.openIowa` ("Open Iowa's SNAP application in this tab… click the SecondHand toolbar icon") on any tab whose URL the extension can't read. Without `tabs` or host access, that's every non-Iowa tab until the toolbar icon grants `activeTab`.

## Design

### Turning it on
- The side panel shows a **Use SecondHand on all websites** button whenever all-websites is off. That includes tabs whose URL it can't read, where it currently shows `panel.openIowa`. The Iowa hint stays as the second line.
- **The click:**
  1. The click calls `chrome.permissions.request({ origins: ['https://*/*'] })` before anything else is awaited, because Chrome only prompts inside the click. `https://*/*` is already in `optional_host_permissions`, so the manifest doesn't change.
  2. The worker then asks the desktop app with a new native request, `trustAllSites`. The app shows one dialog: "Let SecondHand fill forms on any website?". Its detail text says the same things as `trustSite`'s: nothing is filled without a click, Next/Submit are never clicked, and sensitive details still need approval on each site. On approval it saves `allSites: true` in `settings.json`.
  3. If the user declines either step, the Chrome permission is removed again and nothing stays half on. This is the existing `enableSite` pattern.
- **The registration:** one content script, `site-all`.
  - `matches: ['https://*/*']`, `excludeMatches` Iowa's portal patterns (Iowa keeps its own scripts), `allFrames: true`, `runAt: 'document_idle'` and `persistAcrossSessions: true`.
  - Same files as `SITE_FILES`.
  - The open page gets the scripts at once with `executeScript`, as `enableSite` does.

### Where the card appears
- With all-websites on, `generic-content.js` runs on every https page but shows the card only when the page has a form SecondHand can help with. That means at least one field the generic adapter matches to a saved answer, or at least one question Laya could take, using the same eligibility as `layaQuestions`.
- It stays hidden on pages whose only inputs are search boxes, login (password) forms, verification codes or other fields the adapter never fills.
- It re-checks when the page's forms change, as the adapter already does for late-loading forms, so a form that appears later shows the card.
- Embedded forms in iframes are covered by `allFrames`, so no per-frame approval is needed while all-websites is on.

### The desktop app
- **Site checks:** where it checks `trustedSites.includes(origin)` (`layaRequest`, `getFields`), an https origin is also allowed when `allSites` is true. Iowa's rules don't change.
- **Sensitive fields** (`SENSITIVE_FIELDS`) still go through the named confirmation on every site other than Iowa's, as today. "Always allow on this computer" keeps its current meaning.
- **Its Chrome extension page:**
  - shows **All websites: on** with **Turn off**;
  - when off, says to turn it on from the side panel, because Chrome's prompt can only come from the extension.
- **Turning off from the app:**
  1. The app clears `allSites` and saves.
  2. The extension notices on its next request: the app reports `allSites: false` in `status`.
  3. It then unregisters `site-all` and removes the `https://*/*` permission.
  Until that happens, the app refuses requests from origins that aren't in `trustedSites`.

### Turning it off from the side panel
- When all-websites is on, the side panel shows **Turn off on all websites**.
- It unregisters `site-all`, removes the `https://*/*` permission, and asks the app to clear `allSites` with a new native request, `untrustAllSites`.
- **Per-site sites the user turned on before are kept.** If removing `https://*/*` also removed Chrome's access for those origins, they show as off and can be turned on again; the worker checks this and reports it plainly.

### Existing installs
- Per-site registrations keep working, whether all-websites is on or off.
- **The content scripts must load only once per page:** when both a per-site script and `site-all` match a page, `generic-content.js` and the adapter must not run twice. Guard with a per-frame flag and test it.

## Unchanged rules
- Nothing is filled until the applicant clicks Autofill.
- The extension never clicks Next or Submit on a non-Iowa site.
- It never fills passwords, verification codes or signatures, and never touches unknown household members.
- Locking the app, by hand or after 10 idle minutes, stops autofill.
- Laya's sensitive-facts prompt on non-Iowa sites stays.
- No form text or saved answers leave the computer.

## Strings
New side panel, widget and worker strings are added to every catalog in `extension/strings.js`: en, es, vi, zh, fr, ar (Arabic is right-to-left). They're written in each language's natural wording, following the existing catalogs.

## Docs
- **`README.md`:** the "The extension stays in its lane" privacy bullet, "What it does", and "Get started" if the steps change.
- **`docs/security.md`:** the broader access, what it does and doesn't allow, and how to turn it off.
- **`docs/setup.md`**, if it describes turning sites on.
- **`BUILD`:** bump the marker in `extension/background.js` and `extension/panel.js`.

## Tests (written first)
- **Worker:**
  - turning on registers `site-all` only after both Chrome and the app approve;
  - declining either leaves no permission and no script;
  - turning off removes both, keeps per-site registrations, and reports per-site origins that lost Chrome access;
  - `siteEnabled` is true for any https origin while all-websites is on.
- **Desktop:**
  - `trustAllSites` and `untrustAllSites` dialogs and their settings persistence;
  - `getFields`, `suggestFields` and `answerFields` accept an untrusted https origin only while `allSites` is on;
  - sensitive fields still need confirmation;
  - `status` reports `allSites`.
- **Content:** the card stays hidden on a search-only page, a login page and a page without inputs, and shows on a form page, including one whose form appears after load. The scripts run once when both registrations match.
- **Panel:** the button shows on unreadable tabs and when all-websites is off; the off button shows when it's on; Chrome's request happens inside the click.
- **Smoke** (`npm run test:extension`): in the isolated Chromium, turn on all-websites, open a synthetic form on an origin that was never turned on, and click Autofill. It fills from the fictional profile and submits nothing. Then turn it off, and the card is gone.
- `npm test`, `npm run check`, `npm run test:laya`, `npm run test:translation` and `npm run test:ui` all pass.
