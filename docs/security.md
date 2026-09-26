# Security and privacy design

secondHand has no application backend. The desktop process is the sole owner of saved applicant information. It serves no HTTP endpoint. The shipped UI and extension contain no analytics, cloud AI, remote fonts, or automatic updater. Dependencies and build artifacts are downloaded during development/build; this is separate from applicant data processing.

## Vault

`vault.secondhand` contains AES-256-GCM ciphertext with a random 96-bit nonce for every write, a 128-bit authentication tag, and version-bound authenticated additional data. A random 256-bit salt and scrypt (`N=32768`, `r=8`, `p=1`) derive the key from the user's passphrase. The passphrase must be at least 12 characters. KDF parameters are fixed and validated when reading a backup, preventing a file from requesting arbitrary computation.

The passphrase and key are never written to settings. The unlocked key is held in the desktop process and its buffer is cleared on lock. JavaScript strings and copies cannot be reliably zeroed; an unlocked machine and its memory are outside the confidentiality guarantee. The UI clears profile/application state when notified of a lock. The app locks after ten minutes without relevant activity, on system suspend, on supported OS lock-screen events, and on exit.

Writes serialize through a queue, use a private temporary file, sync that file, and atomically rename it. Unix data files are mode `0600`; Windows uses the current user's application-data directory and inherited access controls. Whole-vault size and field lengths are bounded. There is no unencrypted SQLite sidecar, journal, or document cache. This release stores text records; importing/scanning supporting documents is not implemented.

Encrypted export is available through the operating system's file dialog. Import requires a locked vault and explicit confirmation before replacing existing records. The prior encrypted vault is retained as a rollback file. An imported envelope is structurally validated before writing; authentication and payload validation happen when the user supplies its original passphrase. Keep an independent backup. Loss of the passphrase is not recoverable by secondHand.

## Desktop isolation

Only packaged local HTML/CSS/JavaScript is rendered. The window has Node integration disabled, context isolation and sandboxing enabled, spellcheck disabled, restrictive Content Security Policy, denied permissions, blocked network requests, and denied navigation/new-window requests. A narrow preload exposes named actions; the main process verifies the IPC sender, top-level frame, and exact renderer URL. The portal-opening action uses a fixed official URL.

## Extension and local bridge

The extension uses Manifest V3, `activeTab`, `scripting`, and `nativeMessaging`. It has no storage permission or applicant data persistence. Its action supplies a temporary permission for the current tab; application code additionally validates the exact HTTPS Iowa origin and application path before scanning, requesting fields, and filling.

Chrome Native Messaging invokes a local host registered with an exact extension ID. The native host relays bounded, framed JSON over a Unix socket or Windows named pipe to the running desktop. A fresh random session token authenticates local requests; its file is readable only by the current Unix user and protected by the user's directory permissions on Windows. Requests are strictly typed and reject unknown fields. A request cannot run shell commands, access arbitrary files, or fetch arbitrary profile paths.

On Windows, a small compiled C# launcher starts the sibling desktop executable with `ELECTRON_NO_ATTACH_CONSOLE=1` in that child's environment only and relays binary streams. This prevents Electron's pre-JavaScript console newline from corrupting Chrome's length-prefixed protocol. The native branch reads/writes raw descriptors because Electron replaces its JavaScript stdin wrapper on Windows. The launcher source is included; no global environment setting, localhost server, external runtime download, or shell command is needed at application runtime.

This bridge does not protect against malicious software already running as the same OS user. Such software could read process memory, the bridge token, or impersonate a local client. The native host's origin argument is an application integration check, not proof against a hostile local process.

For every field release, the desktop shows the destination and requested field names and asks for approval. It then rechecks that the vault is unlocked. Only requested, nonblank values are returned. Values are transient in the extension worker/content script; the worker orchestrates the operation so a popup closing when the desktop receives focus does not lose or repeat the request.

The adapter checks known applicant-page context and exact field labels, skips hidden/ambiguous/pre-filled fields, and rechecks element identity before filling. It never navigates, clicks Submit, signs, solves CAPTCHA, fills credentials, or interprets household/legal/eligibility questions. Current portal coverage and evidence are in [iowa-portal.md](iowa-portal.md).

## What local-only means

Profile/record persistence is local. Once the user authorizes filling a field, it is exposed to the official portal and potentially other software with access to that browser page. The portal may autosave before formal submission. Government servers, browser history, OS crash dumps, automatic machine backups, and third-party browser extensions are outside this application's control.

Store the vault and exported backups outside cloud-synced folders if all copies must remain offline. Use a strong passphrase and device encryption. Windows uses `%LOCALAPPDATA%\SecondHand` rather than the roaming profile directory; macOS uses `~/Library/Application Support/SecondHand`; Linux uses the application config directory under `SecondHand`. Development tests use isolated temporary directories containing synthetic data only.

## Verification and remaining work

Tests exercise wrong passwords and corrupted ciphertext, atomic local persistence, schema constraints, strict portal origins, bounded native frames, extension ID/token validation, and conservative adapter behavior. The real Electron smoke test exercises profile/application persistence and lock/unlock through the desktop UI.

This is an early pilot build, not an independently audited security product. Before public release: obtain code signing, review Chromium/Electron updates, verify the installed Windows native host with Chrome, validate actual portal fields with a consenting user, and perform an independent security review. Keep screenshots, tests, logs, issues, and commits free of real applicant data.
