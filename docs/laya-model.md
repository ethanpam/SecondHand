# Laya model card

SecondHand's local decision model: [Laya](https://huggingface.co/convaiinnovations/laya) fine-tuned to answer food-assistance form questions from the applicant's saved facts, and to match text boxes to saved fields. It runs on the applicant's computer (#38). Training and evaluation are in `ML_model/` (#41).

## Model
- **Base:** `aac6fef/laya-mlx`, fine-tuned with LayaStudio on an Apple M4 Max.
- **Run:** `round2-lora-proper-1790530553`, from commit `5582a70` (dataset `round2-1790530494`, SHA-256 `1064fcfe…`).
- **Task:** one fixed yes/no question per candidate: "Given the facts about the household, is the candidate the correct answer to the form question?" A question is answered only when its best candidate clears the confidence bar and beats "None of these, or the facts don't say".
- **Format:** `noul-v1`, the single-candidate yes/no prompts in `shared/laya-prompts.cjs`.
- **Runtime export:** int8 ONNX, 409 MB, published at [huggingface.co/JacobTDang/secondhand-laya](https://huggingface.co/JacobTDang/secondhand-laya) (commit `d1beee2813ce4996c50695eb604841365808f1e3`, Apache-2.0). The desktop app ships pinned to that commit (`desktop/laya-model.json`) and installs whatever newer model the repo's `latest.json` names (see [Publishing a model](#publishing-a-model)). Exported with `uv run --no-sync python -m layastudio.export run:round2-lora-proper-1790530553 --target onnx --precision int8`. The exporter checked 10 decisions against the trained model: all gave the same answer, with probabilities within 0.0007.

  | File | Bytes | SHA-256 |
  |---|---|---|
  | `model.onnx` | 3,820,399 | `4fba842d827c73f596b8f17be4a98700d258cfc43365e32898f577b365314fb8` |
  | `model.onnx.data` | 421,294,080 | `af1f87d7d95ff5c72f205b81c91f414cd53bc4632d41972397b99a43a13cd741` |
  | `tokenizer/tokenizer.json` | 3,583,228 | `6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30` |
  | `tokenizer/tokenizer_config.json` | 308 | `50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12` |
  | `rl_agent_config.json` | 1,019 | `7f4cb9dd484a70cd6352eb1efb804e5ebcc9b346e352215318aff486ced58c36` |

## Data
Public form questions only. Households are fictional and generated in code; no real person's data is used.

| Source | Files | Questions | Use |
|---|---|---|---|
| Real forms: Google Forms, Jotform, PDF and web intake forms | 25 | 527 | training |
| Real forms, test split (by form) | 7 | 129 | test |
| Real forms marked holdout (collected after the first model) | 7 | 124 | test, and scored on their own |
| Synthetic rewordings (`questions/synthetic/`) | 7 | 757 | training only |

- Every label is computed by code from the question's answer rule and the facts sheet (`shared/facts.cjs`). No label is written by hand.
- A test prevents any synthetic question from repeating a test or held-out label.
- **Dataset:** 90,365 rows after balancing: 67,461 train, 7,735 validation, 15,169 test.

## Training
| Setting | Value |
|---|---|
| Method | LoRA, rank 16, alpha 32, dropout 0.05, top 4 layers fully trained |
| Objective | proper, balanced class weighting |
| Epochs, updates | 1 epoch, 4,217 updates (batch 8, gradient accumulation 2) |
| Learning rate | 2e-4 (head 1e-4), warmup 6%, weight decay 0.01 |
| Precision | bfloat16 (load it in bfloat16; float16 overflows) |
| Time, peak memory | 3.4 hours, 3.2 GB |
| Validation | loss 0.027, accuracy 0.993 |
| Calibration error (ECE) | 0.0045 before, 0.0013 after temperature fitting |

The fitted temperature for choice questions with 11+ options is 0.10, outside laya-mlx's [0.5, 5] range, so the runtime clamps it. Confidence for questions with 11+ options is uncalibrated.

## Results
Scored with `ML_model/eval/decisions.py`, per question. **Precision** is right answers ÷ answers filled. **Coverage** is right answers ÷ questions the answer key says are answerable. The test split includes the held-out forms.

### Answering (choice and yes/no questions)
| Set | Model | Threshold | Filled | Precision (answer key) | Wrong fills | Coverage |
|---|---|---|---|---|---|---|
| Test (2,016 questions) | previous (`augmented`) | 0.9 | 180 | 0.778 | 40 | 0.854 |
| Test | round 2 | 0.9 | 171 | 0.749 | 43 | 0.780 |
| Test | round 2 | 0.95 | 167 | 0.766 | 39 | 0.780 |
| Holdout (368 questions) | previous | 0.9 | 24 | 0.667 | 8 | 0.941 |
| Holdout | round 2 | 0.9 | 23 | 0.565 | 10 | 0.765 |
| Holdout | round 2 | 0.95 | 22 | 0.545 | 10 | 0.706 |

**Every round-2 wrong fill at 0.9 is a correct answer that the frozen answer key can't express.** The key tags these questions `none` because no answer rule reads them, and the key was not changed after seeing results. Checked against each household's facts:

| Question | Round 2 answered | Test | Holdout |
|---|---|---|---|
| "Are there other members in your household in addition to yourself?" | Yes for households of 2–7, No for 1 | 22 | 6 |
| "Does your household have more than 8 members?" | No, households of 1–7 | 15 | 4 |
| "Apply for?" (the applicant's own row in Iowa's household table) | Yes, when the applicant is applying for SNAP | 6 | 0 |
| **Genuinely wrong answers** | | **0 of 171** | **0 of 23** |

The previous model made 16 genuinely wrong answers of 180 on the same test set:
- 15 to "…in addition to those already listed?", which depends on what the form already listed;
- 1 to "Veteran".

Round 2 answers fewer of the key's answerable questions (78% vs 85%).

### Matching text boxes to saved fields
| Set | Model | Threshold | Precision | Wrong fills | Coverage |
|---|---|---|---|---|---|
| Test (169 boxes) | previous | 0.95 | 0.899 | 8 | 0.866 |
| Test | round 2 | 0.9 | 0.878 | 10 | 0.878 |
| Test | round 2 | 0.95 | 0.909 | 7 | 0.854 |
| Holdout (78 boxes) | previous | 0.95 | 0.884 | 5 | 0.809 |
| Holdout | round 2 | 0.95 | 0.902 | 4 | 0.787 |

SSN is no longer a match candidate, so SecondHand never offers it.

## Known weak spots
- **Boxes that belong to someone else, with no context.** A family member's "Name" or "Date of Birth" in a repeated household section, or "Household Members", still match the applicant's fields. The model sees only the label, not the section it sits in.
- **Combined and ambiguous boxes.** "City and Zip Code" and "City, State and Zip code" match one of the parts. "If yes, please state the situation" matches the state. "How Many Children in household between Ages 0 - 18" matches the under-18 count.
- **Matching precision is below 0.95** on both sets (0.909 test, 0.902 holdout at 0.95).
- **Answers without their facts.** The previous model answered "No" to "Is anyone in your household 60 or older?" from facts that didn't include the applicant's age (a sensitive fact left out of the first pass). The answer happened to be right. Round 2 hasn't been re-checked for this in the app.
- **Speed.** The int8 model runs on the CPU. Each candidate is a separate pass, so a text box with about 20 candidates can take seconds on a busy machine. See the runtime spike (#37) for measurements.

## Publishing a model
The desktop app reads `latest.json` from the repo's `main` branch at startup and every 24 hours while Laya is on, and installs the model it names when that model is newer and in a format the app can run ([security.md](security.md#local-ai-with-laya)). `latest.json` has the same form as `desktop/laya-model.json`:

```json
{ "version": 1, "model": { "revision": "<commit that holds the files>", "format": "noul-v1", "files": [
  { "path": "model.onnx", "url": "https://huggingface.co/JacobTDang/secondhand-laya/resolve/<commit>/model.onnx", "size": 3820399, "sha256": "4fba842d…" }, … ] } }
```

It lists `model.onnx`, `model.onnx.data`, `tokenizer/tokenizer.json`, `tokenizer/tokenizer_config.json`, and `rl_agent_config.json`. `scripts/publish-laya-model.cjs` writes it, with the `hf` CLI logged in with write access to the repo:

1. Check what it would publish: `node scripts/publish-laya-model.cjs <export folder> --repo JacobTDang/secondhand-laya --format noul-v1 --dry-run`. It prints `latest.json` with each file's size and SHA-256, and `<commit>` in place of the commit the upload makes. Nothing is uploaded.
2. Publish: the same command without `--dry-run`, plus `--hf <path to hf>` (or `SECONDHAND_HF_CLI`) when `hf` isn't on the PATH, such as `--hf ../LayaStudio/.venv/bin/hf`. It uploads the five runtime files and gets their commit, uploads `latest.json` pinned to that commit, then reads `latest.json` back from `main` the way the app does. If `latest.json` already names the same files in the same format, it uploads nothing.
3. Update this card: the run, the results, and the file table.

A model trained on different prompts needs a new format (the round-3 model, #65, for example). Add it to `MODEL_FORMATS` in `desktop/laya-model.cjs` with the prompts it needs, release that app, then publish the model with `--format <new format>`. The script only accepts formats this checkout lists, and apps that don't list a format keep their installed model.
