# Touch ID unlock (macOS)

## Goal
On a Mac with Touch ID, the applicant unlocks SecondHand with a fingerprint instead of typing the password each time, including after the 10-minute auto-lock and after a restart. Once on, Touch ID stays available until it's turned off. The password stays the fallback.

## Today
- `desktop/vault.cjs` keeps one data key, wrapped in slots (envelope version 2):
  - `password`: scrypt from the password;
  - `recovery`: the recovery key;
  - `device`: a random secret sealed with Electron `safeStorage` in `device-reset.bin`, used only for "reset on this computer".
- Unlocking needs the password, or a reset.
- The extension's side panel says "SecondHand is locked" and the applicant switches to the app to unlock.

## Design

### The Touch ID slot (`desktop/vault.cjs`, `desktop/main.cjs`)
- **Turning it on:** while unlocked, **Unlock with Touch ID** asks for the password once more.
  1. The app makes a random 32-byte wrapping key and adds a `touchId` slot (the data key wrapped with it, like the other slots).
  2. It seals the wrapping key with `safeStorage.encryptString` into `touch-unlock.bin` in userData, as `{ version: 2, key }`. A version 1 file from the first build of this feature also holds `passwordAt`; it still unlocks, and `passwordAt` is ignored.
  3. The setting shows only when `process.platform === 'darwin'` and `systemPreferences.canPromptTouchID()` is true.
- **Unlocking:**
  1. The lock screen shows **Unlock with Touch ID** beside the password field.
  2. `systemPreferences.promptTouchID('unlock SecondHand')` must succeed.
  3. Then the app unseals the wrapping key, unwraps the `touchId` slot, and unlocks as a password unlock would (same `lockRevision`/`accessRevision` handling, same idle timer).
- **Touch ID stays available no matter what** (the owner's decision, after trying the first build): no password after the app starts and no time limit. It unlocks right after a restart and indefinitely, so the applicant is never pushed back to a password they may have forgotten.
- **A password reset keeps it.** A recovery-key or device reset keeps the data key, so the `touchId` slot and `touch-unlock.bin` stay. SecondHand has no other way to change the password.
- **The slot and `touch-unlock.bin` are removed only** when the applicant turns it off, on Start over, on restoring a backup (a different vault), and on creating a new password for a new vault.
- **Fail loud:**
  - a cancelled or failed Touch ID prompt shows a clear message and leaves the password field ready;
  - an unreadable `touch-unlock.bin` or slot turns Touch ID off, with a message naming the reason, and asks for the password;
  - errors are never swallowed.

### From Chrome (`desktop/bridge.cjs`, `desktop/main.cjs`, `extension/`)
- **A new native request, `unlockWithTouchId`** (`{ id, type }` only).
  - When the app is locked and Touch ID is on, the app shows its Touch ID prompt, which macOS shows as a system dialog. On success it unlocks.
  - Otherwise it answers with a reason, and the side panel keeps its current "Unlock in SecondHand" behavior. It never falls back to asking for the password in Chrome.
- **The side panel's Unlock button** uses it when the app's `status` says Touch ID is ready (`touchId: 'ready' | 'off'`). Its strings go in all six catalogs.

### Settings and UI (`renderer/`)
- **Security settings:** **Unlock with Touch ID**, off by default, with one line explaining it and its limits.
- **Lock screen:** **Unlock with Touch ID** whenever it's on, and a short line only when Touch ID was turned off, with the reason.

## Security and honest limits
- **In `docs/security.md`:**
  - the wrapping key is in the macOS Keychain through `safeStorage`, as the device-reset secret already is;
  - Touch ID gates the app's use of it;
  - in unsigned pilot builds, this protects against someone using the unlocked Mac, not against malware already running as the user;
  - the macOS dialog also accepts the Mac account's login password, and with no password-first rule or time limit, anyone who can pass it can open SecondHand until Touch ID is turned off;
  - hardware-backed biometric keys (Secure Enclave with an access control) need a code-signed app and a native helper, and are out of scope.
- **The vault file itself is unchanged in strength:** the password and recovery slots still work, and the `touchId` slot is useless without the Keychain secret.
- **Windows and Linux:** no change; Windows Hello is out of scope.

## Tests (written first)
- **Vault:** add, use and remove the `touchId` slot; a wrong or missing wrapping key fails loud; a reset keeps it, and it still unlocks.
- **Main process:**
  - Touch ID unlock goes through a stubbed `systemPreferences` (`canPromptTouchID`, `promptTouchID`) and `safeStorage`;
  - it works right after a restart and with no time limit (mocked clock), and is refused after it's turned off;
  - a reset keeps it; Start over, a restored backup and a new password remove it;
  - a cancelled prompt doesn't unlock;
  - `status.touchId` has the right state.
- **Bridge:** `unlockWithTouchId` validation and its replies.
- **Renderer:** the setting only when supported, the lock-screen button, and the line when Touch ID was turned off.
- **Extension:** the side panel's Unlock uses `unlockWithTouchId` when ready, and otherwise keeps today's behavior.
- **Smoke:** `npm run test:ui` stubs Touch ID in test mode only, through an explicit test hook that's refused in packaged builds, like the existing test-mode settings. It checks turning Touch ID on, auto-lock, a Touch ID unlock, Touch ID ready right after a restart, a reset keeping it and Start over removing it.
- `npm test`, `npm run check`, `npm run test:ui`, `npm run test:native`, `npm run test:extension` and `npm run test:translation` pass.
- **Real Touch ID:** at least one real prompt on this Mac when the owner is present, noted as manual.
