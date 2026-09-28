"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from latency_onnx import percentile, pick_page, timed_runs

FORM = "https://forms.example/intake"


def row(task, decision, candidate, split="test"):
    return {"split": split, "task": task, "decision": decision, "state": {"candidate": candidate}, "answers": {"correct": False}}


class PickPage(unittest.TestCase):
    def dataset(self, rows):
        folder = Path(tempfile.mkdtemp())
        (folder / "rows.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        return folder

    def test_takes_one_households_questions_in_form_order_with_all_candidates(self):
        rows = [
            row("match", f"{FORM}#q10", "a"),
            row("match", f"{FORM}#q10", "none"),
            row("answer", f"{FORM}#q2#1", "Yes"),
            row("answer", f"{FORM}#q2#0", "Yes"),
            row("answer", f"{FORM}#q2#0", "No"),
            row("answer", f"{FORM}#q2#0", "none"),
            row("match", f"{FORM}#q1", "b"),
            row("match", "https://other.example/form#q0", "c"),
            row("match", f"{FORM}#q3", "d", split="train"),
            row("answer", f"{FORM}#q11#0", "Yes"),
        ]
        page = pick_page(self.dataset(rows), FORM, household=0, questions=3)
        self.assertEqual([candidates[0]["decision"] for candidates in page], [f"{FORM}#q1", f"{FORM}#q2#0", f"{FORM}#q10"])
        self.assertEqual([len(candidates) for candidates in page], [1, 3, 2])

    def test_a_form_with_too_few_questions_is_refused(self):
        with self.assertRaisesRegex(ValueError, "2 questions"):
            pick_page(self.dataset([row("match", f"{FORM}#q1", "a"), row("answer", f"{FORM}#q2#0", "Yes")]), FORM, household=0, questions=3)


class TimedRuns(unittest.TestCase):
    def test_times_each_run_and_records_the_load_beside_it(self):
        calls = []
        with patch("latency_onnx.os.getloadavg", side_effect=[(1.5, 2.0, 3.0), (2.5, 2.0, 3.0)]):
            runs = timed_runs(lambda: calls.append(1), 2)
        self.assertEqual(len(calls), 2)
        self.assertEqual([run["load_1m"] for run in runs], [1.5, 2.5])
        self.assertTrue(all(run["ms"] >= 0 for run in runs))


class Percentile(unittest.TestCase):
    def test_nearest_rank(self):
        values = list(range(1, 31))
        self.assertEqual(percentile(values, 50), 15)
        self.assertEqual(percentile(values, 95), 29)
        self.assertEqual(percentile(values, 100), 30)

    def test_order_does_not_matter(self):
        self.assertEqual(percentile([3, 1, 2], 50), 2)


if __name__ == "__main__":
    unittest.main()
