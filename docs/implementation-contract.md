# Internal implementation contract

Runtime: Electron desktop, plain HTML/CSS/JavaScript renderer, Manifest V3 Chrome extension. No application backend or cloud AI. CommonJS desktop modules (`.cjs`); browser scripts are plain JS. Node test runner.

## Desktop renderer API

`window.secondHand` exposes async methods returning plain values or throwing sanitized errors:

- `status()` -> `{ exists, unlocked, extensionId, bridgeRunning, platform, extensionSetup }`; setup contains `{ directory, extensionId, version, prepared }`, or `{ prepared: false, available: false }` if bundled assets are unavailable
- `createVault(passphrase)` / `unlock(passphrase)` -> status
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
- `exportBackup()` / `importBackup()` -> `{ cancelled: boolean }` (native dialogs, encrypted vault bytes only; import only while locked)
- `onLocked(callback)` -> unsubscribe function

Profile is a flat object containing only optional string fields: firstName, middleName, lastName, birthDate (YYYY-MM-DD), ssn, email, phone (reference only, not automatically assigned a type), homePhone, mobilePhone, addressLine1, addressLine2, city, state, zip, county, householdSize, monthlyEarnedIncome, monthlyOtherIncome, monthlyRent, monthlyUtilities. Blank means unknown, never zero or false. No defaults for user facts.

Applications: `{ id, program: 'Iowa SNAP', status, createdAt, updatedAt, confirmationNumber, notes, nextAction, dueDate }`. Allowed status: draft, in_progress, submitted, needs_action, approved, denied. Submitted requires confirmationNumber. Manual user records clearly labeled. No invented deadlines.

## Native bridge protocol (extension ↔ host)

Host name `org.secondhand.bridge`. Each request `{ id: string, type, ...payload }`. Response `{ id, ok: true, data }` or `{ id, ok: false, error: string }`.

- `status` -> `{ unlocked, applicationCount }` (no profile values)
- `startAssistedSession` `{ url, fields: string[] }` -> `{ assistanceToken, expiresAt, fields }`. Requires an unlocked vault and a native desktop confirmation naming the approved field scope. The dialog describes guided filling and ordinary Next / Save and Continue actions on supported Iowa SNAP pages, which may save answers to Iowa; it excludes consent, signatures, review, and final submission. `assistanceToken` is 32 random bytes encoded as 64 lowercase hex characters. `expiresAt` is an ISO timestamp exactly 15 minutes after approval. One session can be active, bound to the authenticated extension ID; starting another replaces the previous one. The lifetime is absolute and does not refresh with activity.
- `getFields` `{ url, fields: string[], assistanceToken?: string }` -> `{ values: { field: value } }`. Requires unlocked vault, exact Iowa HTTPS origin/path, and approved extension ID. Without a token, a desktop confirmation dialog names fields before each release. With a token, it must match the active unexpired session and every requested field must be in its approved scope; an invalid token fails rather than falling back to another dialog. Fields are strictly allowlisted and only requested nonblank values are returned.
- `endAssistedSession` `{ url, assistanceToken }` -> `{ ended: true }`. Revokes the matching session. Idempotent for stale tokens, including after the vault locks; a stale stop does not revoke a newer session.
- `checkAssistedSession` `{ url, assistanceToken }` -> `{ active: true }`. Requires an unlocked vault and a valid matching unexpired session; returns no profile data and does not extend session expiry. The worker must check this immediately before every automatic Next action, including pages with no empty mapped fields, then recheck cancellation/tab/expiry before sending the navigation request.
- `recordProgress` `{ url, filledCount: integer }` -> `{ recorded: true }`. Updates a draft/in_progress Iowa application, no page HTML, no profile values, no inferred submitted/approved status. Requires unlocked vault.

Iowa portal URL: `https://hhsservices.iowa.gov/apspssp/ssp.portal`. Exact origin `https://hhsservices.iowa.gov`; path must be `/apspssp/ssp.portal` or descendants, no username/password/other ports.

The bridge supplies the desktop handler with `{ extensionId }` from the authenticated native envelope; request payloads cannot override this context. Assisted tokens are held only in desktop and extension memory and never written to the vault or extension storage. Lock, suspend, screen lock, exit, extension registration changes, and profile saves revoke them. The desktop cannot attest Chrome tab IDs: the extension must bind its token to the initiating tab, stop when it leaves the supported Iowa portal, and never expose the token to the page. If Stop is clicked while initial consent is pending, the worker must end any late grant immediately and perform no fill/navigation.

Native host relays to running desktop over authenticated local IPC, not HTTP. Desktop is sole vault owner. Guided mode may fill approved mapped fields and use specifically supported ordinary Next / Save and Continue controls. Unknown sections, unanswered questions, signatures, consent, review, passwords, CAPTCHA, MFA, and file inputs require a pause/manual action. Never auto-submit an application or guess information. Explicitly document verified mapping coverage versus pending live validation.
