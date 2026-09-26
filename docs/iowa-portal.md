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
6. That page requires the `#termChkbox` consent to use/retrieve applicant information, including asset verification, and consent for other listed people. `#buttonContiId` (Continue) remains disabled until checked. The user reviewed and completed that consent in Chrome; the agent did not accept it.

After consent, the informational **Important Information when applying and what to expect**, **Instructions**, and **About you** pages were inspected. The optional **Assisting Organization or Person** question was left unanswered; Save and Continue allowed proceeding without an answer. Its name/phone controls belong to the helper, so its `#agencyDetails` form is explicitly unsupported.

The blank **Enter Personal Information** page was reached at `/applyForBenefits/enterPersonalInfo`. Its form is `#personalInformation` with action `enterPersonalInfo`. The following headings were observed: **Applicant's Information**, **Contact Information**, **Address Information**, and **Program Information**. Only schema metadata (labels, IDs, names, control types, container structure) was read. No applicant answers, tokens, cookies, or authentication values were captured. No account, invented facts, signature, or submitted application was created by SecondHand.

**The ten controls below have live-inspected DOM mappings. Filling those controls and the full application have not yet been tested in a live applicant session.** The home-address controls are initially hidden until the applicant answers the home-address question themselves. Later pages, submission, receipt capture, and authenticated status tracking remain unverified.

A read-only execution of the scanner's equivalent checks against the live blank form returned `recognizedPage: true`, five matches (`firstName`, `middleName`, `lastName`, `homePhone`, `mobilePhone`), 29 skipped controls, and zero ambiguous matches. This verified the actual ancestor headings, exact selectors, viewport/occlusion checks, and empty-field handling. Hidden home-address controls correctly remained excluded. The browser inspection API cannot clone DOM nodes; its read-only equivalent rejected labels containing nested controls instead of cloning them (the observed labels contained none). Only field names and counts were returned; no values were exported and no form was filled.

## Implemented mapping

The scanner requires the **Enter Personal Information** heading plus the exact observed form ID/action. Each control must also match its observed ID, name, type, and normalized label. The popup requests only the fields the user reviewed. The source fixture is a small sanitized transcription of observed structure, not a saved government page.

| Local field | Observed ID and name | Observed label | Restriction |
| --- | --- | --- | --- |
| `firstName` | `firstName` | First Name* | Primary applicant form only |
| `middleName` | `middleName` | Middle Name | Full middle name, no initial substitution |
| `lastName` | `lastName` | Last Name* | Primary applicant form only |
| `homePhone` | `phoneNumber` | Home Phone Number (999)999-9999 | Explicit home number, formatted to the displayed pattern |
| `mobilePhone` | `otherPhoneNumber` | Mobile Phone Number (999)999-9999 | Explicit mobile number, formatted to the displayed pattern |
| `addressLine1` | `addressLine1` | Home Address Line 1* | Must be inside `#homeAddrDiv` and visible |
| `addressLine2` | `addressLine2` | Home Address Line 2 | Same home-address restriction |
| `city` | `city` | City* | Same home-address restriction |
| `state` | `state` | State* | Same restriction; exact select option (`IA` = Iowa observed) |
| `zip` | `zipcode` | Zip Code (99999)* | Same restriction; five digits only |

Phone formatting accepts ten digits or eleven beginning with US country code 1 (including +1). Other formats are skipped. The legacy generic `phone` field is never assigned to either phone control. Maiden name and suffix are present but remain manual because they are not stored profile fields.

Matching normalizes whitespace, case, a trailing required asterisk, and a trailing colon. It uses associated HTML labels or ARIA names, not broad text search or inferred IDs. Each field must have exactly one safe visible match. Repeated applicant/household names, unknown groups, mailing addresses, hidden/disabled/readonly controls, covered or offscreen elements, and already-entered answers are skipped. No automatic scrolling occurs. Scroll in the portal and scan again to consider additional visible fields.

The profile may store birth date, SSN, email, county, household size, income, rent, and utilities locally, but this release does **not** automatically fill them: their later-page controls and contexts have not been verified. Radio buttons, checkboxes, uploads, CAPTCHA, passwords, MFA, signatures, certifications, and submit/navigation buttons are never operated.

## Local data flow

1. Opening the popup makes no portal edits and requests no profile data.
2. **Scan this page** injects packaged scripts only into the active top-level tab after checking the exact HTTPS origin and `/apspssp/ssp.portal` path boundary. Chrome grants temporary `activeTab` access; the manifest has no persistent host, storage, sync, cookie, history, or externally-connectable permission.
3. The preview lists profile field names, not values. The user selects fields and confirms they belong to the primary applicant and may be shared with Iowa HHS.
4. The service worker requests only selected fields through native host `org.secondhand.bridge`. The desktop's own approval is required. A native port keeps this request running if desktop focus closes the popup. Reopen the popup to see its result.
5. The content script checks the one-use, two-minute preview token, URL, original element identities, emptiness, and visibility again. Values exist transiently in extension memory and the portal's form. JavaScript cannot guarantee immediate memory zeroization; no applicant values are written to extension storage, logs, or a backend.
6. Progress sent back to the desktop contains the official URL without query/fragment and a filled-field count. Submission/approval is never inferred. Closed/locked desktop, denied consent, expired preview, page changes, and missing native host fail without an automatic retry.

Entering answers shares them with the government website; its scripts may save them before submission. The local-only promise concerns SecondHand's storage, not Iowa's handling of information. Chrome's own form-saving, browser sync, other extensions, and device backups are outside SecondHand's control; review those settings if they are part of your privacy requirements. The extension cannot make an online application itself offline.

## Remaining validation before treating this as a supported integration

- Recheck the inspected applicant schema in a permitted live or agency-provided test session before relying on it. Add further mappings only from sanitized, value-free observations. Never commit tokens, cookies, screenshots with applicant data, or page dumps containing personal information.
- Verify each supported field with the applicant's review, including browser masks, required formats, select values, change handlers, and duplicate household sections.
- Exercise desktop approval and native messaging in an installed Windows build with an unpacked extension and an unlocked test vault. Unit tests mock Chrome and the native transport; they do not replace this check.
- Confirm user-driven submission and receipt recording only with a consenting applicant or an agency-provided test environment. No production test submissions.
- Expand income/household/navigation/document coverage only from verified forms and explicit profile semantics. Portal changes should produce a manual fallback until reviewed.

Tests: `node --test tests/extension-*.test.cjs`. Adapter tests use jsdom with explicit simulated geometry; transport tests use a mocked MV3 worker. The public pre-CAPTCHA fixture is a minimal transcription of observed non-sensitive attributes, and the applicant fixture is a sanitized reconstruction of live-inspected structure with synthetic test values supplied only inside jsdom.
