# ML_model

Training and evaluation for SecondHand's local AI: a [Laya](https://huggingface.co/convaiinnovations/laya) decision model, fine-tuned to answer food-assistance form questions from the applicant's saved facts. It runs on the applicant's computer and is free; nothing about the applicant leaves the machine. The plan is in epic #36; training is #41.

## How a training example is made
1. **A real question** from a public form, copied into `questions/` and tagged with an answer rule.
2. **A fictional household**, run through `shared/facts.cjs`. The app uses that same file at runtime to turn a saved profile into plain facts, and all math happens there.
3. **The correct answer**, computed by code from the rule and the facts. No person or AI guesses the labels.
4. **One example per candidate answer.** The state holds the facts, the form question and one candidate, and the fixed yes/no question is "Is this candidate the correct answer, given the facts?"

## Layout
| Path | What |
|---|---|
| `answer-rules.cjs` | The answer rules a question can be tagged with |
| `question-bank.cjs` | Loads and validates `questions/` |
| `questions/` | One JSON file per real public form ([collecting rules](questions/README.md)) |
| `profiles/` | Generator for fictional households |
| `dataset/` | Builds LayaStudio training rows from questions × households |
| `train/` | Local fine-tuning with LayaStudio on Apple Silicon |
| `eval/` | Our own accuracy and calibration checks on held-out forms |

Generated datasets, training runs, and model files are git-ignored. Only code, the question bank, and reports are committed.

## Rules
- **No real personal data**, ever. Forms come in blank, and households are fictional.
- **Test forms are real forms the model never trained on.** Splits are by form, not by question.
- **Free and local.** Training runs on a Mac with LayaStudio (`~/Projects/LayaStudio`), with no paid or cloud GPUs.
