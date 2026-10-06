# Shared desktop application: features, usage, and internals

This guide applies to both the [Windows EXE](windows-exe.md) and [Mac DMG](macos-dmg.md). They package the same Electron application. Platform differences concern installation, native messaging, OS-protected secrets, and Mac Touch ID; they are not separate implementations of the profile editor.

Read the [guide index](README.md) for the source baseline and release distinction. Current source includes broader website support and later Iowa mappings that older public installers may not contain.

## Contents

- [What the desktop app does](#what-the-desktop-app-does)
- [First launch and unlocking](#first-launch-and-unlocking)
- [Overview, profile, and local application records](#overview-profile-and-local-application-records)
- [Connect Chrome](#connect-chrome)
- [Use a supported Iowa application](#use-a-supported-iowa-application)
- [Use other websites](#use-other-websites)
- [Read a document and review extracted information](#read-a-document-and-review-extracted-information)
- [Local AI and offline operation](#local-ai-and-offline-operation)
- [Backups and recovery](#backups-and-recovery)
- [Architecture and source map](#architecture-and-source-map)
- [Development and validation](#development-and-validation)
- [Troubleshooting](#troubleshooting)

## What the desktop app does

The desktop app owns the saved profile. It collects information once, encrypts it locally, and supplies bounded answers to its Chrome extension when authorized. It also keeps local application notes, reviews information extracted from documents, and offers optional local AI assistance for questions that deterministic rules do not resolve.

It is not a browser replacement, an agency account, or an eligibility decision engine. The destination website receives values once they are filled, even before final submission. SecondHand does not control whether that website autosaves them.

## First launch and unlocking

1. Open the installed app. On first use, choose a password of at least 12 characters and confirm it.
2. Save the recovery key shown once. Keep it somewhere you can access if the computer or password becomes unavailable.
3. Review **Let this computer reset my password**. It allows the same OS account to reset the password through a locally protected secret. It is a convenience with consequences on a shared OS account.
4. Complete the guided profile setup, or skip and return later. Unknown answers should remain unanswered.
5. On later launches, use the password. Compatible Macs can enable Touch ID in **Privacy & backups** after setup.

The app locks after ten minutes of inactivity and on supported sleep/OS-lock events or exit. Locking clears the active profile UI and interrupts pending sharing. Restarting the program is different from **Start over**, which erases saved information after confirmation.

The returning-user login paragraph was removed in current source. An older installed binary can still display it until rebuilt and replaced.

## Overview, profile, and local application records

**Overview** presents setup progress and application-related next steps. Treat it as your own organizer, not an agency status screen.

In **My information**, review contact details, home and mailing addresses, household members, program choices, and supported financial information. A typed home phone is not interchangeable with a mobile phone. An unanswered Yes/No question is not automatically No. Address text does not imply an answer to whether you have a home address.

Household birth dates support age-count questions. Ambiguous ownership stays manual: the app must not infer a guardian, silently substitute a spouse's details, or assign one person's financial record to another person.

Current financial support includes explicitly owned records. Historical tax information is kept distinct from present circumstances. A prior annual amount does not establish current monthly income, employment, or eligibility. See [SNAP information model](../snap-information.md).

Choose **Save my information** to persist a draft. Reviewing or applying document candidates does not replace this explicit save. The local field-review action can flag formatting problems or contradictions, but a passed format check does not prove a detail is true or belongs to you.

Use **Applications** to keep local notes and confirmation information. Enter a confirmation only after checking the destination's result. The desktop does not poll the agency for case status.

## Connect Chrome

The packaged app contains extension files, but Chrome does not install them automatically.

1. Open **Chrome extension** in SecondHand and choose **Prepare Chrome extension**.
2. The app copies a fixed set of bundled files to a stable local directory and registers the native host for their extension ID.
3. In Chrome, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select that prepared directory.
4. Keep the directory in place. Moving it can break the installed extension.
5. Keep the desktop app open and unlocked when you want to fill forms.

The extension's current displayed name is **SecondHand**. Its ID is derived from the public manifest key, currently `jogldddafjfbmfjnjlbjloakjbecnjpl`. A display-name change does not change that identity. The key is public and is not an encryption password.

Chrome site permission and desktop trust are separate checks. Loading the extension does not grant unlimited release of profile data. Managed Chrome installations may prohibit unpacked extensions.

## Use a supported Iowa application

Open the official portal in Chrome, not merely whichever browser your OS uses by default. Complete the portal's sign-in, verification, program decisions, and consent yourself.

Choose **Autofill** when you are ready. The widget and side panel show filled fields and questions that still need you. Review every answer. SecondHand preserves already-entered values rather than treating its profile as permission to overwrite the page.

Verified Iowa adapters can continue certain complete screens: the applicant page, the captured home-address selection, supported Tell Us More layouts, and specific screening/financial record forms. They verify page structure, allowed controls, required answers, and blockers. A recognized page that no longer matches its guard can refuse filling instead of falling back to a looser rule.

A financial page receives one matching, explicitly owned record. If several records match, the desktop asks you to select one. It does not send the entire record list to the website.

Other forms can receive supported generic matches without acquiring verified Iowa navigation. Summaries, Add Another, unsupported record variants, household relationships, legal/representative questions, review, signatures, and final submission may remain manual. The [portal coverage table](../iowa-portal.md) defines the exact boundary.

Use **Stop**, lock the app, or leave the permitted context to end assistance. Automated runs have a 64-step bound. A completed step or a Save and Continue action is not a final submitted application.

## Use other websites

### Choose the access scope

For one site, open the side panel and choose **Turn on SecondHand for this site**. Grant Chrome access and review the desktop trust request. An embedded form on another origin may need separate approval.

For broader coverage, choose **Use SecondHand on all websites**. This asks Chrome for HTTPS access and separately asks the desktop to trust that scope. The card appears only when a page has a potentially supported form; search boxes, credential forms, and verification codes are not ordinary application questions.

Turning all-websites mode off unregisters its scripts and revokes desktop trust for that broad mode. Chrome may retain its browser permission until you remove it in Chrome settings. A retained browser grant alone does not re-enable filling. Individually approved sites can remain enabled.

### Choose a fill mode

| Mode | Behavior | What still needs you |
| --- | --- | --- |
| **Autofill** | One-page filling; supported optional AI assistance can participate | Review, unknown fields, and navigation |
| **Fill and continue** | Saved rule matches and exact custom answers; guarded ordinary Next/Continue | Missing answers, ambiguous controls, protected steps, and final submission |

Fill and continue is a separate user-started choice. It does not use AI guesses. It requires an authorized, unchanged page with a single acceptable Next control, valid supported required answers, and no blocking dialogs/errors or unsupported required widgets. Each navigation is consumed before the click so an uncertain result cannot silently retry the same step. Tab changes, origin changes, lock, revocation, blockers, Stop, and the step bound end the run.

The general engine supports native fields, open shadow roots, ordinary editable text, and compatible ARIA dropdown/checkbox/switch controls. Closed shadow roots, unsupported custom controls, and unclear labels can require manual input. These are conservative DOM checks, not a guarantee about arbitrary JavaScript behind a site's button.

### Understand sharing approvals

**Allow once** asks again on a later request. **Always allow on this computer** permits approved-site autofill while the app is unlocked, including sensitive answers. On other sites, **Fill sensitive details** offers a separate approval; **Always allow on this site** can remember that choice for one site. Review and remove remembered sites in the desktop's Chrome extension view.

Passwords, verification codes, signatures, consent, and final submission are not ordinary reusable profile answers. Sensitive approval does not remove those exclusions.

### Save recurring custom answers

Under **My information → Custom answers**, save an exact question label and answer. You can keep up to 50 answers, with up to five explicit aliases each; labels/aliases are limited to 120 characters and answers to 1,000. Save the profile after editing.

Matching normalizes case, extra spaces, and trailing colon/required markers; it does not infer arbitrary semantic equivalents. Conflicting matches, protected questions, another person's context, or incompatible choices remain manual. Custom answers are encrypted and excluded from Laya prompts. Those about a sensitive subject wait for **Fill sensitive details** unless Always allow covers the site; the others follow the ordinary approval.

After Autofill on another website, the side panel's **Remember for next time** keeps an answer you gave to an open question as a custom answer, after the app's confirmation. It keeps the question's kind of box, its choices, and the site it came from, and fills only that same question.

For supported missing profile values entered on a site, **Save to My information** is a separate user action and requires desktop review. It is not background capture of everything typed into a page.

## Read a document and review extracted information

1. In **Documents**, select a PDF, PNG, or JPEG.
2. Wait for local reading, or choose **Cancel reading**. A late result after cancellation or lock is discarded.
3. Compare extracted text and proposed details with the original.
4. Edit and select only details you want to use. A supported form can still yield partial or incorrect results.
5. Apply selected details to the profile draft, review the draft, and explicitly save it.

The desktop accepts up to 30 MiB and 12 PDF pages. English OCR assets are bundled. Current structured layouts include 1040/1040-SR, W-2, SSA-1099, and 1099-NEC, with conservative rules separating applicant, employer/payer, and other household information. Identifier/amount disagreements between OCR passes are omitted. Generic recipient TINs are not assumed to be personal SSNs.

Historical amounts retain their year/source context and require their own review. They are not divided by twelve or silently turned into current benefits answers. Combined names are not blindly split. Unsupported layouts can provide plain text without structured suggestions.

Unlike the mobile apps, desktop does not keep a copied original in an encrypted document library. It reads the file where you selected it, clears temporary review state when discarded/left/locked, and saves only approved profile information through the normal workflow. The original remains subject to its folder's permissions and backups.

**Check extracted fields** runs local validation again after corrections. Optional experimental Laya review compares eligible printed labels with field mappings; it does not verify digits, identity, ownership, or currentness. See [OCR limits](../document-ocr.md) and [field review](../field-review.md).

## Local AI and offline operation

Laya runs through ONNX Runtime on the computer's CPU. While enabled, the app downloads the roughly 429 MB model and checks for updated model metadata. Downloading the model is separate from transmitting applicant information: inference remains local.

Deterministic rules work without Laya. Supported high-confidence model answers are marked for review; eligible non-sensitive general-site choice questions can also receive explicitly marked lower-confidence guesses. Iowa and protected/sensitive cases have stricter boundaries. A marked guess is not a verified answer. Fill and continue excludes model guesses entirely.

Chrome's local translation/summarization features also depend on browser support and resource availability. Do not promise that every installation has them ready offline.

Editing saved data and bundled OCR can work offline. Visiting a destination website and downloading models require connectivity. No SecondHand backend is needed to unlock the vault.

## Backups and recovery

Use **Privacy & backups** to export an encrypted backup before changing computers or performing destructive resets. Restoring uses the locked-vault flow and explicit replacement confirmation. The backup uses the password/recovery slots present when it was exported; changing a later password or recovery key does not rewrite an old exported file.

If the password is lost, use the recovery key or the same-account device-reset option if previously enabled. Without an available recovery path, SecondHand cannot recover the encrypted information. **Start over** is not a password-reset shortcut that preserves the profile.

## Architecture and source map

| Layer | Main files | Responsibility |
| --- | --- | --- |
| Electron main | [main.cjs](../../desktop/main.cjs) | Window lifecycle, lock state, approval dialogs, IPC, native requests |
| Renderer boundary | [preload.cjs](../../desktop/preload.cjs) | Narrow API exposed to the isolated renderer |
| Desktop UI | [app.js](../../renderer/app.js), [index.html](../../renderer/index.html), [styles.css](../../renderer/styles.css) | Forms, drafts, review, navigation, and lock-screen states |
| Encrypted storage | [vault.cjs](../../desktop/vault.cjs) | Envelope validation, key slots, authentication, serialized atomic writes |
| Native transport | [bridge.cjs](../../desktop/bridge.cjs), [registration.cjs](../../desktop/registration.cjs) | Framed Chrome messages, local socket/pipe, registered origin |
| Extension lifecycle | [extension-setup.cjs](../../desktop/extension-setup.cjs), [background.js](../../extension/background.js) | Bundled-file preparation, trusted-site requests, browser coordination |
| Page interpretation | [generic-adapter.js](../../extension/generic-adapter.js), [iowa-adapter.js](../../extension/iowa-adapter.js) | Field identification and guarded page-specific behavior |
| Later Iowa records | [iowa-record-adapter.js](../../extension/iowa-record-adapter.js), [record-fields.cjs](../../desktop/record-fields.cjs) | Captured record pages and bounded native release |
| Shared data | [schema.cjs](../../shared/schema.cjs), [household.cjs](../../shared/household.cjs) | Validation, explicit field semantics, age counts |
| OCR | [ocr-service.cjs](../../desktop/ocr-service.cjs), [ocr-engine.cjs](../../desktop/ocr-engine.cjs), [document-parser.cjs](../../shared/document-parser.cjs) | File reading, isolated recognition, bounded extraction |
| Local model | [laya.cjs](../../desktop/laya.cjs), [laya-worker.cjs](../../desktop/laya-worker.cjs) | Model inference and worker lifecycle |

A fill travels from page detection to extension worker, through Chrome native messaging, into a registered local relay/host, and then to the unlocked app's bridge. The desktop validates origin, requested field scope, current access state, and approvals before returning bounded values. The page engine rechecks the target controls before applying them.

The main BrowserWindow has context isolation and sandboxing enabled, with renderer Node integration disabled. The bridge is a local socket/named pipe, not an HTTP server. Messages are length-prefixed and bounded to 64 KiB. The vault uses AES-256-GCM and password-derived scrypt wrapping; optional device and Touch ID slots depend on OS-protected local secrets. See the security design before modifying these boundaries.

## Development and validation

From the repository root, use Node 22.12 or newer as declared by the package, with Node 24 recommended:

```sh
npm ci
npm run check
npm test
npm start
```

`npm start` prepares bundled OCR assets before launching development Electron. `npm run dev` adds the development reload/browser workflow; install Playwright Chromium first if needed. Development may identify the process as Electron even when the packaged app is SecondHand.

Use focused checks for the area changed:

```sh
npm run test:ui
npm run test:extension
npm run test:native
npm run test:ocr
npm run test:ocr:ui
npm run test:laya
```

These have different runtime prerequisites. Native/app/browser smokes need usable Electron/browser environments; model smokes need their model prerequisites. Use synthetic profiles and documents. Do not turn a fixture replay into an unsolicited real application submission.

The hosted CI workflow was removed. Contributors run relevant commands locally and record their actual results. An extension change also requires matching, newer `BUILD` values in `extension/background.js` and `extension/panel.js`; `npm run check` checks that against the branch's merge base with `origin/main`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Chrome cannot connect | Installed app location, prepared extension folder, matching ID, native registration, and unlocked app |
| No card on a general site | HTTPS, Chrome permission, desktop trust, and a supported form; some custom/closed-shadow controls cannot be recognized |
| A value remains blank | Saved profile, explicit answer, supported field, current person's context, sensitivity approval, existing page value |
| Next stops | Required answers, page errors, dialogs, unsupported widgets, guessed answers, and protected steps |
| OCR yields partial information | Supported layout, page/file limits, scan quality, pass disagreement; compare with the original |
| A source change is missing from the app | Confirm the installed artifact was rebuilt from that revision; a Git pull does not modify an installed bundle |
| Extension shows old branding | Refresh prepared files and reload the extension; do not assume a copied demo folder updates with the repo |
| Lost password | Recovery key or previously enabled device reset; do not erase data merely to restart the app |
