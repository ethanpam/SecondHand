# Validation — September 26, 2026

Environment: Xcode 26.6 (17F113), iOS 26.5 Simulator, isolated iPhone 17 Pro named SecondHand AutoApply QA. Deployment target: iOS 17. No applicant data or production submissions were used.

| Check | Result |
| --- | --- |
| iPhone Release build, app and embedded Safari extension | Passed; compiled without device signing |
| Native XCTest | 17 passed, 0 failures |
| Simulator end-to-end UI test | 1 passed, 0 failures |
| Safari matcher, DOM actions, workflow/popup, and multi-page JavaScript tests | 80 passed, 0 failures |
| Extension popup visual check | Light/dark 390px local browser preview; no horizontal overflow; submission disabled before approval |
| Existing desktop JavaScript syntax/security configuration check | Passed; desktop source unchanged |
| Shared laptop Iowa navigation adapter bundled in Simulator and iPhone builds | Passed; source and both bundled copies have identical SHA-256 hashes |
| Git whitespace check | Passed |

Native tests cover encrypted persistence, rejection of wrong keys and tampering, cross-file ciphertext substitution, unsupported storage versions, backwards-compatible profile migration, sharing-session expiry, typed-phone semantics, notice-based reminders, profile validation, encrypted receipt handoff, durable deduplication, preservation of advanced statuses, and stale receipts after a new renewal begins.

The UI test uses synthetic data in an isolated Simulator. It edits and confirms a profile, saves it, terminates and reopens the app to verify persistence, opens renewal and document screens, explicitly confirms expanded application sharing, revokes access, deletes the test data, then reopens to verify an empty profile. Debug Simulator authentication is bypassed only with `--ui-testing`; production/device builds do not contain that bypass.

The JavaScript suites use the inspected applicant schema plus explicitly synthetic income, signature, and receipt pages. They cover exact matching, user-selected mappings, sensitive and other-person exclusions, scrolling and occlusion, preservation of existing answers, page/form/recipient changes, changed attestation prose, one-use approvals, expiry during actions, concurrent Stop/Pause, stale-popup tokens, strict message origins, worker recovery, and no automatic replay of submission. A combined test runs the real page scripts through the real background controller with mocked browser/native transport across multiple synthetic pages. All submit events are intercepted locally; no network calls or real applications occur.

Overview and document screenshots in `images/` were captured from the Simulator and visually reviewed. The application approval screenshot is a local browser rendering of the extension popup with mock state, not an installed Safari or Iowa session. The UI test's synthetic profile was removed through the app's deletion flow.

## Remaining checks

- Provision both targets with the developer's Apple team and matching App Group/Keychain capabilities.
- Validate Face ID, Touch ID/device passcode, locked-device file protection, actual notification delivery, and document-provider behavior on physical devices.
- Test the installed Safari extension's permission grant, native messaging, popup closure, background recovery, scrolling fills, cancellation, and native receipt import on an iPhone.
- Validate final signing/action and receipt semantics in an agency-provided test environment or a specifically authorized real application. Later-page DOM coverage, successful live filing, and authenticated SNAP renewal remain unverified; unsupported pages use a manual fallback.
- Complete device/accessibility testing and an App Store release review before distributing beyond a prototype.

The local Xcode test run exited successfully and reported `TEST SUCCEEDED`. Its post-test diagnostic collector separately warned that `simctl` was unavailable through the Mac's globally selected Command Line Tools; all build/test commands used an explicit Xcode `DEVELOPER_DIR`.
