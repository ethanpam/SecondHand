# Security and privacy design

secondHand has no application backend. The desktop process is the sole owner of saved applicant information. It serves no HTTP endpoint. The shipped UI and extension contain no analytics, cloud AI, remote fonts, or automatic updater. Dependencies and build artifacts are downloaded during development/build; this is separate from applicant data processing.

## Vault

`vault.secondhand` contains AES-256-GCM ciphertext with a random 96-bit nonce for every write, a 128-bit authentication tag, and version-bound authenticated additional data. Version 2 files encrypt contents with a random 256-bit data key. That key is stored only in wrapped form, in separate AES-256-GCM key slots:

- **password**: wrapped by a key derived from the user's password with a random 256-bit salt and scrypt (`N=32768`, `r=8`, `p=1`). The password must be at least 12 characters.
- **recovery**: wrapped by the same scrypt derivation of a one-time recovery key (160 random bits shown as 32 Crockford base32 characters). It is displayed once, never stored by secondHand, and replacing it removes the old slot.
- **device** (optional): wrapped by an HKDF-SHA256 key from a random 256-bit secret. The secret is sealed with Electron `safeStorage` (macOS Keychain or Windows DPAPI) in `device-reset.bin` beside the vault, so it only works for the same operating-system account. Anyone who can use that signed-in account can therefore reset the password; users who share an account should turn it off in Privacy & backups.

Resetting a password unwraps the data key through the recovery or device slot, authenticates and validates the contents, and writes a new password slot; the encrypted contents are unchanged. Version 1 files (contents keyed directly from the password) still open. Adding a recovery key or device reset upgrades them to version 2 and reuses the existing password-derived key as the password slot, so the password does not change. KDF parameters are fixed and validated when reading a backup, preventing a file from requesting arbitrary computation.

The password, recovery key, and keys are never written to settings. A copied recovery key is cleared from the clipboard after one minute if it is still there. The unlocked key is held in the desktop process and its buffer is cleared on lock. JavaScript strings and copies cannot be reliably zeroed; an unlocked machine and its memory are outside the confidentiality guarantee. The UI clears profile/application state when notified of a lock. The app locks after ten minutes without relevant activity, on system suspend, on supported OS lock-screen events, and on exit.

Writes serialize through a queue, use a private temporary file, sync that file, and atomically rename it. Unix data files are mode `0600`; Windows uses the current user's application-data directory and inherited access controls. Whole-vault size and field lengths are bounded. There is no unencrypted SQLite sidecar, journal, or document cache. This release stores text records; importing/scanning supporting documents is not implemented.

Profile choices for address availability, mailing address, applicant status, programs, and medical-bill help use explicit `yes` / `no` / unanswered values. Unanswered never becomes No, and program selections do not imply eligibility. Home and mailing details remain separate. Existing encrypted profiles load with new fields unanswered, without a format migration or automatic rewrite. The fictional full-applicant test fixture is not a product default and must never be submitted to the live portal.

Encrypted export is available through the operating system's file dialog. Import requires a locked vault and explicit confirmation before replacing existing records. The prior encrypted vault is retained as a rollback file. An imported envelope is structurally validated before writing; authentication and payload validation happen when the user supplies its password or recovery key. Keep an independent backup. Losing both the password and the recovery key (with no device reset available) is not recoverable by secondHand. A backup keeps the key slots it was saved with, so an old recovery key still opens a backup made before the key was replaced.

## Desktop isolation

Only packaged local HTML/CSS/JavaScript is rendered. The window has Node integration disabled, context isolation and sandboxing enabled, spellcheck disabled, restrictive Content Security Policy, denied permissions, blocked network requests, and denied navigation/new-window requests. A narrow preload exposes named actions; the main process verifies the IPC sender, top-level frame, and exact renderer URL. The portal-opening action uses a fixed official URL.

## Extension and local bridge

The extension uses Manifest V3, `activeTab`, `scripting`, `nativeMessaging`, and `sidePanel`, with a host permission limited to `https://hhsservices.iowa.gov/*`. It requires Chrome 116 or newer. Its content script starts only on the Iowa application path, and every request separately validates the exact HTTPS Iowa origin and application path before scanning, requesting fields, or filling. It has no storage permission or applicant data persistence. The page-hosted widget is an extension-origin iframe inside a closed shadow root, so the page cannot script it. The worker binds its requests to the iframe's own tab and accepts Autofill only from a trusted click with `confirmed: true`. The checklist lives in Chrome’s native sidebar. The worker accepts applicant operations only from those exact extension URLs; content scripts and page `postMessage` calls have no path to the vault. Displaying either surface does not start filling.

The widget and sidebar receive field keys, fixed labels, completion/missing/manual status, counts, and fixed messages, never profile values or page-entered answers. Clicking a checklist item or a **need you** link asks the content script to focus the corresponding verified control; it does not retrieve a saved answer. The last autofill result per tab (counts and field keys only) lives in worker memory and clears when the tab navigates or closes. It creates no extension storage or online record.

