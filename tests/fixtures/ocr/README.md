# Synthetic OCR fixture

`synthetic-1040sr.pdf` is the user-supplied file originally named `synthetic_1040sr_realistic_scan.pdf`. The user explicitly identified it as a fake tax return and authorized local OCR development and QA. It was copied without modification; it is not a real applicant's return or a product default.

- One raster-only page, shaped like page 1 of the 2024 Form 1040-SR.
- Visible banner: **SYNTHETIC OCR TEST DATA - NOT FOR FILING**.
- Fictional primary taxpayer, spouse, dependents, identifying numbers, address, and amounts.
- SHA-256: `daaba770190e660e63e568a7bebf58605dc86b234743f627744bd4d2ea1d7e1a`.

Never submit this fixture, its details, or derivatives as an application or tax return. Do not replace it with a real person's document.

## Run locally

```sh
npm run test:ocr -- --input tests/fixtures/ocr/synthetic-1040sr.pdf
```

This uses the bundled PDF.js/Tesseract runtime in an isolated Electron worker and parses the result. The separate default `npm run test:ocr` command generates a simple synthetic PNG and also checks actual cancellation and the PDF page limit.

The PDF is intentionally useful for imperfect-recognition tests. Table borders and nearby columns cause different segmentation passes to read some values differently even at high confidence. In the current verified run:

- Seven primary-profile suggestions remain: first name, last name, street, apartment, city, state, and ZIP.
- The middle initial and SSN are omitted instead of guessed.
- Only line 1a **68,450** and line 2b **460** remain as historical, review-only amounts; other amounts are omitted when the two passes disagree or do not both find them.
- No spouse/dependent details, filing status, age marks, annual-to-monthly income conversion, or eligibility answers are applied to the applicant's profile.

These observations document this scan and runtime, not an accuracy guarantee for other returns. A parser test must use layout anchors and varied synthetic values rather than hardcode this fixture's contents.

Do not commit raw OCR output, extracted-data dumps, or document screenshots. Temporary diagnostic output belongs outside the repository and must contain synthetic data only. See [the document-reading guide](../../../docs/document-ocr.md) for privacy behavior and limits.
