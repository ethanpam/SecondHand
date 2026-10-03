# Read a document on this computer

The desktop app's **Documents** view reads a local PDF, PNG, or JPEG and shows its text for review. English OCR, PDF rendering, and field extraction run on your computer. They do not upload the document, call Laya, or need an OCR account, API key, model download, or separate command-line program.

This feature is in the source branch. These instructions do not establish that it is included in the public download or that a Windows installer has been tested.

## Review before saving

1. Unlock SecondHand and open **Documents**.
2. Click **Choose PDF or photo** and choose a file through the operating system's file picker. The original stays where it is; SecondHand does not move or modify it.
3. Open **Read extracted text by page** and compare each suggested detail with the original. OCR can confuse letters, digits, columns, and people on the same page.
4. Each suggested field starts unchecked and shows the current draft value. Select only the supported details you want to use, confirm **I checked the selected details and they belong to the applicant**, then click **Add selected details to profile draft**. Check that they are still current. This changes the draft, not the encrypted saved profile.
5. Review **My information**, then click **Save my information** to encrypt and persist those changes. You can edit or reject suggestions before saving.

**Discard review**, leaving **Documents**, choosing a replacement document, or locking the app clears the temporary review. If you want to read it again, choose the original file again. Applying details does not attach the source document to your profile or send it to Iowa.

## What it can recognize

For a recognizable Form 1040 or 1040-SR layout, the parser uses printed labels and text positions to propose the primary taxpayer's name, Social Security number, and home address, including an apartment when detected. These are suggestions, not verified identity or proof of a current address. Missing or ambiguous fields may remain blank. Two OCR passes use different page-segmentation modes on the same image. Social Security numbers and tax amounts are proposed only when both passes agree; a missing or different result is omitted for manual review. Agreement is not proof of accuracy, because both passes use the same recognition model.

The review can also identify the tax year and these historical amounts:

| Tax-return line | Meaning in the review |
| --- | --- |
| 1a | W-2 wages reported on the return |
| 1z | Total of lines 1a through 1h |
| 2a / 2b | Tax-exempt / taxable interest |
| 3a / 3b | Qualified / ordinary dividends |
| 4a / 4b | IRA distributions / taxable amount |
| 5a / 5b | Pensions and annuities / taxable amount |
| 6a / 6b | Social Security benefits / taxable amount |

Those amounts and the tax year are for review only. A joint return may combine two people's income, and an earlier tax year does not establish current income. SecondHand does not divide annual amounts by twelve, add overlapping tax lines together, or use them to answer benefits questions automatically.

Spouse and dependent information stays in the document review; it is not substituted for the primary taxpayer or used to create household members. Filing status, age/blindness checkboxes, and dependent rows do not establish date of birth, current household composition, program choices, or eligibility. The parser does not infer those answers.

Other documents can still show extracted text. They do not receive tax-form field suggestions merely because they contain a name, an address, or a nine-digit number. Structured extraction is a limited set of layout rules, not a general document-understanding model. Different revisions, handwriting, damage, rotation, or poor scans can require manual entry.

## Limits and local processing

- One selected PDF, PNG, or JPEG, no larger than **30 MiB**.
- A PDF may contain at most **12 pages**.
- OCR currently uses the bundled **English** recognition model.
- The OCR engine has a **five-minute processing** time limit; time spent choosing or opening the file is separate.
- Each pass is limited to **200,000 text characters and 12,000 words per page**; the document is limited to **500,000 text characters and 80,000 words across both passes**.
- Rendered OCR pages are limited to **16 megapixels**. PNG/JPEG images whose headers report more than **40 megapixels** are rejected. An image dimension may not exceed **20,000 pixels**.
- Password-protected PDFs must be unlocked before reading.

PDF.js renders PDFs and Tesseract.js recognizes image text using its bundled WebAssembly runtime and English language data. The app supplies those files locally to a hidden, sandboxed Electron window in a temporary browser session. That session blocks network access and requests outside its fixed local asset set. No installed Python, Poppler, Tesseract executable, or online OCR service is required on Windows or macOS. PDF rendering targets at least a 2,600-pixel long edge or 300 DPI, subject to the pixel cap. The passes use automatic and sparse-text segmentation (PSM 3 and PSM 11); they do not repair or guess missing digits.

