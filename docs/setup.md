# Set up SecondHand

SecondHand runs on your computer. You do not need a developer account, command line, API key, or online SecondHand account to use a packaged download. Google Chrome 116 or newer is required for the companion extension.

## Install the desktop app

Download a Windows installer or Mac disk image from the [secondHand download website](https://secondhand-download.khoidoan00.chatgpt.site). No GitHub account or repository access is needed.

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
4. Keep the desktop app running and unlocked while using the extension. A SecondHand widget appears in the bottom-right corner of Iowa's portal. On the supported applicant page it shows an **Autofill** button; on other pages it is a small **s.** button that opens the side panel.

There is no extension ID to copy for the bundled extension. Preparing files does **not** install the extension in Chrome: you still complete steps 2–3 yourself. The setup screen cannot verify that you have completed Chrome's installation. Managed school or work browsers may prohibit unpacked extensions; follow that device's policy.

The prepared extension folder stays in the local SecondHand app-data directory. Do not move or delete it while Chrome uses it. **Open folder** and **Copy folder path** remain available in the desktop setup screen.

## Apply on Iowa's portal

Open [Iowa's Self-Service Portal](https://hhsservices.iowa.gov/apspssp/ssp.portal) in **Chrome**. The desktop's portal button uses your default browser, which may be different. The widget and side panel identify the current step without retrieving your saved profile. Choose the guest flow or create/sign into your own Iowa account. Complete the initial program-intent screen, verification, and data-use consent yourself.

Start the application and click **Autofill** in the widget (or **Autofill this page** in the side panel). Autofill then stays on for that tab and works screen by screen:

| Screen | What Autofill does |
| --- | --- |
| Household Application Information | Picks **Yes** when one of your saved programs (SNAP, FIP, Medicaid) is an explicit Yes, then asks you to solve the CAPTCHA and click Continue |
| Before You Start, Important Information, Instructions | Clicks Continue for you (these screens send no answers) |
| Let's get started | Waits for you to read and accept Iowa's consent |
| About you, Assisting Organization or Person | Waits for you to click Continue (leave the assisting fields blank if nobody is helping you) |
| Enter Personal Information | Fills your saved answers, then waits for you to check them and click Save and Continue |
| Any other screen | Stops: SecondHand doesn't know it yet |

After you finish a step and continue, Autofill picks up on the next screen. Click **Stop** in the widget, or **Stop autofill** in the side panel, to end it. Locking SecondHand, leaving Iowa's site, or closing the tab also ends it, and it stops after 15 automatic steps so you can check where you are.

On **Enter Personal Information**, one click fills every empty supported field from your saved profile. It also fills fields that your saved answers reveal, such as a separate mailing address. It fills explicit saved Yes/No and program choices but never infers them from your address, income, or other facts. It never changes an answer that is already on the page.

The first time, the desktop app asks before sharing your saved answers. Choose **Allow once** to be asked again next time, or **Always allow on this computer** to skip the pop-up whenever the app is unlocked. Turn that off under **Chrome extension → Let Chrome autofill without asking**. Locking the vault, manually, after 10 idle minutes, or when your computer sleeps or locks, stops autofill until you unlock again. The widget then shows **Unlock SecondHand**, which brings the app to the front.

After filling, the widget shows **Filled N** and, when something is missing, **N need you**. Click it to jump to each missing field in turn. **Details** opens the side panel, which lists each relevant question as **Done**, **Needs you**, **Optional**, or **Do it yourself**. Click a row to bring that field into view. Checkmarks describe the form's completeness, not agency approval.

SecondHand never clicks **Save and Continue**, Submit, or anything on consent, CAPTCHA, or sign-in screens. Review every answer, then continue yourself.

**Current scope is the initial applicant page:** names, suffix, maiden name, explicit home/mobile phones, home/mailing addresses and address questions, applying-for-benefits choice, saved SNAP/FIP/Medicaid choices, optional medical-bill help choice, and and best time to call. Later application pages remain manual. The helper can scroll rendered fields into view; it skips hidden, covered, ambiguous, and already-entered fields. Review every filled answer. Iowa can receive or save information as it is entered, and Save and Continue sends the page's current answers to Iowa.

Complete all unsupported steps, uploads, signatures, interviews, and final submission yourself. Save the official confirmation number in SecondHand's tracker. Saving a page is not a submitted application. The tracker is your own record, not a live agency status feed. See [verified field coverage](iowa-portal.md).

## Updates and troubleshooting

- **Upgrade to 0.4 or a new desktop version:** install it, open **Chrome extension**, choose **Refresh extension files**, then click **Reload** for SecondHand on `chrome://extensions`. Reload your Iowa tab so it uses the new helper. If Chrome asks, review and approve the updated browser-side-panel permission and site access restricted to `hhsservices.iowa.gov`. The extension ID and local folder stay the same. There is no automatic updater. Save or finish any unsaved application work before reloading; Iowa's guest flow can lose unsaved answers.
- **Helper does not appear:** confirm SecondHand is enabled at `chrome://extensions`, its Iowa site access is allowed, and you are on the official portal in Chrome. Reload the Iowa tab after installing or reloading the extension. Click the widget or the toolbar icon to open the side panel. No saved profile values are requested merely by opening it.
- **Moved the app:** prepare/refresh the extension again to update Chrome's native-host registration. On Mac, keep the app in Applications rather than running it from the mounted disk image.
- **Cannot reach the vault:** open/unlock SecondHand, refresh the extension files, reload the extension in Chrome, and try again. Only Chrome is configured by this setup; Edge and other browsers are not automatically configured.
- **Old manually unpacked copy:** remove the old copy from Chrome, then load the folder prepared by this version. The app preserves vault data when refreshing extension assets.
- **Developer/custom extension:** the collapsed advanced section accepts another extension ID. This replaces the bundled extension's allowed ID. Prepare the bundled extension again to switch back.

## How the setup works

The manifest includes a public `key` to keep the unpacked extension ID stable: `jogldddafjfbmfjnjlbjloakjbecnjpl`. The app derives that ID from the key, copies only a fixed list of shipped extension files, and registers the native host for that exact origin. The public key is an identity pin for unpacked development copies, not a secret, signing credential, or Chrome Web Store approval. An unpacked extension ID is not protection against malicious software running as the same local user. [Chrome manifest key documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key), [Chromium ID implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/id_util.cc).

Chrome's documented unpacked-install procedure requires Developer mode and a user-selected folder; the app does not modify Chrome preferences, suppress Chrome prompts, or use enterprise policy to bypass that step. [Chrome's setup instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).
