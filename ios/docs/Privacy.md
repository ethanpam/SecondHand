# Privacy and data handling

SecondHand is a local iPhone prototype. It has no account service, backend, analytics, advertising SDK, or cloud synchronization. The user controls what to save and when to make application information available to Safari.

This document describes the intended boundaries of the checked-in implementation. Device signing, extension integration, and data lifecycle still need real-device validation before distribution.

## What is saved

The app stores the profile fields the user enters, household names and relationships, income and housing notes, renewal dates and manual statuses, confirmation details, activity records, and imported documents. It does not need an Iowa portal password or Social Security number. Avoid adding credentials to free-text notes or documents unnecessarily.

Renewal status is a personal record. Marking a task submitted or approved does not transmit information to Iowa HHS or verify the agency's decision.

## Local storage and access

The local vault and imported document contents are encrypted with AES-GCM. Encryption keys are stored in Keychain with `whenUnlockedThisDeviceOnly` accessibility. Vault files use complete file protection and are excluded from backup. The app asks for device authentication using biometrics or the device passcode before showing saved information.

Automated UI tests may use the `--ui-testing` launch argument to skip authentication only in a **Debug iOS Simulator build**. The bypass is excluded from physical-device and Release builds. Testing this path does not validate biometrics or device-passcode authentication; those checks remain pending on a real iPhone.

These protections depend on the iPhone's security and passcode. The app must decrypt data while it is being used. Encryption does not make a compromised or already-unlocked device safe, and it does not control copies the user retains outside the app.

There is no server copy or automatic recovery. Losing the device or encryption key, or deleting the saved vault, can permanently remove access to the records. A backup exclusion is intentional; this app is not a backup system.

## Document previews

Imported documents are encrypted at rest. To display a preview, the app creates a temporary decrypted file with complete file protection and cleans it up after use. A preview is therefore not encrypted by the app's AES-GCM layer while open, though iOS file protection still applies.

Importing a document does not delete the source from Files, Photos, downloads, or another provider. Removing it from SecondHand does not remove that original or any copy previously shared elsewhere.

## Safari sharing

The app and its Safari extension share an App Group and a Keychain access group. Only an explicitly enabled, encrypted application snapshot is made available to the extension, with a lifetime of at most ten minutes. The sharing confirmation identifies the categories included, including income and housing cost.

The allowed snapshot fields are:

- First, middle, and last name.
- Email and explicitly labeled home/mobile phone numbers.
- Street address, apartment/unit, city, state, and postal code.
- Monthly income and monthly housing cost, used only when the applicant explicitly maps them to website fields.

The snapshot excludes the legacy general phone number, household members, documents, notes, dates of birth, Social Security numbers, and passwords. Expiry prevents future use; an expired encrypted file can remain until it is replaced or explicitly revoked. Expiry and revocation cannot erase information already released to a page or submitted to the website.

The extension operates in one explicitly started tab on supported Iowa application routes, after Safari permission. Known applicant fields use exact form and field checks; other eligible text/select fields require the user's mapping. The extension can scroll rendered controls into view and fill empty fields. It does not handle login, verification codes, documents, eligibility answers, attestations, or signatures. Each Continue is a user action; final submission has a separate review/approval step and uses the website's normal button once.

Extension storage contains only tab ID, expiry, phase, and counts so popup closure or worker suspension does not cause an automatic retry. It contains no answers, URLs, field labels, or approval tokens. Short-lived page snapshots include current form values and markup in isolated-script memory to detect changes to the reviewed application. They are never sent to the native app or persisted by the extension.

After submission, the user may enter Iowa's confirmation number in the extension. It is written to a separate encrypted pending receipt file and imported into the app on unlock or resume, labeled as user-reported. Receipt IDs and confirmation numbers are retained in the encrypted app vault to prevent repeated imports. A click alone does not change the tracker to Submitted. This is not an agency status connection.

**Once information is filled into a government page, that page can read it.** Offline storage does not keep information private from a website after the user chooses to disclose it. Site behavior, account records, and retained submissions are governed by the receiving service.

## Reminders

Reminders are scheduled locally through iOS. Notifications use generic wording to reduce personal information on the lock screen. Device notification settings still control whether and how alerts appear. Reminders are convenience aids; the user should keep the actual notice and follow its deadlines.

## Deletion and limits

The app's deletion controls operate on SecondHand's local records, document copies, and temporary shared data. They cannot retract applications, delete an Iowa HHS account, remove website-held information, or erase originals outside the app. Do not rely on uninstalling as proof that all related copies or Keychain items have been removed; use the app's deletion controls before removal when possible.

There has been no App Store release, independent security audit, or authenticated live SNAP-case test. Before a public release, validate signed device behavior, biometrics and device-passcode authentication, deletion, backup exclusion, locked-device access, preview cleanup, extension expiration, and changes to the Iowa portal using synthetic or specifically authorized test data. Physical-device authentication and authenticated portal testing remain pending.
