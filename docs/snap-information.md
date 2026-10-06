# Prepare SNAP information locally

In the desktop app, open **My information → More SNAP information** to prepare answers Iowa may request later. These are optional local records. Leave unknown answers **Unanswered**; blank does not mean No, and a blank amount does not mean zero. Review the full question on the portal before using an answer.

The profile supports personal background, Social Security card names, household screening questions, helpers and representatives, and separate records for jobs, other income, housing, dependent care, child support, medical expenses, property, and help paying expenses. Household members have their own additional background fields. Keep the person, amount, frequency, and dates separate rather than combining different people's information.

Edits remain a draft until **Save my information**. Saved answers use the existing encrypted local vault and encrypted backups. Locking clears the displayed values. These additions do not create an online account, upload a document, or send the entire profile to the extension.

## Preparation versus autofill

Storing a field does not establish a verified portal mapping. The exact page and control checks in [Iowa portal coverage](iowa-portal.md) determine what the extension can fill.

| Information | What the app stores | Current extension scope |
| --- | --- | --- |
| Applicant identity, contact details, home/mailing address, program choices | Existing profile fields | Verified initial applicant-page mappings, with completeness checks before its ordinary Save and Continue |
| Home address suggestions | Existing address details | Verified home-only Select Address structure; separate mailing confirmation, county questions, errors, or changed layouts stay manual |
| Applicant Tell Us More answers | Birth date and explicit saved answers such as citizenship, marital status, and disability | Only the captured self-applicant layouts and matching controls; Next remains manual |
| SSN and names printed on the Social Security card | SSN plus separate card first/middle/last names | New exact `dynamicQuestionsStart` controls only. Card names require the explicit “has SSN” Yes and “name matches” No branch. The visible SSN input remains a manual-review item because its hidden submitted mirror was not verified; the extension does not write hidden fields |
| Residency, birthplace, naturalization, interpreter, meals, pregnancy, farmworker, and selected household screening questions | Explicit individual Yes/No answers | Some have conservative Iowa-only generic question rules. These are question matches, not verified complete later-page adapters; uncertain, changed, or unmatched wording remains manual |
| Emergency thresholds, grouped income lists, legal findings, utility types, helpers, representatives | Explicit answers and contact details for reference | Manual unless a specifically supported rule matches. No eligibility decision, group answer, authorization, or consent is inferred from other information |
| Jobs, income-source details, expenses, assets, contributions, extra household-member details | Separate records, up to 20 per category; person, amount, frequency, dates, and description where applicable | Local preparation only. The new record lists are not released through browser autofill or used as model facts. They do not create verified employment, expense, asset, or household-page mappings |
| Historical tax statements | Reviewed source, recipient, year, labeled annual amount and withholding | Local reference only; never converted into current income or a current job, and not sent to the browser or model |

Existing answers on a portal form are preserved. All CAPTCHA, consent, signatures, certifications, and final submission remain manual. Ordinary Save and Continue shares that page's answers with Iowa; it does not prove approval or final submission.

## What a tax document can help with

Tax documents describe a reporting period. They can reduce retyping and provide a historical reference, but current application questions often need newer information. The following table describes supported extraction, not a claim that every revision or scan is readable.

| Document | Evidence offered for review | What it does not establish for this application |
| --- | --- | --- |
| W-2 | Employee identity/address; separately labeled employer name, address, and EIN; tax year; wage and withholding boxes | Whether the person still works there, current pay, hours, pay frequency, or employment start/end dates. [IRS W-2 instructions](https://www.irs.gov/instructions/iw2w3) |
| 1099-NEC | Combined recipient name and address; separate payer name/address/TIN; year; individually labeled compensation and withholding | Current self-employment, current net profit, or deductible business expenses. Recipient TIN may identify a person or business and is never assumed to be the applicant's SSN. [IRS 1099-NEC instructions](https://www.irs.gov/instructions/i1099mec) |
| SSA-1099 | Beneficiary name/address, Box 2 SSN, printed source heading, benefits paid/repaid/net benefits, and withholding | Current monthly payment, exact birth date, disability status, or current Medicare enrollment. Box 8's claim number is not used as an SSN. [SSA explanation of net benefits](https://secure.ssa.gov/poms.nsf/lnx/0205002014) |
| 1040 / 1040-SR | Primary taxpayer identity/address, tax year, and individually labeled historical income lines | Current household composition, marital status, citizenship, employment, rent, assets, or exact birth date. A joint return can contain more than one person's income. These are annual income-tax returns. [IRS form description](https://www.irs.gov/forms-pubs/about-form-1040) |

Employer and payer values are labeled separately and have no applicant-profile mapping. Combined names remain whole when printed name boundaries do not support a split. OCR does not calculate current monthly income, combine overlapping tax lines, or infer household or benefit answers.

Identifiers and monetary values require agreement between two OCR passes. A second form recognized in either pass makes the document ambiguous and suppresses structured suggestions. Conflicting years remain unresolved; the supplied synthetic SSA form deliberately contains 2018/2019 conflicts. The review still shows individually labeled boxes, but its optional historical reference leaves the year and annual amounts blank.

## Keep an optional historical reference

1. Choose the original PDF or image in **Documents** and compare its review with the source.
2. In **Keep a historical tax record**, review the proposed source, recipient, year, and labeled annual amounts. No record is selected automatically.
3. Check **I compared these details with the original and want to keep this historical record**, then click **Add tax record to draft**.
4. The app opens **My information → More SNAP information → Historical tax statements**. Edit or remove the record as needed, then click **Save my information** to persist it.

This is a separate action from **Add selected details to profile draft**, which applies checked applicant fields. Either action preserves unrelated draft edits and does not save automatically. Leaving Documents clears its temporary review, so reread the source if you want to perform the other action afterward.

Historical references contain only the displayed source/recipient names, type, year, and labeled annual values. They exclude SSNs, EINs, other taxpayer identifiers, claim numbers, document images, filenames, and raw OCR text. Employer/payer addresses and identifiers remain in the temporary document review; they are not copied into the reference. Annual values stay blank if their period cannot be established consistently.

See [local document reading](document-ocr.md) for offline processing, file limits, cancellation, and the distinction between source-code QA and available installers. [Local field review](field-review.md) provides advisory format and source warnings; it never verifies an answer or edits it for you.

## Local QA

Parser tests use changed values, shifted/scaled layouts, missing and duplicate labels, blank cells, cross-form ambiguity, and conflicting OCR passes. They check employer/payer separation and prevent identifiers from entering historical records.

```sh
node --test tests/document-parser.test.cjs tests/document-w2.test.cjs tests/document-ssa1099.test.cjs tests/document-1099nec.test.cjs tests/document-cross-pass.test.cjs
node scripts/smoke-document-ui.cjs --case 1040sr
node scripts/smoke-document-ui.cjs --case w2
node scripts/smoke-document-ui.cjs --case ssa1099
node scripts/smoke-document-ui.cjs --case 1099nec
```

The UI harness uses a temporary synthetic vault and the four not-for-filing PDFs. It runs actual local PDF rendering, OCR, review, draft application, explicit historical-reference addition, encrypted saving, and lock/unlock. Only the native file-picker selection is stubbed. No real portal or applicant data is used. A passing development-app check is not proof of an installer build, Windows execution, or accuracy on arbitrary documents. Run these commands locally; this feature introduces no workflow changes.
