"""Train Laya locally on SecondHand's dataset with LayaStudio (Apple silicon, MLX).

Imports ML_model/dataset/out into LayaStudio with our by-form splits pinned, reports the
token budget, then fine-tunes and evaluates against the base model. Run it with
LayaStudio's environment:

    uv run --project ~/Projects/LayaStudio python ML_model/train/run.py --epochs 3
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path

from huggingface_hub import snapshot_download
from layastudio import engine

ROOT = Path(__file__).resolve().parents[1]


ABSTAIN = "None of these, or the facts don\u2019t say"
MATCH_ABSTAIN = "None of these"


def answerable(row):
    """Whether a row's decision has a real answer: a noul-v1 candidate row that is correct and not
    abstaining, or a choice-v1 row whose answer isn't an abstain choice."""
    if "candidate" in row["state"]:
        return row["answers"]["correct"] and row["state"]["candidate"] != ABSTAIN
    (answer,) = row["answers"].values()
    return answer not in (ABSTAIN, MATCH_ABSTAIN)


def balance(rows, abstain_ratio, seed):
    """Keep every decision with a real answer, and at most `abstain_ratio` abstain decisions per
    answerable one in each task and split, so "leave it for the applicant" can't swamp training."""
    if not abstain_ratio:
        return rows
    by_split = {}
    for row in rows:
        by_split.setdefault((row["task"], row["split"]), {}).setdefault(row["decision"], []).append(row)
    rng = random.Random(seed)
    kept = []
    # Sorted, so the same seed keeps the same rows in every run.
    for (_, split), decisions in sorted(by_split.items(), key=lambda item: item[0]):
        answerable_groups, abstain = [], []
        for group in decisions.values():
            (answerable_groups if any(answerable(r) for r in group) else abstain).append(group)
        rng.shuffle(abstain)
        keep_abstain = abstain if split == "test" else abstain[: max(1, round(abstain_ratio * len(answerable_groups)))]
        for group in answerable_groups + keep_abstain:
            kept += group
    rng.shuffle(kept)
    return kept


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", default=str(ROOT / "dataset" / "out"), help="folder with questions.json and rows.jsonl")
    parser.add_argument("--abstain-ratio", type=float, default=1.0, help="abstain decisions kept per answerable one in train/val (0 = keep all)")
    parser.add_argument("--seed", type=int, default=13)
    parser.add_argument("--base", default="aac6fef/laya-mlx", help="Hugging Face repo of the base Laya checkpoint")
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--method", default="lora", choices=["lora", "head", "full"])
    parser.add_argument("--objective", default="proper", choices=["proper", "rlcd", "ce"])
    parser.add_argument("--class-weighting", default="balanced", choices=["balanced", "none"])
    parser.add_argument("--name", default="secondhand")
    args = parser.parse_args()

    source = Path(args.dataset)
    questions = json.loads((source / "questions.json").read_text())
    with open(source / "rows.jsonl") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    rows = balance(rows, args.abstain_ratio, args.seed)
    counts = {split: sum(row["split"] == split for row in rows) for split in ("train", "val", "test")}
    print(f"rows: {len(rows)} {counts}", flush=True)

    print(f"base model: {args.base}", flush=True)
    model_dir = snapshot_download(args.base, allow_patterns=list(engine.CHECKPOINT_FILES))

    # LayaStudio reads state, answers and split; the task and decision ids are only for our evaluation.
    text = "\n".join(json.dumps({key: row[key] for key in ("state", "answers", "split")}, ensure_ascii=False) for row in rows)
    meta = engine.create_dataset(f"{args.name}-{int(time.time())}", questions, text, "rows.jsonl", seed=args.seed)
    if meta["error_count"]:
        raise SystemExit(f"LayaStudio rejected {meta['error_count']} rows, first: {meta['errors'][0]}")
    print(f"dataset: {meta['id']} {meta['rows']}", flush=True)

    report = engine.analyze_dataset(meta["id"], Path(model_dir))
    print("token budget:", json.dumps(report, default=str)[:1500], flush=True)

    run_id = f"{args.name}-{args.method}-{args.objective}-{int(time.time())}"
    spec = {
        "run_id": run_id,
        "base_model": f"hub:{args.base}",
        "dataset": meta["id"],
        "hyperparameters": {"epochs": args.epochs, "method": args.method, "objective": args.objective, "class_weighting": args.class_weighting},
        "baseline": True,
    }
    started = time.time()

    def emit(kind, **fields):
        if kind in ("phase", "result", "error", "warning") or (kind == "progress" and fields.get("step", 0) % 50 == 0):
            print(f"[{time.time() - started:7.1f}s] {kind} {json.dumps(fields, default=str)[:300]}", flush=True)

    engine.train(spec, emit)
    run_dir = engine.WORKSPACE / "runs" / run_id
    print(f"done in {time.time() - started:.0f}s; run folder: {run_dir}", flush=True)
    for name in ("eval.json", "comparison.json"):
        path = run_dir / name
        if path.exists():
            print(name, path.read_text()[:2000], flush=True)


if __name__ == "__main__":
    sys.exit(main())
