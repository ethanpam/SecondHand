# Iowa SNAP portal: coverage and validation

SecondHand is an **experimental guided application companion**, not a complete automatic SNAP application. It can fill all verified controls on the initial **Enter Personal Information** applicant page from explicit local profile answers, show a completion checklist, and use that page’s ordinary **Save and Continue** button after completeness checks. Address verification and later pages remain manual until their controls are verified. Consent, signatures, and final submission always remain manual. A local progress entry or successful Next click does not mean an application was submitted or accepted.

## Live inspection on September 26, 2026

The official [Iowa SNAP application guidance](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap) links to the [Iowa Self Service Portal](https://hhsservices.iowa.gov/apspssp/ssp.portal). Iowa’s [personal information help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/enter_personal_information.htm) identifies this as the primary-applicant page; other family members are entered separately.

The public guest flow was inspected in Chrome without an account or applicant facts. The user completed CAPTCHA and the **Let’s get started** data-use consent themselves. Information-only screens were then traversed, and the untouched optional **Assisting Organization or Person** page was skipped. Its `#agencyDetails` fields describe the helper and are deliberately unsupported. No applicant answers, tokens, cookies, or authentication values were recorded; no applicant-page Save and Continue button was clicked during development inspection.

The blank applicant page was reached at `/applyForBenefits/enterPersonalInfo`. It has `form#personalInformation[action="enterPersonalInfo"]` and headings **Applicant’s Information**, **Contact Information**, **Address Information**, and **Program Information**. A second inspection read all 29 nonhidden-type control schemas: labels, IDs, names, types, radio/checkbox option values, select options, required markers, containers, and public conditional-handler text. These represent 25 logical profile fields because each of four yes/no questions has two radio controls. Hidden session fields were excluded.

Read-only equivalent matching checks on the current blank page returned nine recognized empty fields: first, middle, and last name; suffix; maiden name; home and mobile phone; home-address question; and applicant question. The real ancestor headings and exact radio metadata matched. Home, mailing, program, medical-bill, and best-time controls were initially hidden. State, mailing-state, and suffix default selections were blank. **Actual autofill and navigation with applicant facts have not been tested against the live government portal.**

## Exact applicant mappings

Every mapping requires the observed page heading and form identity, exact ID/name/type, normalized associated label, safe ancestor headings, and a unique element. Radio and checkbox mappings additionally require the exact question legend, option value, and inline handler attribute. The adapter clicks the real allowlisted choice control; it never evaluates handler text or calls page functions directly.

| Profile key | Observed control | Required context / format |
| --- | --- | --- |
| `firstName`, `middleName`, `lastName` | Same ID and name | First Name*, Middle Name, Last Name* |
| `suffix` | `suffix` select | Exact options I, II, III, IV, V, VI, VII, VIII, IX, X, Jr., Sr. |
| `maidenName` | `maidenName` text | Maiden Name |
| `homePhone` | `phoneNumber` text | Home Phone Number (999)999-9999 |
| `mobilePhone` | `otherPhoneNumber` text | Mobile Phone Number (999)999-9999 |
| `hasHomeAddress` | `hasHome1` / `hasHome2`, name `hasHome` | Do you have a home address?*; true/false; `hideShowHome('Yes');` / `hideShowHome('No');` |
| `addressLine1`, `addressLine2`, `city`, `state`, `zip` | `addressLine1`, `addressLine2`, `city`, `state`, `zipcode` | Inside `#homeAddrDiv`; Home Address Line 1*, Home Address Line 2, City*, State*, Zip Code (99999)* |
| `mailingSameAsHome` | `sameAddress1` / `sameAddress2`, name `sameAddress` | Inside `#homeAddrDiv`; Is your mailing address the same as your home address?*; true/false; `sameAddressCheck('Yes');` / `sameAddressCheck('No');` |
| `mailingAddressLine1`, `mailingAddressLine2`, `mailingCity`, `mailingState`, `mailingZip` | Same IDs except `mailingZipcode` | Inside `#sameAdd`; Mailing Address Line 1*, Mailing Address Line 2, Mailing City*, Mailing State*, Mailing Zip Code (99999)* |
| `isApplicant` | `applicant1` / `applicant2`, name `applicant` | Are you applying for benefits?*; true/false; `checkForApplicant('Yes');` / `checkForApplicant('No');` |
| `programMedicaid` | `medicaid`, name `programs`, value `MC` | Inside `#progSelection`; Health Coverage (Medicaid or Children’s Health Insurance Program - CHIP); `showHideFA()` |
| `programSnap` | `snap`, name `programs`, value `FS` | Inside `#progSelection`; Supplemental Nutritional Assistance Program(SNAP); `showHideBestTimetoCall()` |
| `programFip` | `tanf`, name `programs`, value `CW` | Inside `#progSelection`; Family Investment Program (FIP) or Refugee Cash Assistance (RCA); `showHideBestTimetoCall()` |
| `helpPayMedicalBills` | `helpPayMedBill1` / `helpPayMedBill2`, name `helpPayMedBill` | Inside `#faDiv`; exact full question about help paying medical bills from the last three calendar months; true/false; no inline handler; optional |
| `bestContactTime` | `bestTime`, name `bestTimeToCall` | Inside `#bstTime`; Best Time to Call? (30 character limit); text, maxlength 30; optional |

All stored choices are explicit `yes` / `no` strings. Blank means unknown. A program’s explicit No leaves its unchecked box untouched; SecondHand never clears a checked program or changes a selected radio answer. It does not select SNAP merely because the application tracker says Iowa SNAP. Existing answers take precedence over automatic filling.

Both state selects expose the 50 states with two-letter values; the fixture includes a smaller IA/MN subset for isolated tests. ZIP fields accept five digits. Phone formatting accepts ten digits or eleven beginning with country code 1 (including +1), and formats `(NNN)NNN-NNNN`. The legacy generic `phone` field is never assigned a home/mobile type. Suffix must match a listed option; best time is text, not an invented time-of-day enum.

Birth date, SSN, email, county, household size, income, rent, and utilities may be stored locally but are not mapped here: this page has no verified controls for them. No later-page selectors are inferred from profile field names.

## Conditional filling and checklist

The observed handlers reveal these branches:

- Home address **Yes** shows `#homeAddrDiv`, hides mailing, and resets the same-address choice. **No** hides/clears home fields and shows `#sameAdd` mailing fields.
- Same mailing address **Yes** hides/clears mailing fields; **No** shows them.
- Applying for benefits **Yes** shows `#progSelection`; **No** hides/resets its answers.
- Selecting Medicaid shows `#faDiv`; selecting SNAP or FIP shows `#bstTime`.

SecondHand refuses a parent choice if its handler could erase already-entered dependent answers. The checklist displays a static “review existing dependent answers” message and pauses. It never resolves a conflicting answer by guessing.

A scan previews only currently rendered, editable fields. Guided mode uses bounded fresh scans under the existing 15-minute desktop approval so newly revealed fields can be filled on subsequent passes. Manual Fill requests only its original visible preview; newly revealed fields require another check/fill. No hidden values are requested by a scan. The adapter never fills a field unless it is rendered and safely accessible at the moment of writing. It scrolls offscreen controls into view and rechecks identity, emptiness, visibility, and occlusion immediately before each write or choice click.

`probePage(document, url)` exposes only static identifiers, labels, counts, and `checklist: [{key, label, status, required, fillable}]`. Status is `complete`, `missing`, `optional`, or `manual`. It shows only currently relevant visible fields; hidden branches do not appear. Required text and yes/no questions must be answered. Program checkboxes have individual statuses plus a required “Choose at least one program” group. Unchecked programs are optional, not inferred stored No answers. The known optional medical-bill and best-time questions may remain blank. Unknown controls and portal errors produce generic attention rows rather than copying labels that could contain a person’s name. No checklist contains answer values.

`focusField(document, url, key)` accepts only a known static checklist key, scrolls its verified control into view, and focuses it. It cannot accept arbitrary selectors or change an answer.

## Next and later pages

Only the applicant form is eligible for automatic Next. Live metadata verified method `post`, no `onsubmit` or target attribute, and one `button[type="button"].saveAndContinueButton` labeled **Save and Continue**, with handler exactly `submitAction('#personalInformation');`. The form action must resolve to the observed applicant endpoint, and the button must have no target/form-action override.

Next additionally requires expected core controls and all currently applicable conditional controls, complete required answers, at least one selected program when that question is shown, no unknown/invalid controls or duplicate mappings, and no protected step. The live form uses visible required asterisks rather than native `required` / `aria-required` flags; the adapter checks the observed mandatory fields as well as those markers.

An opaque, single-use navigation snapshot records the exact document, URL, form, button, and control state in content-script memory. It is never serialized to the panel or desktop. The adapter rechecks completeness, unchanged answers, original elements, expiration, and button visibility, then clicks once. **Save and Continue shares/saves answers with Iowa. It is not final submission, and a click does not prove the next page loaded or accepted the answers.**

Official [personal information help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/enter_personal_information.htm) says the next page is **Select Address**. Its [address help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/select_address.htm) describes confirming correct addresses before continuing. That help link was found through the official help table of contents, not a guessed application URL. No live address-verification controls have been reached without saving applicant facts, so SecondHand recognizes the heading and pauses with “Review and choose the correct address in Iowa’s form.” It does not select a suggested address or invent a Next selector. Other later pages similarly pause until their controls are verified. After a user completes a manual step, guided filling can resume if the following page is supported and approval remains active.

CAPTCHA, passwords, MFA, consent, signatures, certifications, uploads, review/final-submission steps, and Save and Exit are never operated automatically.

## Local data flow and validation limits

Content scripts run only in the top frame under the official Iowa portal path. Chrome’s host permission is restricted to `https://hhsservices.iowa.gov/*`; stricter runtime path checks guard every operation. The native Chrome side panel runs in the extension origin. There are no storage, sync, cookie, history, or externally-connectable permissions.

Metadata inspection requests no profile values. A selected Fill command or explicitly approved guided session requests only the scanned keys through native host `org.secondhand.bridge`. The desktop owns the encrypted vault and controls disclosure. Values exist transiently in extension memory and Iowa’s form; JavaScript cannot guarantee immediate memory zeroization. No applicant values are written to extension storage, logs, or a SecondHand backend. Progress records only the official URL without query/fragment and a filled count; submission/approval is never inferred.

Entering an answer shares it with Iowa’s website, whose scripts may save it before final submission. The local-storage promise concerns SecondHand, not Iowa’s handling, Chrome form-saving/sync, other extensions, or device backups.

Tests use [the sanitized full-page fixture](../tests/fixtures/iowa-personal-information.cjs) and [fictional QA profile](../tests/fixtures/applicant-profile.json). The fixture reconstructs observed DOM metadata and conditional behavior; it is not a saved page and contains no session material. Mock answers are used only in isolated tests. `node --test tests/extension-adapter.test.cjs` tests the complete conditional flow, missing-answer checklist, exact choice metadata, no overwrite/reset, optional questions, hidden/occluded controls, focus, and one-use Next snapshots. `npm run test:extension` loads the actual extension in isolated Chromium with all Iowa requests intercepted by synthetic fixtures and native calls stubbed; no mock answers go to the government portal.

Before treating this as a production integration, validate actual masks/change handlers and later-page coverage with a consenting applicant or agency-provided test environment, exercise the installed Windows native bridge, and verify submission/receipt recording only through user-driven submission. Never commit applicant data, cookies, tokens, or screenshots of real answers. Portal changes must fall back to manual review.
