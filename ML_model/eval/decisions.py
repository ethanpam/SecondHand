"""Decision-level evaluation of a trained Laya model on SecondHand's held-out forms.

LayaStudio scores rows; a form question is a decision made over several candidate rows.
This regroups them: the model picks its best candidate, answers only when that candidate
beats "none of these" and clears the confidence bar, and otherwise leaves the question to
the applicant. What matters is how often an answer it fills is right (precision), how many
answerable questions it fills (coverage), and how often it fills one it should have left.

    uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --model <run>/model
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
THRESHOLDS = [0.5, 0.7, 0.8, 0.9, 0.95]


def score(decisions, model_dir, questions):
    agent = runtime.load_agent(model_dir, batch_size=16)
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
        best = max(rows[:-1], key=lambda row: row["p"])
        accepted = best["p"] >= threshold and best["p"] > rows[-1]["p"]
        answerable = gold != ABSTAIN
        result["decisions"] += 1
        result["answerable"] += answerable
        result["unanswerable"] += not answerable
        if accepted:
            result["accepted"] += 1
            if best["state"]["candidate"] == gold:
                result["right"] += 1
            else:
                result["wrong_fill"] += 1
                result["wrong_fill_on_unanswerable"] += not answerable
    result["precision"] = result["right"] / result["accepted"] if result["accepted"] else None
    result["coverage"] = result["right"] / result["answerable"] if result["answerable"] else None
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, help="a trained checkpoint folder, e.g. <LayaStudio>/workspace/runs/<run>/model")
    parser.add_argument("--dataset", default=str(ROOT / "dataset" / "out"))
    parser.add_argument("--split", default="test")
    parser.add_argument("--limit", type=int, default=0, help="evaluate this many decisions per task (0 = all)")
    parser.add_argument("--report", help="write the JSON report here")
    args = parser.parse_args()

    source = Path(args.dataset)
    questions = json.loads((source / "questions.json").read_text())
    decisions = {"answer": defaultdict(list), "match": defaultdict(list)}
    with open(source / "rows.jsonl") as handle:
        for line in handle:
            row = json.loads(line)
            if row["split"] == args.split:
                decisions[row["task"]][row["decision"]].append(row)
    if args.limit:
        decisions = {task: dict(list(groups.items())[: args.limit]) for task, groups in decisions.items()}
    for task, groups in decisions.items():
        print(f"{task}: {len(groups)} decisions, {sum(len(rows) for rows in groups.values())} rows", flush=True)
        score(groups, Path(args.model), questions)
    report = {
        "model": args.model,
        "split": args.split,
        "tasks": {task: {str(t): metrics(groups, t) for t in THRESHOLDS} for task, groups in decisions.items()},
    }
    text = json.dumps(report, indent=2)
    print(text)
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(text + "\n")


if __name__ == "__main__":
    sys.exit(main())
