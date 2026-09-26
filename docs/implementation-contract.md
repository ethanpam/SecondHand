# Internal implementation contract

Runtime: Electron desktop, plain HTML/CSS/JavaScript renderer, Manifest V3 Chrome extension. No application backend or cloud AI. CommonJS desktop modules (`.cjs`); browser scripts are plain JS. Node test runner.

## Desktop renderer API

`window.secondHand` exposes async methods returning plain values or throwing sanitized errors:

- `status()` -> `{ exists, unlocked, recoveryKey, deviceReset, deviceResetSupported, extensionId, autofillWithoutAsking, bridgeRunning, platform, extensionSetup }`; setup contains `{ directory, extensionId, version, prepared }`, or `{ prepared: false, available: false }` if bundled assets are unavailable
- `createVault({ password, allowDeviceReset })` -> `{ status, recoveryKey, deviceResetFailed }`; the recovery key is returned once and never stored
- `unlock(password)` -> status
- `resetPassword({ recoveryKey, password } | { method: 'device', password })` -> status (unlocked with the new password)
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
- `setAutofillTrust(enabled: boolean)` -> status. Stores `autofillWithoutAsking` with `extensionId` in the non-sensitive `settings.json`, never in the vault. Requires an unlocked vault.
- `exportBackup()` / `importBackup()` -> `{ cancelled: boolean }` (native dialogs, encrypted vault bytes only; import only while locked)
- `onLocked(callback)` -> unsubscribe function

Profile is a flat object containing only optional string fields, allowlisted by `shared/schema.cjs`:

- Identity: firstName, middleName, lastName, suffix, maidenName, isApplicant, birthDate (YYYY-MM-DD), ssn.
- Contact: email, phone (reference only, not automatically assigned a type), homePhone, mobilePhone, bestContactTime (at most 30 characters).
- Home: hasHomeAddress, addressLine1, addressLine2, city, state, zip, county.
- Mailing: mailingSameAsHome, mailingAddressLine1, mailingAddressLine2, mailingCity, mailingState, mailingZip.
- Explicit requests: programSnap, programFip (FIP or RCA), programMedicaid, helpPayMedicalBills (the portal asks about the last three calendar months).
- Preparation notes: householdSize, monthlyEarnedIncome, monthlyOtherIncome, monthlyRent, monthlyUtilities.

`hasHomeAddress`, `mailingSameAsHome`, `isApplicant`, and the four request fields accept only `''`, `'yes'`, or `'no'`. An explicit `'no'` is a real answer and is released when approved; `''` is unknown and omitted from field responses. Programs are independent user choices, not eligibility determinations. `suffix` accepts blank, I through X, Jr., or Sr. All other values remain bounded strings. No field defaults, boolean coercion, inferred programs, copied mailing addresses, or inferred address answers are permitted. Old encrypted profiles normalize absent new keys to blank in memory; opening them does not rewrite the vault. Profile format and encryption envelope remain version 1.

Saved profile fields are broader than live autofill coverage. The adapter releases only verified fields present on the supported applicant page; date of birth, SSN, email, county, household and money notes are not mapped on that page. The schema-valid `tests/fixtures/applicant-profile.json` is entirely fictional and reserved for local tests, never live Iowa entry.

Applications: `{ id, program: 'Iowa SNAP', status, createdAt, updatedAt, confirmationNumber, notes, nextAction, dueDate }`. Allowed status: draft, in_progress, submitted, needs_action, approved, denied. Submitted requires confirmationNumber. Manual user records clearly labeled. No invented deadlines.

## Native bridge protocol (extension ↔ host)

Host name `org.secondhand.bridge`. Each request `{ id: string, type, ...payload }`. Response `{ id, ok: true, data }` or `{ id, ok: false, error: string }`.