Chrome Native Messaging invokes a local host registered with an exact extension ID. The native host relays bounded, framed JSON over a Unix socket or Windows named pipe to the running desktop. A fresh random session token authenticates local requests; its file is readable only by the current Unix user and protected by the user's directory permissions on Windows. Requests are strictly typed and reject unknown fields. A request cannot run shell commands, access arbitrary files, or fetch arbitrary profile paths.

The desktop's explicit Prepare Chrome extension action copies a fixed allowlist of bundled assets into its local `chrome-extension` folder and registers the ID derived from the manifest's public key. No vault data is copied, and no Chrome settings or enterprise policy are modified. Chrome's Developer mode / Load unpacked step remains manual. The public manifest key provides a stable development ID, not cryptographic proof of the code of an unpacked extension. Folder/clipboard IPC methods accept no arbitrary paths or clipboard payloads. A missing extension bundle does not prevent using the local vault.

On Windows, a small compiled C# host relays bounded binary messages directly to the desktop's authenticated local named pipe. It does not launch Electron, open the vault, or store applicant fields. Its source is included and it uses the installed .NET Framework. This avoids Electron's Windows stdin/console behavior interfering with Chrome's length-prefixed protocol. macOS/Linux use the executable's native mode with raw descriptor streams. No global environment setting, localhost server, external runtime download, or shell command is needed by the Windows host at application runtime.

This bridge does not protect against malicious software already running as the same OS user. Such software could read process memory, the bridge token, or impersonate a local client. The native host's origin argument is an application integration check, not proof against a hostile local process.

Field release is controlled by one desktop setting, **Let Chrome autofill without asking** (`autofillWithoutAsking`). It is off by default.
- **Off:** each Autofill click shows a desktop dialog naming the destination and the requested fields. The buttons are **Cancel**, **Allow once**, and **Always allow on this computer**.
- **On:** the setting is saved in `settings.json` next to the registered extension ID, never in the vault. The desktop then returns requested values without a dialog, but only while the vault is unlocked, only to that same authenticated extension ID, and only for the allowlisted Iowa HTTPS destination and allowlisted fields.
- **Resetting it:** registering a different extension ID turns it off. Locking the vault (manually, after 10 idle minutes, on suspend, on supported OS screen-lock events, or on exit) stops all releases until the user unlocks again.

Dialogs recheck the unlocked vault, the lock generation, and the extension connection before releasing fields, so a lock and re-unlock while a dialog is open invalidates it. Only requested, nonblank values are returned. Values stay transient in the extension worker and content script for the duration of one click, and they are never written to extension storage.

The trade-off is deliberate. With the setting on, anyone who can use the unlocked computer's Chrome can fill the saved answers into Iowa's page without a prompt. The vault lock and the 10-minute idle lock are the boundary. The desktop cannot independently attest a Chrome tab ID or document identity: it validates the authenticated extension, the destination string, and the field names. Binding a fill to its tab is enforced by the shipped extension code, not guaranteed against hostile software controlling that extension or the same OS user.

The adapter checks known applicant-page context and exact field labels, skips hidden/ambiguous/pre-filled fields, and rechecks element identity before filling. The extension never clicks Next, Save and Continue, or Submit. It never signs, solves CAPTCHA, fills credentials, or guesses household, legal, or eligibility answers. Current portal coverage and evidence are in [iowa-portal.md](iowa-portal.md).

Explicit choices may reveal additional verified applicant fields. One Autofill click requests every mapped field once and fills them in at most four fresh-preview passes, so revealed fields are filled without a second request. Saved answers that are blank are reported as fields that need the user, never retried in a loop.

## What local-only means

Profile/record persistence is local. Once the user authorizes filling a field, it is exposed to the official portal and potentially other software with access to that browser page. The portal may autosave before formal submission. Government servers, browser history, OS crash dumps, automatic machine backups, and third-party browser extensions are outside this application's control.

Store the vault and exported backups outside cloud-synced folders if all copies must remain offline. Use a strong password and device encryption. Windows uses `%LOCALAPPDATA%\SecondHand` rather than the roaming profile directory; macOS uses `~/Library/Application Support/SecondHand`; Linux uses the application config directory under `SecondHand`. Development tests use isolated temporary directories containing synthetic data only.

Packaged native-host tests may opt into an isolated storage root with both `SECONDHAND_TEST_MODE=1` and an absolute `SECONDHAND_TEST_USER_DATA` path below the operating system's temporary directory. This only selects local storage; the same origin, token, vault, and approval checks run. Without the explicit test mode, packaged apps use their normal storage directory.

## Verification and remaining work

Tests exercise wrong passwords and corrupted ciphertext, atomic local persistence, schema constraints, strict portal origins, bounded native frames, extension ID and bridge token validation, the autofill trust setting (dialog, Always allow, reset on a new extension ID, lock), and conservative adapter behavior. The real Electron smoke test exercises profile/application persistence and lock/unlock through the desktop UI. Native subprocess smoke messages cover the status, showApp, and field request protocol using synthetic fixtures.

This is an early pilot build, not an independently audited security product. Before public release: obtain code signing, review Chromium/Electron updates, verify the installed Windows native host with Chrome, validate actual portal fields with a consenting user, and perform an independent security review. Keep screenshots, tests, logs, issues, and commits free of real applicant data.
