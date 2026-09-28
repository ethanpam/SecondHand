# Validation — September 26–27, 2026

Environment: Xcode 26.6 (17F113), iOS 26.5 Simulator, isolated iPhone 17 Pro named SecondHand AutoApply QA. Deployment target: iOS 17. The initial automated checks used local synthetic data only. The separately authorized live follow-up below entered fictional data on Iowa's website; no application was submitted.

## Initial checks — September 26, 2026

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

## Installed iPhone Simulator QA — September 27, 2026

Manual QA used the signed app and embedded extension built from commit `120069a` in the isolated **SecondHand AutoApply QA** iPhone Simulator running iOS 26.5. No physical iPhone was connected.

The synthetic **Avery Jordan Example** profile was entered through the app's real UI, including email, home and mobile phone, home address, monthly income of $0, and monthly housing cost of $800. Profile confirmation and saving passed. Backgrounding locked the app; unlocking after returning retained the saved profile. Settings showed the authorized ten-minute sharing countdown at **9:54**. This initial check verified the native app's sharing authorization; Safari's receipt of profile data was verified in the live follow-up below.

In Simulator Safari, **SecondHand for Iowa** was enabled through **Page Menu → Manage Extensions**. The installed extension popup rendered, and **Allow for One Day** granted access to the Iowa site. A fresh direct guest URL redirected to the portal root. The normal **Apply for Assistance → Apply as Guest** path reached **Household Application Information** at `https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/guestLogin`.

Selecting **Start application assistance** returned: “Open an Iowa application page in this tab. Sign-in and account pages stay manual.” The route restriction rejects `guestLogin` before native messaging, so this initial check did not verify real Safari native data transfer or live filling. All website answers remained blank during this check; no save, signature, or submission action was performed. No CAPTCHA was visible at this point, so CAPTCHA handoff was not tested in this check.

[iPhone Safari screenshot of the blank guest page](images/iphone-safari-guest-qa.png).

## Offline iPhone autofill video — September 27, 2026

[Recorded iPhone QA video and reproduction instructions](qa/README.md). The Debug Simulator QA view read the actual encrypted sharing snapshot and ran the unchanged production JavaScript against a bundled reconstructed applicant form. The recording shows five name/phone fields filled, a manual local home-address choice, and five address fields filled: **10 total, zero skipped**. Asserted manual controls remained blank. No network or submission was available in this fixture. This adds native-vault/WebKit integration evidence; this offline recording does not verify Safari native messaging or live filing.

Signed Debug and Release Simulator builds passed, the generated fixture check passed, and the existing iOS JavaScript suite passed **82/82**. The exported H.264 MP4 was decoded and its representative frames visually checked. The extra QA screen is Debug Simulator only and requires `--offline-qa`.

## Live iPhone Safari autofill — September 27, 2026

The user explicitly approved testing the fictional **Avery Jordan Example** profile on Iowa's live website after being told that Iowa may save filled fields before submission. The user completed CAPTCHA and consent in **SecondHand AutoApply QA → Safari**. The normal guest flow then reached **Enter Personal Information** with applicant fields blank; the optional helper page was continued with no helper answers entered. The signed Debug app used the explicitly approved Simulator-only `--ui-testing` authentication bypass, without `--offline-qa`. The test ran through the installed Safari extension and normal Safari in iOS 26.5 Simulator.

[Watch the live Safari QA video](https://github.com/ethanpam/secondHand/blob/e411cfbbf77f7e0169c3ca0c6afea2fa35da2c4f/ios/docs/qa/iphone-live-safari-demo.mp4). On a freshly reloaded applicant form with blank name/phone fields and an unanswered home-address question, one **Start application assistance** action selected **Yes** and filled all **10 text/select fields**: first/middle/last name, home/mobile phone, street, unit, city, state, and ZIP. The popup reported **“Home address Yes selected. 10 fields filled.”** All ten fields were visually checked after closing the popup, including **Demo City**, **Iowa**, and **50309**. The Yes choice is additional to the ten-field count. This verifies the actual encrypted native sharing snapshot → installed Safari extension → live applicant form.

An intermediate run filled seven fields but skipped first name, home phone, and city while Safari was settling after scrolling. Bounded layout-settling checks fixed that issue; the final live rerun filled all ten. Validation of the final change passed: **20 native tests**, **97 JavaScript tests**, and the **signed Debug Simulator build**.

The test stopped before the applicant page's **Save and Continue**, signature, or submission. No application was submitted. Because typing and radio changes occurred on the live website, the absence of a submission does not establish that Iowa retained no data. Later application pages, authenticated renewal, and physical-device behavior were not tested by this run.

## Remaining checks

- Provision both targets with the developer's Apple team and matching App Group/Keychain capabilities.
- Validate Face ID, Touch ID/device passcode, locked-device file protection, actual notification delivery, and document-provider behavior on physical devices.
- Test background recovery, cancellation, and native receipt import; repeat installed-extension permission, native messaging, popup, and scrolling checks on a physical iPhone.
- Validate final signing/action and receipt semantics in an agency-provided test environment or a specifically authorized real application. Later-page DOM coverage, successful live filing, and authenticated SNAP renewal remain unverified; unsupported pages use a manual fallback.
- Complete device/accessibility testing and an App Store release review before distributing beyond a prototype.

The local Xcode test run exited successfully and reported `TEST SUCCEEDED`. Its post-test diagnostic collector separately warned that `simctl` was unavailable through the Mac's globally selected Command Line Tools; all build/test commands used an explicit Xcode `DEVELOPER_DIR`.
