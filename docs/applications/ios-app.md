# iOS app and Safari extension: user and engineering guide

SecondHand for iPhone is a native SwiftUI app with a Safari web extension. It keeps a local profile, encrypted documents, and a notice-based renewal plan. The extension can use a short-lived approved snapshot to help with forms in Safari.

It is a prototype, not a verified end-to-end filing service or an agency case client. The [guide index](README.md) identifies the documented source baseline. The [iOS README](../../ios/README.md) and [validation notes](../../ios/docs/Validation.md) contain platform-specific evidence and setup details.

## Contents

- [What the four areas do](#what-the-four-areas-do)
- [Install for development or a demo](#install-for-development-or-a-demo)
- [First launch and everyday use](#first-launch-and-everyday-use)
- [Documents, camera scans, and OCR](#documents-camera-scans-and-ocr)
- [Enable Safari assistance](#enable-safari-assistance)
- [Approved general websites](#approved-general-websites)
- [Submission and confirmation are separate](#submission-and-confirmation-are-separate)
- [Internal data and request flow](#internal-data-and-request-flow)
- [Build and validate](#build-and-validate)
- [Troubleshooting](#troubleshooting)

## What the four areas do

| Area | Purpose | Important boundary |
| --- | --- | --- |
| Overview | Notice-based dates, renewal tasks, and user-reported progress | Dates come from the notice; no automatic annual-renewal assumption |
| Profile | Contact/household details, income/housing information, supported identifiers and annual references | Save and confirm before sharing; historical annual records are not current monthly income |
| Documents | Encrypted files, preview, scanning, and local text review | OCR is a review aid, not proof of identity or correctness |
| Settings | PIN/Face ID, notifications, sharing session, and approved websites | Safari permission alone does not authorize native release |

The app has no SecondHand online account. Native saved information can be used offline; browsing, website sign-in, uploads, and submission need connectivity. It does not synchronize a desktop or Android vault.

## Install for development or a demo

The documented project uses Xcode 26.6 and targets iOS 17 or later. Open the complete repository's `ios/SecondHand.xcodeproj` and select the **SecondHand** scheme. Use the Xcode version/project requirements in the repository as the baseline rather than assuming an older Xcode can build it.

For a Simulator demo, select an installed iPhone Simulator and run the scheme. The optional `--ui-testing` launch argument bypasses the device-authentication gate only in a Debug Simulator build. It has no effect on physical devices or Release builds. Use only synthetic data with this mode.

For a personal iPhone, connect it to the Mac, use the same signing team for the app and SafariExtension targets, and let Xcode provision them. Follow device trust and Developer Mode prompts. The repository does not contain your signing credentials. See the iOS README's device setup section for the personal-team path and its provisioning limits.

A compile-only invocation with `CODE_SIGNING_ALLOWED=NO` is different from a runnable app with working App Group/Keychain entitlements. Keep normal local signing for interactive use. Do not interpret a successful unsigned compile as proof the extension can read the app's authorized snapshot.

## First launch and everyday use

1. Create the four-digit SecondHand PIN. Optional Face ID is enabled separately in Settings.
2. If upgrading an existing profile, follow the app's migration/authentication flow rather than deleting the installation.
3. Fill and save the profile. Keep home/mobile phone types explicit and review the home-address Yes/No answer separately from address text.
4. Enter deadlines from the actual notice: renewal return, benefits ending, interview, and requested-document dates are distinct.
5. Enable local notifications if desired. Generic reminder wording avoids placing applicant details on the lock screen.
6. Import or scan documents when needed. Review changes before saving them to the profile.

Face ID failure falls back to the app PIN. Repeated incorrect PIN attempts incur delays. The app's authentication state is local; there is no online account reset. Keep device access and data-loss limitations in mind when uninstalling or changing phones.

## Documents, camera scans, and OCR

In Documents, **Add a document** imports a PDF/image from Files. **Scan a document** uses the camera on supported devices and saves an encrypted PDF. Simulator cannot establish that a real camera capture works; imported synthetic files are suitable for Simulator checks.

Use **Read text** to extract text locally. Selectable PDF text is used when appropriate; scanned pages and images use Apple Vision. The original remains in the encrypted document library. Temporary extracted text is cleared when review closes or the app locks rather than saved as a separate plaintext record.

The app accepts supported files up to 20 MB, and OCR/scans are capped at 20 pages. Review amounts, checkbox interpretations, page order, and multi-column layouts against the original. Password-protected, invalid, or unsupported documents can need a different copy or manual entry.

### Put selected details into a profile draft

From **Set up my profile**, choose **Upload or scan a document**, or select an item from **Saved documents**. The parser supports bounded layouts for 1040/1040-SR, W-2, 1099-NEC, and SSA-1099.

1. Read the candidate list and compare it with the source.
2. Correct names/address components where needed; combined full names are not guessed into arbitrary first/last boundaries.
3. SSNs and supported annual amounts require agreeing OCR readings and start unchecked. Reveal masked identifiers only when needed for review.
4. Deselect anything you do not want, and confirm the information belongs to you and is current.
5. Choose **Use selected details** to update the unsaved profile draft.
6. Review the draft and use its ordinary Save action.

Employer/payer data is not substituted for the applicant. A generic 1099 recipient TIN is not assumed to be an SSN. Conflicting years or amount evidence can remain blank. Historical annual records retain source/year/type; they do not automatically answer current monthly-income questions. The explicit home-address Yes/No choice remains separate.

## Enable Safari assistance

Enable SecondHand in Safari's extension settings and grant the appropriate website access. The extension works in Safari; it does not make Chrome on iPhone support this extension.

In the native app, authorize a sharing session for up to ten minutes. This creates an approved snapshot; it is not an ongoing background authorization to read any future profile change. Choose sensitive inclusions deliberately and start a fresh session when the approved information changes.

For Iowa, open the intended portal flow, complete sign-in/verification/consent, and start application assistance from Safari's SecondHand popup. The session is bound to one tab. Pause, Resume, Stop, expiration, and page changes are part of the workflow, not just cosmetic buttons.

On the inspected applicant page, verified primary-applicant fields can fill automatically after Start. A saved explicit answer to **Do you have a home address?** can select the verified control and reveal fields for the same run. Existing answers are preserved, and a choice that could erase entered dependent address values is refused.

On other eligible fields, review the proposed mapping or explicitly select the saved detail that belongs there. Do not treat the desktop's broader Iowa adapters or record lists as proof of equivalent mobile coverage.

## Approved general websites

1. In Settings, enable **Allow approved websites during this session**, choose the permitted information, and authorize the ten-minute session.
2. Open a top-level HTTPS form in Safari. In the popup, choose **Allow this site** and grant the browser's site permission.
3. Review the exact origin. Approval does not automatically include subdomains or another origin inside an embedded frame.
4. Review suggested field matches, select uncertain mappings yourself, and optionally choose **Remember these matches for this site**.
5. Choose **Fill selected details**. General pages do not fill on load just because permission exists.
6. After completing the page, use **Check current page** if needed. Next is available only for one recognized Next/Continue control after required native fields validate and visible errors are resolved.
7. Click Next explicitly. The page is rechecked immediately before action, and the next page or single-page-app step requires a fresh review.

SSN/annual-income sharing needs inclusion in the app session and the relevant site-specific sensitive approval. The native bridge independently checks origin, expiry, approval, and allowed field scope; it does not rely on Safari permission alone. Older session formats remain Iowa-only.

Remove a site through the popup or **Approved websites** in Settings to revoke its native sharing. Forgetting remembered matches clears the site's mappings. Removing and re-approving a site does not resurrect old mappings through a stale approval revision.

General-site support is deliberately bounded: top-level ordinary text/select controls, conservative mappings, and user-controlled continuation. Credentials, payment, consent, signatures, final submission, embedded forms, other-person sections, and required custom widgets can remain manual.

## Submission and confirmation are separate

For recognized Iowa signing pages, the user must complete the website signature, check the extension's approval box, and choose **Approve and submit application**. The engine rechecks the reviewed page and attempts the ordinary website action once. It does not retry an uncertain submission automatically.

This differs from desktop, which leaves final submission entirely to the user on the website. It also does not imply that arbitrary general-site submission is supported on iOS.

After the action, read the website's result. A click alone never marks the tracker submitted. Enter and confirm the actual confirmation number; an encrypted receipt can then be imported into the app on unlock. If the page is not recognized, record the result manually.

Live end-to-end submission and authenticated renewal are not verified by the current prototype documentation. Existing live Simulator footage stops before applicant-page Save and Continue, signature, or final submission. Synthetic tests and browser replays are not proof of filing on a physical phone.

## Internal data and request flow

The native app stores encrypted profile/document data using CryptoKit AES-GCM. The shared App Group and Keychain entitlements let the Safari extension access specifically authorized encrypted handoff records. The extension does not get unrestricted ownership of the app's profile editor.

Important source responsibilities:

| File | Role |
| --- | --- |
| [AppStore.swift](../../ios/SecondHand/Core/AppStore.swift) | Native state, authentication/session lifecycle, persistence orchestration |
| [Models.swift](../../ios/SecondHand/Core/Models.swift) | Profile, renewal, sharing, and approved-site models |
| [AppAuthentication.swift](../../ios/SecondHand/Core/AppAuthentication.swift) | PIN validation, derivation, retry delays, local Keychain credential record |
| [SecureVault.swift](../../ios/SecondHand/Core/SecureVault.swift) | Encrypted files, keys, snapshots, approvals, and receipts |
| [DocumentOCR.swift](../../ios/SecondHand/Core/DocumentOCR.swift) | Apple document text/recognition pipeline |
| [ProfileDocumentImport.swift](../../ios/SecondHand/Core/ProfileDocumentImport.swift) | Structured review candidates and draft import |
| [ReminderScheduler.swift](../../ios/SecondHand/Core/ReminderScheduler.swift) | Generic local notifications tied to entered dates |
| [SafariWebExtensionHandler.swift](../../ios/SafariExtension/SafariWebExtensionHandler.swift) | Native request validation and bounded release |
| [background.js](../../ios/SafariExtension/Resources/background.js) | Browser session, permissions, popup requests, native communication |
| [application-assistant.js](../../ios/SafariExtension/Resources/application-assistant.js) | In-page inspection, filling, reviewed navigation |
| [popup.js](../../ios/SafariExtension/Resources/popup.js) | User choices and displayed assistance state |

The PIN credential uses PBKDF2-HMAC-SHA256 with a random salt and 100,000 iterations; the implementation tracks failed attempts and escalating retry delays. Its Keychain item is app-only and device-only. This is distinct from the shared encryption key used for authorized extension handoff.

The vault includes `profile.sealed`; sharing uses an expiring encrypted `session.sealed`. Shared directories are excluded from backup and use file protection. Remembered matches contain field keys and hashed context/path with approval revision, not answers or raw labels. Revocation and stale-page checks must remain effective across async replies.

Signing identifiers currently include app `com.ethanpam.secondhand`, extension `com.ethanpam.secondhand.SafariExtension`, App Group `group.com.ethanpam.secondhand`, and matching shared Keychain access group. If changing identifiers, update project generation, entitlements, Info.plist, and source constants consistently.

## Build and validate

From the repository root, install JavaScript test dependencies:

```sh
npm ci --ignore-scripts
node --test ios/Tests/*.test.js
```

From `ios/`, regenerate the project only when source layout/target settings change:

```sh
python3 scripts/generate_project.py
```

A compile-only Simulator build from `ios/`:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project SecondHand.xcodeproj -scheme SecondHand \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

For native tests and interactive UI checks, select a real available Simulator in Xcode and use Product → Test with the normal signing setup. The [validation notes](../../ios/docs/Validation.md) describe specific checks. The local general-site replay is `node ios/scripts/smoke-approved-sites.cjs` from the root; it uses Chromium and synthetic native responses, not actual Safari permission prompts.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Extension missing | Correct SafariExtension target installed, Safari enabled, site permission granted |
| App works but native sharing fails | Matching signing team, App Group and Keychain entitlements, active snapshot |
| Permission granted but no answers | Browser permission, native site approval, session scope, expiration, selected fields |
| Face ID unavailable | App setting, device availability, and PIN fallback |
| Scan option absent | Physical device/camera scanning support; use Files import in Simulator |
| Next disabled | Missing native-required fields, visible errors, ambiguous/protected controls, stale page review |
| New profile edit not shared | Save and start a fresh approved session |
| Tracker says submitted unexpectedly | A local state is user-reported; verify the actual website result and confirmation |
| Data lost after reinstall/device change | Local device-bound storage has no cloud recovery or cross-platform sync |
