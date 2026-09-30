# Dataset builder

Combines `questions/` (real forms and training-only rewordings) with fictional households from `profiles/`. For every question and household it builds the facts sheet with `shared/facts.cjs`, computes the correct answer from the question's rule, and writes LayaStudio rows: `questions.json` plus JSONL `{ state, answers, split, task, decision }`. Output goes to `dataset/out/` (git-ignored). See #41 and #65.

Two tasks:
- **answer**: choice questions, answered from the household's facts.
- **match**: text boxes, matched to a saved field.

`--format` picks the prompts (the model's `format`, see `desktop/laya-model.cjs`):
- **`choice-v1`** (#65): one `choice` row per decision, which scores every option in one pass.
  - Answering: the state is `{ facts, question }`, and the choices are the form's options plus "None of these, or the facts don't say".
  - Matching: the state is `{ question }`, and the choices are the saved fields offered for the box's type plus "None of these". Sensitive fields (date of birth, income, money on hand, medical costs) are never offered, so a date box isn't asked about at all.
  - Training boxes are also asked with fixed groups of fields (`MATCH_GROUPS`), answered "None of these" when their field isn't in the group. Validation and test boxes are asked only the way the app asks.
  - `questions.json` holds one LayaStudio question per distinct set of choices.
- **`noul-v1`** (round 2, the model the app ships): one yes/no row per candidate, with the one question in `questions.json`.

Both formats use the same decisions, households and splits. Splits are by form: about 20% of real forms, and every form marked holdout, are test; validation is about 10% of the other forms' decisions.

```
node ML_model/dataset/build.cjs --format choice-v1 --today 2026-09-26 --households 2000 --seed 7 --per-question 24
```
