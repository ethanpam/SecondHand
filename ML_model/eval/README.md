# Evaluation

Our own checks of each trained model on held-out real forms: precision of accepted answers, how many answerable questions it answers, wrong answers on "facts don't say" items, and calibration. These verify LayaStudio's reports. Reports are committed; raw outputs are not. See #41.

```
uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --model <LayaStudio>/workspace/runs/<run>/model --report ML_model/eval/reports/<name>.json
uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval
```

Models load in the precision they were trained in (from their `laya_finetune.json`). laya-mlx's float16 default overflows on bfloat16-trained models.
