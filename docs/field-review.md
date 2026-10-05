# Review applicant information locally

**Check information** in My information reviews the current draft, including household members. Documents automatically checks extracted fields after a scan; **Check extracted fields** checks them again after corrections. Neither action changes a value, selects a document field, saves the draft, or sends anything to a benefits portal.

Results appear beside the relevant controls:

- **Blank**: the value is blank. A blank answer is not automatically an error.
- **Format checks passed**: the value passed the applicable exact checks. This does not establish ownership, currentness, or truth.
- **Check source**: compare this detail with the original document or the applicant's current circumstances.
- **Needs review**: a format issue, contradictory answer, low-confidence reading, or conflicting draft value needs attention.

Checks include profile choices, dates and household age counts, email/phone/state/ZIP formats, money formats, and Social Security number structure. The SSN checks use [SSA's invalid-number rules](https://www.ssa.gov/employer/randomizationfaqs.html); they cannot establish that a number was issued or belongs to the applicant. Unfamiliar names are not treated as invalid just for being unfamiliar. Historical tax amounts retain their review-only role and are never divided by twelve or copied into current income.

## Optional Laya feedback

**Include experimental Laya review** is unchecked by default. It asks the installed local model about eligible printed document labels and the field they were mapped to. The OCR parser preserves the printed label separately from its own display label, so this comparison has source evidence. Combined labels, unsupported fields, absent evidence, and ambiguous answers stay with the applicant.

The current Laya model was trained for form matching and answering form questions, not for confirming OCR digits or verifying identity. Its optional review therefore uses its existing label-matching task. A strong alternative match may add a warning. Agreement never upgrades a value to verified, removes a rule warning, repairs digits, or makes a correction. Profile values are checked by rules; they are not submitted to Laya for a general factual verdict.

Only eligible label text and fixed field descriptions enter the model. Profile values, OCR values, SSNs, source pages, passwords, recovery keys, and verification codes are not model inputs. Review does not turn Laya on, download a model, or make a remote inference request. The existing Laya setting still controls its separate model downloads and update checks.

Model review is bounded and may be partial. The interface reports unavailable, skipped, incomplete, or failed model review rather than presenting those cases as a pass. Rule results remain available when Laya is off or unavailable. This feature does not add a trained OCR-verification model or establish accuracy across document types.

## Lifecycle and testing

Editing a value invalidates its previous review. Navigation, replacing or discarding a document, and locking clear the temporary results. Late responses cannot restore results after edits or lock/unlock. No review report or document text is written to the vault, logs, or settings; only the applicant's existing explicit Save action stores profile changes.

Regression tests cover invalid formats, contradictory synthetic answers, source-label evidence, unknown fields, model abstention/failure, no mutation, and stale IPC/UI responses. The actual OCR UI smoke test uses a synthetic PDF and a temporary encrypted vault. Model evaluation fixtures are synthetic and report model mistakes separately from rule results. Passing these checks is not a claim that all extracted details are accurate.

Run `npm run review:evaluate` to evaluate an already-installed local model without downloading one or opening applicant data. It reports cold-start behavior separately from warmed requests. An explicit export can be selected with `-- --model-dir /path/to/model --model-format noul-v1` (or `choice-v2`). With no available model, it reports that no model evaluation ran.

The initial local `noul-v1` evaluation caught all four deliberately mismatched labels and added no model warnings to the four comparison cases. The six excluded cases were not sent to the model. One comparison intentionally contained a wrong ZIP digit behind a correct label: Laya did not flag it. This is a small synthetic label-matching check, not an accuracy estimate or validation of OCR values. No new model training was performed.
