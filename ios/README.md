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

**Second Hand has no app account or sign-in.** You can demo it without a paid Apple Developer subscription: Simulator needs no Apple account, and testing on your own iPhone uses a free Apple account in Xcode. An Iowa benefits-portal account is only relevant when using the official website. Apple's [account guidance](https://developer.apple.com/help/account/basics/about-your-developer-account) explains free personal-device testing and its limits.

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

Compile for the simulator without device signing (this checks the build only; use the demo steps below to run the app):

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project SecondHand.xcodeproj \
  -scheme SecondHand \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

`DEVELOPER_DIR` selects Xcode for this command without changing the Mac's global developer-tool setting. Use the path to your Xcode installation if it differs.

## Demo in Simulator for free

No iPhone, Apple sign-in, or paid membership is needed. Apple also supports [testing Safari web extensions in Simulator](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension) before joining the Developer Program.

1. Open `ios/SecondHand.xcodeproj` in Xcode and select the **SecondHand** scheme.
2. In the destination menu beside the Run button, select an available **iPhone Simulator**.
3. Open **Product → Scheme → Edit Scheme → Run → Arguments**. Add and enable `--ui-testing` under **Arguments Passed On Launch**.
4. Click **▶ Run** or press **Command-R**, then explore the app using made-up sample information.

The launch argument skips the device-authentication gate only in a **Debug Simulator build**. It has no effect on a physical iPhone or in a Release build. Keep Xcode's default local signing enabled: the app needs its Keychain and App Group entitlements even in Simulator. Do not use `CODE_SIGNING_ALLOWED=NO` for an interactive demo.

## Demo on your iPhone for free

You can install the app directly from your Mac with a **free Apple account / Personal Team**. You do not need to enroll in the paid Apple Developer Program for this personal-device demo. Apple's current [iOS capability matrix](https://developer.apple.com/help/account/reference/supported-capabilities-ios) includes App Groups and Keychain sharing for free Apple Developer accounts; provisioning still needs to succeed for your own account and identifiers.

1. Connect your iPhone to the Mac with a data-capable USB cable. Unlock it and tap **Trust This Computer** if prompted. Use an iPhone with a device passcode set, since the app protects access with Face ID, Touch ID, or the device passcode.
2. In **Xcode → Settings → Apple Accounts**, add your Apple account and complete sign-in. Internet access is needed for Xcode to set up signing.
3. Open `ios/SecondHand.xcodeproj`. Select the blue project icon, then the **SecondHand** target. Under **Signing & Capabilities**, enable **Automatically manage signing** and choose your **Personal Team**. Repeat for the **SafariExtension** target using the same team.
4. Select the **SecondHand** scheme and your connected **iPhone** in Xcode's destination menu, then click **▶ Run** or press **Command-R**.
5. If Xcode asks for Developer Mode, open **Settings → Privacy & Security → Developer Mode** on the iPhone, turn it on, and follow the restart and confirmation prompts. Unlock the phone and run the app from Xcode again. If the setting is missing, let Xcode recognize the connected phone first.

See Apple's [device setup instructions](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices) and [Developer Mode guide](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

Once installed, you can disconnect the cable and demo the offline features. Free Personal Team provisioning lasts **7 days**; rebuild and run from Xcode with the same team and identifiers after it expires. You do not need to delete the app to renew it. Paid membership is needed for distribution through TestFlight or the App Store, not this personal-device demo. See [Apple's account guidance](https://developer.apple.com/help/account/basics/about-your-developer-account).

### Signing identifiers

The repository contains no development-team credentials. Both targets must use matching App Group and Keychain settings:

| Setting | Value |
| --- | --- |
| App bundle identifier | `com.ethanpam.secondhand` |
| Safari extension bundle identifier | `com.ethanpam.secondhand.SafariExtension` |
| Shared App Group | `group.com.ethanpam.secondhand` |
| Shared Keychain access group | `$(AppIdentifierPrefix)com.ethanpam.secondhand.shared` |

If Xcode reports that these identifiers are unavailable to your team, change them consistently in `scripts/generate_project.py`, both targets' entitlements and `Info.plist` files, and matching source constants in `SecondHand/Core/SecureVault.swift`, then regenerate the project. Recheck the signing team after regeneration. App Groups and shared Keychain access must resolve to the same values in both signed targets. An identifier conflict does not mean you need a paid subscription.

### Try Safari autofill (optional)

After installing the app, enable SecondHand in Safari's extension settings and grant access to `hhsservices.iowa.gov`. On current iOS versions, Safari settings are under **Settings → Apps → Safari → Extensions**; older versions place Safari directly in Settings.

Save and review your profile in the app, enable its temporary Safari sharing session, then open the official portal in Safari. Any instruction to sign in here refers to your **Iowa benefits-portal account**, not an Apple account or a Second Hand account. Open SecondHand from Safari's extension menu and use its fill action on the intended application page. Review the result, complete any remaining information, and submit yourself only when making a real application. You do not need to create or submit an Iowa application to demo the native app. Follow the instructions on your HHS notice for recertification.

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

Automated UI tests use the same Debug Simulator-only `--ui-testing` authentication bypass described in the Simulator demo steps above. Simulator UI testing does not validate Face ID, Touch ID, or device-passcode behavior.

Before distributing the app, validate signed App Group and Keychain sharing, biometrics and device-passcode authentication, document lifecycle, notifications, accessibility, and Safari behavior on a real device. Physical-device authentication and authenticated live SNAP-case testing remain pending. No App Store release has been performed.

## Data and Iowa guidance

The app uses an AES-GCM encrypted local vault, device-only Keychain keys, complete file protection, and backup exclusions. It has no backend, analytics, or cloud synchronization. There is no automatic recovery if the device or key is lost. Read [Privacy and data handling](docs/Privacy.md) for the storage and Safari-sharing boundaries.

Iowa SNAP renewal is not universally annual. Follow the actual return-by date and required tasks in your Iowa HHS notice. Official links and the limits of the verified portal research are recorded in [Iowa sources](docs/Iowa-sources.md), reviewed September 26, 2026.
