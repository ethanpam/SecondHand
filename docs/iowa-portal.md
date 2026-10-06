# Iowa SNAP portal: coverage and validation

SecondHand is an **experimental application companion**, not a complete automatic SNAP application. It can fill all verified controls on the initial **Enter Personal Information** applicant page from explicit local profile answers, show a completion checklist, and use that page’s ordinary **Save and Continue** button after completeness checks. This development branch also selects the first suggested home address on the observed **Select Address** step, then continues, and fills the primary applicant’s saved birth date on the verified **Tell Us More** page, plus saved answers on the fully captured `dynamicQuestionsStart` and legacy `dynamicQuestions` layouts. Separate captured screening and person-owned financial forms have the bounded coverage below. Missing answers stay with the applicant. The captured Tell Us More layout may use ordinary Save and Continue only after every visible question is recognized and answered; its partial birth-date-only layout remains manual. Separate mailing confirmation, county questions, and all unverified later-page navigation remain manual. The generic engine may fill rule-matched fields on other unverified pages; that is not verified Iowa page coverage. Consent, signatures, and final submission always remain manual. A local progress entry or successful Next click does not mean an application was submitted or accepted. Public 0.4 downloads predate these address and birth-date changes.


## Live inspection on September 26, 2026

The official [Iowa SNAP application guidance](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap) links to the [Iowa Self Service Portal](https://hhsservices.iowa.gov/apspssp/ssp.portal). Iowa’s [personal information help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/enter_personal_information.htm) identifies this as the primary-applicant page; other family members are entered separately.

The initial public guest inspection was conducted in Chrome without an account or applicant facts. The user completed CAPTCHA and the **Let’s get started** data-use consent themselves. Information-only screens were then traversed, and the untouched optional **Assisting Organization or Person** page was skipped. Its `#agencyDetails` fields describe the helper and are deliberately unsupported. No applicant answers, tokens, cookies, or authentication values were recorded; no applicant-page Save and Continue button was clicked during development inspection.

The blank applicant page was reached at `/applyForBenefits/enterPersonalInfo`. It has `form#personalInformation[action="enterPersonalInfo"]` and headings **Applicant’s Information**, **Contact Information**, **Address Information**, and **Program Information**. A second inspection read all 29 nonhidden-type control schemas: labels, IDs, names, types, radio/checkbox option values, select options, required markers, containers, and public conditional-handler text. These represent 25 logical profile fields because each of four yes/no questions has two radio controls. Hidden session fields were excluded.

Read-only equivalent matching checks on the current blank page returned nine recognized empty fields: first, middle, and last name; suffix; maiden name; home and mobile phone; home-address question; and applicant question. The real ancestor headings and exact radio metadata matched. Home, mailing, program, medical-bill, and best-time controls were initially hidden. State, mailing-state, and suffix default selections were blank. **The extension itself has been tested in isolated Chromium; live navigation described below was performed by the operator, not the extension.**

A later read-only inspection of the user-opened **Select Address** page verified the home-suggestion radio group, separate original-address option, county rows, errors, hidden modal, and ordinary Next handler. The page contained one home suggestion. No choice or Next button was clicked during that inspection. The sanitized address fixture reconstructs this structure using the campus location supplied for QA; it contains no session material. Multiple-suggestion variants are generated test cases, not additional live observations.

Later the same day, the user explicitly authorized a fictional live guest draft after being told that ordinary **Save and Continue** sends and may save each page. The operator completed one single-adult SNAP path through **E-Signature**, using the supplied public campus test address. The signature checkbox remained unchecked, the name remained blank, and **Submit Application** remained disabled. No final submission or certification occurred. The [sanitized journey record](iowa-live-journey.md) lists the observed pages and limits. This was a separate manual inspection, not proof that the extension automatically completes all pages or household branches.

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

Birth date, SSN, email, county, household size, income, rent, and utilities are not mapped on the initial applicant page. Birth date and SSN have the separate mappings below; other saved fields are preparation information unless an exact question-level rule applies. No later-page selectors are inferred from profile field names.

## Primary applicant birth date

The optional **Tell Us More** mapping requires the exact `/applyForBenefits/dynamicQuestions` route, visible heading and self-information introduction, **Start Application | Active** and **People | Unvisited** breadcrumbs, and the observed `form#answerSet` posting to `simple`. It recognizes only `#question02419` with `input#answerSets0.answers3.answerValue`, name `answerSets[0].answers[3].answerValue`, label **Date of Birth (mm/dd/yyyy)**, and the observed date-input metadata. The two alternate birth-date templates must remain hidden. The primary-applicant heading and original elements are held in a private in-memory fingerprint and rechecked before filling; the name is never sent to the sidebar.

A valid saved `birthDate` in `YYYY-MM-DD` format becomes `MM/DD/YYYY`. Blank, invalid, future, hidden, changed, or already-filled fields are skipped. No age or date is inferred. The checklist uses static labels for the remaining manual questions and **Next is always manual on this page**, even after birth date fills. Citizenship, gender, SSN, disability, and other answers are not mapped or defaulted. This adds one profile key to the existing 25 applicant-page keys; it does not widen the initial page’s selectors.

## Complete Tell Us More layouts

Tell Us More is also served at `/applyForBenefits/dynamicQuestionsStart` with other questions shown. It needs the same checks as the layout above (exact route, heading, introduction, breadcrumbs, and `form#answerSet`), plus the applicant’s name group directly above a single question panel, no disabled template question on screen, and one visible birth-date box. Each question is checked on its own against the recorded page (trimmed in `tests/fixtures/iowa-tell-us-more.html`): its id and class, its wording, and each control’s id, name, value, label, and `hideShowQuestions` handler. A question that differs is left for the applicant.

Each question fills from the applicant’s own answer, saved under **About you** in My information. Blank means not saved, never No. Where no answer of the applicant’s is saved, a household answer fills a question only when it settles it.

| Question | Filled from | Household answer used only when the applicant’s is blank |
| --- | --- | --- |
| Are you male or female? (`#question02418`) | `sex`: **Male** or **Female** | none |
| Date of Birth (`#question02`, `answerSets[0].answers[5].answerValue`) | `birthDate`, as `MM/DD/YYYY` | none |
| Do you have a Social Security Number? (`#question02420`) | `hasSsn`, which the desktop works out as `yes` when an SSN is saved, otherwise the saved `hasSsnAnswer` | none |
| Social Security Number (`#question03`, visible `input#answerSets0.answers8.answerValue`) | `ssn`, only after the verified **Yes** answer; review in Iowa’s form remains required | none |
| Is the first and last name you provided the same name that appears on your Social Security card? (`#question04068`, shown by Iowa after **Yes** to having a number) | `ssnCardNameMatches` | none |
| First, middle, and last name on the Social Security card (`#question04070`, `#question04071`, `#question04072`; answer indexes `12`, `15`, `16`) | Separate `ssnCardFirstName`, `ssnCardMiddleName`, `ssnCardLastName`; only after **Yes** to having an SSN and **No** to the name-match question | none; ordinary saved names are never substituted |
| Are you a U.S. Citizen or National? (`#question06001`) | `usCitizen` | `householdAllCitizens` is `yes`: **Yes** |
| Were you born in the U.S.? (`#question06181`, answer index `21`) | `bornInUs`, only after the captured citizenship **Yes** branch reveals it | none; citizenship never implies birthplace |
| Marital Status (`#question04`, a list) | `maritalStatus`, one of Iowa’s six choices | none |
| Are you in the military, a veteran, or a spouse of a veteran? (`#question01007331`) | `militaryOrVeteran` | none: a household answer about veterans doesn’t cover a spouse of a veteran |
| Do you eat with the household? (`#question02422`, answer index `25`) | `eatsMealsWithHousehold`, only when Iowa actually renders the captured question without `disabledQuestion` | none |
| Are you Disabled? (`#question07`) | `disabled` | `householdDisability` is `no`: **No** |
| Are you Blind? (`#question0565`) | `blind` | none |
| Do you have a physical, mental, or emotional health condition … or live in a medical facility or nursing home? (`#question01000031`) | `healthLimitation` | none |
| Do you have Medicare? (`#question01000414`) | `medicare` | `householdMedicare` is `no`: **No** |

A question with nothing saved stays for the applicant; after Autofill its checklist row says it isn’t saved and points to My information. Radios are clicked and the marital status is chosen one question at a time, so Iowa’s own scripts run, and the page is verified again before each one. Newly revealed controls need a fresh scan on the next Autofill pass. The exact captured optional card middle-name field may remain blank. Other visible known questions need an answer before automatic Continue. Answers already on the page are never changed. Ordinary **Save and Continue** is eligible only after every visible question has exact known controls and a complete answer. Newly revealed, unknown, or unanswered controls pause continuation, even if some saved answers have filled.

The captured SSN control is a visible `tel` input without a submission name, paired with a hidden text input named `answerSets[0].answers[8].answerValue`. SecondHand fills only the verified visible blank input, dispatching input/change events. It never writes the hidden mirror, and it skips the visible input if either field already contains an answer. The capture does not establish Iowa’s external masking implementation. Continuation therefore requires the visible number and the exact, enabled, submittable hidden mirror to each contain a valid number with the same nine digits. An empty, mismatched, disabled, or malformed mirror keeps the SSN in **manual review** and prevents automatic Continue. The adapter only checks that state; it never synchronizes or writes the hidden answer. Invalid number shapes and overlong card names are skipped; no number or name appears in checklist metadata. Hidden alternatives, unexpected labels/handlers, duplicate IDs, changed applicant context, and changed parent answers are rejected.

The ordinary next control must be the recorded `button#dqButtonId309`, with its exact Save and Continue label, classes, title, and `dynamicQuestionsButton` handler targeting `simple?buttonId=309`. A private single-use snapshot binds the exact document, URL, applicant context, form, button, visible questions, and control values. The adapter rechecks that snapshot, all known answers, visibility, and page errors/dialogs immediately before one click; the worker also checks a current unlocked desktop authorization. Unknown question groups, visible alternative templates, consent, signatures, certification, review, and final-submission controls block it. The `dynamicQuestionsStart` Female/pregnancy branch remains manual because its follow-ups have not been verified for navigation. A separate full legacy `dynamicQuestions` capture supports Female → pregnancy, including explicit due date and number of expected babies when Yes; its exact controls are in `tests/fixtures/iowa-tell-us-more-legacy-live.cjs`. No due date or count is inferred. The older partial DOB fixture remains manual. A Yes to citizenship needs the exact captured birthplace follow-up answered; an unknown follow-up pauses the page. This does not widen the partial `dynamicQuestions` birth-date fixture into a complete page mapping.

## Iowa-only question matching on other pages

The general parser also recognizes a bounded set of complete, unambiguous Yes/No questions on the official Iowa portal. This is question-level matching, **not verified later-page coverage or navigation**. The question must match an exact supported phrase, retain every qualification, and offer exactly **Yes** and **No**. Blank saved answers never become No. The parser checks the page and control context again before filling; changed labels/options, person selectors, duplicate questions, hidden controls, and helper/employer/other-person contexts pause filling. These new keys are excluded from general-site, model-guess, and Save-to-My-information lists.

Supported independent household topics are school/college attendance, strike status, work/planned work/self-employment, a job ending in the last 30 days, money from friends/relatives, educational grants/loans, dependent care, housing, subsidized housing, child support, utilities, energy assistance in the past year, medical/Medicare expenses, real/personal property, trusts, property transfers in the past 90 days, vehicles, shared resources, aging out of foster care, homelessness, Iowa EBT, and benefits from another state. A topical mention or a shortened version of a longer question does not match.

On the shared `/applyForBenefits/dynamicQuestions` route, the strict captured adapters now take precedence for **Job Information**, **Income Information**, **Expenses Information**, and **Property Information**. A recognizable heading with incomplete or changed metadata returns an explicit manual instruction and cannot fall through to generic rules or model guesses. The generic library’s question rules do not override that boundary. Unknown headings, Tell Us More, altered forms, person selection, helper/employer context, and certification controls retain their separate guards. Generic matching alone never authorizes Next. Pages recorded only by question indexes or paraphrased topics do not acquire mappings.

The applicant’s own residency, U.S. birthplace, naturalized citizenship, interpreter need, meal purchase/preparation, pregnancy, and migrant/seasonal farmworker answers additionally require the recorded self-information introduction with **Start Application | Active** and **People | Unvisited**. Personal Iowa residency uses the explicit saved answer; home-address state never settles it. No new model guesses are used for these questions.

Outside the exact captured scopes below, combined questions, ambiguous **How much**/**How often** controls, helpers, representatives, and unverified household-member pages remain manual. Saving a detail does not itself create a mapping. Other Information at `dynamicQuestionsResume`, including legal and representative questions, has no new automatic adapter. Consent, legal certifications, signatures, and final submission always remain human actions.

## Captured later screening and financial records

On October 6, 2026, the operator manually traversed a fictional single-adult SNAP draft through Work/non-self-employment, Private Pension, rent, utilities, and cash, inspected additional Social Security, self-employment, and pregnancy branches, and stopped at the Submit Application introduction before signing or submitting. The extension was off during this inspection. The later layouts were inspected manually in this separately authorized fictional guest draft. The operator’s live inspection established control metadata; it did not demonstrate extension-driven completion. Sanitized fixtures reconstruct that metadata with synthetic handlers and fictional answers. Automated tests use isolated documents and do not send fixture answers to Iowa.

`iowa-later-adapter.js` supports six exact scalar layouts. All require the captured heading, phase, form, question wording, controls, and ordinary Next handler; unknown controls, follow-ups, errors, dialogs, consent, and signatures pause navigation.

| Page | Captured scope and limits |
| --- | --- |
| Emergency SNAP screening | Four explicit household threshold/comparison answers; no calculation from saved income or money |
| Background Information (`ssaVerificationRender`) | Iowa residency, migrant/seasonal status, language and rendered language-help question, naturalization, birthplace state, and race. This URL is the observed Background Information form; the name does not authorize an identity-verification submission. Uncaptured naturalization or race follow-ups stay manual |
| Job Information | Explicit household school/college, strike, work/planned work/self-employment, and recent job-ending answers |
| Income Information | Exact grouped household income questions and expected-change answer; no inference from job or tax records |
| Expenses Information | Exact household screening questions, including separate current-address energy assistance and uncovered aged/disabled medical costs |
| Property Information | Exact household screening questions, including separate own-or-buy property, conservatorship-or-trust, and owned-or-registered vehicle answers; older narrower answers are not migrated |

`iowa-record-adapter.js` uses a separate, fixed `getRecordFields` request for the following `dynamicQuestions` layouts. Ordinary `getFields` cannot request any list. Every record needs an explicit person. If the page already selects a person, the app filters to that exact normalized name; otherwise the user chooses among explicitly owned records. Multiple candidates always require a desktop chooser. The browser then requires one unique matching person option and preserves any existing owner or conflicting answer.

| Captured record page | Allowed local record and fields |
| --- | --- |
| Job and Job History | One `jobs` Work record: owner, work/training choice, start date, employer, job title, explicit monthly hours, gross pay and frequency, tips/commissions, income-expected-same, and three explicit recent-change answers. Captured self-employment Yes uses separate monthly net income, Monthly frequency, and business-expense answer. Gross pay, weekly hours, and annual tax amounts are never converted. Training stays manual |
| Retirement income | One `otherIncomeSources` record of exact type **Private Pension** or **Social Security**: person, type, current amount, frequency. No payer, dates, or SSA-1099 annual values are released |
| Housing expense | One `housingExpenses` record of type **Rent**, or the exact responsibility-label alias: person, type, amount the person is responsible for, frequency. Household rent totals are not substituted |
| Utility expenses | One `utilityExpenses` record: person plus explicit Yes/No for gas, electricity, water/sewage, telephone, pet fees, garage rent, landlord extra charges, garbage, heating/cooling. Household utility scalars do not assign expenses to a person |
| Liquid assets | One `assets` record of exact type **Cash/Uncashed Check**: person, type, current value, and only explicitly saved amount owed, account/reference, institution, acquired date. Optional blanks remain blank; no zero, date, owner, or shared interest is inferred |

Only requested fields from the selected record reach the private content-script fill path. The entire list, local chooser labels, unrelated fields, tax statements, and model inferences are excluded. A missing record returns an empty result and pauses. Lock, profile edits, changed connection/trust, a changed document/person/answer, or a stale one-use snapshot prevents the authorized fill or Next. Checklist metadata never includes owners, employers, amounts, or account references. Continuation requires all visible questions to be supported and complete; unchecked change or utility boxes do not imply No.

Summaries, **Add Another Entry**, household relationships, Other Information/legal/representative questions, final review, and all uncaptured financial variants remain manual. Each run is bounded and cannot sign, certify, consent, or submit the application.

## Conditional filling and checklist

The observed handlers reveal these branches:

- Home address **Yes** shows `#homeAddrDiv`, hides mailing, and resets the same-address choice. **No** hides/clears home fields and shows `#sameAdd` mailing fields.
- Same mailing address **Yes** hides/clears mailing fields; **No** shows them.
- Applying for benefits **Yes** shows `#progSelection`; **No** hides/resets its answers.
- Selecting Medicaid shows `#faDiv`; selecting SNAP or FIP shows `#bstTime`.

SecondHand refuses a parent choice if its handler could erase already-entered dependent answers. The checklist displays a static “review existing dependent answers” message and pauses. It never resolves a conflicting answer by guessing.

A scan previews only currently rendered, editable fields. One Autofill click requests every mapped scalar key once, then fills in at most four fresh-preview passes. Financial record pages request one selected record and use at most six fresh-preview passes. Fields revealed by an earlier answer can therefore fill without another desktop value request. Each pass fills only fields that are rendered at that moment. The adapter never fills a field unless it is rendered and safely accessible at the moment of writing. It scrolls offscreen controls into view and rechecks identity, emptiness, visibility, and occlusion immediately before each write or choice click.

`probePage(document, url)` exposes only static identifiers, labels, counts, and `checklist: [{key, label, status, required, fillable}]`. Status is `complete`, `missing`, `optional`, or `manual`. It shows only currently relevant visible fields; hidden branches do not appear. Required text and yes/no questions must be answered. Program checkboxes have individual statuses plus a required “Choose at least one program” group. Unchecked programs are optional, not inferred stored No answers. The known optional medical-bill and best-time questions may remain blank. Unknown controls and portal errors produce generic attention rows rather than copying labels that could contain a person’s name. No checklist contains answer values.

`focusField(document, url, key)` accepts only a known static checklist key, scrolls its verified control into view, and focuses it. It cannot accept arbitrary selectors or change an answer.

## Next and later pages

The applicant form, verified home-address confirmation structure, complete captured Tell Us More layouts, and exact screening/financial variants above are eligible for automatic Next under their separate checks. Completeness checks do not establish the truth of an answer. On the applicant page, live metadata verified method `post`, no `onsubmit` or target attribute, and one `button[type="button"].saveAndContinueButton` labeled **Save and Continue**, with handler exactly `submitAction('#personalInformation');`. The form action must resolve to the observed applicant endpoint, and the button must have no target/form-action override.

On the initial applicant page, Next additionally requires expected core controls and all currently applicable conditional controls, complete required answers, at least one selected program when that question is shown, no unknown/invalid controls or duplicate mappings, and no protected step. The live form uses visible required asterisks rather than native `required` / `aria-required` flags; the adapter checks the observed mandatory fields as well as those markers.

An opaque, single-use navigation snapshot records the exact document, URL, form, button, and control state in content-script memory. It is never serialized to the panel or desktop. The adapter rechecks completeness, unchanged answers, original elements, expiration, and button visibility, then clicks once. **Save and Continue shares/saves answers with Iowa. It is not final submission, and a click does not prove the next page loaded or accepted the answers.**

Official [personal information help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/enter_personal_information.htm) says the next page is **Select Address**. Its [address help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/select_address.htm) describes confirming correct addresses before continuing. Live inspection subsequently verified `/applyForBenefits/addressValidation`, `form#addressValue[action="selectedAddress"]`, the home suggestion/original boundaries, sequential `homeAddressIndex` radios, and **Save and Continue** with handler `submitForm();`. Autofill chooses the first possible home match and rechecks the page before advancing. It requests no additional profile values: the desktop accepts this exact address URL as one of its fixed empty-field navigation authorization endpoints and returns no profile data. The other exact endpoints are listed in the implementation contract; each still needs its own content-adapter context and ordinary Next checks. The applicant must review the selected address before submission. See [the address contract](address-automation.md) for exact guards and observed versus generated cases.

An unrecognized address layout, separate mailing choices, visible county questions, errors, or visible dialogs pause automation. The hidden modal's Sign & Submit control is never used. Tell Us More has the bounded mappings and completeness-gated Next described above; its partial birth-date-only layout remains manual. Only the five captured financial record scopes above may fill one selected record and continue under their guards. Other employment, income, expense, and property variants remain manual until their exact controls are captured and tested. The preserved generic engine may fill rule-matched fields on otherwise unverified Iowa pages after the usual desktop authorization; unmatched answers and every Next on those pages stay manual. Its rules now include household counts by age and a student's name and grade worked out from the household list (#98); Iowa's household-member pages are not mapped, and verified Iowa coverage is unchanged. On those general-engine pages the side panel can also offer Save to My information for a matched question whose saved answer was blank. Recognized manual or protected applicant, address, and Tell Us More contexts explicitly reject generic fallback. The six exact scalar layouts use their captured adapters and disable model guesses. An unverified variant of a recognized protected layout does not fall through to generic filling. Other question-level rules never authorize navigation by themselves. After a user completes a manual step, Autofill can resume on a supported following page while it remains on; otherwise they start it again. Every data release and automatic data-page continuation requires the desktop checks described in the implementation contract.


CAPTCHA, passwords, MFA, consent, signatures, certifications, uploads, review/final-submission steps, and Save and Exit are never operated automatically.

## Pre-applicant screens (autopilot)

A second read-only inspection on September 26, 2026 walked Back through a guest session and recorded each earlier screen's visible heading, controls, and button handlers. No answers were read.

| Screen | Recorded controls | Autofill |
| --- | --- | --- |
| Household Application Information | `form#householdApplicationForm[action=selectHouseholdInfo]`. Radios `#householdApplyProgYes` (`true`) and `#householdApplyProgNo` (`false`), name `householdApplyProg`, `onclick="toggleCaptcha();"`, with exact label text. Continue runs `validateMsg();`. | Picks Yes only when a saved program choice is an explicit Yes. Choosing reveals Iowa's CAPTCHA, which stays with the applicant. |
| Before You Start... | Continue `submitUrlLink('letsGetStarted');return false;`. No named controls. | Continues |
| Let's get started | `#termChkbox` in `form#welcomeForm[action=forceLogin]`. Continue runs `welcomeSubmit();`. | Waits for consent |
| Important Information when applying and what to expect. | Continue `submitUrlLink('instructions');return false;` | Continues |
| Instructions | Continue `submitUrlLink('aboutYou');return false;`. The page also shows illustration buttons (Save and Continue, Edit, Submit Application) with empty handlers, and unnamed sample controls. | Continues |

An info screen is continued only when:
- its heading is in the registry;
- exactly one rendered `button.saveButton` reads "Continue" and has that screen's recorded `onclick`;
- no rendered named field exists outside the language menu;
- no CAPTCHA, consent, verification, pop-up, or signature step is visible.

The adapter re-verifies all of this immediately before its single click. Illustration buttons never qualify.

## Local data flow and validation limits

The Iowa content script runs only in the top frame under the official portal path. Iowa’s required host permission is restricted to `https://hhsservices.iowa.gov/*`; stricter runtime path checks guard every operation. Separate generic-site support requires optional HTTPS origin permission plus explicit local desktop trust. It does not extend Iowa’s verified coverage or operate recognized manual/protected Iowa steps. The native Chrome side panel runs in the extension origin. No profile values are placed in Chrome storage or sync. The extension’s local storage holds site-access configuration; it has no cookie, history, or externally-connectable permission.

Metadata inspection requests no profile values. An Autofill click on the recognized applicant page requests the page's mapped keys through native host `org.secondhand.bridge`, with a desktop dialog unless the user chose **Always allow on this computer**. The desktop owns the encrypted vault and controls disclosure. Values exist transiently in extension memory and Iowa’s form; JavaScript cannot guarantee immediate memory zeroization. No applicant values are written to extension storage, logs, or a SecondHand backend. Progress records only the official URL without query/fragment and a filled count; submission/approval is never inferred.

Entering an answer shares it with Iowa’s website, whose scripts may save it before final submission. The local-storage promise concerns SecondHand, not Iowa’s handling, Chrome form-saving/sync, other extensions, or device backups.

Tests use [the sanitized full-page fixture](../tests/fixtures/iowa-personal-information.cjs) and [fictional QA profile](../tests/fixtures/applicant-profile.json). The fixture reconstructs observed DOM metadata and conditional behavior; it is not a saved page and contains no session material. Automated tests use mock answers only in isolated fixtures. The separately authorized operator-run live draft is documented above. `node --test tests/extension-adapter.test.cjs` tests the complete conditional flow, missing-answer checklist, exact choice metadata, no overwrite/reset, optional questions, hidden/occluded controls, focus, and one-use Next snapshots. Worker tests cover per-request autofill authorization and bounded autopilot. `npm run test:extension` loads the actual extension in isolated Chromium with all Iowa requests intercepted by synthetic fixtures and native calls stubbed; no mock answers go to the government portal.


Before treating this as a production integration, validate the installed extension’s actual masks/change handlers and later-page coverage with a consenting applicant or agency-provided test environment, exercise the installed Windows native bridge, and verify submission/receipt recording only through user-driven submission. Never commit applicant data, cookies, tokens, or screenshots of real answers. Portal changes must fall back to manual review.
