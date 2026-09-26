# Iowa SNAP portal: coverage and validation

SecondHand 0.1 is an **experimental assisted-fill companion**, not a complete automatic SNAP application. It opens the official portal, previews a conservative set of applicant fields, requests permission from the local desktop vault, and fills those fields on the current page. The user navigates, answers other questions, reviews, signs, and submits. A local progress entry does not mean an application was submitted to Iowa.

## What was verified on September 26, 2026

The official [Iowa SNAP application guidance](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap) links to the [Iowa Self Service Portal](https://hhsservices.iowa.gov/apspssp/ssp.portal). Iowa's [personal information help page](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/enter_personal_information.htm) identifies **Enter Personal Information** as the primary-applicant page and says other family members are entered separately.

The live public portal was inspected in Chrome without an account or applicant facts:

1. **Apply for Assistance** (`#modal-btn`) opens guest/account choices.
2. **Apply as Guest** (`#modal-closeBtn`) opens `/applyForBenefits/guestLogin`.
3. That page has the heading **Household Application Information**, form `#householdApplicationForm`, and Yes/No program-intent radio controls `#householdApplyProgYes` / `#householdApplyProgNo` (name `householdApplyProg`).
4. Selecting the intent to apply for SNAP/FIP/RCA/health coverage and continuing reached `/applyForBenefits/selectHouseholdInfo`, which required a CAPTCHA. Its `captchaAnswer` input and Refresh button were observed. The user completed the CAPTCHA manually; SecondHand did not solve or bypass it.
5. The next **Before You Start...** page displayed informational slides. Its Continue button led to `/applyForBenefits/letsGetStarted`, **Let's get started**.
6. That page requires the `#termChkbox` consent to use/retrieve applicant information, including asset verification, and consent for other listed people. `#buttonContiId` (Continue) remains disabled until checked. The development inspection stopped without accepting that consent.

**The applicant page behind the portal's data-use consent has not been inspected. No applicant field IDs, exact current labels, application navigation, final submission, receipt capture, or authenticated status tracking have been validated live.** No account, invented personal information, consent attestation, signature, or submitted application was created by SecondHand. Public help may lag the current application. Completing this validation requires appropriate user authorization or an agency-provided test environment; do not use fictitious facts in the production portal.

## Implemented mapping

All mappings below are **conservative candidates tested against synthetic HTML**, not claimed captures of the post-CAPTCHA portal. The scanner requires an English heading matching `Enter Personal Information` or `Primary Applicant Information`. It stops on unknown pages; labels alone never enable filling.

| Local profile field | Exact normalized labels accepted | Additional restriction |
| --- | --- | --- |
| `firstName` | First name; Applicant first name | Primary applicant scope |
| `middleName` | Middle name; Applicant middle name | Does not substitute middle initial |
| `lastName` | Last name; Applicant last name | Primary applicant scope |
| `birthDate` | Date of birth; Birth date; Date of birth (MM/DD/YYYY) | Native date input, or explicit MM/DD/YYYY hint |
| `ssn` | Social Security number; Social Security number (SSN) | Only plain text controls; password/masked controls unsupported |
| `email` | Email address; E-mail address | Primary applicant scope |
| `phone` | Phone number; Telephone number; Primary phone number | Text/tel control, no guessing alternate numbers |
| `addressLine1` | Address line 1; Street address; Home address; Residential address line 1 | Explicit Home/Residential/Physical address group |
| `addressLine2` | Address line 2; Apartment number; Apartment / unit; Residential address line 2 | Same home-address restriction |
| `city` | City; City/town | Same home-address restriction |
| `state` | State | Same restriction; select option must match value/label (IA ↔ Iowa allowed) |
| `zip` | ZIP code; ZIP | Same home-address restriction |
| `county` | County; County of residence | Same restriction; exact select option only |

Matching normalizes whitespace, case, a trailing required asterisk, and a trailing colon. It uses associated HTML labels or ARIA names, not broad text search or inferred IDs. Each field must have exactly one safe visible match. Repeated applicant/household names, unknown groups, mailing addresses, hidden/disabled/readonly controls, covered or offscreen elements, and already-entered answers are skipped. No automatic scrolling occurs. Scroll in the portal and scan again to consider additional visible fields.

The profile may store household size, income, rent, and utilities locally, but this release does **not** automatically fill them: the question's person, time period, and meaning have not been verified. Radio buttons, checkboxes, uploads, CAPTCHA, passwords, MFA, signatures, certifications, and submit/navigation buttons are never operated.

## Local data flow

1. Opening the popup makes no portal edits and requests no profile data.
2. **Scan this page** injects packaged scripts only into the active top-level tab after checking the exact HTTPS origin and `/apspssp/ssp.portal` path boundary. Chrome grants temporary `activeTab` access; the manifest has no persistent host, storage, sync, cookie, history, or externally-connectable permission.
3. The preview lists profile field names, not values. The user selects fields and confirms they belong to the primary applicant and may be shared with Iowa HHS.
4. The service worker requests only selected fields through native host `org.secondhand.bridge`. The desktop's own approval is required. A native port keeps this request running if desktop focus closes the popup. Reopen the popup to see its result.
5. The content script checks the one-use, two-minute preview token, URL, original element identities, emptiness, and visibility again. Values exist transiently in extension memory and the portal's form. JavaScript cannot guarantee immediate memory zeroization; no applicant values are written to extension storage, logs, or a backend.
6. Progress sent back to the desktop contains the official URL without query/fragment and a filled-field count. Submission/approval is never inferred. Closed/locked desktop, denied consent, expired preview, page changes, and missing native host fail without an automatic retry.

Entering answers shares them with the government website; its scripts may save them before submission. The local-only promise concerns SecondHand's storage, not Iowa's handling of information. Chrome's own form-saving, browser sync, other extensions, and device backups are outside SecondHand's control; review those settings if they are part of your privacy requirements. The extension cannot make an online application itself offline.

## Remaining validation before treating this as a supported integration

- Inspect the real applicant page after a person completes CAPTCHA and the required data-use consent, or in an agency-provided test environment. Add sanitized, value-free fixtures and exact scope/label mapping grounded in that observation. Do not commit tokens, cookies, screenshots with applicant data, or page dumps containing personal information.
- Verify each supported field with the applicant's review, including browser masks, required formats, select values, change handlers, and duplicate household sections.
- Exercise desktop approval and native messaging in an installed Windows build with an unpacked extension and an unlocked test vault. Unit tests mock Chrome and the native transport; they do not replace this check.
- Confirm user-driven submission and receipt recording only with a consenting applicant or an agency-provided test environment. No production test submissions.
- Expand income/household/navigation/document coverage only from verified forms and explicit profile semantics. Portal changes should produce a manual fallback until reviewed.

Tests: `node --test tests/extension-*.test.cjs`. Adapter tests use jsdom with explicit simulated geometry; transport tests use a mocked MV3 worker. The public pre-CAPTCHA fixture is a minimal transcription of observed non-sensitive attributes, and the applicant fixture is explicitly synthetic.
