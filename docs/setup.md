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
| Enter Personal Information | Fills explicit saved answers, waits for missing required answers, then uses verified Save and Continue when complete |
| Select Address (verified home-only layout) | Selects the first suggested home address, then continues; review the chosen address before submission. Mailing, county, errors, and changed layouts stay manual |
| Tell Us More (verified primary-applicant context) | Fills matching saved answers, including SSN and separate card names in their captured conditional controls. A fully recognized page may continue only after every visible question is answered, any submitted SSN matches the visible number, and no errors or dialogs remain. Missing or unknown answers and the partial birth-date-only layout stay manual |
| Captured screening and financial record forms | The six screening pages and five record scopes listed in [portal coverage](iowa-portal.md) may fill and continue when all visible supported questions are complete. Each financial release uses one explicitly owned saved record, with a desktop chooser if several match. |
| Other Iowa pages | May fill generic rule matches after desktop approval; review them and continue yourself. Unmatched or protected steps remain manual |

After you finish a step and continue, Autofill picks up on the next screen. Click **Stop** in the widget, or **Stop autofill** in the side panel, to end it. Locking SecondHand, leaving Iowa's site, or closing the tab also ends it, and it stops after 64 automatic steps so you can check where you are.

On **Enter Personal Information**, one click fills every empty supported field from your saved profile. It also fills fields that your saved answers reveal, such as a separate mailing address. It fills explicit saved Yes/No and program choices but never infers them from your address, income, or other facts. It never changes an answer that is already on the page.

The first time, the desktop app asks before sharing your saved answers. Choose **Allow once** to be asked again next time, or **Always allow on this computer** to skip the pop-up whenever the app is unlocked, on every site SecondHand is on, sensitive details such as your Social Security number, birth date, income, and citizenship and disability answers included. Turn that off under **Chrome extension → Let Chrome autofill without asking**. Locking the vault, manually, after 10 idle minutes, or when your computer sleeps or locks, stops autofill until you unlock again. The widget then shows **Unlock SecondHand**, which brings the app to the front.


After filling, the card shows a yellow **N need you** link when something is missing. Click it to jump to each missing field in turn. Click the SecondHand logo on the card to open the side panel, which shows how many answers were filled and lists each relevant question as **Done**, **Needs you**, **Optional**, or **Do it yourself**. Click a row to bring that field into view. Checkmarks describe the form's completeness, not agency approval.

Autofill can use **Save and Continue** on the verified complete applicant page, home-address confirmation, complete Tell Us More layouts, and the captured screening and financial record variants described above. It never operates consent, CAPTCHA, sign-in, signature, or final Submit controls. Iowa may save answers as they are entered or a page is continued. Review every answer and the selected address before final submission.

**The initial applicant-page mapping includes:** names, suffix, maiden name, explicit home/mobile phones, home/mailing addresses and address questions, applying-for-benefits choice, saved SNAP/FIP/Medicaid choices, optional medical-bill help choice, and best time to call. This development branch also covers the verified home-address selection and the Tell Us More answers described above. Unanswered or unknown Tell Us More controls pause continuation. The complete captured layout may continue under the checks above; the partial birth-date-only layout remains manual. Only the captured Work/self-employment, Private Pension/Social Security, rent responsibility, personal utilities, and Cash/Uncashed Check record variants are mapped. Other financial variants remain manual. Summaries, Add Another, household relationships, Other Information/legal/representative questions, and final review also remain manual. Generic rule matching may help fill other unverified Iowa pages, but it does not give those pages verified mappings or automatic Next. Public 0.4 installers predate these changes. The helper can scroll rendered fields into view; it skips hidden, covered, ambiguous, and already-entered fields. Review every filled answer. Iowa can receive or save information as it is entered, and Save and Continue sends the page's current answers to Iowa.

Complete all unsupported steps, uploads, signatures, interviews, and final submission yourself. Save the official confirmation number in SecondHand's tracker. Saving a page is not a submitted application. The tracker is your own record, not a live agency status feed. See [verified field coverage](iowa-portal.md).

## Other food-assistance forms

On another HTTPS site, open the SecondHand toolbar sidebar and choose **Turn on SecondHand for this site**. Chrome asks for that origin, then the desktop asks whether to trust it. Embedded forms need their own origin approval. Autofill fills once per click and never navigates or submits on these sites. Unless **Always allow on this computer** is on, Autofill fills everything else and leaves sensitive answers waiting in the sidebar. **Fill sensitive details** there shows their own pop-up, which also offers **Always allow on this site** to skip it on that site alone. The app lists those sites under **Chrome extension → Sites that fill sensitive details without asking**, each with **Remove**, and drops one when you turn its site off. The optional on-device AI matches question labels without receiving saved profile values; when unavailable, rule matching remains available. Turn off a site in the sidebar, which also removes its desktop trust, or remove its trust in the app.

