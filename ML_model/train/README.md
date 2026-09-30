# Training

Fine-tunes Laya locally on Apple Silicon with [LayaStudio](https://github.com/biplovgautam/LayaStudio) (`~/Projects/LayaStudio`), driven by `run.py` through `layastudio.engine.train`. It imports `dataset/out/` with our splits pinned, keeps at most one "leave it for the applicant" decision per answerable one in training and validation, and fine-tunes with LoRA. Runs and model files go to LayaStudio's `workspace/runs/`. See #41.

```
uv run --project ~/Projects/LayaStudio python ML_model/train/run.py --epochs 1 --name <name>
uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/train
```

`export.py` exports a run to ONNX with LayaStudio's exporter for the desktop app. A choice-v2 run has one question per set of choices, hundreds of them, which LayaStudio's export check would put in one batch, so it checks one question of each task and option count instead:

```
uv run --project ~/Projects/LayaStudio python ML_model/train/export.py --run <run id> --precision int8
```

LayaStudio's own evaluation after training loads the model in float16, which can overflow for a bfloat16-trained model and end the run with an error after the model is saved. Score models with `ML_model/eval/decisions.py`, which loads them in their training precision.
