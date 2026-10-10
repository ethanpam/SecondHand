# Windows EXE: installation, daily use, and engineering

The Windows download is an installer for the SecondHand desktop app. It is not an application form or a standalone Chrome extension. The installer places the Electron application and its native-messaging relay on the computer; Chrome setup is a separate user step.

For detailed profile, OCR, autofill, custom-answer, and backup instructions, read the [shared desktop guide](desktop-common.md). This page covers Windows-specific behavior. The [guide index](README.md) records the source baseline; older public packages may not include everything in current source.

## Contents

- [What is in the package](#what-is-in-the-package)
- [Install and set up](#install-and-set-up)
- [Daily use](#daily-use)
- [Local storage and permissions](#local-storage-and-permissions)
- [How Chrome reaches the app](#how-chrome-reaches-the-app)
- [Build an EXE from source](#build-an-exe-from-source)
- [Validate a Windows release](#validate-a-windows-release)
- [Update and troubleshoot](#update-and-troubleshoot)

## What is in the package

| Item | Purpose |
| --- | --- |
| `secondHand-<version>-win-x64.exe` | NSIS installer produced by the release command |
| Installed `secondHand.exe` | Main Electron application; product display name is SecondHand |
| `secondHand-native.exe` | Small C# executable that Chrome uses for native messaging |
| Bundled `extension/` resources | Files copied into a stable user-data directory during extension setup |
| Bundled `ocr/` resources | PDF.js, Tesseract.js/WebAssembly, and English language data |
| ONNX Runtime dependency | Local Laya inference runtime; model files have their own download lifecycle |

The supported build target in this repository is **Windows x64**. Do not infer a Windows ARM-native installer from the presence of Mac arm64 support. The repository does not establish a tested minimum Windows release in this packaging configuration; check the Electron runtime and real target machines before making a compatibility promise.

## Install and set up

1. Visit the project's download website and choose Windows. Save the `.exe` installer from the intended release.
2. Review the pilot's unsigned-build notice. Verify the source before opening it; do not disable OS security protections to make an unknown installer run.
3. Run the installer. The current NSIS configuration is interactive rather than one-click, installs per user, allows a chosen installation directory, and creates a desktop shortcut.
4. Open **SecondHand**. Create a password and store the recovery key. Only the recovery key can reset a forgotten password.
5. Save your profile. Leave uncertain details unanswered rather than entering placeholders that could later fill a real form.
6. Open **Chrome extension → Prepare Chrome extension**.
7. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the prepared directory. Paste the copied folder path into the chooser's address bar if necessary.
8. Keep SecondHand unlocked when asking the extension to fill.

Installing the app does not install Chrome or bypass an organization's extension policy. The bundle's stable extension ID is registered automatically during preparation; you do not need to invent or manually replace it.

## Daily use

Start SecondHand and unlock it. Review **My information** whenever your circumstances change. Save before switching to a browser workflow that depends on the new answers. Use **Documents** to extract and review information from a supported local PDF/image, remembering that selected OCR candidates first enter an unsaved draft.

Open the destination form in Chrome. Approve the site and sharing scope, then choose Autofill. On general sites, Autofill handles one page; optional Fill and continue is a separate guarded navigation mode. On supported Iowa pages, verified adapters may navigate when complete. Review fills and complete credentials, verification, consent, signature, and final submission yourself.

Record the official result under Applications only after checking the website. There is no background agency-status feed. To stop for the day, save edits, lock the vault, and quit. A restart does not require deleting anything in application data.

## Local storage and permissions

Production data normally lives under `%LOCALAPPDATA%\SecondHand`. This is selected by the app rather than Electron's default roaming directory. Important files include:

- `vault.secondhand`: encrypted applicant records.
- `settings.json`: app/extension preferences, not a plaintext copy of the profile.
- `native-messaging\org.secondhand.bridge.json`: Chrome's native-host manifest.
- `chrome-extension\`: the prepared extension files.
- Model files and runtime caches used by the local app.

Do not manually edit an encrypted vault or delete this directory to troubleshoot a display problem. Use the app's encrypted export/import and recovery flows.

The installer is configured not to delete app data on uninstall. That is not a substitute for an independently retained encrypted backup; user deletion, OS reinstallation, or lost local keys can still make data unavailable.

## How Chrome reaches the app

The Chrome manifest identifies native host `org.secondhand.bridge` and permits the exact extension origin. On Windows, registration writes the manifest path into the current user's registry:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\org.secondhand.bridge
```

Chrome launches `secondHand-native.exe` beside the main executable. The relay handles Chrome's length-prefixed JSON over standard input/output and connects to the desktop's local named-pipe bridge. This avoids using the GUI Electron executable as an ordinary console relay on Windows.

The relay does not replace desktop authorization. The main app still validates the registered extension, request shape/scope, site trust, unlocked state, and required approval. A working pipe is not permission to read the entire vault.

Relevant implementation files:

- [native-launcher.cs](../../desktop/native-launcher.cs): Windows relay.
- [registration.cjs](../../desktop/registration.cjs): registry and native-host manifest setup.
- [bridge.cjs](../../desktop/bridge.cjs): transport framing and request validation.
- [build-native-host.cjs](../../scripts/build-native-host.cjs): C# compilation.
- [package.json](../../package.json): NSIS, executable names, resource inclusion, and release scripts.

## Build an EXE from source

Use a Windows build machine. The Windows build script explicitly rejects other platforms; running it on a Mac is not a supported shortcut.

Prerequisites include the complete repository, the Node version declared by the root package (Node 24 is the documented recommendation), npm, and the Windows .NET Framework compiler. The script searches `%WINDIR%\Microsoft.NET\Framework64` and `Framework` for the v4.0.30319 `csc.exe`; its error message directs missing-compiler users to enable .NET Framework 4.8.

From the repository root:

```sh
npm ci
npm run check
npm test
npm run dist:win
```

The build performs these stages:

1. Prepare OCR files and their integrity manifest under `build/ocr`.
2. Compile `desktop/native-launcher.cs` to `build/native/secondHand-native.exe`.
3. Package the app for Windows x64 with electron-builder.
4. Place the relay alongside the packaged executable and include extension/OCR resources.
5. Produce the NSIS installer in `release/`, using the filename configured in the root package.

The project is private and installers are not committed to Git. Building with `--publish never` creates local artifacts; it does not publish a download or automatically update the website.

## Validate a Windows release

Run unit/static checks, then exercise the actual Windows package on a suitable test machine. Check installation, vault creation, lock/unlock, encrypted backup, Chrome preparation, native-host startup while the app is open and closed, and a synthetic form fill. Check OCR with synthetic fixtures, not real tax documents in test output.

`npm run test:native` covers the native messaging smoke path; inspect the test's packaged/development options for the executable you are validating. The shared desktop guide lists UI, extension, OCR, and model smokes. A passing Mac build does not verify Windows DPAPI, registry registration, relay execution, or installer behavior.

## Update and troubleshoot

Install a reviewed new package, reopen the app, and refresh the bundled Chrome files if requested. Existing source describes an extension self-update flow, but old public installers may require manual **Refresh extension files** followed by Chrome's Reload action. Save or finish any active application page before reloading it.

| Problem | Likely check |
| --- | --- |
| Installer or app blocked | Source, integrity, signing status, and local device policy; do not disable protections globally |
| Chrome says host missing | Run Prepare Chrome extension from the installed app and confirm the installation has not moved |
| App works but Chrome cannot connect | Relay executable, per-user registry registration, native manifest, exact extension ID, and unlocked app |
| Building on macOS fails at native host | The script requires a Windows machine and its .NET Framework compiler |
| Profile appears missing after switching accounts | Data and device-protected secrets are per OS account; use an intentional encrypted restore |
| Windows Hello option absent | It is not implemented by the desktop Touch ID feature |
| Changes merged but installer looks old | Rebuild and distribute a package from the intended commit; Git changes do not rewrite installed files |
