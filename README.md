# secondHand

A desktop benefits companion and Chrome extension for Iowa SNAP. Your saved profile and application tracker live in an encrypted vault on your computer. An Open assistant button appears on Iowa's Self-Service Portal. It opens a Chrome side panel with a field checklist and approved filling/Next actions through a local Chrome Native Messaging connection.

**This is an early assisted-application release.** The initial applicant page has verified filling for names and suffix, phone/contact preferences, home and mailing addresses, and explicitly saved yes/no and program choices. Guided mode fills newly revealed fields, waits for missing required answers, then selects the verified Save and Continue control. Unverified later steps, consent, signatures, and final submission remain manual. You review the answers and complete those steps on Iowa's website. Only the government can confirm eligibility or approval. See [Iowa portal coverage](docs/iowa-portal.md) for the exact scope.

## iPhone app

A native SwiftUI iOS companion and Safari extension are in [`ios/`](ios/README.md). Open [`ios/SecondHand.xcodeproj`](ios/SecondHand.xcodeproj) in Xcode. It provides encrypted on-device storage, renewal reminders, and a guided application assistant with saved-answer filling, explicit page continuation, separately approved submission, and user-reported confirmation capture. This is a prototype; live Iowa filing and authenticated renewal remain unverified. The iPhone and desktop vaults are independent; there is no cross-device synchronization. See the [iOS setup guide](ios/README.md) and [application pipeline](ios/docs/Application-assistant.md).

## Android app

A matching Kotlin/Jetpack Compose app is in [`android/`](android/README.md). Open that folder in Android Studio. It includes encrypted offline profiles and documents, notice-based reminders, and an in-app Iowa assistant with explicit page and submission approval. It reuses the laptop and iOS form engines; supported WebViews run them in an isolated JavaScript world, with manual browsing on older providers. Live Iowa filing and authenticated renewal remain unverified. See the [Android setup guide](android/README.md) and [validation record](android/docs/Validation.md).

## Install on Windows or Mac

