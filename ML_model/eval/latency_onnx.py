"""CPU latency and memory of an ONNX export for one form page, through onnxruntime.

A page is one household's first N questions on a real form, in form order, each scored with
every candidate it has, the way the dataset's format asks: one prompt per candidate (noul-v1)
or one per question (choice-v1). Reports the time to load the model
and score the first page, the median and 95th percentile of later pages with the 1-minute load
average beside each run, and peak memory.

    uv run --project ~/Projects/LayaStudio python ML_model/eval/latency_onnx.py --onnx <export> \\
        --dataset <built dataset> --form <form url> --runs 30 --out <report.json>
"""

import argparse
import json
import math
import os
import platform
import resource
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

import onnxruntime

from decisions import candidates
from onnx_score import OnnxScorer


def pick_page(dataset, form, household, questions):
    """The first `questions` test decisions of `form` for one household, in form order."""
    groups = defaultdict(list)
    with open(Path(dataset) / "rows.jsonl") as handle:
        for line in handle:
            row = json.loads(line)
            # Decisions are <url>#q<n> for matching and <url>#q<n>#<household> for answering.
            parts = row["decision"].split("#")
            if row["split"] != "test" or parts[0] != form:
                continue
            if row["task"] == "answer" and parts[2] != str(household):
                continue
            groups[row["decision"]].append(row)
    order = sorted(groups, key=lambda key: int(key.split("#")[1].removeprefix("q")))
    if len(order) < questions:
        raise ValueError(f"{form} has {len(order)} questions for household {household}; the page needs {questions}")
    return [groups[key] for key in order[:questions]]


def timed_runs(run, count):
    """Call run() count times; each timing comes with the 1-minute load average taken before it."""
    runs = []
    for _ in range(count):
        load = os.getloadavg()[0]
        started = time.perf_counter()
        run()
        runs.append({"ms": round((time.perf_counter() - started) * 1000, 1), "load_1m": round(load, 2)})
    return runs


def percentile(values, q):
    """Nearest-rank percentile: the smallest value at least q% of the values are at or below."""
    ordered = sorted(values)
    return ordered[max(1, math.ceil(q / 100 * len(ordered))) - 1]


def peak_rss_mb():
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak / 2**20 if sys.platform == "darwin" else peak / 2**10  # bytes on macOS, KiB on Linux


def machine():
    if sys.platform == "darwin":
        return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], check=True, capture_output=True, text=True).stdout.strip()
    return platform.processor() or platform.machine()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--onnx", required=True, help="an ONNX export folder")
    parser.add_argument("--dataset", required=True, help="a dataset built by ML_model/dataset/build.cjs")
    parser.add_argument("--form", required=True, help="the form's source url, as in questions/")
    parser.add_argument("--household", type=int, default=0)
    parser.add_argument("--questions", type=int, default=20)
    parser.add_argument("--runs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=16, help="rows per onnxruntime call")
    parser.add_argument("--threads", type=int, default=0, help="onnxruntime intra-op threads (0 = its default)")
    parser.add_argument("--out", help="write the JSON report here")
    args = parser.parse_args()

    questions = json.loads((Path(args.dataset) / "questions.json").read_text())
    page = [[c for row in rows for c in candidates(row, questions)] for rows in pick_page(args.dataset, args.form, args.household, args.questions)]
    rss_before = peak_rss_mb()

    first_load_1m = round(os.getloadavg()[0], 2)
    started = time.perf_counter()
    scorer = OnnxScorer(args.onnx, batch_size=args.batch_size, threads=args.threads)
    session_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    scorer.score_decisions(page, questions)
    first_page_ms = (time.perf_counter() - started) * 1000

    runs = timed_runs(lambda: scorer.score_decisions(page, questions), args.runs)
    times = [run["ms"] for run in runs]

    report = {
        "machine": machine(),
        "cpus": os.cpu_count(),
        "platform": platform.platform(),
        "onnxruntime": onnxruntime.__version__,
        "onnx": args.onnx,
        "form": args.form,
        "household": args.household,
        "questions": args.questions,
        "questions_by_task": {task: sum(candidates[0]["task"] == task for candidates in page) for task in ("answer", "match")},
        "candidates": sum(len(decision) for decision in page),
        "prompts": len(scorer.prompts(page, questions)),
        "batch_size": args.batch_size,
        "threads": args.threads or "onnxruntime default",
        "session_load_ms": round(session_ms, 1),
        "first_page_ms": round(first_page_ms, 1),
        "first_load_ms": round(session_ms + first_page_ms, 1),
        "first_load_load_1m": first_load_1m,
        "p50_ms": percentile(times, 50),
        "p95_ms": percentile(times, 95),
        "min_ms": min(times),
        "max_ms": max(times),
        "load_1m_range": [min(run["load_1m"] for run in runs), max(run["load_1m"] for run in runs)],
        "runs": runs,
        "rss_before_model_mb": round(rss_before, 1),
        "peak_rss_mb": round(peak_rss_mb(), 1),
    }
    text = json.dumps(report, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text + "\n")


if __name__ == "__main__":
    sys.exit(main())
