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
- `startAssistedSession` `{ url, fields: string[] }` -> `{ assistanceToken, expiresAt, fields }`. Requires an unlocked vault and a native desktop confirmation naming the approved field scope. The dialog describes guided filling and ordinary Next / Save and Continue actions on supported Iowa SNAP pages, which may save answers to Iowa; it excludes consent, signatures, review, and final submission. `assistanceToken` is 32 random bytes encoded as 64 lowercase hex characters. `expiresAt` is an ISO timestamp exactly 15 minutes after approval. One session can be active, bound to the authenticated extension ID; starting another replaces the previous one. The lifetime is absolute and does not refresh with activity.
- `getFields` `{ url, fields: string[], assistanceToken?: string }` -> `{ values: { field: value } }`. Requires unlocked vault, exact Iowa HTTPS origin/path, and approved extension ID. Without a token, a desktop confirmation dialog names fields before each release. With a token, it must match the active unexpired session and every requested field must be in its approved scope; an invalid token fails rather than falling back to another dialog. Fields are strictly allowlisted and only requested nonblank values are returned.
- `endAssistedSession` `{ url, assistanceToken }` -> `{ ended: true }`. Revokes the matching session. Idempotent for stale tokens, including after the vault locks; a stale stop does not revoke a newer session.
- `checkAssistedSession` `{ url, assistanceToken }` -> `{ active: true }`. Requires an unlocked vault and a valid matching unexpired session; returns no profile data and does not extend session expiry. The worker must check this immediately before every automatic Next action, including pages with no empty mapped fields, then recheck cancellation/tab/expiry before sending the navigation request.
- `recordProgress` `{ url, filledCount: integer }` -> `{ recorded: true }`. Updates a draft/in_progress Iowa application, no page HTML, no profile values, no inferred submitted/approved status. Requires unlocked vault.

Iowa portal URL: `https://hhsservices.iowa.gov/apspssp/ssp.portal`. Exact origin `https://hhsservices.iowa.gov`; path must be `/apspssp/ssp.portal` or descendants, no username/password/other ports.

The bridge supplies the desktop handler with `{ extensionId }` from the authenticated native envelope; request payloads cannot override this context. Assisted tokens are held only in desktop and extension memory and never written to the vault or extension storage. Lock, suspend, screen lock, exit, extension registration changes, and profile saves revoke them. The desktop cannot attest Chrome tab IDs: the extension must bind its token to the initiating tab, stop when it leaves the supported Iowa portal, and never expose the token to the page. If Stop is clicked while initial consent is pending, the worker must end any late grant immediately and perform no fill/navigation.

Native host relays to running desktop over authenticated local IPC, not HTTP. Desktop is sole vault owner. Guided mode may fill approved mapped fields and use specifically supported ordinary Next / Save and Continue controls. Unknown sections, unanswered questions, signatures, consent, review, passwords, CAPTCHA, MFA, and file inputs require a pause/manual action. Never auto-submit an application or guess information. Explicitly document verified mapping coverage versus pending live validation.

## Browser sidebar and conditional fields

Chrome 116+ uses its native `sidePanel` surface for the applicant checklist and controls. The exact extension `panel.html` URL without a tab sender may request approved operations. The page-hosted `panel.html?surface=launcher` iframe may only open the sidebar after a trusted user click; it cannot request profile fields or start assistance. The page and sidebar never receive an assistance token. The sidebar receives field keys, fixed labels, completion/missing/manual status, counts, and workflow messages, not saved or portal-entered values.

Guided filling makes at most four fresh-preview passes per run to handle conditional fields revealed by explicit saved choices. A field key is attempted at most once per page until an explicit resume; unknown saved answers are recorded as missing keys without retry loops. On the recognized applicant page, missing required answers pause navigation. Under the same unexpired session, polling may continue after the user supplies the missing answers directly in Iowa or reveals another unattempted approved field. This never starts a new desktop grant. Stop, lock/revocation, expiry, changed tabs, unsupported steps, consent, and final submission retain their existing boundaries. Every automatic navigation still requires the desktop session check.

## Address confirmation under development

`extension/address-policy.js` provides a pure comparison decision for structured submitted addresses and suggestions. It has no live DOM integration and is not loaded into the released workflow. The current Select Address pause remains in force until actual controls are verified. See [the address confirmation contract](address-automation.md) for its strict matching rules, value-free results, source-of-truth requirements, and activation conditions.
