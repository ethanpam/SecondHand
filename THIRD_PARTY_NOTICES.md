# Third-party material

SecondHand contributors' original code is licensed under [MIT](LICENSE). Third-party code, fonts, models, questionnaires, and media retain their own terms. The root license does not grant rights that their owners have not granted.

## Notices already included

| Material | Location / source | Terms and notice |
| --- | --- | --- |
| React Bits Variable Proximity and Text Type adaptations | `website/app/_components/variable-wordmark.tsx`, `website/app/_home/text-type.tsx`; [source and pinned revision](docs/react-bits-design-research.md) | **MIT with Commons Clause, not plain MIT.** Keep the full [upstream notice](website/public/react-bits-license.txt). Read its restrictions before extracting or redistributing these components. |
| Geist and Bricolage Grotesque fonts | Extension font assets and website Fontsource packages | SIL Open Font License; [bundled extension notices](extension/font-licenses.txt). Preserve the website packages' notices when distributing their fonts. |
| Electron, ONNX Runtime, Tesseract.js, pdf.js, React, and other dependencies | Package manifests and lockfiles | Each dependency's own license applies. Preserve notices from installed packages and packaged runtimes. The README credits are not an exhaustive dependency license inventory. |
| SecondHand mascot | Shared app/website icons | Generation provenance and prompt are recorded in [the mascot note](docs/secondhand-mascot.md). |
| Synthetic tax-document fixtures | `tests/fixtures/ocr/`, `ios/Tests/Fixtures/` | [Fixture provenance](tests/fixtures/ocr/README.md) records fictional data. These are test documents, not applicant records or filing-ready forms. |

## Permission records still needed before public release

- **Copied questionnaires:** `ML_model/questions/` records original form sources. Source URLs alone are not redistribution licenses. Record the applicable permission or terms for each source, or replace/remove material whose redistribution is not established.
- **External design/template material:** retain the source references in the website README and design research note; confirm applicable terms for copied template code as well as installed packages.

These open items are documentation gaps, not a claim that the material is unauthorized. Adding MIT to this repository does not resolve them. See the [public-release review](docs/public-release-review.md) for the remaining checks.
