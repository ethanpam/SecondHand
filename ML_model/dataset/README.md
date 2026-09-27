# Dataset builder

Combines `questions/` (real forms and training-only rewordings) with fictional households from `profiles/`. For every question and household it builds the facts sheet with `shared/facts.cjs`, computes the correct answer from the question's rule, and writes LayaStudio rows: `questions.json` plus JSONL `{ state, answers, split, task, decision }`. Output goes to `dataset/out/` (git-ignored). See #41.

Two tasks:
- **answer**: choice questions. One row per option plus "None of these, or the facts don't say", with the household's facts.
- **match**: text boxes. One row per saved field that could fill the box, plus the same abstain candidate.

Splits are by form: about 20% of real forms, and every form marked holdout, are test; validation is about 10% of the other forms' decisions.

```
node ML_model/dataset/build.cjs --today 2026-09-26 --households 2000 --seed 7 --per-question 24
```
