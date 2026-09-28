"""Decision-level evaluation of a trained Laya model on SecondHand's held-out forms.

LayaStudio scores rows; a form question is a decision made over several candidate rows.
This regroups them: the model picks its best candidate, answers only when that candidate
beats "none of these" and clears the confidence bar, and otherwise leaves the question to
the applicant. What matters is how often an answer it fills is right (precision), how many
answerable questions it fills (coverage), and how often it fills one it should have left.

    uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --model <run>/model
    uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --runtime onnx --onnx <export> \
        --reference-probs mlx=<an MLX report>.probs.json
"""

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

from layastudio import runtime

ROOT = Path(__file__).resolve().parents[1]
ABSTAIN = "None of these, or the facts don’t say"
THRESHOLDS = [0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 0.992, 0.995, 0.996]


def training_precision(model_dir):
    """The precision a checkpoint was trained in, from the record LayaStudio saves beside it."""
    record = Path(model_dir) / "laya_finetune.json"
    if not record.exists():
        raise FileNotFoundError(f"{record} is missing, so the model's training precision is unknown.")
    precision = json.loads(record.read_text()).get("hyperparameters", {}).get("precision")
    if not precision:
        raise ValueError(f"{record} does not say which precision the model was trained in.")
    return precision


def holdout_forms(questions_dir):
    """URLs of the real forms kept out of training for good (source.holdout)."""
    urls = set()
    for path in Path(questions_dir).glob("*.json"):
        source = json.loads(path.read_text())["source"]
        if source.get("holdout"):
            urls.add(source["url"])
    if not urls:
        raise ValueError(f"No form in {questions_dir} is marked holdout.")
    return urls


def probabilities(decisions):
    """Each row's p, per task and decision: {task: {decision: [p, ...]}}."""
    return {task: {key: [row["p"] for row in rows] for key, rows in groups.items()} for task, groups in decisions.items()}


def same_rows(reference, other):
    """Refuse two {decision: [...]} maps that do not hold the same decisions and row counts."""
    if set(reference) != set(other):
        raise ValueError(f"The two scorings cover different decisions ({len(reference)} vs {len(other)})")
    for key, rows in reference.items():
        if len(rows) != len(other[key]):
            raise ValueError(f"Decision {key!r} has {len(rows)} rows in one scoring and {len(other[key])} in the other")


def fill(probs, threshold):
    """The candidate a decision fills, or None. The last probability is the abstain candidate's."""
    best = max(range(len(probs) - 1), key=lambda i: probs[i])
    return best if probs[best] >= threshold and probs[best] > probs[-1] else None


def agreement(reference, other, atol=0.05, thresholds=THRESHOLDS):
    """How far two scorings of the same rows ({decision: [p, ...]}) are apart, row by row, and
    how many decisions they would fill differently at each threshold."""
    same_rows(reference, other)
    diffs = [abs(a - b) for key, probs in reference.items() for a, b in zip(probs, other[key])]
    return {
        "rows": len(diffs),
        "share_diff_gt_atol": sum(d > atol for d in diffs) / len(diffs) if diffs else None,
        "max_abs_diff": round(max(diffs), 4) if diffs else None,
        "atol": atol,
        "decisions": len(reference),
        "decisions_with_different_fill": {
            str(t): sum(fill(probs, t) != fill(other[key], t) for key, probs in reference.items()) for t in thresholds
        },
    }


def apply_probabilities(decisions, saved):
    """Set each row's p from a saved .probs.json of the same rows instead of scoring again."""
    for task, groups in decisions.items():
        same_rows(groups, saved[task])
        for key, rows in groups.items():
            for row, p in zip(rows, saved[task][key]):
                row["p"] = p


def named_reference(text):
    """--reference-probs NAME=PATH, e.g. mlx=reports/mlx-test.probs.json."""
    name, _, path = text.partition("=")
    if not name or not path:
        raise ValueError(f"Expected NAME=PATH, got {text!r}")
    return name, Path(path)


def load(model_dir):
    # On Apple silicon, laya-mlx defaults to float16, whose range is too small for models trained
    # in bfloat16: their outputs overflow. So load in the training precision. LayaStudio's
    # runtime.load_agent has no precision setting, hence laya_mlx directly.
    if runtime.backend() == "mlx":
        import laya_mlx

        return laya_mlx.load(str(model_dir), batch_size=16, dtype=training_precision(model_dir))
    return runtime.load_agent(model_dir, batch_size=16)


def score(decisions, model_dir, questions):
    agent = load(model_dir)
    started, done = time.time(), 0
    for rows in decisions.values():
        for row in rows:
            out = agent.predict(row["state"], questions)
            row["p"] = out["answers"]["correct"]["noul"]
            done += 1
            if done % 500 == 0:
                print(f"scored {done} rows in {time.time() - started:.0f}s", flush=True)


def metrics(decisions, threshold):
    result = {"decisions": 0, "answerable": 0, "accepted": 0, "right": 0, "wrong_fill": 0, "wrong_fill_on_unanswerable": 0, "unanswerable": 0}
    for rows in decisions.values():
        if rows[-1]["state"]["candidate"] != ABSTAIN:
            raise ValueError("Every decision must end with the abstain candidate.")
        gold = next(row["state"]["candidate"] for row in rows if row["answers"]["correct"])
        chosen = fill([row["p"] for row in rows], threshold)
        answerable = gold != ABSTAIN
        result["decisions"] += 1
        result["answerable"] += answerable
        result["unanswerable"] += not answerable
        if chosen is not None:
            result["accepted"] += 1
            if rows[chosen]["state"]["candidate"] == gold:
                result["right"] += 1
            else:
                result["wrong_fill"] += 1
                result["wrong_fill_on_unanswerable"] += not answerable
    result["precision"] = result["right"] / result["accepted"] if result["accepted"] else None
    result["coverage"] = result["right"] / result["answerable"] if result["answerable"] else None
    return result