To use SecondHand on every site at once, choose **Use SecondHand on all websites** in the sidebar. Chrome asks for access to every https site, then the desktop asks once whether to trust all websites. SecondHand's card then shows on any page with a form it can help with; search boxes, sign-in pages, and verification codes don't count. Nothing is filled until you click **Autofill**, Next and Submit stay yours, and sensitive answers wait for **Fill sensitive details** on each site unless you chose **Always allow**. Embedded forms need no separate approval while it is on.

To turn it off, choose **Turn off on all websites** in the sidebar, or **Turn off** under **All websites** on the app's **Chrome extension** page (the extension follows the next time it talks to the app). Then nothing of SecondHand runs on other sites, and the app refuses any site you haven't trusted. Iowa's portal and the sites you turned on one at a time stay on. Chrome still lists SecondHand's access to all websites until you remove it: open `chrome://extensions`, then SecondHand, then **Details**, then **Site access**. While Chrome keeps it, turning all websites on again needs no second Chrome prompt; the app still asks.

## Updates and troubleshooting

- **Update the desktop app:** install the new version and open it. The next time the extension talks to the app, for example when you open the side panel or click **Autofill**, the app refreshes its extension folder and SecondHand reloads itself in Chrome. It waits until no Autofill is on and no fill, approval, or click is under way, and while a page still shows questions that need you or answers to save, until you leave that page or close its tab. The side panel then says once that SecondHand was updated. SecondHand’s button on a form page that was open asks you to reload that page: save or finish unsaved work first, because Iowa's guest flow can lose unsaved answers. If Chrome asks, review the updated permissions. The extension ID and local folder stay the same. Keep **Developer mode** on at `chrome://extensions`: Chrome turns unpacked extensions off without it.
- **Went back to an older app:** an older app never replaces the newer extension files a newer app prepared, so SecondHand keeps the newer extension. **Refresh extension files** in the older app says so. Install the newer app again to update.
- **Update from a version without automatic updates (including public 0.4):** that extension can't update itself, so do it once by hand. Open **Chrome extension** in the app, choose **Refresh extension files**, then click **Reload** for SecondHand on `chrome://extensions`, and reload your Iowa tab. Later updates are automatic.
- **The side panel shows update steps:** if it says SecondHand couldn't update its extension files, the app couldn't write its folder. Choose **Refresh extension files** on the app's **Chrome extension** page, then click **Reload** for SecondHand on `chrome://extensions`. If it says Chrome is running a copy the app doesn't update, Chrome loads SecondHand from another folder. Remove that copy on `chrome://extensions`, then **Load unpacked** the folder from **Copy folder path**.
- **Helper does not appear:** confirm SecondHand is enabled at `chrome://extensions`, its Iowa site access is allowed, and you are on the official portal in Chrome. Reload the Iowa tab after installing or reloading the extension. Click the widget or the toolbar icon to open the side panel. No saved profile values are requested merely by opening it.
- **Moved the app:** prepare/refresh the extension again to update Chrome's native-host registration. On Mac, keep the app in Applications rather than running it from the mounted disk image.
- **Cannot reach the vault:** open/unlock SecondHand, refresh the extension files, reload the extension in Chrome, and try again. Only Chrome is configured by this setup; Edge and other browsers are not automatically configured.
- **Old manually unpacked copy:** remove the old copy from Chrome, then load the folder prepared by this version. The app preserves vault data when refreshing extension assets.
- **Developer/custom extension:** the collapsed advanced section accepts another extension ID. This replaces the bundled extension's allowed ID. Prepare the bundled extension again to switch back.

## How the setup works

The manifest includes a public `key` to keep the unpacked extension ID stable: `jogldddafjfbmfjnjlbjloakjbecnjpl`. The app derives that ID from the key, copies only a fixed list of shipped extension files, and registers the native host for that exact origin. The public key is an identity pin for unpacked development copies, not a secret, signing credential, or Chrome Web Store approval. An unpacked extension ID is not protection against malicious software running as the same local user. [Chrome manifest key documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key), [Chromium ID implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/crx_file/id_util.cc).

Updates reach the extension through the same folder. Each time the extension asks the app for its status, the app reports the extension build it ships: the `BUILD` marker in its `background.js`. If the prepared folder holds another build, the app refreshes it from its own bundle with the same fixed file list, writing `background.js` last. A newer build, prepared by a newer app, is never replaced with an older one: the app reports that build instead. When the app's build is newer than the one Chrome runs, the extension reads the build in its own folder on disk. It calls `chrome.runtime.reload()` only if that is the app's build, and only when no Autofill is on, no fill, approval, or click is under way, and no tab shows a need-you list or Save offers; otherwise it waits for the next quiet moment, or shows the steps to update by hand. It never reloads when the builds match or when its files didn't change, so it can't reload in a loop.

Chrome's documented unpacked-install procedure requires Developer mode and a user-selected folder; the app does not modify Chrome preferences, suppress Chrome prompts, or use enterprise policy to bypass that step. [Chrome's setup instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked).
