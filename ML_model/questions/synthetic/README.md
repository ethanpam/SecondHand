# Synthetic rewordings (training only)

Reworded questions written to teach the model more ways forms ask the same thing. Files here have `source.kind: "synthetic"` and no URL; the dataset builder only ever puts them in training, never in the test set. Never copy a question from a test form (see the list the rewording task gives you); the test set must stay unseen.

Same format and answer rules as `../README.md`. Validate with `node --test tests/ml-question-bank.test.cjs`.
