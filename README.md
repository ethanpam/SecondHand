# secondHand

A desktop benefits companion and Chrome extension for Iowa SNAP. Your saved profile and application tracker live in an encrypted vault on your computer. An Open assistant button appears on Iowa's Self-Service Portal. It opens a Chrome side panel with a field checklist and approved filling/Next actions through a local Chrome Native Messaging connection.

**This is an early assisted-application release.** The initial applicant page has verified filling for names and suffix, phone/contact preferences, home and mailing addresses, and explicitly saved yes/no and program choices. Guided mode fills newly revealed fields, waits for missing required answers, then selects the verified Save and Continue control. Unverified later steps, consent, signatures, and final submission remain manual. You review the answers and complete those steps on Iowa's website. Only the government can confirm eligibility or approval. See [Iowa portal coverage](docs/iowa-portal.md) for the exact scope.

## iPhone app

A native SwiftUI iOS companion and Safari extension are in [`ios/`](ios/README.md). Open [`ios/SecondHand.xcodeproj`](ios/SecondHand.xcodeproj) in Xcode. It provides encrypted on-device profile and document storage, notice-based renewal reminders, and user-reviewed contact autofill. The iPhone and desktop vaults are independent; there is no cross-device synchronization. See the [iOS setup and validation guide](ios/README.md) for signing, Simulator tests, and current portal limitations.

## Install on Windows or Mac

Download the Windows `.exe` installer or the Mac `.dmg` for your processor from the [secondHand download website](https://secondhand-download.khoidoan00.chatgpt.site). On Mac, drag SecondHand into Applications and launch it there before setting up Chrome. These pilot builds are unsigned and Mac builds are not notarized, so your operating system may warn or block them.

1. Open SecondHand and create your local vault. Keep your passphrase safe; there is no online reset.
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

Address confirmation is under development. The [comparison component and integration notes](docs/address-automation.md) cover strict address matching; live address selection remains disabled pending inspection of Iowa's actual controls.

GitHub Actions runs syntax/security configuration checks, unit/integration tests, Electron/native smoke tests, and builds Windows installers plus Apple silicon and Intel Mac disk images. Workflow artifacts expire after 30 days and can be rebuilt with **Run workflow**; tagged builds can retain installers in a GitHub prerelease. No application server, database service, API keys, or applicant account with secondHand is required.

## Data boundaries

- The encrypted vault holds the profile, application notes, receipts entered as text, and deadlines. No cloud account, analytics, telemetry, remote fonts, or AI service is used by this code.
- The desktop app is the sole persistent owner of applicant data. Chrome extension storage and Chrome Sync are not used for applicant information.
- Filling a field shares it with Iowa's website. The website can read or autosave values before you click Submit, and ordinary **Save and Continue** saves page answers. Desktop approval occurs **before filling**; a guided approval covers only the listed profile fields and verified Next actions for up to 15 minutes. It does not authorize consent, signatures, or final submission.
- The extension is restricted to Iowa's supported HTTPS portal, requests only recognized fields on the current page, and never fills passwords, verification codes, signatures, or unknown household members.
- An encrypted backup is the portable recovery mechanism. Backups still require the original passphrase. Keep them off cloud-synced folders if you want all copies offline.
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
