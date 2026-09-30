"""Export a trained run to ONNX with LayaStudio's exporter, for the desktop app (#38, #65).

LayaStudio's exporter traces the graph, then checks it against MLX on every question in the
checkpoint's questions.json, ten sample states each, in one batch. A choice-v2 checkpoint has one
question per set of choices, hundreds of them: far too many rows for one batch. So this exports
from a view of the checkpoint (its files, linked) whose questions.json keeps one question of each
task and option-count bucket. The graph's batch, token and option sizes stay dynamic, so the
questions it was checked with don't limit it. Score the export with ../eval/decisions.py.

    uv run --project ~/Projects/LayaStudio python ML_model/train/export.py --run <run id> --precision int8
"""

import argparse
import json
import sys
import tempfile
from pathlib import Path

from laya_mlx.common import QTYPES, temp_bucket
from layastudio import engine
from layastudio import export as studio


def sample_questions(questions):
    """One question per task (the id's prefix, e.g. answer- or match-) and option-count bucket,
    the first by id of each."""
    picked = {}
    for qid in sorted(questions):
        definition = questions[qid]
        options = len(definition["criteria"]) if definition["type"] == "choice" else 2
        picked.setdefault((qid.split("-")[0], temp_bucket(QTYPES[definition["type"]], options)), qid)
    return {qid: questions[qid] for qid in sorted(picked.values())}


def view(model_dir, questions, folder):
    """`folder` as a checkpoint: model_dir's files linked in, and `questions` as its questions.json."""
    model_dir, folder = Path(model_dir), Path(folder)
    for entry in model_dir.iterdir():
        if entry.name != "questions.json":
            (folder / entry.name).symlink_to(entry.resolve())
    (folder / "questions.json").write_text(json.dumps(questions, indent=2, ensure_ascii=False) + "\n")
    return folder


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", required=True, help="a LayaStudio run id, from workspace/runs/")
    parser.add_argument("--precision", default="int8", choices=studio.PRECISIONS["onnx"])
    parser.add_argument("--out", help="the export folder (default: workspace/exports/<run>-onnx-<precision>)")
    args = parser.parse_args()

    model_dir = engine.WORKSPACE / "runs" / engine.check_id(args.run) / "model"
    questions = json.loads((model_dir / "questions.json").read_text())
    out = Path(args.out) if args.out else engine.WORKSPACE / "exports" / f"{args.run}-onnx-{args.precision}"
    sample = sample_questions(questions)
    print(f"checking the export on {len(sample)} of the run's {len(questions)} questions: {', '.join(sample)}", flush=True)
    with tempfile.TemporaryDirectory() as folder:
        report = studio.export(f"path:{view(model_dir, sample, folder)}", "onnx", out_dir=out, precision=args.precision,
                               emit=lambda kind, **fields: print(kind, fields.get("message", ""), flush=True))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    sys.exit(main())
