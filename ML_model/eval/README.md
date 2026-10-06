# Evaluation

Our own checks of each trained model on held-out real forms: precision of accepted answers, how many answerable questions it answers, and wrong answers on "facts don't say" items. `--holdout` scores only the forms marked holdout, and `--exclude-holdout` every other test form, so thresholds can be chosen on forms apart from the ones they are reported on. `--final` scores a dataset built with `build.cjs --final` and refuses one without the final holdout's forms. Reports are committed; raw outputs are not. See #41.

Both dataset formats are scored the same way, per decision: a `noul-v1` dataset asks one prompt per candidate, and a `choice-v2` dataset (#65) one prompt per decision that scores all its candidates. The report names the format.

```
uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --model <LayaStudio>/workspace/runs/<run>/model --report ML_model/eval/reports/<name>.json
uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval
```

Models load in the precision they were trained in (from their `laya_finetune.json`). laya-mlx's float16 default overflows on bfloat16-trained models.

Every report also writes each row's probability next to it (`<name>.probs.json`). Use it to compare runtimes row by row, or to rebuild a report without scoring again:

```
# An ONNX export on the CPU, compared with an earlier MLX scoring of the same rows
uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --runtime onnx --onnx <LayaStudio>/workspace/exports/<export> \
    --reference-probs mlx=<mlx report>.probs.json --report <name>.json
# The same report again from its saved probabilities
uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --runtime onnx --onnx <export> --probs <name>.probs.json --report <name>.json
# CPU latency and peak memory for one 20-question form page
uv run --project ~/Projects/LayaStudio python ML_model/eval/latency_onnx.py --onnx <export> --dataset <built dataset> --form <form url> --out <name>.json
```

A `noul-v1` dataset asks every text box about every saved field, and every choice question. `--as-app-asks` scores what the desktop app asks (`app_offers.cjs`, which runs the app's own `offeredFields` and `factsCover`): each box only on the fields it is offered (a date box isn't asked, and a box whose answer isn't offered is right only by abstaining), and only the choice questions the app asks (one it doesn't ask stays counted, and is never filled). `--task answer` or `--task match` scores one task:

```
uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --runtime onnx --onnx <export> --dataset <noul-v1 dataset> --final --as-app-asks --task match --report <name>.json
```

`page_latency.cjs` times one form page through the desktop's own request code (`desktop/field-suggestions.cjs`, then `desktop/field-answers.cjs` with the time left) and onnxruntime-node, as one Autofill click does, with the 1-minute load average beside each run:

```
node ML_model/eval/page_latency.cjs --model <export> --format choice-v2 --form <form url> --runs 30 --out <name>.json
```

`app_accuracy.cjs` fills the final holdout through the desktop's own request code with a real export, one fictional household's choice question at a time and each form's text boxes at once, and checks every fill against the answer key (#143). It builds the holdout as the reports above did (400 households, seed 11, 8 per question) and leaves out the click's time limit, so a busy computer answers the same. `WRONG_FILL_BUDGETS` is the share of each task's decisions a format may fill wrong; `tests/laya-parity.test.cjs` runs the same check with `SECONDHAND_LAYA_ACCURACY=1`. The measured runs are `round2-onnx-int8-final-app-fills.json` and `round4-onnx-int8-final-app-fills.json`.

```
node ML_model/eval/app_accuracy.cjs --model <export> --format noul-v1 --out <name>.json
```

The runtime comparison for #37 is in `docs/superpowers/specs/2026-09-27-laya-runtime-spike.md`.

`runtime_fixtures.py` writes the Python reference outputs that the desktop app's JavaScript Laya runtime (#38) is tested against: token ids, prompts, and int8 ONNX probabilities for a fixed sample of rows. There is one file per model format: `tests/fixtures/laya/parity-noul.json` from round 2's export (the shipped model) and `parity-choice.json` from a `choice-v2` export. Each file names the checkpoint it came from. Its docstring has the commands. `tests/laya-parity.test.cjs` checks each against its own export and skips a format whose export isn't given:

```
SECONDHAND_LAYA_NOUL_MODEL_DIR=<LayaStudio>/workspace/exports/round2-lora-proper-1790530553-onnx-int8 \
SECONDHAND_LAYA_CHOICE_MODEL_DIR=<LayaStudio>/workspace/exports/round4-lora-proper-1790727905-onnx-int8 \
  node --test tests/laya-parity.test.cjs
```
