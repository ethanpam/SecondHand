# SecondHand application guides

These guides explain what each SecondHand application does, how to use it, and how its implementation works. They are written for both people using the software and contributors maintaining it.

**Source baseline:** `b31b5a9` on `main`, reviewed October 6, 2026. These are descriptions of repository source, not a claim that every feature is present in a published installer. The website currently declares desktop release `0.4.0`; several features below were added after the original public 0.4 downloads. Rebuilding an installer, installing it locally, merging a PR, and publishing a download are separate operations.

## Choose a guide

| Application | Start here | What you get |
| --- | --- | --- |
| Windows `.exe` | [Windows installation and engineering](windows-exe.md) | An NSIS installer for the Electron desktop app, with a Windows native-messaging relay |
| macOS `.dmg` | [Mac installation and engineering](macos-dmg.md) | A disk image containing `SecondHand.app`, built separately for Apple silicon and Intel |
| Both desktop apps | [Shared desktop features and workflows](desktop-common.md) | Profile management, encrypted backups, OCR, Chrome autofill, permissions, AI, and implementation details |
| iPhone | [iOS app and Safari extension](ios-app.md) | Native SwiftUI app, encrypted documents, notice-based reminders, and reviewed Safari assistance |
| Android | [Android app and in-app assistant](android-app.md) | Native Compose app, encrypted documents and reminders, plus a guarded WebView assistant |
| Website | [Website, downloads, and publishing](website.md) | Public product information, setup instructions, and installer distribution |

The Windows and Mac guides cover platform-specific installation and packaging. Read the shared desktop guide for the features inside those apps. The mobile guides are separate because their authentication, document storage, browser integrations, and submission behavior differ.

## The product at a high level

SecondHand reduces repeated typing. A person saves information locally, reviews it, and authorizes a supported browser workflow to use selected answers. The software also provides tools for reviewing documents and keeping track of application-related work.

There is no shared SecondHand cloud account. Desktop, iOS, and Android keep separate local data. Installing one platform does not import another platform's profile. The public website distributes software; it is not the applicant vault or an application-submission service.

SecondHand is independent software. It does not decide benefits eligibility, replace official instructions, or retrieve authoritative application status. An application's local status or a successful Next click does not prove submission or acceptance. Users must read the destination site's result and follow up through that service.

## Platform comparison

| Capability | Windows / Mac | iOS | Android | Website |
| --- | --- | --- | --- | --- |
| Main technology | Electron, JavaScript/CommonJS | SwiftUI and Safari web extension | Kotlin, Compose, AndroidX WebKit | React, Vinext, Cloudflare Worker/R2 |
| Profile storage | Password-protected encrypted vault | Encrypted App Group files and Keychain-backed keys | Encrypted private files and Android Keystore | No applicant profile storage |
| Unlock | Password; recovery/device reset; optional Mac Touch ID | Four-digit app PIN; optional Face ID | Strong biometric or device credential | No applicant sign-in |
| Imported document originals | Read from their original location; not kept in a document vault | Encrypted document library | Encrypted document library | No document intake |
| Document OCR | Bundled PDF.js/Tesseract, with reviewable extraction | Apple Vision/PDF text, camera scanning where available | No equivalent native OCR workflow documented in this source | None |
| Browser surface | Chrome extension and native messaging | Safari extension and native messaging | App-owned WebView | Ordinary browser pages |
| General websites | Approved HTTPS sites, custom answers, optional guarded continuation | Exact approved HTTPS origins with reviewed matches and user-controlled Next | Iowa-focused native assistant; no desktop-style general-site permission UI | Not an autofill engine |
| Final submission | User performs it on the site | Separate approval on recognized signing flow; unsupported flows manual | Separate native approval on recognized flow; unsupported flows manual | None |
| Cross-device synchronization | None | None | None | None |

Sharing a JavaScript adapter does not imply feature parity. Android packages selected desktop/iOS files, but its native transport and allowed snapshot remain independently constrained. A new desktop feature does not automatically become a mobile feature.

## How to read the lower-level sections

Each platform guide includes a source map and build/validation commands. Paths refer to the repository, and commands state their working directory. A build checks compilation and packaging; a test checks only the behavior exercised by that test. Synthetic fixtures, desktop browser replays, Simulator checks, physical-device checks, and live website filing are different forms of evidence.

The detailed security and portal documents remain the reference for changing field allowlists, permission behavior, or navigation rules:

- [Security and privacy design](../security.md)
- [Exact Iowa portal coverage](../iowa-portal.md)
- [Document OCR behavior and limits](../document-ocr.md)
- [OCR implementation walkthrough](../document-ocr-code-guide.md)
- [Field review and optional model checks](../field-review.md)
- [Implementation contract](../implementation-contract.md)
- [iOS application pipeline](../../ios/docs/Application-assistant.md)
- [Android validation](../../android/docs/Validation.md)

## Typical journeys

**Desktop applicant:** install the correct package → create a password and keep the recovery key → save a profile → prepare and load the Chrome extension → authorize a site → fill and review → complete protected steps yourself → record the result locally.

**iPhone applicant:** install the native app → create the app PIN → save profile and notice dates → optionally scan documents → enable Safari extension access → authorize a short sharing session → review and fill → explicitly continue and, where supported, separately approve submission → record the website's result.

**Android applicant:** install the app → authenticate with the device → save profile and notice dates → authorize a short session → open the in-app assistant → review and fill supported pages → complete protected actions → record the confirmation after checking the result.

**Website visitor:** choose the correct platform download → save the installer → follow the platform installation guide → configure Chrome separately. Visiting the site does not install or authorize the extension.

## Keeping these guides accurate

When changing a feature, update its platform guide and the underlying implementation-specific document together. In particular, review descriptions of site access, persistent approval, submitted data, recovery, document retention, and final submission. Do not copy desktop claims into mobile guides without checking the native code.

When releasing, record which source revision produced each package. Update the website's advertised release only after the artifact exists and its downloaded bytes have been verified. Do not label source-only features as publicly available merely because their PR merged.
