# Internal implementation contract

Runtime: Electron desktop, plain HTML/CSS/JavaScript renderer, Manifest V3 Chrome extension. No application backend or cloud AI. CommonJS desktop modules (`.cjs`); browser scripts are plain JS. Node test runner.

## Desktop renderer API

`window.secondHand` exposes async methods returning plain values or throwing sanitized errors:

- `status()` -> `{ exists, unlocked, extensionId, bridgeRunning, platform }`
- `createVault(passphrase)` / `unlock(passphrase)` -> status
- `lock()` -> status
- `getData()` -> `{ profile, applications }`
- `saveProfile(profile)` -> saved profile
- `saveApplication(application)` -> saved application (empty/missing id creates UUID)
- `deleteApplication(id)` -> true
- `openPortal()` -> true (fixed Iowa URL only)
- `connectExtension(extensionId)` -> `{ extensionId, manifestPath }` (register native host for current OS)
- `exportBackup()` / `importBackup()` -> `{ cancelled: boolean }` (native dialogs, encrypted vault bytes only; import only while locked)
- `onLocked(callback)` -> unsubscribe function

Profile is a flat object containing only optional string fields: firstName, middleName, lastName, birthDate (YYYY-MM-DD), ssn, email, phone, addressLine1, addressLine2, city, state, zip, county, householdSize, monthlyEarnedIncome, monthlyOtherIncome, monthlyRent, monthlyUtilities. Blank means unknown, never zero or false. No defaults for user facts.

Applications: `{ id, program: 'Iowa SNAP', status, createdAt, updatedAt, confirmationNumber, notes, nextAction, dueDate }`. Allowed status: draft, in_progress, submitted, needs_action, approved, denied. Submitted requires confirmationNumber. Manual user records clearly labeled. No invented deadlines.

## Native bridge protocol (extension ↔ host)

Host name `org.secondhand.bridge`. Each request `{ id: string, type, ...payload }`. Response `{ id, ok: true, data }` or `{ id, ok: false, error: string }`.

- `status` -> `{ unlocked, applicationCount }` (no profile values)
- `getFields` `{ url, fields: string[] }` -> `{ values: { field: value } }`. Requires unlocked vault, exact Iowa HTTPS origin/path, approved extension ID, and desktop confirmation dialog naming fields before releasing them. Fields strictly allowlisted. Only requested nonblank values returned.
- `recordProgress` `{ url, filledCount: integer }` -> `{ recorded: true }`. Updates a draft/in_progress Iowa application, no page HTML, no profile values, no inferred submitted/approved status. Requires unlocked vault.

Iowa portal URL: `https://hhsservices.iowa.gov/apspssp/ssp.portal`. Exact origin `https://hhsservices.iowa.gov`; path must be `/apspssp/ssp.portal` or descendants, no username/password/other ports.

Native host relays to running desktop over authenticated local IPC, not HTTP. Desktop is sole vault owner. No secrets persisted by extension. Per-page user-triggered fill only; unknown sections, signatures, passwords, CAPTCHA, MFA, file inputs remain manual. Never auto-submit or guess information. Explicitly document verified mapping coverage versus pending live validation.
