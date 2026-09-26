# secondHand

A desktop benefits companion and Chrome extension for Iowa SNAP. Your saved profile and application tracker live in an encrypted vault on your computer. The extension requests individual fields through Chrome Native Messaging, with approval in the desktop app, and fills supported fields on Iowa's Self-Service Portal.

**This is an early assisted-application release.** It does not determine eligibility or submit applications unattended. You review the page, answer unsupported questions, navigate, sign, and submit on Iowa's website. Only the government can confirm eligibility or approval. See [Iowa portal coverage](docs/iowa-portal.md) for observed mappings and remaining manual steps.

## Install on Windows

1. Open the repository's **Actions → Verify and build** page. Download the `secondHand-windows` artifact from a successful run and extract it.
2. Run the `.exe` installer. This initial build is unsigned; a public distribution should use a trusted code-signing certificate.
3. Extract `secondHand-extension.zip` into a permanent folder. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that folder.
4. Open secondHand, create a vault with a strong passphrase, and save your profile. Blank fields mean unknown. Store the passphrase somewhere safe: there is no server-side password reset.
5. Copy the extension's 32-character ID from `chrome://extensions` into the desktop app's extension setup. Connect it to register the local Native Messaging host for your user account.
6. Open Iowa's portal from the app. Create/sign into an Iowa account yourself, or choose the guest flow. Open the extension on a supported application page, scan the page, review the matched field names, and request filling. Approve the specific field release in secondHand, then review the filled form.
7. Complete the remaining questions and submission yourself. Save the official confirmation number in the local application tracker. Tracker statuses and deadlines are your records, not live government case status.

Keep the desktop app running and unlocked when using the extension. A lock, an unknown page, or a changed form stops field sharing. Register again if you move the development checkout or replace the unpacked extension and its ID changes.

## Develop

Requires Node.js 22.12+ (Node 24 recommended) and npm. Windows is the installer target; macOS is supported for development.

```sh
npm ci
npm run check
npm test
npm start
```

For the development extension, load this repository's `extension/` directory unpacked in Chrome. On macOS/Linux, connect its ID in the running desktop app; registration creates a development native-host launcher. On Windows, build/install the `.exe` before connecting the extension, because Chrome needs the packaged executable as its native host. The desktop UI itself runs with `npm start` on either platform.

```sh
npm run test:ui       # Real Electron UI smoke test; needs a desktop session
npm run extension:zip
npm run dist:win      # Run on Windows to build the NSIS .exe installer
npm run dist:mac      # Optional unsigned local macOS application bundle
```

GitHub Actions runs syntax/security configuration checks, unit/integration tests, an Electron smoke test, and the Windows installer build. Artifacts expire after 14 days and can be rebuilt with **Run workflow**. No application server, database service, API keys, or applicant account with secondHand is required.

## Data boundaries

- The encrypted vault holds the profile, application notes, receipts entered as text, and deadlines. No cloud account, analytics, telemetry, remote fonts, or AI service is used by this code.
- The desktop app is the sole persistent owner of applicant data. Chrome extension storage and Chrome Sync are not used for applicant information.
- Filling a field shares it with Iowa's website. The website can read or autosave values before you click Submit; this is why desktop approval occurs **before filling**.
- The extension is restricted to Iowa's supported HTTPS portal, requests only recognized fields on the current page, and never fills passwords, verification codes, signatures, or unknown household members.
- An encrypted backup is the portable recovery mechanism. Backups still require the original passphrase. Keep them off cloud-synced folders if you want all copies offline.
- This does not protect an unlocked computer from malware, malicious same-user processes, browser extensions reading Iowa's page, OS backups/crash dumps, or government-side storage. Read [the security design](docs/security.md).

## Project layout

| Directory | Purpose |
| --- | --- |
| `desktop/` | Electron main/preload, encrypted vault, native host, local IPC, registration |
| `renderer/` | Local desktop interface |
| `extension/` | Manifest V3 popup, worker, and conservative Iowa adapter |
| `shared/` | Validated profile/application schema and portal allowlist |
| `tests/` | Crypto, protocol, schema, and portal-adapter regression tests |
| `scripts/` | Validation, real UI smoke test, extension packaging |

## Before broader distribution

Validate each supported page against the current live portal with a consenting applicant, then expand mappings with sanitized fixtures and regression tests. Review [portal coverage](docs/iowa-portal.md) before using real data. Test the installed native host on Windows with Chrome, obtain a code-signing certificate, and complete a security review. Publishing to the Chrome Web Store requires a stable extension ID and its own store review; loading unpacked is the development/pilot path.

Official resources: [Iowa SNAP application instructions](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap), [Iowa Self-Service Portal](https://hhsservices.iowa.gov/apspssp/ssp.portal), [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
