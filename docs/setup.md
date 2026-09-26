# Set up SecondHand

SecondHand runs on your computer. You do not need a developer account, command line, API key, or online SecondHand account to use a packaged download. Google Chrome 116 or newer is required for the companion extension.

## Install the desktop app

Download a Windows installer or Mac disk image from the [secondHand download website](https://secondhand-download.khoidoan00.chatgpt.site). No GitHub account or repository access is needed.

- **Windows:** run the `.exe` installer and open SecondHand.
- **MacBook:** choose the Apple silicon download for an M-series Mac, or Intel for an Intel Mac. Open the `.dmg`, drag SecondHand to Applications, eject the disk image, and open the app from Applications. Move it into Applications before preparing the extension so Chrome's local connection points to a permanent app location.

These pilot downloads are unsigned; Mac builds are not Apple-notarized. Windows or macOS may show a security warning or refuse to open them. Verify the source and decide whether you trust this pilot; don't disable your device's security protections. Signed, store-reviewed distribution is still future work.

Create a password of at least 12 characters. SecondHand then shows a one-time recovery key; copy it, save it to a file, or write it down, and keep it away from the computer. If you forget your password, choose **Forgot password?** on the unlock screen and enter the recovery key. With **Let this computer reset my password** on (the default, changeable in Privacy & backups), you can also reset it on the same computer account without the key. There is no online password reset. Fill in your profile; leave unknown details blank. Home and mobile phone numbers are separate fields. An “Other phone” is only a reference and is never assumed to be one of those types.

## Set up Chrome once

1. In SecondHand, choose **Chrome extension → Prepare Chrome extension**. The app copies its bundled extension into a permanent local folder, registers the matching Chrome connection, and opens the folder. Your vault is not copied into it.
2. Open Chrome. Enter `chrome://extensions` in the address bar. You can use **Copy Chrome setup address** in SecondHand.
3. Turn on **Developer mode**, choose **Load unpacked**, and select the prepared folder. Use **Copy folder path** in SecondHand to find it:
   - On Mac, press **Command + Shift + G** inside Chrome's folder chooser, paste the path, and open/select that folder.
   - On Windows, paste the path into the folder chooser's address bar, then choose **Select Folder**.
4. Keep the desktop app running and unlocked while using the extension. An **Open assistant** button appears automatically on Iowa's supported portal. Click it, or pin and click SecondHand's toolbar icon, to open the browser side panel. Chrome requires this user click; the extension does not force the side panel open.

There is no extension ID to copy for the bundled extension. Preparing files does **not** install the extension in Chrome: you still complete steps 2–3 yourself. The setup screen cannot verify that you have completed Chrome's installation. Managed school or work browsers may prohibit unpacked extensions; follow that device's policy.

The prepared extension folder stays in the local SecondHand app-data directory. Do not move or delete it while Chrome uses it. **Open folder** and **Copy folder path** remain available in the desktop setup screen.

## Apply on Iowa's portal

Open [Iowa's Self-Service Portal](https://hhsservices.iowa.gov/apspssp/ssp.portal) in **Chrome**. The desktop's portal button uses your default browser, which may be different. Click **Open assistant** to see the checklist in Chrome’s sidebar. It identifies the current step without retrieving your saved profile. Choose the guest flow or create/sign into your own Iowa account. Complete the initial program-intent screen, verification, and data-use consent yourself.

On **Enter Personal Information**, the sidebar lists each relevant field/question with **✓ Complete**, **○ Missing required**, **Optional · blank**, or **Needs manual review**. A field row brings its verified control into view. After an approved fill, missing saved details are identified as **Missing from saved profile**. Checkmarks describe the form’s completeness, not agency approval. The separate fill list identifies controls supported for autofill. Select the fields you want to share and review the confirmation checkbox before using either page action:

- **Fill this page:** requests desktop approval for the selected fields and fills the empty supported controls. It stays on the current page.
- **Fill & Next:** requests the same field approval, fills the page, and activates its verified **Save and Continue** button only when required fields and manual questions are complete. Otherwise it pauses and explains what needs attention.
- **Start guided autofill:** opens a separate desktop approval listing the profile fields and the scope of a guided session. Approving permits supported filling and verified ordinary Next actions for up to **15 minutes**. It does not approve consent, signatures, or final submission.

Guided mode fills explicit saved details, including your saved Yes/No and program choices. It never infers those choices from your address, income, or other facts. Choices can reveal more fields; fresh scans fill those in bounded passes under the same approval. Missing required information puts the session into **Waiting for missing information**. Add the missing answers directly in Iowa’s form: the active session checks again and continues once required answers are complete. Optional fields can remain blank. Saving new answers in the desktop profile revokes the old approval, so resume with a fresh approval after profile changes. Verification, consent, signatures, review, and unsupported steps pause for user review; they never resume from page completeness alone. An expired or stopped session needs a new desktop approval.

Use **Pause automatic mode** while it is running, or **Stop guided session** when it has paused, to stop the workflow and end its approval. Locking the desktop vault also revokes approval. Stopping does not undo fields already filled or answers already saved by Iowa.

**Current scope is the initial applicant page:** names, suffix, maiden name, explicit home/mobile phones, home/mailing addresses and address questions, applying-for-benefits choice, saved SNAP/FIP/Medicaid choices, optional medical-bill help choice, and best time to call, plus the verified Save and Continue control. This development branch also selects the first verified home-address suggestion and continues, and fills the primary applicant’s saved birth date on Tell Us More. Other Tell Us More answers and its Next button stay manual, as do all other later pages. Public 0.4 installers predate these changes. The helper can scroll rendered fields into view; it skips hidden, covered, ambiguous, and already-entered fields. Review every filled answer. Iowa can receive or save information as it is entered, and Save and Continue sends the page's current answers to Iowa.

Complete all unsupported steps, uploads, signatures, interviews, and final submission yourself. Save the official confirmation number in SecondHand's tracker. A successful Next click is not a submitted application. The tracker is your own record, not a live agency status feed. See [verified field coverage](iowa-portal.md).

## Updates and troubleshooting

- **Upgrade to 0.4 or a new desktop version:** install it, open **Chrome extension**, choose **Refresh extension files**, then click **Reload** for SecondHand on `chrome://extensions`. Reload your Iowa tab so it uses the new helper. If Chrome asks, review and approve the updated browser-side-panel permission and site access restricted to `hhsservices.iowa.gov`. The extension ID and local folder stay the same. There is no automatic updater. Save or finish any unsaved application work before reloading; Iowa's guest flow can lose unsaved answers.
- **Helper does not appear:** confirm SecondHand is enabled at `chrome://extensions`, its Iowa site access is allowed, and you are on the official portal in Chrome. Reload the Iowa tab after installing or reloading the extension. Click **Open assistant** or the toolbar icon to open the sidebar. No saved profile values are requested merely by opening it.
- **Moved the app:** prepare/refresh the extension again to update Chrome's native-host registration. On Mac, keep the app in Applications rather than running it from the mounted disk image.
- **Cannot reach the vault:** open/unlock SecondHand, refresh the extension files, reload the extension in Chrome, and try again. Only Chrome is configured by this setup; Edge and other browsers are not automatically configured.
- **Old manually unpacked copy:** remove the old copy from Chrome, then load the folder prepared by this version. The app preserves vault data when refreshing extension assets.
- **Developer/custom extension:** the collapsed advanced section accepts another extension ID. This replaces the bundled extension's allowed ID. Prepare the bundled extension again to switch back.

## How the setup works

The manifest includes a public `key` to keep the unpacked extension ID stable: `jogldddafjfbmfjnjlbjloakjbecnjpl`. The app derives that ID from the key, copies only a fixed list of shipped extension files, and registers the native host for that exact origin. The public key is an identity pin for unpacked development copies, not a secret, signing credential, or Chrome Web Store approval. An unpacked extension ID is not protection against malicious software running as the same local user. [Chrome manifest key documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key), [Chromium ID implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/id_util.cc).

Chrome's documented unpacked-install procedure requires Developer mode and a user-selected folder; the app does not modify Chrome preferences, suppress Chrome prompts, or use enterprise policy to bypass that step. [Chrome's setup instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).
