# Dataset builder

Combines `questions/` with fictional households from `profiles/`. For every question and household it builds the facts sheet with `shared/facts.cjs`, computes the correct answer from the question's rule, and writes LayaStudio rows (`questions.json` plus JSONL `{ state, answers, split }`), with splits by form. Output goes to `dataset/out/` (git-ignored). See #41.