OCR assets are bundled at build time, about 29 MiB in the current bundle. This is separate from [Laya](../README.md#local-ai-with-laya), whose optional local inference model has its own download and update behavior. Reading a document does not invoke Laya.

The source remains in its existing location. SecondHand does not keep a document database, a copied original, a raw-text cache, or an attachment in the encrypted vault. Source bytes and worker resources are released after processing or cancellation; review text and candidates remain in temporary UI memory until the review is cleared. Saving chosen profile fields stores those fields through the existing encrypted-profile workflow.

Clearing references is not guaranteed forensic memory erasure: JavaScript strings, operating-system memory, crash dumps, and backups are outside that guarantee. The original file remains subject to the permissions, cloud sync, and backups of its original folder. See [Security and privacy](security.md#local-document-reading).

**Cancel reading** or locking revokes a pending read. An operating-system file picker already open may remain visible; a late selection or result cannot restore a cancelled review. A failed or cancelled read does not save profile changes.

## Development and QA

The [code walkthrough](document-ocr-code-guide.md) explains each OCR component, the review/save boundary, and what the tests cover.

```sh
npm ci
npm run test:ocr
npm run test:ocr -- --input tests/fixtures/ocr/synthetic-1040sr.pdf
npm run test:ocr:ui
```

The default smoke command runs the real Electron OCR engine on a generated synthetic PNG, then checks actual cancellation, rejection of a 13-page PDF, and missing/corrupted bundled files. Damaged reader files show a reinstall message; malformed manifests fail before a worker opens. These checks use temporary copies and leave the real bundle untouched. The command with `--input` reads the supplied one-page **synthetic** 2024 Form 1040-SR scan through the same bundled engine and parser. The fixture is marked as test data, not for filing; its [provenance](../tests/fixtures/ocr/README.md) is recorded alongside it. Neither check starts the applicant vault or Laya, or sends anything to a government portal.

`test:ocr:ui` exercises the desktop Documents view with that PDF and a temporary synthetic vault, with Laya disabled. Only the native file-picker response is stubbed. PDF rendering, OCR, parsing, review selection, draft merging, encrypted saving, and lock/unlock are real. It checks that reading and applying do not auto-save, unrelated draft edits survive, uncertain SSNs are omitted, and historical amounts cannot enter monthly income. Screenshots and a report are written to the ignored `artifacts/ocr/` folder.

To test an installed or mounted package, run `node scripts/smoke-document-ui.cjs --executable /absolute/path/to/secondHand.app/Contents/MacOS/secondHand --artifacts artifacts/ocr-packaged` (use the app executable path on Windows). This opts the packaged app into its existing isolated test-storage mode. The harness verifies the storage path and packaged mode, records the runtime architecture, and never uses the normal applicant vault.

Both Mac DMGs have been built locally, mounted read-only, and tested through the complete packaged OCR/review/encrypted-save/lock/unlock workflow with the synthetic PDF. Each package's 217 bundled OCR assets passed hash checks, and its OCR code matched source. The Apple silicon build ran natively; the Intel build ran as `darwin/x64` under Rosetta on Apple silicon, so physical Intel hardware remains untested. Windows execution remains unverified: this test machine has no Windows runtime or .NET Framework native-host compiler. The Mac builds retain the existing unsigned, non-notarized pilot packaging. No CI workflow or public release is created by these commands.

On the supplied PDF, the current result proposes seven profile details: first name, last name, street, apartment, city, state, and ZIP. The middle initial and SSN are omitted. Only the agreeing historical amounts for line 1a (68,450) and line 2b (460) are proposed, for review only; the other amounts are omitted because the passes do not read them consistently. This is a deliberately partial result, not flawless extraction.

The synthetic sample is useful for detecting primary/spouse/dependent confusion and the two amount columns. It is not evidence of accuracy across all tax returns, document types, scan qualities, languages, or installed Windows/macOS combinations. Parser unit tests should cover missing anchors, changed values, ambiguous identity, column boundaries, and blank amounts rather than treating the sample's exact values as parsing rules.

Keep real documents, OCR text, Social Security numbers, and document screenshots out of tests, commits, logs, and issues. Use synthetic fixtures when reporting a parsing problem.