def load_decisions(source, split, holdout, limit):
    decisions = {"answer": defaultdict(list), "match": defaultdict(list)}
    with open(Path(source) / "rows.jsonl") as handle:
        for line in handle:
            row = json.loads(line)
            if row["split"] == split:
                decisions[row["task"]][row["decision"]].append(row)
    if holdout:
        urls = holdout_forms(ROOT / "questions")
        decisions = {task: {key: rows for key, rows in groups.items() if key.split("#")[0] in urls} for task, groups in decisions.items()}
    if limit:
        decisions = {task: dict(list(groups.items())[:limit]) for task, groups in decisions.items()}
    return decisions


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", help="a trained checkpoint folder, e.g. <LayaStudio>/workspace/runs/<run>/model")
    parser.add_argument("--runtime", choices=("mlx", "onnx"), default="mlx")
    parser.add_argument("--onnx", help="an ONNX export folder (model.onnx, tokenizer/, rl_agent_config.json)")
    parser.add_argument("--batch-size", type=int, default=16, help="rows per onnxruntime call")
    parser.add_argument("--threads", type=int, default=0, help="onnxruntime intra-op threads (0 = its default)")
    parser.add_argument("--dataset", default=str(ROOT / "dataset" / "out"))
    parser.add_argument("--split", default="test")
    parser.add_argument("--holdout", action="store_true", help="evaluate only the forms marked holdout in questions/")
    parser.add_argument("--limit", type=int, default=0, help="evaluate this many decisions per task (0 = all)")
    parser.add_argument("--report", help="write the JSON report here")
    parser.add_argument("--errors", help="write every wrong fill at --error-threshold here (JSON lines)")
    parser.add_argument("--error-threshold", type=float, default=0.9)
    parser.add_argument("--reference-probs", action="append", default=[], metavar="NAME=PATH",
                        help="another scoring's .probs.json to compare with row by row (repeatable)")
    parser.add_argument("--probs", help="take each row's probability from this model's saved .probs.json instead of scoring again")
    args = parser.parse_args()
    references = [named_reference(text) for text in args.reference_probs]

    if args.runtime == "onnx":
        if not args.onnx:
            parser.error("--runtime onnx requires --onnx <export-dir>")
        model_label = args.onnx
    else:
        if not args.model:
            parser.error("--runtime mlx requires --model <checkpoint>")
        model_label = args.model

    source = Path(args.dataset)
    questions = json.loads((source / "questions.json").read_text())
    decisions = load_decisions(source, args.split, args.holdout, args.limit)
    if args.probs:
        apply_probabilities(decisions, json.loads(Path(args.probs).read_text()))
    elif args.runtime == "onnx":
        from onnx_score import OnnxScorer

        scorer = OnnxScorer(args.onnx, batch_size=args.batch_size, threads=args.threads)
    for task, groups in decisions.items():
        print(f"{task}: {len(groups)} decisions, {sum(len(rows) for rows in groups.values())} rows", flush=True)
        if args.probs:
            continue
        if args.runtime == "onnx":
            scorer.score_rows([row for rows in groups.values() for row in rows], questions, progress_every=500)
        else:
            score(groups, Path(args.model), questions)
    report = {
        "model": model_label,
        "runtime": args.runtime,
        "split": args.split,
        "holdout": args.holdout,
        "tasks": {task: {str(t): metrics(groups, t) for t in THRESHOLDS} for task, groups in decisions.items()},
    }
    if args.runtime == "onnx":
        report["onnx"] = {"batch_size": args.batch_size, "threads": args.threads or "onnxruntime default"}
    if args.probs:
        report["probs_from"] = args.probs
    scored = probabilities(decisions)
    if references:
        report["agreement"] = {}
        for name, path in references:
            reference = json.loads(path.read_text())
            report["agreement"][name] = {task: agreement(reference[task], probs) for task, probs in scored.items()}
    if args.errors:
        with open(args.errors, "w") as handle:
            for task, groups in decisions.items():
                for rows in groups.values():
                    chosen = fill([row["p"] for row in rows], args.error_threshold)
                    best = rows[chosen] if chosen is not None else None
                    gold = next(row["state"]["candidate"] for row in rows if row["answers"]["correct"])
                    if best and best["state"]["candidate"] != gold:
                        handle.write(json.dumps({"task": task, "decision": rows[0]["decision"], "question": rows[0]["state"]["question"],
                                                 "chosen": best["state"]["candidate"], "p": round(best["p"], 4), "gold": gold,
                                                 "facts": rows[0]["state"].get("facts", "")}, ensure_ascii=False) + "\n")
    text = json.dumps(report, indent=2)
    print(text)
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(text + "\n")
        # Every row's probability, so another runtime's scoring can be compared without rescoring this one.
        Path(args.report).with_suffix(".probs.json").write_text(json.dumps(scored) + "\n")


if __name__ == "__main__":
    sys.exit(main())
