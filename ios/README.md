# SecondHand

An offline-first iPhone app for keeping an Iowa SNAP profile, documents, and renewal tasks together. A companion Safari Web Extension offers user-triggered contact autofill on the Iowa HHS portal.

This is an independent prototype, not an Iowa HHS product. It does not determine eligibility, synchronize with an agency case, or submit applications. Renewal and application statuses are entered by the user.

## What is included

- A SwiftUI app for a saved contact and household profile, income and housing notes, and renewal tracking.
- Separate dates for renewal return, benefits ending, interview, and requested documents. Dates come from the user's notice; the app does not assume annual renewal.
- An encrypted local document vault and document preview.
- Local reminders with generic wording on the lock screen.
- A device authentication gate using biometrics or the device passcode.
- A Safari extension that receives a short-lived, explicitly enabled contact snapshot and fills recognizable, empty fields after the user chooses to fill them.

Saved information and reminders work offline. Opening the Iowa website, signing in, uploading proof, and submitting an application require internet access.

<img src="docs/images/overview.png" width="280" alt="Second Hand renewal overview with no saved personal data"> <img src="docs/images/documents.png" width="280" alt="Second Hand document vault empty state">

## Autofill scope

Autofill is a prototype restricted to the primary-applicant form documented in the repository's [public portal inspection](../docs/iowa-portal.md), with conservative field matching exercised against local fixtures. **Safari filling in a live applicant session and a SNAP-specific online renewal flow have not been verified.** A successful fixture test is not a guarantee that the current portal can be filled.

The shared snapshot contains only first name, last name, and home-address fields. It expires after at most ten minutes. Generic email and phone stay in the app because the inspected form distinguishes home and mobile phone numbers. The snapshot also excludes household details, income, documents, notes, birth dates, Social Security numbers, and passwords. The extension does not sign in, upload documents, choose eligibility answers, accept attestations, or submit a form. The user reviews every answer and completes those steps on the official website.

The extension is for Safari on iOS. It does not add extension support to Chrome on iOS.

## Open and build

Requirements: a Mac with **Xcode 26.6**, Python 3 to regenerate the project, and an **iOS 17 or later** device or simulator. Node.js is needed only for the JavaScript tests. There are no third-party app dependencies.

Open `ios/SecondHand.xcodeproj` from the repository root in Xcode and select the `SecondHand` scheme. All commands below run from the `ios/` directory (`cd ios` first). The repository includes the project; regenerate it after changing the source layout or target configuration with:

```sh
python3 scripts/generate_project.py
```

Build for the simulator without device signing:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project SecondHand.xcodeproj \
  -scheme SecondHand \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

`DEVELOPER_DIR` selects Xcode for this command without changing the Mac's global developer-tool setting. Use the path to your Xcode installation if it differs.

## Run on your iPhone

Choose your own Apple development team under **Signing & Capabilities** for both the app and Safari extension targets. Configure matching capabilities and provisioning for both targets; the repository contains no development-team credentials.

| Setting | Value |
| --- | --- |
| App bundle identifier | `com.ethanpam.secondhand` |
| Safari extension bundle identifier | `com.ethanpam.secondhand.SafariExtension` |
| Shared App Group | `group.com.ethanpam.secondhand` |
| Shared Keychain access group | `$(AppIdentifierPrefix)com.ethanpam.secondhand.shared` |

If these identifiers are unavailable to your team, change them consistently in the project generator, entitlements, and matching source constants. App Groups and shared Keychain access must resolve to the same values in both signed targets. Your Apple account must support provisioning the required capabilities.

Build and run the app on the connected iPhone. Enable SecondHand in Safari's extension settings and grant access to `hhsservices.iowa.gov`. On current iOS versions, Safari settings are under **Settings → Apps → Safari → Extensions**; older versions place Safari directly in Settings.

Save and review your profile in the app, enable its temporary Safari sharing session, then open the official portal in Safari. Sign in yourself if needed. Open SecondHand from Safari's extension menu and use its fill action on the intended application page. Review the result, complete any remaining information, and submit yourself. Follow the instructions on your HHS notice for recertification.

## Tests and validation

Verified locally with Xcode 26.6: **7 native tests, 1 end-to-end UI test, and 30 Safari JavaScript tests pass**. The Release app and extension compile for physical iPhones. See [validation notes](docs/Validation.md) for coverage and remaining device checks.

Run the JavaScript matching and safety tests:

```sh
node --test Tests/extension.test.js
```

Run the native test target through **Product → Test** in Xcode using an available iPhone simulator. For a command-line run, replace the destination below with a simulator shown by `xcodebuild -showdestinations -project SecondHand.xcodeproj -scheme SecondHand`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project SecondHand.xcodeproj \
  -scheme SecondHand \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_UDID' \
  CODE_SIGN_IDENTITY=- test
```

Tests use local ad-hoc signing so the Simulator can enforce the app's Keychain and App Group entitlements. Unlike the compile-only command above, do not disable signing for an interactive run or UI test.

For automated UI tests, the `--ui-testing` launch argument skips device authentication **only in a Debug build running in the iOS Simulator**. It does not bypass authentication in a Release build or on a physical iPhone. To explore the prototype in Simulator, add that argument in **Edit Scheme → Run → Arguments**. Use synthetic test records. Simulator UI testing does not validate Face ID, Touch ID, or device-passcode behavior.

Before distributing the app, validate signed App Group and Keychain sharing, biometrics and device-passcode authentication, document lifecycle, notifications, accessibility, and Safari behavior on a real device. Physical-device authentication and authenticated live SNAP-case testing remain pending. No App Store release has been performed.

## Data and Iowa guidance

The app uses an AES-GCM encrypted local vault, device-only Keychain keys, complete file protection, and backup exclusions. It has no backend, analytics, or cloud synchronization. There is no automatic recovery if the device or key is lost. Read [Privacy and data handling](docs/Privacy.md) for the storage and Safari-sharing boundaries.

Iowa SNAP renewal is not universally annual. Follow the actual return-by date and required tasks in your Iowa HHS notice. Official links and the limits of the verified portal research are recorded in [Iowa sources](docs/Iowa-sources.md), reviewed September 26, 2026.
