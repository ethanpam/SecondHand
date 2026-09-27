# Android validation

Validated on September 26, 2026. All application data and confirmation numbers used in tests were synthetic. No real Iowa application was submitted.

## Build and IDE

- Opened and successfully synced the project in Android Studio Quail 2, 2026.1.2 Patch 1, using its bundled JDK 21.
- Gradle 9.3.1, Android Gradle Plugin 9.1.1, compile/target SDK 36, minimum SDK 30.
- Debug APK, minified unsigned release APK, and instrumentation APK build successfully.
- Android Lint completes with no errors, 21 warnings, and one hint. Dependency/version recommendations and guarded WebView API warnings remain.
- The Gradle wrapper verifies the official distribution checksum. SDK paths, build outputs, and signing keys are excluded from Git.
- Both APKs contain byte-for-byte copies of the shared Iowa adapter, field mapper, application engine, and Android transport. The minified release DEX contains no `ui_testing` emulator-bypass marker.

## Automated coverage

- **16 JVM tests:** model serialization, notice dates and reminder planning, receipt deduplication/status preservation, explicit sharing fields, grant expiry, URL policy, and authenticated ciphertext/tamper behavior.
- **86 JavaScript tests:** 80 shared iOS/DOM-engine checks and six Android transport checks. Coverage includes approved mappings, protected fields, stale page approvals, signature handling, submission gating, and cancellation.
- Instrumented native workflow covers profile entry, draft preservation during rotation, persistence after relaunch, lock/unlock, discarding a backgrounded unsaved draft, document navigation, and deleting app data.
- Instrumented storage checks exercise the actual Android Keystore, non-exportable keys, encrypted profile/document round trips, tamper rejection, and sharing revocation. Each storage fixture uses a separate directory and test-only key alias.
- Instrumented browser fixtures intercept all network requests. They exercise the real WebView controller with synthetic income, signature, and confirmation pages. The positive workflow requires an installed WebView with isolated-world support; it is explicitly skipped otherwise.

The Android 16/API 36 emulator with WebView 133.0.6943.137 and Android 17/API 37.0 emulator with WebView 145.0.7632.218 each completed four passing instrumented tests, with the positive isolated-world test skipped. Both correctly retained manual browsing and rejected automatic assistance on those older providers.

The final complete suite on the official API 37.2 emulator image with WebView **149.0.7827.5** completed **six passing instrumented tests, zero failures, and zero skips**. The positive controller workflow verifies that the bridge is invisible to page scripts, explicit field mapping works, Continue reaches the signature page, unapproved and stale submissions are rejected, exactly one approved click occurs, repeat attempts do not submit again, and a user-confirmed receipt is saved with sharing revoked. This run exposed and verified the fix for WebView149's null JavaScript callback crash.

The sixth test renders the actual native assistant around a local intercepted form and verifies its Close control stays below the status bar. Overview, document, and assistant screenshots in `images/` were visually reviewed. Dark-mode resources and native theme colors are implemented; a full dark-mode and large-text device review remains outstanding.

## Reproduce

Use a dedicated emulator with no personal Second Hand data. The UI test deliberately clears the app's vault.

```sh
cd android
./gradlew :app:assembleDebug :app:assembleRelease :app:testDebugUnitTest :app:lintDebug
./gradlew :app:connectedDebugAndroidTest
```

From the repository root:

```sh
node --test ios/Tests/*.test.js android/tests/*.test.js
node scripts/check.cjs
```

Gradle writes reports under `app/build/reports/`. Instrumentation screenshots use synthetic data, temporarily clear the secure-window flag only from test code, and restore it immediately. The app itself keeps that flag enabled.

## Remaining real-device and portal work

The follow-up [guest-page QA report](Iowa-guest-QA.md) documents a GET-only live entry check and the fuller fictional applicant-form test. Neither establishes live filing. Its opt-in live test is skipped during ordinary offline regression runs.

- Live Iowa login, CAPTCHA, full application, authenticated renewal, and confirmation behavior remain unverified. Successful synthetic tests do not establish successful agency filing.
- Physical-device credential/biometric prompts, document import/preview, accessibility at large text sizes, and notification delivery through battery restrictions need device checks.
- Portal file uploads currently require an external browser. Browser sessions are separate; signing in again or resuming through Iowa may be necessary.
- Isolated JavaScript support depends on the independently updated WebView provider, not just the Android OS version. Unsupported providers offer manual browsing.
- No Play Store publication, release signing, unattended renewal, agency case synchronization, or cross-device vault synchronization is included.
