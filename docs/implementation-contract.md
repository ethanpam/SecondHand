# Internal implementation contract

Runtime: Electron desktop, plain HTML/CSS/JavaScript renderer, Manifest V3 Chrome extension. No application backend or cloud AI. CommonJS desktop modules (`.cjs`); browser scripts are plain JS. Node test runner.

## Desktop renderer API

`window.secondHand` exposes async methods returning plain values or throwing sanitized errors:

- `status()` -> `{ exists, unlocked, lockRevision, recoveryKey, deviceReset, deviceResetSupported, extensionId, autofillWithoutAsking, trustedSites, bridgeRunning, platform, extensionSetup }`; setup contains `{ directory, extensionId, version, prepared }`, or `{ prepared: false, available: false }` if bundled assets are unavailable

- `createVault({ password, allowDeviceReset })` -> `{ status, recoveryKey, deviceResetFailed }`; the recovery key is returned once and never stored
- `unlock(password)` -> status
- `resetPassword({ recoveryKey, password } | { method: 'device', password })` -> status (unlocked with the new password)
- `startOver({ confirmation })` -> status (locked only; `confirmation` must be the typed phrase `start over`). Erases the encrypted file, copies kept by earlier restores, and the reset secret for this computer; Chrome extension settings stay. `status.exists` is then false, so a new password can be created
- `replaceRecoveryKey()` -> `{ recoveryKey }` (unlocked only; retires the previous key)
- `setDeviceReset(enabled)` -> status (unlocked only)
- `saveRecoveryKey(recoveryKey)` -> `{ cancelled }` / `copyRecoveryKey(recoveryKey)` -> true
- `lock()` -> status
- `getData()` -> `{ profile, applications }`
- `saveProfile(profile)` -> saved profile
- `saveApplication(application)` -> saved application (empty/missing id creates UUID)
- `deleteApplication(id)` -> true
- `openPortal()` -> true (fixed Iowa URL only)
- `prepareExtension()` -> `{ directory, extensionId, version, prepared, manifestPath, folderOpened }`; copies bundled assets into the fixed local extension folder and registers its stable ID; never installs into Chrome
- `openExtensionFolder()` / `copyExtensionFolderPath()` -> true (fixed prepared folder only)
- `copyChromeExtensionsUrl()` -> true (copies the fixed `chrome://extensions` address)
- `connectExtension(extensionId)` -> `{ extensionId, manifestPath }` (register native host for current OS)
- `removeTrustedSite(origin)` -> status (unlocked only; removes an exact previously approved origin).
- `setAutofillTrust(enabled: boolean)` -> status. Stores `autofillWithoutAsking` with `extensionId` and separately approved `trustedSites` in the non-sensitive `settings.json`, never in the vault. Requires an unlocked vault.
- `exportBackup()` / `importBackup()` -> `{ cancelled: boolean }` (native dialogs, encrypted vault bytes only; import only while locked)
- `onLocked(callback)` -> unsubscribe function; the callback receives `{ lockRevision }` (invalid or legacy notifications provide no revision and still clear sensitive UI)

`lockRevision` is a monotonic, process-local counter used to correlate a lock response with its notification. The renderer applies a transition once, regardless of their delivery order, so a delayed duplicate notification cannot erase a newly typed passphrase or authentication error. A newer lock transition must still clear sensitive UI and invalidate pending data loads. The counter is not an applicant field or persisted vault data.

Profile is a flat object containing only optional string fields, allowlisted by `shared/schema.cjs`:

- Identity: firstName, middleName, lastName, suffix, maidenName, isApplicant, birthDate (YYYY-MM-DD), ssn.
- Contact: email, phone (reference only, not automatically assigned a type), homePhone, mobilePhone, bestContactTime (at most 30 characters).
- Home: hasHomeAddress, addressLine1, addressLine2, city, state, zip, county.
- Mailing: mailingSameAsHome, mailingAddressLine1, mailingAddressLine2, mailingCity, mailingState, mailingZip.
- Explicit requests: programSnap, programFip (FIP or RCA), programMedicaid, helpPayMedicalBills (the portal asks about the last three calendar months).
- Household and preparation notes: householdSize, monthlyEarnedIncome, monthlyOtherIncome, monthlyRent, monthlyUtilities, householdAdults, householdChildren, householdSeniors, householdVeteran, householdDisability, assetsOnHand, monthlyMedicalExpenses, householdAllCitizens, householdLegalStatus, householdPregnant, householdMedicare.

