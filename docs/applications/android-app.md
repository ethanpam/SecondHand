# Android app and in-app assistant: user and engineering guide

SecondHand for Android is a Kotlin/Jetpack Compose prototype with a local profile, renewal organizer, encrypted documents, and an in-app browser assistant. It is not a Chrome extension for Android and does not share the desktop vault.

The source described here is identified in the [guide index](README.md). See the [Android README](../../android/README.md), [privacy design](../../android/docs/Privacy.md), and [validation record](../../android/docs/Validation.md) for the platform's existing evidence.

## Contents

- [What the app does](#what-the-app-does)
- [Install or run a development build](#install-or-run-a-development-build)
- [First use and daily workflow](#first-use-and-daily-workflow)
- [Use the in-app assistant](#use-the-in-app-assistant)
- [What can be shared](#what-can-be-shared)
- [Browser limitations and manual fallback](#browser-limitations-and-manual-fallback)
- [Storage, authentication, and reminders](#storage-authentication-and-reminders)
- [Architecture and source map](#architecture-and-source-map)
- [Build and test](#build-and-test)
- [Troubleshooting](#troubleshooting)

## What the app does

The native interface has four main areas: Overview, Profile, Documents, and Settings. It helps a person keep their information and notice-based deadlines together, then authorize a limited snapshot for a supported Iowa form.

The assistant can fill inspected primary-applicant fields, present explicit mappings for other eligible fields, and provide reviewed Continue and submission actions on supported flows. It does not decide eligibility, synchronize an agency case, or perform scheduled automatic renewals. Live filing and authenticated renewal remain unverified.

Native profile, document, and reminder features work offline. The portal and actual transmission of an application require a network connection. Reminder dates come from the user's notice rather than an assumption that every renewal happens annually.

## Install or run a development build

The project targets Android SDK 36 with a minimum of Android 11/API 30. The documented toolchain uses Android Studio, SDK Platform 36, Build Tools 36.0.0, and Studio's JDK 21 for Gradle. Java source compatibility in the app build is 17; this is separate from the JDK used to run Gradle.

1. Clone the **entire repository**. The build packages JavaScript from sibling `extension/` and `ios/` directories, so copying only `android/` is insufficient.
2. Open the `android` directory in Android Studio and let Gradle sync complete.
3. Install the requested SDK components through SDK Manager.
4. Choose an API 30+ emulator or connected phone and run the `app` configuration.
5. Configure a device credential or supported strong biometric to use normal app authentication.

Personal-device development does not require a Google Play publishing subscription. Device debugging and production distribution are different tasks. A release artifact still needs an appropriate signing key and release process.

## First use and daily workflow

Authenticate using the device's supported biometric or credential. Android does not use the iPhone app's four-digit SecondHand PIN system.

Save and review contact details, typed phone numbers, address, household notes, monthly income, and housing information. Record each relevant notice date separately. Enable notifications if you want generic reminders, and account for Android battery policies that may delay inexact scheduling.

In Documents, import supported PDFs/images for encrypted local storage and preview. Files are capped at 20 MB. This Android source documents a document vault and preview; it does not claim parity with desktop tax-form OCR or iPhone camera/OCR-to-profile workflows. Do not assume a feature exists because another platform has a similarly named Documents tab.

Before an application session, check the saved information reflects present circumstances. A historical amount or household note is not automatically a current form answer.

## Use the in-app assistant

1. Save and confirm your profile.
2. Explicitly authorize up to ten minutes of application sharing.
3. Open the assistant's in-app browser.
4. Complete login, CAPTCHA, program decisions, and consent on the website yourself.
5. Start assistance on a supported page. Verified applicant fields use the approved snapshot; other eligible fields need an explicit mapping selected for that page.
6. Inspect every fill. Existing answers are preserved. Complete unsupported or missing questions manually.
7. Refresh the preview and choose Continue when the reviewed page is ready. Use Pause or Stop to interrupt assistance.
8. Review the application and complete the website's signature yourself. A recognized submission action requires separate native approval before one website button click.
9. Read the result and enter the actual confirmation. The app does not infer successful filing from a button click.

Do not use a real submission to demonstrate the app. The documented emulator screenshots use synthetic forms. The [Iowa guest QA record](../../android/docs/Iowa-guest-QA.md) distinguishes public guest inspection from reconstructed form tests.

## What can be shared

The Android native sharing snapshot includes supported name/email, explicit home/mobile phone, home address, monthly income, and monthly housing cost. The privacy contract excludes household members, generic phone, notes, document contents, signatures, passwords, SSNs, and birth dates from autofill release.

This is different from iOS's optional SSN/annual-record sharing and desktop's richer field/record support. Packaging a shared DOM engine does not expand the Android native allowlist by itself.

The grant is memory-only and expires. Locking, backgrounding, or stopping invalidates assistance. Reopen the assistant and authenticate again as necessary. The app does not preserve its browsing session through lock or process restart; use the official site's own save/resume feature before leaving unfinished work.

## Browser limitations and manual fallback

The assistant requires AndroidX WebKit's isolated JavaScript world, checked at runtime. If the WebView provider lacks that capability, the app retains manual browsing and an external-browser option. It does not fall back to privileged page-world injection.

Use **Open in browser** for document uploads and portal features that reject embedded browsers. An external browser may need a separate login. The in-app session is not transferred to Chrome, and the native assistant cannot fill pages in another browser.

The Android product remains Iowa-focused in this source. Desktop all-websites mode, custom answers, AI guessing, and iOS exact-site approval UI should not be advertised as Android features without implementing and validating the native side.

## Storage, authentication, and reminders

Profiles, household/renewal records, and document metadata are serialized into an AES-256-GCM vault. Imported documents are encrypted separately and bind their unique IDs into authenticated ciphertext. Android Keystore owns the non-exportable key; hardware backing depends on the device.

Files and reminder metadata live under the app's `noBackupFilesDir`. App backup and device transfer are disabled. Device/key loss or uninstall can make information unrecoverable; there is no SecondHand cloud recovery service.

The UI separately gates access with strong biometric/device credentials. Sensitive screens use the secure-window flag to limit ordinary screenshots and recent-app previews. Backgrounding locks native data and revokes the temporary grant. Necessary decrypted document previews are temporary; the encrypted original remains until intentionally deleted.

Notifications use generic wording without names, benefit amounts, case numbers, or documents. They are reminders based on user-entered dates, not authoritative agency scheduling.

## Architecture and source map

| Component | File | Responsibility |
| --- | --- | --- |
| Entry/lifecycle | [MainActivity.kt](../../android/app/src/main/java/com/ethanpam/secondhand/MainActivity.kt) | Android activity integration |
| Root UI | [SecondHandRoot.kt](../../android/app/src/main/java/com/ethanpam/secondhand/ui/SecondHandRoot.kt) | Main Compose experience and authentication surface |
| App state | [AppStore.kt](../../android/app/src/main/java/com/ethanpam/secondhand/core/AppStore.kt) | Saved state, locks, grants, and operations |
| Models/serialization | [Models.kt](../../android/app/src/main/java/com/ethanpam/secondhand/core/Models.kt), [ModelCodec.kt](../../android/app/src/main/java/com/ethanpam/secondhand/core/ModelCodec.kt) | Native data model and encoding |
| Crypto/storage | [SecureVault.kt](../../android/app/src/main/java/com/ethanpam/secondhand/core/SecureVault.kt), [VaultCipher.kt](../../android/app/src/main/java/com/ethanpam/secondhand/core/VaultCipher.kt) | Keystore-backed encrypted files |
| Assistant transport | [AssistantController.kt](../../android/app/src/main/java/com/ethanpam/secondhand/assistant/AssistantController.kt) | WebView requests, grants, context/approval checks |
| Assistant controls | [AssistantScreen.kt](../../android/app/src/main/java/com/ethanpam/secondhand/assistant/AssistantScreen.kt) | Reviewed native browser controls |
| Reminders | [ReminderScheduler.kt](../../android/app/src/main/java/com/ethanpam/secondhand/core/ReminderScheduler.kt) | Scheduling entered deadlines |
| Shared asset build | [app/build.gradle.kts](../../android/app/build.gradle.kts) | Copies inspected adapter/DOM engine into generated assets |

The Gradle `syncSharedAssistantAssets` task packages `extension/iowa-adapter.js`, `ios/SafariExtension/Resources/field-mapper.js`, and `application-assistant.js`. These generated assets should not be hand-edited or committed. Change the source, assess all consuming platforms, and rebuild.

A native-user action starts a bounded operation. The controller checks origin, main frame, document/request identity, URL, session expiry, and approval before providing answers to isolated code. It does not expose `addJavascriptInterface` to arbitrary pages. The page engine inspects and fills within that operation, and stale/cancelled results must not act on a changed document.

## Build and test

From `android/`:

```sh
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The debug APK is at `android/app/build/outputs/apk/debug/app-debug.apk` relative to the repository root. Let Android Studio write the ignored `local.properties` for the SDK location; do not commit a developer's machine-specific path or signing keys.

On a Mac using Studio's bundled JDK, from `android/`:

```sh
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:assembleDebug
```

Shared JavaScript validation from the repository root:

```sh
npm ci --ignore-scripts
node --test ios/Tests/*.test.js android/tests/*.test.js
```

For a dedicated synthetic-data emulator, from `android/`:

```sh
adb shell am start -n com.ethanpam.secondhand/.MainActivity --ez ui_testing true
./gradlew :app:connectedDebugAndroidTest
```

The test bypass is restricted to Debug builds on detected emulators. It is not a release authentication mechanism. Instrumentation can manipulate test state; use a dedicated emulator rather than a personal installation containing real information.

A release candidate needs actual device checks for Keystore/authentication, notifications, WebView support, lock/background cleanup, and portal compatibility. Local JS or compile success alone does not establish these properties.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Missing shared asset/build failure | Full repository checkout; Gradle reads sibling iOS and extension files |
| Gradle cannot find SDK | Android Studio SDK installation and ignored local.properties |
| JDK mismatch | Gradle daemon/toolchain configuration and Studio JDK |
| Cannot unlock | Device credential/strong biometric setup and the app's authentication result |
| Manual-only browser | Installed WebView provider's isolated-world capability |
| Upload fails | Use Open in browser; expect separate sign-in and no transferred assistant session |
| Assistant stopped after switching apps | Intended lock/revocation; start a new approved session |
| Reminder arrives late | OS battery/notification policy; follow the actual notice independently |
| Looking for desktop-style OCR or arbitrary-site support | Those capabilities are not established for this Android source |
