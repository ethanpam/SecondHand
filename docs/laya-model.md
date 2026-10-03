# Laya model card

SecondHand's local decision model: [Laya](https://huggingface.co/convaiinnovations/laya) fine-tuned to answer food-assistance form questions from the applicant's saved facts, and to match text boxes to saved fields. It runs on the applicant's computer (#38). Training and evaluation are in `ML_model/` (#41, #65).

## Models
| | Round 2 | Round 3 (#65) | Round 4 (#65) |
|---|---|---|---|
| Format | `noul-v1`: one yes/no question per candidate | `choice-v1`: one `choice` question per form question, all its options in one pass | `choice-v2`: as `choice-v1`, with a text box described by its label and type |
| Run | `round2-lora-proper-1790530553`, from commit `5582a70` | `round3-lora-proper-1790708976`, from commit `3ecfd91` | `round4-lora-proper-1790727905`, from commit `5c5a5bc` |
| Dataset | `round2-1790530494`, SHA-256 `1064fcfe…` | `round3-1790708973`, SHA-256 `08e5410f…` | `round4-1790727902`, SHA-256 `6b5b9279…` |
| Status | Published; the desktop app ships pinned to it | Retired: never published, and the app no longer runs `choice-v1` | Exported, not published: below round 2 on the final holdout |

All three are fine-tuned from `aac6fef/laya-mlx` (revision `20aed815…`) with LayaStudio on an Apple M4 Max. The desktop app asks a model in its own format (`MODEL_FORMATS` in `desktop/laya-model.cjs`), with that format's prompts in `shared/laya-prompts.cjs` and its confidence bars in `desktop/laya-decisions.cjs`. A question is answered only when its best candidate clears the bar and beats "None of these, or the facts don't say" (text boxes: "None of these").

### Round 2 (`noul-v1`, published)
Every candidate is asked the same question: "Given the facts about the household, is the candidate the correct answer to the form question?"

The int8 ONNX export (409 MB) is published at [huggingface.co/JacobTDang/secondhand-laya](https://huggingface.co/JacobTDang/secondhand-laya) (commit `d1beee2813ce4996c50695eb604841365808f1e3`, Apache-2.0). The desktop app ships pinned to that commit (`desktop/laya-model.json`) and installs whatever newer model the repo's `latest.json` names (see [Publishing a model](#publishing-a-model)).
- Exported with `uv run --no-sync python -m layastudio.export run:round2-lora-proper-1790530553 --target onnx --precision int8`.
- The exporter checked 10 decisions against the trained model: all gave the same answer, with probabilities within 0.0007.
- The desktop runtime gives the same probabilities as Python's onnxruntime on 55 `noul-v1` decisions, to 2e-16 (`tests/laya-parity.test.cjs`, with `SECONDHAND_LAYA_NOUL_MODEL_DIR` pointing at this export).

| File | Bytes | SHA-256 |
|---|---|---|
| `model.onnx` | 3,820,399 | `4fba842d827c73f596b8f17be4a98700d258cfc43365e32898f577b365314fb8` |
| `model.onnx.data` | 421,294,080 | `af1f87d7d95ff5c72f205b81c91f414cd53bc4632d41972397b99a43a13cd741` |
| `tokenizer/tokenizer.json` | 3,583,228 | `6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30` |
| `tokenizer/tokenizer_config.json` | 308 | `50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12` |
| `rl_agent_config.json` | 1,019 | `7f4cb9dd484a70cd6352eb1efb804e5ebcc9b346e352215318aff486ced58c36` |

### Round 3 (`choice-v1`, retired)
- **Answering:** the state is `{ facts, question }`. The choices are the form's options plus "None of these, or the facts don't say", under the instruction "Given the facts about the household, which option is the correct answer to the form question?"
- **Matching:** the state is `{ question }`, the box's label. The choices are the saved fields offered for the box's type plus "None of these", under "Which saved answer belongs in the form box with this label?"
  - Text boxes are offered every field AI may suggest; number boxes the counts, costs, phone and ZIP; email and phone boxes their one field.
  - A date box is never asked, since date of birth is never offered.

The int8 ONNX export was 425.1 MB of graph and weights (428.7 MB for the folder). That local copy is not kept. Use the round 2 or round 4 export in [Local workspace](#local-workspace).
- The exporter checked one question of each task and option-count bucket against the trained model, 80 decisions in all. All gave the same answer, with probabilities within 0.014.
- The desktop runtime gave the same probabilities as Python's onnxruntime on 50 `choice-v1` decisions, to 3e-16. Round 4's `choice-v2` fixture has since replaced that one.

| File | Bytes | SHA-256 |
|---|---|---|
| `model.onnx` | 3,850,217 | `c6d9dbce3735e84ca433a9942449ebaebdb092e0ff4d86922c48d95776dcb375` |
| `model.onnx.data` | 421,294,080 | `9dac8b5c5a068446be82c8a468aa459a50b673f0a712645b8612db8288ba0a2a` |
| `tokenizer/tokenizer.json` | 3,583,228 | `6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30` |
| `tokenizer/tokenizer_config.json` | 308 | `50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12` |
| `rl_agent_config.json` | 977 | `91dfb0b6c2ef5eaede597f6e3e8b5a68cb507b72885d33e2de441dc90f0c424c` |

### Round 4 (`choice-v2`, not published)
- **Answering:** as round 3.
- **Matching:** the state is `{ question, type }`, the box's label and its type in words (`text`, `long text`, `number`, `email`, `phone`), under "Which saved answer belongs in this form box, given its label and type?" The choices are as round 3's.

The int8 ONNX export is 425.1 MB of graph and weights (428.7 MB for the folder), at `<LayaStudio>/workspace/exports/round4-lora-proper-1790727905-onnx-int8`. It was exported with `uv run --project ~/Projects/LayaStudio python ML_model/train/export.py --run round4-lora-proper-1790727905 --precision int8`.
- The exporter checked 80 decisions, one question of each task and option-count bucket: all gave the same answer as the trained model, with probabilities within 0.0005.
- The desktop runtime gives the same probabilities as Python's onnxruntime on 50 `choice-v2` decisions, to 7e-16 (`tests/laya-parity.test.cjs`, with `SECONDHAND_LAYA_CHOICE_MODEL_DIR` pointing at this export).

| File | Bytes | SHA-256 |
|---|---|---|
| `model.onnx` | 3,850,217 | `3993dc1d2a17c615e763f29a150125af2c61a8086647a94cad557ce49eac1a3b` |
| `model.onnx.data` | 421,294,080 | `916d52877749f2cbbe59f75244ea1106f961252ecc4b98aebe8e82370e35037f` |
| `tokenizer/tokenizer.json` | 3,583,228 | `6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30` |
| `tokenizer/tokenizer_config.json` | 308 | `50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12` |
| `rl_agent_config.json` | 977 | `01e49ea92e388f7f9e63b306476ed69c92dbcbe386efe36b5f53fc95bea13aa6` |

### Local workspace
Kept files are under `~/Projects/LayaStudio/workspace`:
- Exports: `exports/round2-lora-proper-1790530553-onnx-int8` (shipped `noul-v1`) and `exports/round4-lora-proper-1790727905-onnx-int8` (`choice-v2`, not published).
- Runs: `runs/round2-lora-proper-1790530553` and `runs/round4-lora-proper-1790727905`.
- Datasets: `datasets/round2-1790530494-1064fcfe` and `datasets/round4-1790727902-6b5b9279`.

## Data
Public form questions only. Households are fictional and generated in code; no real person's data is used.

| Source | Files | Questions | Use |
|---|---|---|---|
| Real forms: Google Forms, Jotform, PDF and web intake forms | 25 | 527 | training |
| Real forms, test split (by form) | 7 | 129 | test |
| Real forms marked holdout (collected after the first model) | 7 | 124 | test, and scored on their own |
| Synthetic rewordings (`questions/synthetic/`) | 11 | 883 (757 before round 4) | training only |
| Final holdout (`questions-final/`, collected after round 3) | 15 | 394 | scored once, after round 4's bars were frozen |

- Every label is computed by code from the question's answer rule and the facts sheet (`shared/facts.cjs`). No label is written by hand.
- Tests keep every held-out and test form out of training and validation (`tests/ml-dataset-choice.test.cjs`), and keep synthetic questions from repeating a test or held-out label (`tests/ml-question-bank.test.cjs`).
- The three rounds use the same question bank, households, decisions and splits (`node ML_model/dataset/build.cjs --format <format> --today 2026-09-26 --households 2000 --seed 7 --per-question 24`). Round 3 adds training-only matching rows that offer fixed groups of fields, so the model learns to answer "None of these" when a box's field isn't on offer.
- Round 4 adds 126 training-only rewordings, each tag reviewed, in four files:
  - `coverage-vs-applying.json` (34): coverage and benefits held now, which the facts never settle, next to programs applied for;
  - `applicant-vs-household.json` (36): the applicant alone, the whole household, or one other member (veteran, disability, citizen, age);
  - `apply-for-rows.json` (14): a household table's "Applying?" column, with a new rule, `applyingFor`, that answers from the programs the form covers;
  - `text-box-negatives.json` (42): combined boxes, other members' and proxies' boxes, counts over other age ranges, and short labels only the box type settles ("Contact" as an email box or a phone box).
- `shared/facts.cjs` is unchanged: the shipped round-2 model reads the same facts sheet.

| Dataset | Rows | After balancing | Train | Validation | Test |
|---|---|---|---|---|---|
| Round 2 (a row per candidate) | 118,204 | 90,365 | 67,461 | 7,735 | 15,169 |
| Round 3 (a row per decision) | 22,135 | 14,639 | 11,252 | 1,220 | 2,167 |
| Round 4 (a row per decision) | 24,427 | 15,947 | 12,440 | 1,340 | 2,167 |

Round 3's trainer skipped 23 training rows and 2 validation rows (round 4's: 25 and 3). Their questions ("Country", with 215 and 250 options) don't fit Laya's 512-token window. The desktop never sends a question with more than 30 options.

## Training
| Setting | Round 2 | Round 3 | Round 4 |
|---|---|---|---|
| Method | LoRA, rank 16, alpha 32, dropout 0.05, top 4 layers fully trained | same | same |
| Objective | proper, balanced class weighting | same | same |
| Epochs, updates | 1 epoch, 4,217 updates | 3 epochs, 2,106 updates (batch 8, gradient accumulation 2) | 3 epochs, 2,328 updates |
| Learning rate | 2e-4 (head 1e-4), warmup 6%, weight decay 0.01 | same | same |
| Precision | bfloat16 (load it in bfloat16; float16 overflows) | same | same |
| Time, peak memory | 3.4 hours, 3.2 GB | 2.0 hours, 3.5 GB | 1.6 hours, 3.5 GB |
| Validation | loss 0.027, accuracy 0.993 (per candidate) | loss 0.058, accuracy 0.989 (per decision; 0.971, 0.987 and 0.989 after epochs 1–3) | loss 0.033, accuracy 0.992 (0.973, 0.986 and 0.992 after epochs 1–3) |
| Calibration error (ECE) | 0.0045 before, 0.0013 after | 0.0104 before, 0.0055 after | 0.0055 before, 0.0026 after |

The `choice` calibration temperatures are fitted per option count:

| Choices | 2 | 3–5 | 6–10 | 11+ |
|---|---|---|---|---|
| Round 3 | 0.50 | 1.38 | 1.77 | 1.99 |
| Round 4 | 0.50 | 1.12 | 1.93 | 1.60 |

- The 11+ bucket is no longer clamped (round 2's was 0.10).
- The 2-choice bucket (a lone checkbox, or an email or phone box) is fitted at the search's lower bound, 0.5, so it sharpens those scores.

LayaStudio's own test accuracy is 0.947 per decision for round 3 and 0.964 for round 4, against 0.41 for the base model (McNemar, round 4: 1,214 fixed, 14 broken).

## Results
Scored with `ML_model/eval/decisions.py`, per question. **Precision** is right answers ÷ answers filled; **coverage** is right answers ÷ questions the answer key says are answerable.

The answer key is frozen: questions no answer rule reads are tagged `none`. So a fill the key calls wrong counts as right only when the household's facts prove it (the #41 method). The fills proved right are:
- "Are there other members in your household in addition to yourself?" answered Yes for households of 2 or more and No for 1;
- "Does your household have more than 8 members?" answered No for households of 1–7;
- Iowa's "Apply for?" (the applicant's own row) answered Yes when the applicant applies for SNAP or FIP;
- "Please select the age range of those living in your household" checked the applicant's own band.

### Round 4: the pool, and how its bars were chosen
Round 3's errors were found on the 7 held-out forms, so they can't judge round 4. They join the other test forms in the pool the bars are chosen on (the whole test split: 2,016 choice decisions, 164 answerable; 151 text boxes, 70 answerable). A new final holdout, collected after round 3, judges round 4 once.

The rule, set before scoring: each bar is the lowest in a fixed list at which the int8 scores' #41 precision on the pool reaches 0.95. The answering list is 0.9, 0.95, 0.97, 0.98, 0.99, 0.992 and 0.995; the matching list is 0.9, 0.95, 0.96, 0.97, 0.975, 0.98, 0.985 and 0.99.
- **Answering: 0.9**, at 0.959.
- **Matching: 0.999.** No bar in the list reaches 0.95 (the best is 0.925, at 0.99), and none does up to 0.999. The rule was then extended to the bar with the best precision: 0.999, at 0.941.

| Model | Runtime | Bar | Filled | Right by key | Right by facts | Wrong | Precision (#41) | Coverage |
|---|---|---|---|---|---|---|---|---|
| **Answering** | | | | | | | | |
| Round 2 | MLX bf16 | 0.9 | 171 | 128 | 43 | 0 | **1.000** | 0.780 |
| Round 3 | ONNX int8 | 0.9 | 179 | 125 | 39 | 15 | **0.916** | 0.762 |
| Round 4 | MLX bf16 | 0.9 | 197 | 153 | 38 | 6 | **0.970** | 0.933 |
| Round 4 | ONNX int8 | 0.9 | 194 | 147 | 39 | 8 | **0.959** | 0.896 |
| **Matching** | | | | | | | | |
| Round 2 (every field) | MLX bf16 | 0.95 | 77 | 70 | 0 | 7 | **0.909** | 0.854 |
| Round 3 | ONNX int8 | 0.98 | 35 | 35 | 0 | 0 | **1.000** | 0.500 |
| Round 4 | ONNX int8 | 0.99 | 53 | 49 | 0 | 4 | 0.925 | 0.700 |
| Round 4 | ONNX int8 | 0.999 | 17 | 16 | 0 | 1 | **0.941** | 0.229 |

- **Round 3's error is gone.** "Type of Health Care Coverage" isn't answered "Medicaid" any more.
- **Round 4's wrong answers** (int8, 0.9):
  - 5 × "I am filling this form out for?" answered "…for Me and My Household": who the form is for isn't in the profile;
  - 2 × Iowa's "Apply for?" answered No: the form also covers RCA, which the profile doesn't record;
  - 1 × "Does your household have more than 8 members?" answered Yes.
- **"Facts don't say" fills.** 47 of round 4's fills are on questions the key marks "facts don't say": 39 are proved right and 8 are wrong, 0.4% of the 1,852 such questions.
- **Round 4's wrong matches** are count boxes over other age ranges or groups: "Children between Ages 0 - 18", "Children 0-5", "Children 6-18", "children who attend Stephen Decatur", "Adults 19 - 64", and "Household Members". They score 0.99–0.999, as high as the saved counts, so no bar separates them. At 0.999 one is left: "How Many Children in household between Ages 0 - 18".

### Round 3's bars
On the int8 scores of the test forms that aren't held out (`--exclude-holdout`), round 3's bars are:
- **Answering: 0.9.** Precision 0.970, coverage 0.812. 0.8 only just reaches 0.95, at 0.954.
- **Matching: 0.98**, the lowest bar that reaches 0.95 there: precision 1.000, coverage 0.645. 0.975 gives 0.909.

Round 3's held-out forms were then scored once, below. Round 2's bars were chosen in #41. Held-out numbers use `--today 2026-09-26 --households 400 --seed 11 --per-question 8`: 368 choice decisions (17 answerable) and 71 text boxes (39 answerable, date boxes left out).

### The 7 held-out forms (round 4: part of the pool)
| Model | Runtime | Bar | Filled | Right by key | Right by facts | Wrong | Precision (#41) | Coverage |
|---|---|---|---|---|---|---|---|---|
| **Answering** | | | | | | | | |
| Round 2 | MLX bf16 | 0.9 | 23 | 13 | 10 | 0 | **1.000** | 0.765 |
| Round 2 | ONNX int8 | 0.9 | 22 | 12 | 10 | 0 | **1.000** | 0.706 |
| Round 3 | MLX bf16 | 0.9 | 26 | 14 | 10 | 2 | **0.923** | 0.824 |
| Round 3 | ONNX int8 | 0.9 | 23 | 11 | 10 | 2 | **0.913** | 0.647 |
| Round 4 | ONNX int8 | 0.9 | 22 | 14 | 6 | 2 | 0.909 | 0.824 |
| **Matching** (as the app asks) | | | | | | | | |
| Round 2 | MLX bf16 | 0.95 | 34 | 31 | 0 | 3 | **0.912** | 0.795 |
| Round 2 | ONNX int8 | 0.95 | 35 | 31 | 0 | 4 | **0.886** | 0.795 |
| Round 3 | MLX bf16 | 0.98 | 15 | 15 | 0 | 0 | **1.000** | 0.385 |
| Round 3 | ONNX int8 | 0.98 | 15 | 15 | 0 | 0 | **1.000** | 0.385 |
| Round 4 | ONNX int8 | 0.999 | 10 | 9 | 0 | 1 | 0.900 | 0.231 |

- **"Facts don't say" fills.** Round 3 int8 filled 12 of the 351 answering questions the key marks "facts don't say". 10 are proved right; 2 (0.6%) are wrong. Round 2's 10 such fills are all proved right.
- **Round 3's wrong answers.** "Type of Health Care Coverage" (a check-all list: Medicaid, Medicare, Private Insurance, Uninsured) is answered "Medicaid" at 0.93–0.997 whenever the facts say "The applicant is applying for Medicaid health coverage." Applying is not having coverage. No bar removes it.
- **Round 2's matching score as the app asks** leaves out the fields the app never offers (date of birth, income, money on hand, medical costs). Scored with every field, as in #41, it is 0.902 precision and 0.787 coverage of 47 boxes. `decisions.py --as-app-asks` now scores what the app asks from its own code (see Speed).
- **At a 0.97 matching bar**, round 3 int8 would reach 0.952 precision and 0.513 coverage on the held-out forms. That bar wasn't chosen, because on the other test forms it gives 0.875.

Round 4's two wrong answers here are "I am filling this form out for?"; its wrong match is "Children between Ages 0 - 18".

### Final holdout
Fifteen real forms (394 questions) collected after round 3, re-checked against their live pages, tagged, and merged after round 4's bars were frozen in `0f636a4`. They were scored once, with no change to bars, data or prompts afterwards. The build is `node ML_model/dataset/build.cjs --final --format <format> --today 2026-09-26 --households 400 --seed 11 --per-question 8`.
- 1,232 choice decisions. Only 11 questions are answerable by the key, which makes 59 answerable decisions.
- 222 text boxes (240 in `noul-v1`, which also asks date boxes), 81 answerable.
- Confidence intervals are Wilson 95% intervals over decisions. A question's households share one question, so the real uncertainty is wider than they show.

| Model | Runtime | Bar | Filled | Right by key | Right by facts | Wrong | Key precision (95% CI) | #41 precision (95% CI) | Coverage |
|---|---|---|---|---|---|---|---|---|---|
| **Answering** | | | | | | | | | |
| Round 2 | ONNX int8 | 0.9 | 72 | 57 | 10 | 5 | 0.792 (0.68–0.87) | **0.931** (0.85–0.97) | 57/59 = 0.966 |
| Round 2 | MLX bf16 | 0.9 | 72 | 57 | 10 | 5 | 0.792 (0.68–0.87) | **0.931** (0.85–0.97) | 0.966 |
| Round 4 | ONNX int8 | 0.9 | 79 | 49 | 13 | 17 | 0.620 (0.51–0.72) | **0.785** (0.68–0.86) | 49/59 = 0.831 |
| Round 4 | MLX bf16 | 0.9 | 79 | 51 | 13 | 15 | 0.646 (0.54–0.74) | **0.810** (0.71–0.88) | 0.864 |
| **Matching** (as the app asks) | | | | | | | | | |
| Round 2 | ONNX int8 | 0.95 | 68 | 59 | 0 | 9 | 0.868 (0.77–0.93) | **0.868** | 59/81 = 0.728 |
| Round 2 | MLX bf16 | 0.95 | 66 | 58 | 0 | 8 | 0.879 (0.78–0.94) | **0.879** | 0.716 |
| Round 4 | ONNX int8 | 0.999 | 17 | 16 | 0 | 1 | 0.941 (0.73–0.99) | **0.941** | 16/81 = 0.198 |
| Round 4 | MLX bf16 | 0.999 | 15 | 14 | 0 | 1 | 0.933 (0.70–0.99) | **0.933** | 0.173 |

**Right by the facts** (the key tags these `none`; the facts settle them; the same rules for both rounds):
- Vermont's "U.S. citizen?" for another member: Yes when everyone in the household is a citizen.
- Vermont's "Disabled?" for another member: No when nobody in the household has a disability.
- "Does anyone pay over $35 a month in medical expenses?": from the saved amount.
- "Does anyone have income?": from the saved income.
- "Do you pay rent or room rent?": No when the household pays no rent or mortgage.
- "Do you pay for utilities?": from the saved amount.

**Round 4's wrong answers** (int8, 17, on 5 questions):
- 7 × "Anyone in your household elderly and/or disabled?" answered No. Three of those households have someone 65 or older, and the others could have someone 60 to 64.
- 5 × Vermont's "Do you own your home?" answered Yes. Nothing in the profile says so.
- 3 × Vermont's "Due to disability?" (whether one income is due to a disability) answered No.
- 1 × Oregon's active-duty question answered "No, never served in the U.S. Armed Forces". The facts can't pick between its two "No" choices.
- 1 × "Are you interested in applying for SNAP, Medicaid, Medicare or LIHEAP?" answered "All of the above", for an applicant who applies only for SNAP.

**Round 2's wrong answers** (int8, 5, on 4 questions):
- 2 × "elderly and/or disabled?" answered No.
- 1 × "Have you or anyone in your household recently applied for SNAP?" answered No.
- 1 × "…at least one shelter/utility expense?" answered No, for a household paying rent.
- 1 × the interest question answered "SNAP".

**Wrong matches:**
- Round 4 (1): Vermont's "Phone number:" for the person who helped fill in the form.
- Round 2 (int8, 9):
  - someone else's name or phone;
  - "Street Address (If Different)";
  - combined name boxes answered with one part ("…& suffix" answered with the suffix, "NOMBRE - NAME" with the last name);
  - "CIUDAD-CITY" answered with the county;
  - "Who pays the rent?" answered with the rent amount;
  - "Number of adults in household (including yourself)" answered with the count of adults 18 to 64. This is the one borderline tag: counted as right, round 2's int8 matching precision is 60/68.

**"Facts don't say" fills.** Round 4 int8 filled 30 of the 1,173 questions the key marks "facts don't say": 13 are proved right and 17 are wrong (1.4%). Round 2 filled 15: 10 right and 5 wrong (0.4%).

**Summary.** On forms neither round was tuned on, round 4 answers less precisely than round 2 (0.785 against 0.931) and matches far fewer boxes (20% against 73%), though more precisely (0.941 against 0.868). Its errors are confident answers to yes/no questions about property, income sources and other members that its facts don't settle. Both rounds now decide a 20-question page within the 3-second budget: round 4 in 1.6 s, and round 2 in 2.7 s since #81's speed work (see Speed).

### Round 3 on the test split (every test form, including the held-out ones: 2,016 decisions, 151 boxes)
Round 3, ONNX int8:
- **Answering at 0.9:** 179 filled, 125 right by key, 39 right by facts, 15 wrong: precision 0.916, coverage 0.762 of 164. The wrong answers are 12 "Type of Health Care Coverage" → Medicaid, 2 "Apply for?" → Yes (the applicant applies only for Medicaid), and 1 "Veteran" → Yes (the question is about the applicant, and someone in the household is a veteran).
- **Matching at 0.98:** 35 filled, 0 wrong: precision 1.000, coverage 0.500 of 70.

On the held-out forms, int8 moves 1.1% of round 3's answering probabilities by more than 0.05 from MLX, and 0.5% of its matching ones (round 2: 0.3% and 0.9%). On the pool, it moves 0.7% of round 4's answering probabilities and 0.9% of its matching ones.

The reports are in `ML_model/eval/reports/`: `round4-3epoch.json` (MLX), `round4-onnx-int8-*.json`, and the round 2 and round 3 reports.

## Speed
One 20-question page through the desktop's own request code (`ML_model/eval/page_latency.cjs`: `field-answers.cjs`, then `field-suggestions.cjs` with the time left) and onnxruntime-node on the CPU of an Apple M4 Max (10 performance and 4 efficiency cores, 36 GB). The page is the Utica Food Pantry intake form (held out), household 0: 6 choice questions and 14 text boxes.

| Model | 1-min load before (during) | Model load | p50 | p95 | Max | Pages fully decided within 3 s |
|---|---|---|---|---|---|---|
| **Round 2 (`noul-v1`), this app** | 2.98 (3.2–9.2) | 491 ms | **2,723 ms** | 2,820 ms | 2,954 ms | **30 of 30**: all 15 question passes |
| Round 2 before (`c9199b3`), timed beside it | 4.23 (to 6.8) | 476 ms | 3,234 ms | 3,295 ms | 3,296 ms | 0 of 30: 8–9 of its 23 question passes fit |
| Round 4 (`choice-v2`) | 2.83 (to 6.7) | 463 ms | 1,644 ms | 1,705 ms | 1,711 ms | 30 of 30: all 21 question passes |
| Round 3 (`choice-v1`) | 2.99 (to 8.5) | 443 ms | 1,586 ms | 1,603 ms | 1,624 ms | 30 of 30: all 21 question passes |
| Round 2 before, first timing | 8.55 (to 9.5), right after round 3 | 465 ms | 3,178 ms | 3,215 ms | 3,219 ms | 0 of 30: 9 of its 23 question passes fit |

- Round 2's times before are the 3-second budget running out. Its whole page took 10.8 s.
- The load average counts the benchmark's own onnxruntime threads, which is why it rises during a run. The 1-minute load was 2.4 when the run before started and 3.0 when the run after did.
- Windows was not measured.
- The reports are `round2-latency-page-utica-speed.json` and `round2-latency-page-utica-main-quiet.json`, beside `round2-latency-page-utica.json`, `round3-latency-page-utica.json` and `round4-latency-page-utica.json`.
- A round-2 page is now 15 question passes: 2 choice questions with facts that need no permission, the same 2 again with every fact, and 11 text boxes. "New Client:", "Existing Client:" and "Is this your first time receiving food this year?" name nothing the facts cover, so they aren't asked. "Type of ID" and the signature box never reach Laya, and the two date boxes aren't asked.
- A round-3 or round-4 page is 21 question passes: the 5 open choice questions without sensitive facts, the same 5 again with every fact (none was answered in the first pass), and 11 text boxes.

### Where round 2's time went, and what changed (#81)
Before, a 20-question page was 304 rows of about 91 tokens (61 to 281) through the model: each of 13 text boxes asked about all 19 saved fields and abstaining (260 rows), and each of the 5 choice questions asked about each option and abstaining, twice (44 rows, with the facts sheet).
- **Profile.** Nearly all the time is onnxruntime running the model. Tokenizing all 304 rows takes 11 ms and padding them into batches 1 ms; the model process's messages and the awaits between requests are negligible.
  - In a run, the int8 matrix products (`DynamicQuantizeMatMul`) take 55–60% of the time, layer norms 8%, and transposes, `Where`, splits and other small operators the rest.
  - One session uses the CPU poorly. A batch of 8 short rows takes 444 ms on 1 thread and 190 ms on 10, only 2.3 times faster: its matrix products run 1.7 times faster, and its transposes slower. onnxruntime's own choice of 14 threads takes 210 ms; the efficiency cores slow it down.
  - Padding wastes 3% of the tokens, so sorting rows by length across requests would gain little.

The whole page with no budget, through the desktop runtime, adding one change at a time (the median of three runs each, at a 1-minute load of 3.1 to 4.9):

| Change | Rows | Answering | Matching | Page |
|---|---|---|---|---|
| Before: every saved field for every text box, one session | 304 | 4.1 s | 6.7 s | 10.8 s |
| A text box is asked only the saved fields its label names, and a date box isn't asked | 103 | 4.0 s | 1.6 s | 5.7 s |
| Two onnxruntime sessions, 5 threads each, running batches at once | 103 | 3.0 s | 1.0 s | 4.0 s |
| A choice question that names nothing the facts cover isn't asked | 85 | 1.7 s | 1.0 s | 2.7 s |

- **Text boxes** (`offeredFields`, `shared/laya-prompts.cjs`). A box is offered the groups of saved fields its label names: names, email and phone, address, household counts, housing costs. A label that names none is offered every field, and a date box none, since date of birth is never offered. The groups were chosen on the training labels, where they keep every answerable box's field.
- **Two sessions** (`desktop/laya.cjs`, `desktop/laya-worker.cjs`). On a Mac with 8 or more performance cores and 16 GB or more, the model process runs two sessions, each on a worker thread with half of the performance cores. Batches run in the order asked, two at a time. The noul-v1 callers ask all of a pass's questions at once, and each request ends when the click's time does. The batches are the same as before, so every score is too. A smaller Mac runs one session on its performance cores. Elsewhere one session runs with onnxruntime's own thread count, as before.
  - 2 sessions of 7 threads, which use the efficiency cores too, take 4.7–5.0 s. 3 sessions take 3.7–4.1 s, for a third copy of the weights.
  - The model process holds about 1 GB loaded and 2 GB while deciding, against 0.5 GB and 1.3 GB with one session.
- **Choice questions** (`factsCover`, `shared/laya-prompts.cjs`). A question is asked only when its label or options name a topic the facts sheet covers: the household and its members' ages, veterans, disability, pregnancy, Medicare, citizenship, home and place, income, housing costs, money on hand, medical costs, and programs applied for. The facts sheet itself is unchanged. The words were chosen on the training questions, where every question with an answer rule names its topic.

#### Accuracy
The changes to text boxes and choice questions change what the model is asked, so `decisions.py --as-app-asks` scores what the app asks: `app_offers.cjs` runs the app's own `offeredFields` and `factsCover` on each decision. A choice question the app doesn't ask stays counted, and unfilled. The two-session runtime changes no input: the desktop gives the same probabilities as Python's onnxruntime on round 2's export to 1.2e-16 (`tests/laya-parity.test.cjs`).

| Set | Task | Bar | Before | After |
|---|---|---|---|---|
| Test pool | Answering | 0.9 | 157 filled, 119 right by key, 38 wrong by key | the same |
| Test pool | Matching | 0.95 | 68 filled, 60 right, 8 wrong (precision 0.882, coverage 60/70) | the same |
| Final holdout | Answering | 0.9 | 72 filled, 57 right by key, 15 wrong by key (#41 precision 0.931, coverage 57/59) | the same |
| Final holdout | Matching | 0.95 | 68 filled, 59 right, 9 wrong (precision 0.868, coverage 59/81) | the same |

- **Every bar.** Answering is the same at every bar in the reports, on both sets. The questions not asked are ones the facts never settled: on the test pool and the final forms every question with an answer rule is still asked, and none of the ones left out was ever filled.
- **The app's own rules.** With the app's two passes and its rule that the best answer must beat the runner-up by 0.5, no decision changes either, on either set. The app asks 19% fewer choice questions on the test pool and 26% fewer on the final forms. For text boxes, no candidate scoring 0.45 or more is ever left out, and matching rows fall by 63% and 58%.
- Every text box keeps its saved field in every split: 246 of 246 in training, 27 of 27 in validation, 70 of 70 on the test pool, 81 of 81 on the final forms.
- The reports are `round2-onnx-int8-test-app.json` and `round2-onnx-int8-final-app.json` (after), `round2-onnx-int8-test-answer.json` (the test pool's answering before) and `round2-onnx-int8-final.json` (the final's before). The test pool's matching before, and the app's own rules on both tasks, come from the same int8 scores: each text-box label's rows scored once, and the answering rows with and without sensitive facts.
- The answering scores were made in single-thread processes, each running whole batches of 16 in dataset order, so every batch is the one `decisions.py` would run, and the reports were rebuilt from them with `--probs`. Rebuilt this way, the final's answering report matches its earlier one at every bar.

#### Tried and not shipped
Both change what the model reads, and both lose answers on the final forms (the app's two passes and rules):
- **Every fact first.** Ask every question with every fact, then ask only the answered ones again without sensitive facts. It saves the first pass, but drops answers that only the first pass gives. On the final forms it loses "How many people do you live with" (7) and "County" (Clinton), right by key, and "Do you pay rent" (No), right by the facts: coverage 57/59 to 55/59.
- **Each question asked with only the facts on its topics.** Rows get 4–5 times shorter, but the model needs the whole sheet. With only "Everyone in the household is a US citizen." it no longer answers "Are you a U.S. citizen?", and the same holds for disability and age. On the final forms coverage falls from 57/59 to 43/59 and precision by key from 0.770 to 0.705.

## Known weak spots
- **Choice questions in another language only (round 2).** Round 2 asks a choice question only when its words name a topic the facts cover, and those words are English. A question written only in Spanish, say, isn't asked and goes to the applicant. Every question in the question bank that uses another language also has English, so none of the test or final forms shows the effect.
- **Confident answers the facts don't settle (round 4, final holdout).** Yes/no questions about home ownership, income sources, "elderly and/or disabled" and other members are answered at 0.93–1.00. Its answering precision on the final forms is 0.785.
- **Count boxes over other age ranges or groups (round 4).**
  - "Children 0-5", "Adults 19 - 64" and "children who attend a school" match the saved counts at 0.99–0.999. That's why no match bar reaches 0.95 on the pool.
  - At the 0.999 bar round 4 matches only 23% of the pool's answerable boxes, below the 50% target.
  - Round 3 matched none of these at its 0.98 bar, with 50% coverage. At 0.99, round 4 matches 70%, 4 of them wrong.
- **Who the form is for, and forms that cover programs the profile doesn't record (round 4).** "I am filling this form out for?" is answered "Me and My Household", and Iowa's "Apply for?" No (the form also covers RCA).
- **Boxes that belong to someone else, with no context.**
  - A family member's "Name" or "Date of Birth" in a repeated household section, or "Household Members", can still match the applicant's fields below the bar.
  - No round sees the section heading a box sits under. The question bank doesn't record sections, and round 4 skipped them.
- **Combined and ambiguous boxes.** "City and Zip Code" and "City, State and Zip code" can match one of the parts below the bar.
- **Answers without their facts.** The first pass leaves sensitive facts out, such as the applicant's age. The previous model answered "No" to "Is anyone in your household 60 or older?" from facts without the age. The answer happened to be right.
- **Fixed in round 4.**
  - "Applying for Medicaid" is no longer read as Medicaid coverage.
  - The box type now settles short labels: "Where can we reach you?" in an email box is matched to the email address.

## Publishing a model
The desktop app reads `latest.json` from the repo's `main` branch at startup and every 24 hours while Laya is on. It installs the model `latest.json` names when that model is newer and in a format the app can run ([security.md](security.md#local-ai-with-laya)). `latest.json` has the same form as `desktop/laya-model.json`:

```json
{ "version": 1, "model": { "revision": "<commit that holds the files>", "format": "noul-v1", "files": [
  { "path": "model.onnx", "url": "https://huggingface.co/JacobTDang/secondhand-laya/resolve/<commit>/model.onnx", "size": 3820399, "sha256": "4fba842d…" }, … ] } }
```

It lists `model.onnx`, `model.onnx.data`, `tokenizer/tokenizer.json`, `tokenizer/tokenizer_config.json`, and `rl_agent_config.json`. `scripts/publish-laya-model.cjs` writes it, with the `hf` CLI logged in with write access to the repo:

1. Check what it would publish: `node scripts/publish-laya-model.cjs <export folder> --repo JacobTDang/secondhand-laya --format <format> --dry-run`. It prints `latest.json` with each file's size and SHA-256, and `<commit>` in place of the commit the upload makes. Nothing is uploaded.
2. Publish: the same command without `--dry-run`, plus `--hf <path to hf>` (or `SECONDHAND_HF_CLI`) when `hf` isn't on the PATH, such as `--hf ../LayaStudio/.venv/bin/hf`.
   - It uploads the five runtime files and gets their commit, then uploads `latest.json` pinned to that commit.
   - It then reads `latest.json` back from `main` the way the app does.
   - If `latest.json` already names the same files in the same format, it uploads nothing.
3. Update this card: the run, the results, and the file table.

A model trained on different prompts needs a new format. Add it to `MODEL_FORMATS` in `desktop/laya-model.cjs` with the prompts and confidence bars it needs, release that app, then publish the model with `--format <new format>`.
- The script only accepts formats this checkout lists.
- Apps that don't list a format keep their installed model.
- `choice-v2` is listed, so publishing a `choice-v2` model switches apps with this code over to it. Older apps ignore it. `choice-v1` (round 3) was never published and is no longer listed.
- A development build runs a local export with `SECONDHAND_LAYA_MODEL_DIR=<export> SECONDHAND_LAYA_MODEL_FORMAT=<format>`.