`hasHomeAddress`, `mailingSameAsHome`, `isApplicant`, the four request fields, and the household Yes/No fields listed in `YES_NO_FIELDS` accept only `''`, `'yes'`, or `'no'`. An explicit `'no'` is a real answer and is released when approved; `''` is unknown and omitted from field responses. Programs are independent user choices, not eligibility determinations. `suffix` accepts blank, I through X, Jr., or Sr. All other values remain bounded strings. No field defaults, boolean coercion, inferred programs, copied mailing addresses, or inferred address answers are permitted. Old encrypted profiles normalize absent new keys to blank in memory; opening them does not rewrite the vault. The profile payload remains version 1. New encrypted vaults use the version 2 envelope with password/recovery key slots; legacy version 1 envelopes remain readable.

Saved profile fields are broader than live autofill coverage. The Iowa adapter requests only its verified page-scoped keys: 25 initial applicant keys plus birthDate on the separately scoped primary-applicant Tell Us More page. SSN, email, county, household and money notes are not mapped by that verified Iowa adapter. The generic engine may map some of them on other pages, subject to its own rules and native approval; this does not establish Iowa-specific coverage. Tell Us More never auto-advances. The schema-valid `tests/fixtures/applicant-profile.json` is entirely fictional; automated tests keep it isolated. A separately authorized manual live inspection is recorded in `docs/iowa-live-journey.md` and stopped before signing or submitting.

Applications: `{ id, program: 'Iowa SNAP', status, createdAt, updatedAt, confirmationNumber, notes, nextAction, dueDate }`. Allowed status: draft, in_progress, submitted, needs_action, approved, denied. Submitted requires confirmationNumber. Manual user records clearly labeled. No invented deadlines.

## Native bridge protocol (extension ↔ host)

Host name `org.secondhand.bridge`. Each request `{ id: string, type, ...payload }`. Response `{ id, ok: true, data }` or `{ id, ok: false, error: string }`.

- `status` -> `{ unlocked, applicationCount, accessRevision }` (no profile values)
- `showApp` -> `{ shown: true }`. Shows and focuses the desktop window so the user can unlock. Works while locked and returns no profile data.
- `getFields` `{ url, fields: string[] }` -> `{ values: { field: value }, accessRevision }`. Requires an unlocked vault and the approved extension ID. Iowa requests use the exact HTTPS origin and portal path. Other HTTPS sites additionally require an explicitly trusted origin. Fields are strictly allowlisted, and only requested nonblank values are returned.
  - When `autofillWithoutAsking` is on and the caller's extension ID matches the stored one, nonsensitive eligible requests return without a dialog; the other-site sensitive-field exception below still applies.
  - Otherwise a desktop dialog names the fields, with the buttons **Cancel**, **Allow once**, and **Always allow on this computer**. "Always allow" turns the setting on and saves it.
  - The dialog rechecks the unlocked vault, the access revision, and the extension ID before releasing values, so a lock and re-unlock while it is open invalidates the answer.
  - Registering a different extension ID turns the setting off.
  - Other sites require desktop `trustSite` approval and Chrome’s optional origin permission. Sensitive fields on those sites require an every-time confirmation, even with persistent autofill trust.
  - An empty `fields: []` is accepted only for the exact observed Iowa `enterPersonalInfo` or `addressValidation` URL, with no query, fragment, or trailing slash. It authorizes the disclosed verified applicant continuation or first-home-suggestion action under the same unlocked/trust checks and returns `{ values: {}, accessRevision }` without reading the saved profile.
- `trustSite` `{ url }` -> `{ trusted: true, origin }`; a native desktop prompt approves a non-Iowa HTTPS origin before adding it to the local trusted-site list.
- `recordProgress` `{ url, filledCount: integer }` -> `{ recorded: true }`. Updates a draft/in_progress Iowa application, no page HTML, no profile values, no inferred submitted/approved status. Requires unlocked vault.

Iowa portal URL: `https://hhsservices.iowa.gov/apspssp/ssp.portal`. Exact origin `https://hhsservices.iowa.gov`; path must be `/apspssp/ssp.portal` or descendants, no username/password/other ports.

`accessRevision` is a randomly seeded, process-local safe-integer disclosure revision, separate from the renderer’s `lockRevision`. A fill/Next rechecks that the desktop is unlocked and the revision still matches its field authorization before acting. Lock, profile changes, or connection/trust changes invalidate prior authorization.

The bridge supplies the desktop handler with `{ extensionId }` from the authenticated native envelope; request payloads cannot override this context. The desktop cannot attest Chrome tab IDs, so the extension binds every autofill to the tab that asked for it and re-checks that tab's URL before each fill pass.