- `status` -> `{ unlocked, applicationCount }` (no profile values)
- `showApp` -> `{ shown: true }`. Shows and focuses the desktop window so the user can unlock. Works while locked and returns no profile data.
- `getFields` `{ url, fields: string[] }` -> `{ values: { field: value } }`. Requires an unlocked vault, the exact Iowa HTTPS origin and path, and the approved extension ID. Fields are strictly allowlisted, and only requested nonblank values are returned.
  - When `autofillWithoutAsking` is on and the caller's extension ID matches the stored one, values are returned without a dialog.
  - Otherwise a desktop dialog names the fields, with the buttons **Cancel**, **Allow once**, and **Always allow on this computer**. "Always allow" turns the setting on and saves it.
  - The dialog rechecks the unlocked vault, the lock generation, and the extension ID before releasing values, so a lock and re-unlock while it is open invalidates the answer.
  - Registering a different extension ID turns the setting off.
- `recordProgress` `{ url, filledCount: integer }` -> `{ recorded: true }`. Updates a draft/in_progress Iowa application, no page HTML, no profile values, no inferred submitted/approved status. Requires unlocked vault.

Iowa portal URL: `https://hhsservices.iowa.gov/apspssp/ssp.portal`. Exact origin `https://hhsservices.iowa.gov`; path must be `/apspssp/ssp.portal` or descendants, no username/password/other ports.

The bridge supplies the desktop handler with `{ extensionId }` from the authenticated native envelope; request payloads cannot override this context. The desktop cannot attest Chrome tab IDs, so the extension binds every autofill to the tab that asked for it and re-checks that tab's URL before each fill pass.

Native host relays to running desktop over authenticated local IPC, not HTTP. Desktop is sole vault owner. The extension fills approved mapped fields only; it never clicks Next, Save and Continue, or submit. Unknown sections, unanswered questions, signatures, consent, review, passwords, CAPTCHA, MFA, and file inputs stay manual. Never auto-submit an application or guess information. Explicitly document verified mapping coverage versus pending live validation.

## Browser sidebar and conditional fields

Chrome 116+ uses its native `sidePanel` surface for the checklist. Two extension surfaces may send UI messages to the worker:
- **Side panel:** the exact `panel.html` URL with no tab sender. It passes an explicit `tabId`.
- **On-page widget:** the `panel.html?surface=launcher` iframe inside an Iowa tab. The worker always uses the iframe's own `sender.tab.id` and ignores any `tabId` in the message.

Both may send `ui:pageState`, `ui:autofill` and `ui:stop` (each with `confirmed: true`, from a trusted click), `ui:focusField`, and `ui:showApp`. Only the side panel may send `ui:desktopStatus`, and only the widget may send `ui:openPanel`. Content scripts and page `postMessage` calls have no path to the vault. Neither surface ever receives profile values: they get field keys, fixed labels, completion/missing/manual status, counts, and fixed messages.

`ui:autofill` turns **autopilot** on for that tab and runs a step; `ui:stop` turns it off. Autopilot state lives only in worker memory, and a page can never turn it on. Each step reads the page, skips a `url|pageKey` it has already handled in this run, and acts on the adapter's classification:
- `info`: the content script runs `continuePage`, which clicks the page's recorded Continue once.
- `fillable`: the worker checks `status`, sends one `getFields` for `profileRequest(pageKey)`, turns those values into page answers with `pageValues`, and fills them in up to four fresh-preview passes. Each key is attempted at most once, and saved answers that are blank are reported as "need you" keys rather than retried.
- A page with a `todo`: autopilot waits with that instruction.
- Anything else: autopilot turns off with "SecondHand doesn't know this page yet."

A step runs when the tab finishes loading and on widget polls. Autopilot turns off after 15 steps, on a locked or unreachable desktop, on a cancelled or failed fill, when the tab closes, or when a page load leaves Iowa's portal. The worker re-reads the tab on every load, because Chrome hides other sites' URLs without the `tabs` permission. Values are released when each fill finishes.

The result is `{ state: 'done' | 'waiting' | 'continuing' | 'stopped' | 'locked' | 'offline' | 'error', filled, needYou, message, todo?, pageKey }`. It is kept per tab until that tab navigates. `ui:pageState` returns `{ page, scan, result, autopilot }`.
