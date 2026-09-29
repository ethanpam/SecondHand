# Evaluation

Our own checks of each trained model on held-out real forms: precision of accepted answers, how many answerable questions it answers, and wrong answers on "facts don't say" items. `--holdout` scores only the forms marked holdout, and `--exclude-holdout` every other test form, so thresholds can be chosen on forms apart from the ones they are reported on. Reports are committed; raw outputs are not. See #41.

Both dataset formats are scored the same way, per decision: a `noul-v1` dataset asks one prompt per candidate, and a `choice-v1` dataset (#65) one prompt per decision that scores all its candidates. The report names the format.

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

`page_latency.cjs` times one form page through the desktop's own request code (`desktop/field-answers.cjs`, then `desktop/field-suggestions.cjs` with the time left) and onnxruntime-node, as one Autofill click does, with the 1-minute load average beside each run:

```
node ML_model/eval/page_latency.cjs --model <export> --format choice-v1 --form <form url> --runs 30 --out <name>.json
```

The runtime comparison for #37 is in `docs/superpowers/specs/2026-09-27-laya-runtime-spike.md`.

`runtime_fixtures.py` writes the Python reference outputs that the desktop app's JavaScript Laya runtime (#38) is tested against: token ids, prompts, and int8 ONNX probabilities for a fixed sample of rows (`tests/fixtures/laya/`). Its docstring has the commands.
