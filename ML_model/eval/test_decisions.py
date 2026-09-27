"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval"""

import json
import tempfile
import unittest
from pathlib import Path

from decisions import ABSTAIN, agreement, holdout_forms, metrics, named_reference, probabilities, training_precision


class TrainingPrecision(unittest.TestCase):
    def folder(self, finetune):
        folder = Path(tempfile.mkdtemp())
        if finetune is not None:
            (folder / "laya_finetune.json").write_text(json.dumps(finetune))
        return folder

    def test_reads_the_precision_the_model_was_trained_in(self):
        self.assertEqual(training_precision(self.folder({"hyperparameters": {"precision": "bfloat16"}})), "bfloat16")
        self.assertEqual(training_precision(self.folder({"hyperparameters": {"precision": "float32"}})), "float32")

    def test_a_checkpoint_without_its_training_record_is_refused(self):
        with self.assertRaisesRegex(FileNotFoundError, "laya_finetune.json"):
            training_precision(self.folder(None))

    def test_a_training_record_without_a_precision_is_refused(self):
        with self.assertRaisesRegex(ValueError, "precision"):
            training_precision(self.folder({"hyperparameters": {}}))


class HoldoutForms(unittest.TestCase):
    def bank(self, forms):
        folder = Path(tempfile.mkdtemp())
        for name, source in forms.items():
            (folder / f"{name}.json").write_text(json.dumps({"source": source, "questions": []}))
        (folder / "synthetic").mkdir()
        return folder

    def test_only_forms_marked_holdout_count(self):
        folder = self.bank({"kept": {"url": "https://a.example/form", "holdout": True}, "trained": {"url": "https://b.example/form"}})
        self.assertEqual(holdout_forms(folder), {"https://a.example/form"})

    def test_a_bank_without_holdout_forms_is_refused(self):
        with self.assertRaisesRegex(ValueError, "holdout"):
            holdout_forms(self.bank({"trained": {"url": "https://b.example/form"}}))


class Agreement(unittest.TestCase):
    def test_share_over_the_tolerance_and_largest_difference(self):
        left = {"a": [0.9, 0.1], "b": [0.5]}
        right = {"a": [0.91, 0.2], "b": [0.56]}
        # differences 0.01, 0.10, 0.06: two of three exceed 0.05
        result = agreement(left, right, atol=0.05)
        self.assertEqual(result["rows"], 3)
        self.assertAlmostEqual(result["share_diff_gt_atol"], 2 / 3)
        self.assertAlmostEqual(result["max_abs_diff"], 0.1)
        self.assertEqual(result["atol"], 0.05)

    def test_different_decisions_are_refused(self):
        with self.assertRaisesRegex(ValueError, "decisions"):
            agreement({"a": [0.1], "b": [0.2]}, {"a": [0.1]})
        with self.assertRaisesRegex(ValueError, "decisions"):
            agreement({"a": [0.1]}, {"a": [0.1], "c": [0.2]})

    def test_different_candidate_counts_are_refused(self):
        with self.assertRaisesRegex(ValueError, "rows"):
            agreement({"a": [0.1, 0.2]}, {"a": [0.1]})


class Probabilities(unittest.TestCase):
    def test_keeps_each_decisions_rows_in_order(self):
        decisions = {"answer": {"d1": [{"p": 0.9}, {"p": 0.2}]}, "match": {"m1": [{"p": 0.4}]}}
        self.assertEqual(probabilities(decisions), {"answer": {"d1": [0.9, 0.2]}, "match": {"m1": [0.4]}})


class NamedReference(unittest.TestCase):
    def test_splits_name_and_path(self):
        self.assertEqual(named_reference("mlx=/tmp/a.probs.json"), ("mlx", Path("/tmp/a.probs.json")))

    def test_a_reference_without_a_name_is_refused(self):
        with self.assertRaises(ValueError):
            named_reference("/tmp/a.probs.json")


class Metrics(unittest.TestCase):
    def test_precision_and_coverage_at_a_threshold(self):
        decisions = {
            "d1": [
                {"state": {"candidate": "Yes"}, "answers": {"correct": True}, "p": 0.96},
                {"state": {"candidate": ABSTAIN}, "answers": {"correct": False}, "p": 0.1},
            ],
            "d2": [
                {"state": {"candidate": "No"}, "answers": {"correct": False}, "p": 0.99},
                {"state": {"candidate": ABSTAIN}, "answers": {"correct": True}, "p": 0.2},
            ],
        }
        result = metrics(decisions, 0.95)
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result["right"], 1)
        self.assertEqual(result["wrong_fill"], 1)
        self.assertEqual(result["wrong_fill_on_unanswerable"], 1)
        self.assertAlmostEqual(result["precision"], 0.5)
        self.assertAlmostEqual(result["coverage"], 1.0)


if __name__ == "__main__":
    unittest.main()
