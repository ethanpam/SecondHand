"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/train"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from run import ABSTAIN, MATCH_ABSTAIN, balance

HERE = Path(__file__).resolve().parent


def rows():
    out = []
    for task in ("answer", "match"):
        for split in ("train", "val", "test"):
            for n in range(12):
                gold = ABSTAIN if n % 3 else "Yes"
                for candidate in ("Yes", "No", ABSTAIN):
                    out.append({"task": task, "split": split, "decision": f"{task}-{split}-{n}", "state": {"candidate": candidate},
                                "answers": {"correct": candidate == gold}})
    return out


def choice_rows():
    """choice-v1: one row per decision, answered with its choice."""
    out = []
    for task, abstain in (("answer", ABSTAIN), ("match", MATCH_ABSTAIN)):
        for split in ("train", "val", "test"):
            for n in range(12):
                out.append({"task": task, "split": split, "decision": f"{task}-{split}-{n}", "state": {"question": f"Q{n}"},
                            "answers": {f"{task}-q": abstain if n % 3 else "Yes"}})
    return out


class Balance(unittest.TestCase):
    def test_choice_rows_are_balanced_by_their_answer(self):
        kept = balance(choice_rows(), 1.0, 13)
        for task in ("answer", "match"):
            self.assertEqual(sum(1 for r in kept if r["task"] == task and r["split"] == "test"), 12, "test keeps everything")
            for split in ("train", "val"):
                rows = [r for r in kept if r["task"] == task and r["split"] == split]
                self.assertEqual(len(rows), 8, "4 answerable + 4 abstain")
                self.assertEqual(sum(1 for r in rows if r["answers"][f"{task}-q"] == "Yes"), 4)


    def test_keeps_every_answerable_decision_and_at_most_one_abstain_each_outside_test(self):
        kept = balance(rows(), 1.0, 13)
        decisions = {(r["task"], r["split"], r["decision"]) for r in kept}
        for task in ("answer", "match"):
            self.assertEqual(sum(1 for t, s, _ in decisions if t == task and s == "test"), 12, "test keeps everything")
            for split in ("train", "val"):
                self.assertEqual(sum(1 for t, s, _ in decisions if t == task and s == split), 8, "4 answerable + 4 abstain")

    def test_the_same_seed_keeps_the_same_rows_in_every_process(self):
        # Python varies string hashing per process, so anything iterating a set of strings can differ between runs.
        script = "import json, test_run; from run import balance; print(json.dumps([r['decision'] for r in balance(test_run.rows(), 1.0, 13)]))"
        outputs = set()
        for hash_seed in ("1", "2", "3", "4"):
            result = subprocess.run([sys.executable, "-c", script], cwd=HERE, capture_output=True, text=True, check=True,
                                    env={**os.environ, "PYTHONHASHSEED": hash_seed})
            outputs.add(result.stdout)
        self.assertEqual(len(outputs), 1, "balance() must not depend on the process's hash seed")
        self.assertTrue(json.loads(outputs.pop()))


if __name__ == "__main__":
    unittest.main()
