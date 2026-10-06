# Privacy and data handling

SecondHand is a local iPhone prototype. It has no account service, backend, analytics, advertising SDK, or cloud synchronization. The user controls what to save and when to make application information available to Safari.

This document describes the intended boundaries of the checked-in implementation. Device signing, extension integration, and data lifecycle still need real-device validation before distribution.

## What is saved

The app stores the profile fields the user enters, household names and relationships, income and housing notes, renewal dates and manual statuses, confirmation details, activity records, and imported documents. It does not need an Iowa portal password or Social Security number. Avoid adding credentials to free-text notes or documents unnecessarily.

Renewal status is a personal record. Marking a task submitted or approved does not transmit information to Iowa HHS or verify the agency's decision.

## Local storage and access

The local vault and imported document contents are encrypted with AES-GCM. Encryption keys are stored in Keychain with `whenUnlockedThisDeviceOnly` accessibility. Vault files use complete file protection and are excluded from backup. The app requires a user-created four-digit SecondHand PIN before showing saved information. Face ID can be enabled in Settings; cancellation, failure, or unavailability falls back to the app PIN, not the device passcode. PIN verifiers use PBKDF2-HMAC-SHA256 with 100,000 iterations and a random 32-byte salt, stored in an app-only, device-only Keychain item. Failed PIN attempts and increasing retry delays persist in that item. Existing profiles require the previous device authentication once before PIN enrollment. The app still clears its open session on backgrounding; there is no manual lock button.

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
- The applicant's saved Yes or No answer to **Do you have a home address?**, only when one is saved. It is never inferred from the address.
- Monthly income and monthly housing cost, used only when the applicant explicitly maps them to website fields.

The snapshot excludes the legacy general phone number, household members, documents, notes, dates of birth, and passwords. Expiry prevents future use; an expired encrypted file can remain until it is replaced or explicitly revoked. Expiry and revocation cannot erase information already released to a page or submitted to the website.

The extension operates in one explicitly started tab and origin, after Safari permission. Additional HTTPS websites require both an encrypted exact-origin approval and a current session explicitly enabling approved websites. Their SSN and income fields need additional site-specific sensitive-data approval. Known applicant fields use exact form and field checks; other eligible text/select fields require the user's mapping. The extension can scroll rendered controls into view, fill empty fields, and click the saved Yes or No on the unanswered home-address question. It does not answer other questions or handle login, verification codes, documents, eligibility answers, attestations, or signatures. Each Continue is a user action; final submission has a separate review/approval step and uses the website's normal button once.

Extension storage contains tab ID, expiry, phase, counts, and the session origin so popup closure or worker suspension does not cause an automatic retry. If requested, it also retains site origins and SHA-256 hashes of field context/path mapped to saved-field keys (at most 50 sites and 100 mappings per site). These hashes are not an anonymity guarantee. It contains no answers, full page URLs, raw field labels or review tokens. Approvals are stored encrypted in the shared vault. Remove or forget a site in the popup; app-side removal revokes sharing and a new approval revision prevents reuse of previous mappings. Browser-side metadata can remain until cleared from the extension. Short-lived page snapshots include current form values and markup in isolated-script memory to detect changes to the reviewed application. They are never sent to the native app or persisted by the extension.

After submission, the user may enter Iowa's confirmation number in the extension. It is written to a separate encrypted pending receipt file and imported into the app on unlock or resume, labeled as user-reported. Receipt IDs and confirmation numbers are retained in the encrypted app vault to prevent repeated imports. A click alone does not change the tracker to Submitted. This is not an agency status connection.

**Once information is filled into a government page, that page can read it.** Offline storage does not keep information private from a website after the user chooses to disclose it. Site behavior, account records, and retained submissions are governed by the receiving service.

## Reminders

Reminders are scheduled locally through iOS. Notifications use generic wording to reduce personal information on the lock screen. Device notification settings still control whether and how alerts appear. Reminders are convenience aids; the user should keep the actual notice and follow its deadlines.

## Deletion and limits

The app's deletion controls operate on SecondHand's local records, document copies, and temporary shared data. They cannot retract applications, delete an Iowa HHS account, remove website-held information, or erase originals outside the app. Do not rely on uninstalling as proof that all related copies or Keychain items have been removed; use the app's deletion controls before removal when possible.

There has been no App Store release, independent security audit, or authenticated live SNAP-case test. Before a public release, validate signed device behavior, Face ID enrollment and fallback, app-PIN setup and retry limits, migration from device authentication, deletion, backup exclusion, locked-device access, preview cleanup, extension expiration, and changes to the Iowa portal using synthetic or specifically authorized test data. Physical-device authentication and authenticated portal testing remain pending.

## Document text recognition

Camera scans are converted to PDFs in memory and saved through the encrypted document vault. Camera permission is requested only when scanning is chosen. Apple Vision reads saved images and rasterized PDF pages on-device; PDFs with a text layer are read locally. Recognition does not call a remote service. Extracted text is held in memory for review, not written to an unencrypted temporary file. Profile setup can propose taxpayer, employee, or recipient name and address fields from supported 1040/1040-SR, W-2, 1099-NEC, and SSA-1099 layouts using the bundled desktop parser. Only user-reviewed and selected values are applied to the unsaved draft; saving still requires confirmation. SSNs and labeled annual amounts are offered only when two OCR readings agree and are unchecked by default. Users may select them after review; SSNs are masked in profile and review screens until revealed. Annual entries retain their year, source, and income type, remain separate from current monthly income, and are not totaled. Both are stored in the encrypted app vault and shared with Iowa only when explicitly included in a temporary session. Home-address answers are not inferred. Closing review or locking the app clears the displayed result; cancellation stops work between pages and rejects stale results. Selecting and copying text uses the user’s standard iOS controls. Imported originals may still exist in Files or a cloud provider.


SSN and annual-income sharing: Settings offers an unchecked SSN inclusion switch and a picker for one annual record (type, amount, year, source). These choices apply to a new ten-minute session (additional sites also require explicit site approval and sensitive-data permission); revoke an active session before changing them. Safari offers SSN only for an explicitly labeled applicant/self SSN field and annual amounts/years only for corresponding annual questions. The user selects each mapping and clicks Fill; these are not verified live-page automatic mappings. No annual totals or monthly conversions are calculated. Generic ambiguous SSN fields, other-person fields, and unsupported layouts remain manual. Values are not stored in extension browser storage or displayed in popup previews. Later live Iowa pages still require verification; local synthetic tests do not establish complete portal coverage.
