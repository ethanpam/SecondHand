# Iowa SNAP portal: coverage and validation

SecondHand is an **experimental guided application companion**, not a complete automatic SNAP application. It opens the official portal, previews a conservative set of applicant fields, requests permission from the local desktop vault, and fills those fields on the current page. The user answers other questions and reviews the page. **Fill & Next** or an explicitly approved **guided autofill** session can activate the verified applicant page’s ordinary Save and Continue control after completeness checks; other steps, consent, signatures, and final submission remain manual. A local progress entry does not mean an application was submitted to Iowa.

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

Matching normalizes whitespace, case, a trailing required asterisk, and a trailing colon. It uses associated HTML labels or ARIA names, not broad text search or inferred IDs. Each field must have exactly one safe visible match. Repeated applicant/household names, unknown groups, mailing addresses, hidden/disabled/readonly controls, covered elements, and already-entered answers are skipped. Rendered fields below the viewport can appear in the preview. When filling, SecondHand scrolls the original field into view and rechecks its identity, emptiness, and visibility/occlusion immediately before writing. A field that stays hidden or covered is skipped.

The profile may store birth date, SSN, email, county, household size, income, rent, and utilities locally, but this release does **not** automatically fill them: their later-page controls and contexts have not been verified. Radio buttons, checkboxes, uploads, CAPTCHA, passwords, MFA, signatures, certifications, Save and Exit, and final submission are never operated. The one verified page-level Save and Continue control is available through Fill & Next or an approved guided session, using the same navigation checks described below.

## Guided page detection and Next

`probePage(document, url)` returns only static page identifiers, supported field names, status reasons, and counts. It identifies the observed welcome/information/assisting-person pages for guidance, but does not navigate them. Unknown pages remain manual. Visible account verification, CAPTCHA, consent, signature, and final-submission steps stop guided progression.

Only `#personalInformation[action="enterPersonalInfo"]` is eligible for Next. A second blank-page inspection verified method `post`, no `onsubmit` attribute, and one `button[type="button"].saveAndContinueButton` labeled **Save and Continue**, with inline handler exactly `submitAction('#personalInformation');`. The adapter requires those attributes, an action resolving to the observed Iowa applicant endpoint, and no target/form-action override. It clicks the actual button; it never evaluates the handler string, calls site functions directly, or uses generic form submission. Before enabling the action, the adapter requires:

- The expected applicant name and household/application choice controls are present.
- Required rendered fields are complete, including controls marked required through their visible labels or legends.
- All rendered radio questions and the program-choice group have a user-selected answer.
- No unknown controls, validation errors, duplicate mappings, or protected steps are active.

The live blank form has no HTML `required` or `aria-required` flags on its inputs; labels and question legends carry the required asterisks. A read-only check of the implemented completeness rules returned five fillable name/phone fields, two required name fields remaining, two unanswered manual groups (`hasHome` and `applicant`), a verified Next selector, and `canAdvance: false`. Home/mailing-address, program, and medical-bill controls remain conditional. The optional best-time-to-call field stays optional even though it sits inside the required program-choice fieldset. No answers were entered and the applicant Next button was not clicked during inspection.

An opaque, single-use snapshot records the exact page, form, button, and field state in content-script memory. It is never serialized to the panel or desktop. Next rechecks the snapshot, current question completeness, button identity, and visibility before clicking once. Changed answers, changed controls, an expired snapshot, or a covered button require checking the page again. **Save and Continue shares/saves the current answers with Iowa. It is not the final submission, and a successful click does not establish that the next page loaded or accepted the answers.**

## Local data flow

1. Packaged content scripts detect pages only under the official Iowa portal path in the top frame. The manifest's host permission is restricted to `https://hhsservices.iowa.gov/*` (Chrome host permissions are origin-wide); stricter runtime URL/path checks guard every operation. There are no storage, sync, cookie, history, or externally-connectable permissions.
2. Detection and the in-page guide inspect field metadata; they request no profile values. The guide runs in an extension-origin frame, separate from Iowa’s page scripts. A fresh scan previews recognized fields.
3. The user selects fields and authorizes sharing them with Iowa. The service worker requests only those fields through native host `org.secondhand.bridge`; desktop approval is also required. A native port preserves the request while the desktop approval has focus.
4. The content script checks the one-use preview token, URL, original element identities, and emptiness again. It scrolls rendered offscreen fields safely and rechecks visibility before each write. Values exist transiently in extension memory and the portal's form. JavaScript cannot guarantee immediate memory zeroization; no applicant values are written to extension storage, logs, or a backend.
5. A separate Next command uses its own opaque navigation snapshot and the allowlist above. It never fills missing answers, checks agreements, or decides program eligibility.
6. Progress sent to the desktop contains the official URL without query/fragment and a filled-field count. Submission/approval is never inferred. Closed/locked desktop, denied consent, expired previews, changed pages, and missing native host fail without an automatic retry.

Entering answers shares them with the government website; its scripts may save them before submission. The local-only promise concerns SecondHand's storage, not Iowa's handling of information. Chrome's own form-saving, browser sync, other extensions, and device backups are outside SecondHand's control; review those settings if they are part of your privacy requirements. The extension cannot make an online application itself offline.

## Remaining validation before treating this as a supported integration

- Recheck the inspected applicant schema in a permitted live or agency-provided test session before relying on it. Add further mappings only from sanitized, value-free observations. Never commit tokens, cookies, screenshots with applicant data, or page dumps containing personal information.
- Verify each supported field with the applicant's review, including browser masks, required formats, select values, change handlers, and duplicate household sections.
- Exercise desktop approval and native messaging in an installed Windows build with an unpacked extension and an unlocked test vault. Unit tests mock Chrome and the native transport; they do not replace this check.
- Confirm user-driven submission and receipt recording only with a consenting applicant or an agency-provided test environment. No production test submissions.
- Expand income/household/navigation/document coverage only from verified forms and explicit profile semantics. Portal changes should produce a manual fallback until reviewed.

Tests: `node --test tests/extension-*.test.cjs` and `npm run test:extension`. The latter loads the actual unpacked extension in isolated Chromium, intercepts every Iowa request with a synthetic fixture, and stubs only the native desktop calls. It verifies automatic panel injection, extension-frame message identity, trusted Fill & Next, overlay handling, manual/consent pauses, and lock/reapproval behavior without sending information to Iowa. Adapter tests use jsdom with explicit simulated geometry; transport tests use a mocked MV3 worker. The public pre-CAPTCHA fixture is a minimal transcription of observed non-sensitive attributes, and the applicant fixture is a sanitized reconstruction of live-inspected structure with synthetic test values supplied only inside jsdom.
