# Set up SecondHand

SecondHand runs on your computer. You do not need a developer account, command line, API key, or online SecondHand account to use a packaged download. Google Chrome is required for the companion extension.

## Install the desktop app

Download a Windows installer or Mac disk image from the [official GitHub release](https://github.com/ethanpam/secondHand/releases/latest).

- **Windows:** run the `.exe` installer and open SecondHand.
- **MacBook:** choose the Apple silicon download for an M-series Mac, or Intel for an Intel Mac. Open the `.dmg`, drag SecondHand to Applications, eject the disk image, and open the app from Applications. Move it into Applications before preparing the extension so Chrome's local connection points to a permanent app location.

These pilot downloads are unsigned; Mac builds are not Apple-notarized. Windows or macOS may show a security warning or refuse to open them. Verify the source and decide whether you trust this pilot; don't disable your device's security protections. Signed, store-reviewed distribution is still future work.

Create a local vault with a passphrase of at least 12 characters. Keep that passphrase safe: there is no online password reset. Fill in your profile; leave unknown details blank. Home and mobile phone numbers are separate fields. An “Other phone” is only a reference and is never assumed to be one of those types.

## Set up Chrome once

1. In SecondHand, choose **Chrome extension → Prepare Chrome extension**. The app copies its bundled extension into a permanent local folder, registers the matching Chrome connection, and opens the folder. Your vault is not copied into it.
2. Open Chrome. Enter `chrome://extensions` in the address bar. You can use **Copy Chrome setup address** in SecondHand.
3. Turn on **Developer mode**, choose **Load unpacked**, and select the prepared folder. Use **Copy folder path** in SecondHand to find it:
   - On Mac, press **Command + Shift + G** inside Chrome's folder chooser, paste the path, and open/select that folder.
   - On Windows, paste the path into the folder chooser's address bar, then choose **Select Folder**.
4. Use Chrome's puzzle-piece menu to pin SecondHand. Keep the desktop app running and unlocked while using the extension.

There is no extension ID to copy for the bundled extension. Preparing files does **not** install the extension in Chrome: you still complete steps 2–3 yourself. The setup screen cannot verify that you have completed Chrome's installation. Managed school or work browsers may prohibit unpacked extensions; follow that device's policy.

The prepared extension folder stays in the local SecondHand app-data directory. Do not move or delete it while Chrome uses it. **Open folder** and **Copy folder path** remain available in the desktop setup screen.

## Apply on Iowa's portal

Open [Iowa's Self-Service Portal](https://hhsservices.iowa.gov/apspssp/ssp.portal) in **Chrome**. The desktop's portal button uses your default browser, which may be different. Choose the guest flow or create/sign into your own Iowa account. Complete program selection and verification yourself.

On the supported primary applicant information page, open SecondHand in Chrome, scan the page, select the matched fields, and request filling. The desktop asks you to approve those specific fields before sharing them. Review the filled answers on the portal.

Continue the application yourself, including all unsupported questions, uploads, signatures, interviews, and final submission. Save the official confirmation number in SecondHand's tracker. The tracker is your own record, not a live agency status feed. See [verified field coverage](iowa-portal.md).

## Updates and troubleshooting

- **New desktop version:** install it, open **Chrome extension**, choose **Refresh extension files**, then click the extension's reload icon on `chrome://extensions`. Close and reopen its popup. Its ID and local folder stay the same. There is no automatic updater.
- **Moved the app:** prepare/refresh the extension again to update Chrome's native-host registration. On Mac, keep the app in Applications rather than running it from the mounted disk image.
- **Cannot reach the vault:** open/unlock SecondHand, refresh the extension files, reload the extension in Chrome, and try again. Only Chrome is configured by this setup; Edge and other browsers are not automatically configured.
- **Old manually unpacked copy:** remove the old copy from Chrome, then load the folder prepared by this version. The app preserves vault data when refreshing extension assets.
- **Developer/custom extension:** the collapsed advanced section accepts another extension ID. This replaces the bundled extension's allowed ID. Prepare the bundled extension again to switch back.

## How the setup works

The manifest includes a public `key` to keep the unpacked extension ID stable: `jogldddafjfbmfjnjlbjloakjbecnjpl`. The app derives that ID from the key, copies only a fixed list of shipped extension files, and registers the native host for that exact origin. The public key is an identity pin for unpacked development copies, not a secret, signing credential, or Chrome Web Store approval. An unpacked extension ID is not protection against malicious software running as the same local user. [Chrome manifest key documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key), [Chromium ID implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/id_util.cc).

Chrome's documented unpacked-install procedure requires Developer mode and a user-selected folder; the app does not modify Chrome preferences, suppress Chrome prompts, or use enterprise policy to bypass that step. [Chrome's setup instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).
