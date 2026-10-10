# macOS DMG: installation, daily use, and engineering

The Mac `.dmg` is a disk image containing `SecondHand.app` and an Applications shortcut. It is an installation container, not the persistent location from which to run the app. Copy SecondHand to Applications before configuring Chrome.

The app shares its JavaScript UI, vault, document reader, and autofill implementation with Windows. Read the [shared desktop guide](desktop-common.md) for full feature instructions and the [guide index](README.md) for release/source scope.

## Contents

- [Choose the right download](#choose-the-right-download)
- [Install](#install)
- [Work with your saved data](#work-with-your-saved-data)
- [Touch ID](#touch-id)
- [Native messaging on macOS](#native-messaging-on-macos)
- [Why a window can still say Electron](#why-a-window-can-still-say-electron)
- [Build a DMG](#build-a-dmg)
- [Inspect and validate the actual bundle](#inspect-and-validate-the-actual-bundle)
- [Updates and troubleshooting](#updates-and-troubleshooting)

## Choose the right download

| Mac | Build | Typical release filename |
| --- | --- | --- |
| Apple silicon (M-series) | `arm64` | `secondHand-<version>-mac-arm64.dmg` |
| Intel | `x64` | `secondHand-<version>-mac-x64.dmg` |

Use **About This Mac** to check the processor/chip. Do not use the Intel build merely because the product version matches an Apple silicon build. An Intel build tested under Rosetta is useful evidence, but does not establish testing on physical Intel hardware.

Current packaging calls the bundle, display name, and executable **SecondHand** and uses the green mascot through a native `.icns` asset. Lowercase `secondHand` in the download filename is an artifact convention, not the Finder display name.

## Install

1. Download the matching DMG from the project's download site.
2. Open the disk image and drag **SecondHand** into **Applications**.
3. Eject the disk image.
4. Launch **Applications → SecondHand**.
5. Create the password and retain the recovery key. Only the recovery key can reset a forgotten password.
6. Save your profile or complete the guided setup.
7. Choose **Chrome extension → Prepare Chrome extension**.
8. In Chrome's extensions page, use Developer mode and **Load unpacked** to select the prepared folder. In its folder chooser, **Command–Shift–G** opens Go to Folder so you can paste the copied path.

These pilot builds are unsigned and not notarized. Verify the download source and follow appropriate macOS guidance for software you trust; this guide does not recommend disabling Gatekeeper or stripping security attributes as a routine installation step.

Running from a mounted DMG can bind native registration to a temporary location. If you already did that, move the app to Applications, reopen that copy, and prepare the Chrome extension again.

## Work with your saved data

Start SecondHand from Applications and unlock it. Edit and save profile changes before using them in Chrome. The page, not the app, controls whether entered answers are sent or autosaved. Always review the destination's form and complete protected actions yourself.

Use **Privacy & backups** to export an encrypted backup. Quitting, reopening, or updating the app is different from choosing **Start over**. Do not delete the profile folder to refresh a window or icon.

Production data normally lives in:

```text
~/Library/Application Support/SecondHand
```

The directory contains the encrypted `vault.secondhand`, configuration, prepared Chrome files, optional OS-protected recovery/unlock secrets, models, and Electron runtime state. Profile answers are encrypted, but not every cache or settings file is itself a vault. The desktop does not retain selected document originals as an encrypted document library.

## Touch ID

Touch ID is optional and off by default. On a Mac where Electron reports it available, enable **Unlock with Touch ID** under **Privacy & backups** while the app is unlocked. The feature uses an OS-protected key slot to open the same encrypted vault; it is not a separate cloud identity or a replacement for the password/recovery plan.

If Touch ID is unavailable, cancelled, or no longer able to open the saved key, use the password and review the setting. Hardware, OS availability, and the local protection state matter. Windows does not gain Windows Hello support from this code path.

The implementation lives in [touch-id.cjs](../../desktop/touch-id.cjs) and [vault.cjs](../../desktop/vault.cjs). Read the detailed [Touch ID design](../security.md#touch-id-unlock-macos) before changing enrollment, cancellation, lock, or fallback behavior.

## Native messaging on macOS

Chrome reads the native host manifest from:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/org.secondhand.bridge.json
```

In a packaged installation, registration points to the installed executable, normally:

```text
/Applications/SecondHand.app/Contents/MacOS/SecondHand
```

Chrome passes its extension origin when launching the host. The executable recognizes native-host mode, validates the origin, handles native message streams, and connects to the running app's local bridge. The app and host communicate locally rather than through a web service.

Development uses a generated launcher script that points to the development Electron executable and source directory. Preparing the extension from that copy can replace registration with the development location. Re-run preparation from the installed application when returning to the packaged app.

## Why a window can still say Electron

`npm start` or a development workflow launches the Electron distribution from `node_modules`. Its bundle identity can appear as Electron even if the window title is SecondHand. It is not the same bundle as `/Applications/SecondHand.app`.

For the packaged experience, open the installed app. Do not rename Electron inside a dependency directory or copy a development binary over the packaged app. Branding is built from the root package configuration and `desktop/icon.icns`.

If the installed app appears stale, check which bundle is running and which commit produced it. A Git pull or successful PR merge does not change `/Applications`. Refreshing Chrome also does not replace the desktop bundle.

## Build a DMG

From the complete repository on a Mac, with the root package's Node version supported (Node 24 recommended):

```sh
npm ci
npm run check
npm test
npm run dist:mac:arm64
```

For Intel only:

```sh
npm run dist:mac:x64
```

For both architectures:

```sh
npm run dist:mac
```

These commands prepare OCR resources and invoke electron-builder. They place results under `release/` and do not publish them. Packaged output commonly includes `release/mac-arm64/SecondHand.app` or `release/mac/SecondHand.app` as well as the DMG; inspect build output rather than assuming both architectures use the same intermediate folder.

`package.json` defines product name, app identifier `org.secondhand.desktop`, architecture-specific runtime exclusions, `desktop/icon.icns`, and the DMG layout. The current configuration explicitly disables signing identity, hardened runtime, and notarization. Changing that for a production release requires an actual signing/notarization workflow and credentials, not a documentation claim.

The shared mascot generator is:

```sh
swift scripts/generate-icons.swift
```

Run it from the root on macOS when intentionally refreshing branding. It generates icons for multiple platforms, then uses macOS `iconutil` to build the multi-resolution native app icon. Review all changed assets; it is not a Mac-only rewrite.

## Inspect and validate the actual bundle

For an Apple silicon package, this read-only command reports bundle metadata:

```sh
plutil -p release/mac-arm64/SecondHand.app/Contents/Info.plist
```

Check `CFBundleName`, `CFBundleDisplayName`, and `CFBundleExecutable` are SecondHand, and `CFBundleIconFile` points to the bundled mascot icon. Verify the packaged icon matches `desktop/icon.icns` if investigating a branding problem.

Use a separate synthetic test profile when exercising lock/unlock, backup/restore, OCR, and Chrome integration. The [OCR guide](../document-ocr.md) describes the packaged executable option for its smoke harness. Do not run a destructive test against a personal vault. Test the installed/mounted package in addition to development source; resource paths and native-host launch behavior differ.

A real release check includes launching from Applications, preparing Chrome, connecting while the app is open and closed, testing synthetic forms, verifying OCR assets, and checking the matching architecture. Prior development checks and earlier installer checks do not validate a newly built package automatically.

## Updates and troubleshooting

Save open work and quit the old application before replacing it. Install the new app in the same permanent location and reopen it. Refresh prepared Chrome files if needed; older extension builds may require a manual Reload in Chrome.

| Symptom | What to inspect |
| --- | --- |
| Finder/Dock says Electron | Development Electron versus the packaged Applications copy |
| Old mascot/name still visible | Actual running bundle, packaged plist/icon, and whether the new DMG was installed |
| Chrome stopped working after ejecting a DMG | Reinstall in Applications and prepare native registration again |
| App opens but extension says disconnected | Stable prepared folder, exact extension ID, native manifest, unlocked app |
| Touch ID missing | Compatible hardware and current OS availability; password remains the fallback |
| New source feature absent | Installed build provenance; rebuild/reinstall is separate from merging |
| Password unavailable | Recovery key, or restore a backup; never erase just to restart |
