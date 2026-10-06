# Document OCR code walkthrough

This guide explains the additions in PR #78 by file and function. Related lines are grouped so imports, validation, cleanup, and tests can be reviewed together. Links point to the source in this branch; function names remain useful if later edits move the line numbers. For the user-facing workflow, see [Read a document](document-ocr.md).

## Follow one document through the app

1. **Choose:** the Documents screen generates a request UUID and calls the desktop preload. Main opens the native file picker; the UI never supplies a filesystem path.
2. **Read:** the service reads the selected file into memory, checks cancellation/unlock state, and starts a fresh hidden OCR window.
3. **Recognize:** that sandboxed window renders the PDF or image and runs two local English OCR passes. It returns text, confidence, and word positions.
4. **Interpret:** the parser proposes fields only for a recognized tax-return layout. This is a set of conservative rules, not Laya or a remote AI service.
5. **Review:** suggestions start unchecked. The user compares them with the original and current profile draft, corrects values, and confirms they belong to the applicant.
6. **Apply, then save:** selected values enter the unsaved profile draft. The existing **Save my information** action validates and encrypts the profile. Reading or applying alone never saves it.

## Desktop entry points and file access

| Source | What the lines do and why |
| --- | --- |
| [main.cjs: reader setup](../desktop/main.cjs#L110-L120) | Supplies the native picker, unlocked-vault check, correct development/packaged asset directory, progress forwarding, and parser to `createDocumentReader`. The picker allows one PDF/PNG/JPEG. |
| [main.cjs: document methods](../desktop/main.cjs#L433-L440) | `readDocument` requires an unlocked vault and refreshes activity; `cancelDocumentRead` validates the request UUID. Neither writes the profile. The adjacent existing `saveProfile` method is the separate persistence boundary. |
| [main.cjs: IPC validation](../desktop/main.cjs#L613-L617) | Accepts calls only from the actual desktop window's top-level frame at the exact renderer URL, checks the method allowlist/argument count, and returns safe public error text. A webpage cannot use this to read a path. |
| [main.cjs: lock](../desktop/main.cjs#L150-L158) and [quit](../desktop/main.cjs#L627-L632) | Cancel outstanding document work when access is revoked or the app closes. |
| [preload.cjs: document API](../desktop/preload.cjs#L18-L30) | Exposes only `readDocument(id)`, `cancelDocumentRead(id)`, and `onDocumentProgress(callback)`. Progress is rebuilt from validated UUID/phase/page/count fields; Electron events and arbitrary payloads are not passed to the UI. The subscription returns an unsubscribe function. |
| [ocr-service.cjs: `readSelectedFile`](../desktop/ocr-service.cjs#L9-L29) | Opens the picker-selected file read-only, requires a regular bounded file, reads incrementally, and checks aborts and file changes. It closes the file in `finally` and clears its byte buffer on failure. It creates no copied document. |
| [ocr-service.cjs: `createDocumentReader`](../desktop/ocr-service.cjs#L32-L79) | Serializes reads, checks the UUID/unlock state, and keeps an abort controller per operation. Its guard runs after asynchronous steps so a late picker or OCR result cannot revive cancelled work. Results expose the basename, not the source path. `finally` clears the source buffer and destroys the engine. A stale UUID cannot cancel a newer job. |

## The isolated OCR engine

[ocr-limits.cjs](../desktop/ocr-limits.cjs#L3-L86) centralizes the limits and safe error vocabulary. `documentKind` checks file signatures and image dimensions rather than trusting the extension. `progress` validates status messages. `validatePages` bounds returned page dimensions, text, word counts, confidence, and bounding boxes, and reconstructs the permitted result shape. Limits include 30 MiB, 12 pages, and a five-minute engine timeout. These checks also apply to data coming back from the sandbox.

[ocr-engine.cjs](../desktop/ocr-engine.cjs) manages the hidden window:

- [`assetMap` and `assetPath`](../desktop/ocr-engine.cjs#L12-L40) read the generated manifest, reject unsafe paths/metadata, and build a fixed asset allowlist. Nulls, arrays, and primitive values in place of the manifest, asset collection, or metadata return `ASSETS` before opening a window. URL lookup requires the exact virtual origin and rejects query strings, fragments, credentials, and unknown paths.
- [`createOcrEngine().read`](../desktop/ocr-engine.cjs#L45-L65) is single-use. It identifies the input, creates a nonpersistent Electron session, denies permissions/downloads, and blocks requests outside the local asset set and its blob workers. The `https://secondhand-ocr.invalid` origin is handled locally; it is not an upload destination.
- The [protocol handler](../desktop/ocr-engine.cjs#L66-L81) reads only allowlisted bundled files and checks their declared sizes and SHA-256 hashes. Missing or damaged assets settle the operation immediately with `ASSETS` and reinstall guidance, before a worker fetch error could turn it into a generic document failure. Cancellation that already finished remains final.
- The `BrowserWindow` is hidden, sandboxed, context-isolated, and has no Node integration. Navigation, popups, and webviews are denied. The CSP limits scripts/workers to the bundled runtime; `wasm-unsafe-eval` is needed for WebAssembly, not arbitrary document JavaScript.
- `receive` accepts worker messages only from that window's exact main frame. On `ready`, main sends bytes and limits, never a file path. Progress and completed output are validated before forwarding.
- `finish` settles once, removes listeners/timers, destroys the window and workers, unregisters the local protocol, and clears session caches. Abort, timeout, crash, and success all converge on cleanup.

[ocr-preload.cjs](../desktop/ocr-preload.cjs#L1-L15) is the tiny worker bridge: one `start` callback receives the input; `progress`, `complete`, and `fail` send results back. [ocr.html](../desktop/ocr.html) loads the bundled Tesseract script and runtime module without inline code or document content.

[ocr-runtime.mjs](../desktop/ocr-runtime.mjs#L1-L111) performs the actual work:

| Function/block | Purpose |
| --- | --- |
| `dimensions`, `canvasOf` | Calculate a bounded raster size and create a white canvas. PDFs target 300 DPI or a 2,600-pixel long edge, subject to the pixel cap. |
| `wordsFrom` | Flatten Tesseract's block/paragraph/line hierarchy into bounded words with confidence and coordinates for the parser. |
| `api.start`: input setup | Open PDFs with PDF.js, disabling evaluation/XFA and annotations during rendering; reject excessive page counts. Decode PNG/JPEG locally. |
| `Tesseract.createWorker` | Use bundled English data, worker code, and WASM, with its recognition cache disabled. There is no runtime model download. |
| Page loop / `recognize` | Render one page at a time, report progress, and run automatic and sparse-text segmentation (PSM 3 and 11). Store both readings and enforce total output limits. |
| `catch` / `finally` | Map errors to safe codes, release canvas/bitmap/PDF resources, and terminate the worker. Main's window destruction also stops a worker stuck during initialization. |

## Turning OCR into review candidates

The helpers in [document-parser.cjs](../shared/document-parser.cjs) are pure: they return analysis and never access the vault.

- [`wordRows`](../shared/document-parser.cjs#L14-L52) validates positioned words, drops tiny marks that OCR split off inside another word (such as the dot of an i), and groups the rest into rows using their heights and vertical centers.
- [`matches` and `afterLabel`](../shared/document-parser.cjs#L54-L83) locate printed labels and read only one bounded value row between known headers. A blank primary cell does not trigger a search farther down into a spouse or dependent's details.
- [`recognizedType` and `money`](../shared/document-parser.cjs#L85-L96) identify supported 1040/1040-SR text and accept strict numeric amount syntax. They do not repair letters into digits or guess zeros.
- [`parseTaxPage`](../shared/document-parser.cjs#L98-L222) uses unique label anchors and column positions to separate primary names/SSNs, spouse fields, domestic address cells, and historical tax lines. Its `add` helper validates eligible profile values with the existing schema. Spouse fields and amounts have no `profileKey`, making them review-only. Ambiguous foreign addresses/years produce warnings rather than guesses.
- [`analyzeDocument`](../shared/document-parser.cjs#L225-L264) requires exactly one supported taxpayer header. Multiple returns or unknown layouts produce no structured suggestions. Amounts and SSNs survive only when both segmentation passes produce the same value. Other primary name/address suggestions still require user review. Confidence is recognition metadata, not a probability that an answer is correct.

## Review UI and the save boundary

[index.html](../renderer/index.html#L172-L185) adds the Documents view, progress/cancel controls, warning area, review rows, applicant confirmation, and expandable raw text. [styles.css](../renderer/styles.css#L17-L18) supplies the card/grid layout, readable text panels, warning styles, and narrow-window layouts; it adds no data storage behavior.

The document functions in [renderer/app.js](../renderer/app.js#L274-L455) implement the interaction:

- `documentControls` derives disabled/busy states and selection count. Nothing can be applied without selected fields and applicant confirmation.
- `clearDocumentReview` increments the review revision, unsubscribes progress, clears text/field DOM nodes and references, resets confirmation, and cancels the old request if needed. Navigation, discard, replacement, and lock invoke it.
- `documentText`, `confidenceText`, and `documentCurrent` format bounded display text and show the current **draft** value, including unsaved edits.
- `renderDocument` displays type/year, warnings, source page/confidence, raw text, and suggestions through `textContent`/input values, never injected HTML. Only the nine explicitly allowed identity/address keys receive checkboxes. Every checkbox starts unchecked; other fields say review-only. Editing a suggestion or changing a selection clears the confirmation.
- `readDocument` correlates progress/results with the UUID, vault generation, review revision, and current view. Old success/error/progress callbacks are ignored after cancellation or lock, even if the app has since unlocked.
- `applyDocumentFields` rechecks that selected current draft values have not changed during review, copies only selected values, marks the draft dirty, and opens My information. It never calls `saveProfile`.

[`showView`](../renderer/app.js#L247-L263) preserves unsaved profile edits when entering Documents and clears OCR review when leaving it. The existing [profile submit handler](../renderer/app.js#L826) remains the explicit Save action; main validates the resulting profile before the existing encrypted vault update. OCR does not infer DOB, household composition, eligibility, or current monthly income from a tax return.

## Dependencies, build output, and tests

[prepare-ocr-assets.cjs](../scripts/prepare-ocr-assets.cjs#L1-L43) copies installed PDF.js, Tesseract, supported WASM variants, English data, and licenses into `build/ocr`. `copy` records size/hash; `directory` walks sorted entries and refuses symlinks. The manifest records package versions. [package.json](../package.json#L23-L57) runs this preparation before development/start/tests/builds and includes the resulting assets as packaged resources. The OCR packages are build dependencies because their selected runtime files are copied into the app. Installing dependencies requires the normal package download; reading a document afterward does not.

[package-lock.json](../package-lock.json) is generated dependency resolution: versions, integrity hashes, and transitive packages used by `npm ci`. Its many lines are dependency metadata, not handwritten OCR behavior. [The PDF fixture](../tests/fixtures/ocr/README.md) is the explicitly authorized **fake**, raster-only tax return, copied unchanged and marked “NOT FOR FILING”; its binary diff is not executable source or real applicant data.

| Test file/command | What failure it is intended to catch |
| --- | --- |
| [desktop-ocr.test.cjs](../tests/desktop-ocr.test.cjs) | Invalid files/output, asset URL escape, oversized reads, lock/cancel races, stale cancellation, path/text leakage through errors, unsafe progress payloads. |
| [desktop-ocr-assets.test.cjs](../tests/desktop-ocr-assets.test.cjs) | Malformed manifest shapes fail before window creation; missing/corrupt files return `ASSETS`, cleanup runs, queued worker messages stay ignored, and a later asset failure cannot override cancellation. The protocol/filesystem are real; Electron surfaces are mocked to control timing. |
| [desktop-ocr-main.test.cjs](../tests/desktop-ocr-main.test.cjs) | Requests from the wrong frame, caller-supplied path arguments, locked reads, or missing lock/quit cancellation. |
| [document-parser.test.cjs](../tests/document-parser.test.cjs) | Primary/spouse confusion, blank-cell fallback, conflicting amounts/SSNs, shifted geometry, foreign addresses, multiple returns, and fabricated fields on unknown documents. Values/layouts vary instead of hardcoding the sample's answers. |
| [renderer-documents.test.cjs](../tests/renderer-documents.test.cjs) | Auto-saving, silent draft replacement, missing confirmation, stale async results, unsafe HTML, and text surviving discard/navigation/lock. Mock promises deliberately control race order. |
| [`npm run test:ocr`](../scripts/smoke-ocr.cjs) | Runs the real Electron/PDF.js/Tesseract engine on generated synthetic data, including real recognition cancellation, 13-page rejection, and missing/corrupt assets in a temporary copy. `--input tests/fixtures/ocr/synthetic-1040sr.pdf` checks the supplied scan. |
| [`npm run test:ocr:ui`](../scripts/smoke-document-ui.cjs) | Runs real OCR through the desktop review, draft merge, encrypted Save, and lock/unlock. Only the native picker result is stubbed. A temporary vault and disabled Laya avoid touching normal data or starting model downloads. Screenshots/reports default to ignored `artifacts/ocr`. |

The UI smoke also accepts `--executable /absolute/path/to/app` to launch an already built application and `--artifacts directory` to separate its screenshots/report. It asserts the requested packaged/development mode and isolated user-data path before the test. Packaged mode uses the existing explicit test-storage environment variables; it does not bypass vault or OCR validation. This tests the packaged runtime/resources rather than substituting source assets. Platform execution results are recorded separately in the [QA scope](document-ocr.md#development-and-qa).

## Tradeoffs and privacy limits

Bundling English OCR adds package size and dual recognition passes add CPU time, but documents need no OCR service/account or processing download. Both passes use the same model: agreement reduces some table-reading errors but cannot establish accuracy. Strict layout rules deliberately omit uncertain fields; handwriting, changed form revisions, poor scans, and other languages can require manual entry. Historical/joint amounts stay review-only and are never divided into monthly income.

The product creates no copied original, OCR database, attachment, or raw-text cache. Selected values persist only through Save. Clearing buffers/references and destroying workers reduces retention; it is not a guarantee of forensic memory erasure, and it cannot control the original folder's cloud sync/backups. A native picker already open may remain visible after cancellation, but its late selection is discarded. Synthetic smoke tests prove the exercised paths, not universal document accuracy or every installed Windows/macOS combination. See [privacy details](security.md#local-document-reading) and [current QA scope](document-ocr.md#development-and-qa).
