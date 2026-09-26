# Validation — September 26, 2026

Environment: Xcode 26.6 (17F113), iOS 26.5 Simulator, iPhone 17 Pro. Deployment target: iOS 17.

| Check | Result |
| --- | --- |
| iPhone Release build, app and embedded Safari extension | Passed; compiled without device signing |
| Native XCTest | 7 passed, 0 failures |
| Simulator end-to-end UI test | 1 passed, 0 failures |
| Safari matcher and popup JavaScript tests | 30 passed, 0 failures |
| Existing desktop JavaScript syntax/security configuration check | Passed; desktop source unchanged |
| Git whitespace check | Passed |

Native tests cover encrypted persistence, rejection of wrong keys and tampering, cross-file ciphertext substitution, unsupported storage versions, contact-only session expiry, notice-based reminders, completed task suppression, calendar-day calculations, and profile validation.

The UI test uses synthetic data. It edits and confirms a profile, saves it, terminates and reopens the app to verify persistence, opens renewal and document screens, grants and revokes temporary autofill access, deletes all local data, then reopens to verify an empty profile. Debug Simulator authentication is bypassed only with `--ui-testing`; production/device builds do not contain that bypass.

The JavaScript suite uses synthetic DOM fixtures based on the repository's documented public applicant form. It exercises exact page/form/field matching, sensitive and other-person field rejection, home-address context, offscreen and covered fields, no-overwrite behavior, changed DOM/navigation, one-use previews, session expiry, select matching, and popup-to-native data boundaries. It makes no network calls or real submissions.

Screenshots in `images/` were captured from the Simulator and visually reviewed. They contain no applicant information. The UI test's synthetic profile was removed through the app's deletion flow.

## Remaining checks

- Provision both targets with the developer's Apple team and matching App Group/Keychain capabilities.
- Validate Face ID, Touch ID/device passcode, locked-device file protection, actual notification delivery, and document-provider behavior on physical devices.
- Test the installed Safari extension's native messaging and field filling on an iPhone in a permitted applicant or agency test session. The public DOM mapping is documented; Safari filling and authenticated SNAP renewal are not yet validated.
- Complete device/accessibility testing and an App Store release review before distributing beyond a prototype.

The local Xcode test run exited successfully and reported `TEST SUCCEEDED`. Its post-test diagnostic collector separately warned that `simctl` was unavailable through the Mac's globally selected Command Line Tools; all build/test commands used an explicit Xcode `DEVELOPER_DIR`.