Native host relays to running desktop over authenticated local IPC, not HTTP. Desktop is sole vault owner. The extension fills approved mapped fields. Iowa autopilot can continue verified information screens, the complete initial applicant page, and the verified first-home-address confirmation; other navigation stays manual. It never signs or submits an application. Unknown sections, unanswered questions, signatures, consent, review, passwords, CAPTCHA, MFA, and file inputs stay manual. Never auto-submit an application or guess information. Explicitly document verified mapping coverage versus pending live validation.

## Browser sidebar and conditional fields

Chrome 116+ uses its native `sidePanel` surface for the checklist. Two extension surfaces may send UI messages to the worker:
- **Side panel:** the exact `panel.html` URL with no tab sender. It passes an explicit `tabId`.
- **On-page widget:** the `panel.html?surface=launcher` iframe inside an Iowa tab. The worker always uses the iframe's own `sender.tab.id` and ignores any `tabId` in the message.

Both may poll `ui:pageState`, send `ui:focusField` from a trusted click, and send `ui:autofill`, `ui:stop`, or `ui:showApp` with `confirmed: true` from a trusted click. Only the side panel may send `ui:desktopStatus`, and only the widget may send `ui:openPanel`. Content scripts and page `postMessage` calls have no path to the vault. Neither surface ever receives profile values: they get field keys, fixed labels, completion/missing/manual status, counts, and fixed messages.

`ui:autofill` turns **autopilot** on for that tab and runs a step; `ui:stop` turns it off. Autopilot state lives only in worker memory, and a page can never turn it on. Each step reads the page, skips a `url|pageKey` it has already handled in this run, and acts on the adapter's classification:
- `info`: the content script runs `continuePage`, which clicks the page's recorded Continue once.
- Verified home-address confirmation: a no-data desktop authorization and fresh, single-use content snapshot allow the first suggested home address to be selected, then ordinary Save and Continue. No profile values are requested.
- Other `fillable` pages: the worker checks `status`, sends one `getFields` for `profileRequest(pageKey)`, turns those values into page answers with `pageValues`, and fills them in up to four fresh-preview passes. Each key is attempted at most once, and saved answers that are blank are reported as "need you" keys rather than retried. The verified applicant page may continue only after required-answer, unchanged-document, visibility, and fresh desktop-unlocked checks. The DOB-only Tell Us More page always remains manual after filling.
- A page with a `todo`: autopilot waits with that instruction.
- Otherwise unverified manual pages may use generic rule matching while Autofill is on; any filled values still require the native checks, and Next stays manual. Recognized manual/protected Iowa contexts carry instructions that prevent generic fallback.
- When neither verified behavior, a manual instruction, nor generic matches apply, autopilot turns off with "SecondHand doesn't know this page yet."

A step runs when the tab finishes loading and on widget polls. Autopilot turns off after 15 steps, on a locked or unreachable desktop, on a cancelled or failed fill, when the tab closes, or when a page load leaves Iowa's portal. The worker re-reads the tab on every load, because Chrome hides other sites' URLs without the `tabs` permission. Values are released when each fill finishes.

The result is `{ state: 'done' | 'waiting' | 'continuing' | 'stopped' | 'locked' | 'offline' | 'error', filled, needYou, message, todo?, pageKey }`. It is kept per tab until that tab navigates. `ui:pageState` returns `{ page, scan, result, autopilot }`.


## Home-address confirmation and generic sites

`extension/address-policy.js` loads before the Iowa adapter in content scripts and the worker and is included in prepared extension assets. The observed home-only `addressValidation` page can select the first structurally verified suggestion, then continue. Widget/sidebar and desktop trust copy disclose the preference. This is selection from Iowa’s candidates, not an address-correctness determination or a new profile default. Private single-use snapshots bind the document, URL, control identities, address text, selection, and form state without exposing values to the sidebar. Mailing confirmation, visible county questions, unknown controls, errors, and rendered dialogs pause. See [the address contract](address-automation.md). Public 0.4 downloads predate this integration.

For otherwise unverified Iowa pages, generic rule matching can fill recognized fields but never enables automatic navigation. For other HTTPS sites, optional origin permission and local desktop trust are separate approvals. The generic adapter fills once per explicit click and never navigates or submits. Optional Chrome on-device AI sees unmatched field labels/options and allowed profile-key names, never saved profile values; no cloud AI fallback exists. Embedded forms require their own origin approval. Iowa’s recognized manual or protected steps must not fall through to generic mapping.