Download the Windows `.exe` installer or the Mac `.dmg` for your processor from the [secondHand download website](https://secondhand-download.khoidoan00.chatgpt.site). On Mac, drag SecondHand into Applications and launch it there before setting up Chrome. These pilot builds are unsigned and Mac builds are not notarized, so your operating system may warn or block them.

1. Open SecondHand and create a password. Save the recovery key it shows you somewhere safe, away from the computer. If you forget your password, choose **Forgot password?** and use that key, or reset it on the same computer if you left **Let this computer reset my password** on.
2. In **Chrome extension**, choose **Prepare Chrome extension**. The app prepares a permanent folder and registers its local connection automatically.
3. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that folder. Use the app's **Copy folder path** button to locate it. No extension ID copying or command line is needed.
4. Save your profile, keep the app unlocked, and open [Iowa's portal](https://hhsservices.iowa.gov/apspssp/ssp.portal) in Chrome. Use Chrome 116 or newer. Click **Open assistant** on the page or SecondHand’s toolbar icon to open the browser side panel. On the supported applicant page, choose **Fill this page**, **Fill & Next**, or **Start guided autofill**, then approve the request in the desktop app. Guided mode requires explicit approval for a session lasting up to **15 minutes**.
5. Review the checklist: **✓ Complete**, **○ Missing required**, optional blank fields, and manual-review items. Click a row to find the field in Iowa’s form. An active guided session continues automatically when missing required answers are complete. Protected or unverified steps require your review; **Resume guided autofill** only works on a supported page. Use the helper's pause/stop control or lock the desktop vault to end assistance. Complete consent, signatures, and final submission yourself; save the official confirmation in your local tracker.

Chrome installation still requires the manual Load unpacked step; the app does not silently install extensions. See [the complete setup and troubleshooting guide](docs/setup.md) for Mac folder selection, updates, and custom builds.

**Upgrading to 0.4:** install the new desktop app, choose **Refresh extension files**, click **Reload** for SecondHand at `chrome://extensions`, and reload your Iowa tab. If Chrome asks, review the updated permissions for the browser side panel and restricted Iowa site access. Avoid reloading an application containing unsaved answers—save or finish your current work first.

## Develop

Requires Node.js 22.12+ (Node 24 recommended) and npm. Packaged downloads target Windows and macOS (Apple silicon and Intel). The Windows build also uses the .NET Framework 4.x compiler included with supported Windows installations to compile the small native-messaging host from source.

```sh
npm ci
npm run check
npm test
npm start
```

On macOS/Linux, use the desktop's Prepare Chrome extension button; it registers a development native-host launcher automatically. You can also load the repository's `extension/` directory directly: its manifest key pins the same ID. On Windows, build/install the `.exe` before connecting, because Chrome needs the packaged native relay. The desktop UI itself runs with `npm start` on either platform.

```sh
npm run test:ui       # Real Electron UI smoke test; needs a desktop session
npm run test:extension # Isolated Chromium with synthetic Iowa fixtures; install via npx playwright install chromium
npm run test:native   # Native protocol test (on Windows set SECONDHAND_PACKAGED_EXE to the built native host)
npm run extension:zip
npm run dist:win      # Run on Windows to build the NSIS .exe installer
npm run dist:mac      # Unsigned DMGs for Apple silicon and Intel Macs
```

Fictional QA data is in [`tests/fixtures/applicant-profile.json`](tests/fixtures/applicant-profile.json). It is for isolated tests only and is never sent to the real Iowa portal.

No application server, database service, API keys, or applicant account with secondHand is required.

## Continuous integration

GitHub Actions checks every pull request and every push to `main`:

| Workflow | Runs when | What it checks |
| --- | --- | --- |
| **Verify and build** (`build.yml`) | Every pull request, `main`, and `v*` tags | Static checks and unit tests on Node 22 and 24; website lint, tests, typecheck, and build; the Chromium extension smoke test; the Electron UI and native-host tests, then Windows and Mac installers. **CI result** passes only when all of these pass. |
| **iOS** (`ios.yml`) | Changes under `ios/` | Safari extension JavaScript tests, then native and UI tests on the newest iPhone simulator with Xcode 26. |
| **Dependency audit** (`audit.yml`) | Lockfile changes and every Monday | `npm audit` for the desktop app and website. Critical advisories fail; high ones are reported as warnings. |
| **Workflow lint** (`workflow-lint.yml`) | Changes to workflow files | actionlint and shellcheck. |

Dependabot opens weekly update pull requests for npm packages and actions. A newer commit on a pull request cancels the older run. If a UI test fails, its screenshots (or the Xcode result bundle) are attached to the run as an artifact.

**Releases.** Installers from each run are kept as artifacts for 30 days and can be rebuilt with **Run workflow**. Pushing a tag that matches `package.json` (for example `v0.4.0`) builds all installers and attaches them, with checksums, to a draft prerelease. Publishing to the public download website stays a manual step with a temporary upload token; see [`website/README.md`](website/README.md).

## Data boundaries

- The encrypted vault holds the profile, application notes, receipts entered as text, and deadlines. No cloud account, analytics, telemetry, remote fonts, or AI service is used by this code.
- The desktop app is the sole persistent owner of applicant data. Chrome extension storage and Chrome Sync are not used for applicant information.
- Filling a field shares it with Iowa's website. The website can read or autosave values before you click Submit, and ordinary **Save and Continue** saves page answers. Desktop approval occurs **before filling**; a guided approval covers only the listed profile fields and verified Next actions for up to 15 minutes. It does not authorize consent, signatures, or final submission.
- The extension is restricted to Iowa's supported HTTPS portal, requests only recognized fields on the current page, and never fills passwords, verification codes, signatures, or unknown household members.
- An encrypted backup is the portable copy of your information. A backup opens with the password or recovery key it was saved with. Keep backups off cloud-synced folders if you want all copies offline.
- This does not protect an unlocked computer from malware, malicious same-user processes, browser extensions reading Iowa's page, OS backups/crash dumps, or government-side storage. Read [the security design](docs/security.md).

## Project layout

| Directory | Purpose |
| --- | --- |
| `desktop/` | Electron main/preload, encrypted vault, native host, local IPC, registration |
| `renderer/` | Local desktop interface |
| `extension/` | Manifest V3 browser side panel, launcher, worker, and conservative Iowa adapter |
| `shared/` | Validated profile/application schema and portal allowlist |
| `tests/` | Crypto, protocol, schema, and portal-adapter regression tests |
| `scripts/` | Validation, real UI smoke test, extension packaging |
| `website/` | Public installer download site, setup guide, and authenticated release publishing |
| `ios/` | Native iPhone app, Safari extension, Xcode project, and iOS tests |

## Download website

The [public download website](https://secondhand-download.khoidoan00.chatgpt.site) serves Windows and Mac installers without requiring GitHub access. Its source is in [`website/`](website/README.md). Only software installers are hosted online; applicant information remains in the desktop vault. Website publishing credentials are never included in the app or browser bundles.

## Before broader distribution

Validate each supported page against the current live portal with a consenting applicant, then expand mappings with sanitized fixtures and regression tests. Review [portal coverage](docs/iowa-portal.md) before using real data. Test the installed native host on Windows with Chrome, obtain a code-signing certificate, and complete a security review. The bundled unpacked extension has a stable development ID. Publishing to the Chrome Web Store still requires a developer account, store package/identity coordination, and review; loading unpacked is the pilot path.

Official resources: [Iowa SNAP application instructions](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap), [Iowa Self-Service Portal](https://hhsservices.iowa.gov/apspssp/ssp.portal), [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
