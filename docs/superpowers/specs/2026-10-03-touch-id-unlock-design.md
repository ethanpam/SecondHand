# Touch ID unlock (macOS)

## Goal
On a Mac with Touch ID, the applicant unlocks SecondHand with a fingerprint instead of typing the password each time, including after the 10-minute auto-lock. The password stays the fallback and is still required at the moments below.

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
  2. It seals the wrapping key with `safeStorage.encryptString` into `touch-unlock.bin` in userData, together with `{ version: 1, passwordAt }`. `passwordAt` is when the password was last used.
  3. The setting shows only when `process.platform === 'darwin'` and `systemPreferences.canPromptTouchID()` is true.
- **Unlocking:**
  1. The lock screen shows **Unlock with Touch ID** beside the password field.
  2. `systemPreferences.promptTouchID('unlock SecondHand')` must succeed.
  3. Then the app unseals the wrapping key, unwraps the `touchId` slot, and unlocks as a password unlock would (same `lockRevision`/`accessRevision` handling, same idle timer).
- **When the password is still required** (Touch ID refuses and says why):
  - the first unlock after the app starts: an in-memory flag, set only by a password unlock;
  - more than 14 days since `passwordAt`;
  - after a password change, a recovery-key reset, a device reset or Start over. Each of these removes the slot and `touch-unlock.bin`.
  Every password unlock refreshes `passwordAt`.
- **Turning it off:** removes the slot and deletes `touch-unlock.bin`.
- **Fail loud:**
  - a cancelled or failed Touch ID prompt shows a clear message and leaves the password field ready;
  - an unreadable `touch-unlock.bin` or slot turns Touch ID off, with a message naming the reason, and asks for the password;
  - errors are never swallowed.

### From Chrome (`desktop/bridge.cjs`, `desktop/main.cjs`, `extension/`)
- **A new native request, `unlockWithTouchId`** (`{ id, type }` only).
  - When the app is locked, Touch ID is on and allowed right now, the app shows its Touch ID prompt, which macOS shows as a system dialog. On success it unlocks.
  - Otherwise it answers with a reason, and the side panel keeps its current "Unlock in SecondHand" behavior. It never falls back to asking for the password in Chrome.
- **The side panel's Unlock button** uses it when the app's `status` says Touch ID is ready (`touchId: 'ready' | 'password' | 'off'`). Its strings go in all six catalogs.

### Settings and UI (`renderer/`)
- **Security settings:** **Unlock with Touch ID**, off by default, with one line explaining it and its limits.
- **Lock screen:** **Unlock with Touch ID**, plus a short line when the password is needed ("Enter your password: it's needed after SecondHand restarts or every 14 days").

## Security and honest limits
- **In `docs/security.md`:**
  - the wrapping key is in the macOS Keychain through `safeStorage`, as the device-reset secret already is;
  - Touch ID gates the app's use of it;
  - in unsigned pilot builds, this protects against someone using the unlocked Mac, not against malware already running as the user;
  - hardware-backed biometric keys (Secure Enclave with an access control) need a code-signed app and a native helper, and are out of scope.
- **The vault file itself is unchanged in strength:** the password and recovery slots still work, and the `touchId` slot is useless without the Keychain secret.
- **Windows and Linux:** no change; Windows Hello is out of scope.

## Tests (written first)
- **Vault:** add, use and remove the `touchId` slot; a wrong or missing wrapping key fails loud; changing the password or resetting removes it.
- **Main process:**
  - Touch ID unlock goes through a stubbed `systemPreferences` (`canPromptTouchID`, `promptTouchID`) and `safeStorage`;
  - it's refused before the first password unlock since start, after 14 days (mocked clock) and after it's turned off;
  - a cancelled prompt doesn't unlock;
  - `status.touchId` has the right state.
- **Bridge:** `unlockWithTouchId` validation and its replies.
- **Renderer:** the setting only when supported, the lock-screen button, and the "password needed" line.
- **Extension:** the side panel's Unlock uses `unlockWithTouchId` when ready, and otherwise keeps today's behavior.
- **Smoke:** `npm run test:ui` stubs Touch ID in test mode only, through an explicit test hook that's refused in packaged builds, like the existing test-mode settings. It checks turning Touch ID on, auto-lock, a Touch ID unlock, and a restart requiring the password.
- `npm test`, `npm run check`, `npm run test:ui`, `npm run test:native` and `npm run test:extension` pass.
- **Real Touch ID:** at least one real prompt on this Mac when the owner is present, noted as manual.
