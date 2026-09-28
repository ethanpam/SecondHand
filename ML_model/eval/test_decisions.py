"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval"""

import json
import tempfile
import unittest
from pathlib import Path

from decisions import (
    ABSTAIN,
    MATCH_ABSTAIN,
    agreement,
    apply_probabilities,
    candidates,
    dataset_format,
    fill,
    holdout_forms,
    load_decisions,
    metrics,
    named_reference,
    probabilities,
    training_precision,
)

YES_NO = {"type": "choice", "instructions": "Which option?", "criteria": ["Yes", "No", ABSTAIN]}
FIELDS = {"type": "choice", "instructions": "Which saved answer?", "criteria": ["email address", "phone number", MATCH_ABSTAIN]}
NOUL = {"correct": {"type": "noul", "instructions": "Is the candidate correct?"}}


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
        left = {"a": [0.9, 0.1], "b": [0.5, 0.3]}
        right = {"a": [0.91, 0.2], "b": [0.56, 0.3]}
        # differences 0.01, 0.10, 0.06, 0: two of four exceed 0.05
        result = agreement(left, right, atol=0.05)
        self.assertEqual(result["rows"], 4)
        self.assertAlmostEqual(result["share_diff_gt_atol"], 0.5)
        self.assertAlmostEqual(result["max_abs_diff"], 0.1)
        self.assertEqual(result["atol"], 0.05)

    def test_counts_decisions_that_would_be_filled_differently(self):
        # The last probability of each decision is the abstain candidate's.
        reference = {"a": [0.996, 0.1, 0.01], "b": [0.3, 0.2, 0.01], "c": [0.96, 0.95, 0.0]}
        other = {"a": [0.994, 0.1, 0.01], "b": [0.3, 0.2, 0.01], "c": [0.95, 0.96, 0.0]}
        result = agreement(reference, other, thresholds=[0.9, 0.995])
        self.assertEqual(result["decisions_with_different_fill"], {"0.9": 1, "0.995": 1})

    def test_different_decisions_are_refused(self):
        with self.assertRaisesRegex(ValueError, "decisions"):
            agreement({"a": [0.1], "b": [0.2]}, {"a": [0.1]})
        with self.assertRaisesRegex(ValueError, "decisions"):
            agreement({"a": [0.1]}, {"a": [0.1], "c": [0.2]})

    def test_different_candidate_counts_are_refused(self):
        with self.assertRaisesRegex(ValueError, "rows"):
            agreement({"a": [0.1, 0.2]}, {"a": [0.1]})


class Fill(unittest.TestCase):
    def test_fills_the_best_candidate_when_it_clears_the_bar_and_beats_abstaining(self):
        self.assertEqual(fill([0.2, 0.97, 0.1], 0.95), 1)
        self.assertIsNone(fill([0.2, 0.94, 0.1], 0.95))
        self.assertIsNone(fill([0.2, 0.97, 0.98], 0.95))


class ApplyProbabilities(unittest.TestCase):
    def test_sets_each_rows_p_from_a_saved_scoring(self):
        decisions = {"answer": {"d1": [{"x": 1}, {"x": 2}]}, "match": {}}
        apply_probabilities(decisions, {"answer": {"d1": [0.3, 0.7]}, "match": {}})
        self.assertEqual([row["p"] for row in decisions["answer"]["d1"]], [0.3, 0.7])

    def test_a_saved_scoring_of_other_rows_is_refused(self):
        with self.assertRaisesRegex(ValueError, "decisions"):
            apply_probabilities({"answer": {"d1": [{}]}}, {"answer": {"d2": [0.1]}})
        with self.assertRaisesRegex(ValueError, "rows"):
            apply_probabilities({"answer": {"d1": [{}]}}, {"answer": {"d1": [0.1, 0.2]}})


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


class Candidates(unittest.TestCase):
    def test_a_noul_row_is_one_candidate(self):
        row = {"decision": "d", "task": "answer", "state": {"question": "Q", "candidate": "Yes"}, "answers": {"correct": True}}
        self.assertEqual(candidates(row, NOUL), [row])

    def test_a_choice_row_is_every_choice_in_order_with_the_abstain_choice_last(self):
        row = {"decision": "d", "task": "answer", "split": "test", "state": {"facts": "F", "question": "Q"}, "answers": {"yn": "No"}}
        out = candidates(row, {"yn": YES_NO})
        self.assertEqual([c["state"]["candidate"] for c in out], ["Yes", "No", ABSTAIN])
        self.assertEqual([c["answers"]["correct"] for c in out], [False, True, False])
        self.assertEqual(out[0]["state"], {"facts": "F", "question": "Q", "candidate": "Yes"})
        self.assertEqual(out[0]["source"], {"qid": "yn", "state": {"facts": "F", "question": "Q"}})
        self.assertTrue(all(c["decision"] == "d" for c in out))

    def test_a_choice_question_without_an_abstain_choice_last_is_refused(self):
        row = {"decision": "d", "task": "answer", "state": {"question": "Q"}, "answers": {"q": "a"}}
        with self.assertRaisesRegex(ValueError, "abstain"):
            candidates(row, {"q": {"type": "choice", "instructions": "x", "criteria": ["a", "b"]}})


class DatasetFormat(unittest.TestCase):
    def test_names_the_format_from_its_questions(self):
        self.assertEqual(dataset_format(NOUL), "noul-v1")
        self.assertEqual(dataset_format({"yn": YES_NO, "fields": FIELDS}), "choice-v1")
        with self.assertRaisesRegex(ValueError, "format"):
            dataset_format({"yn": YES_NO, **NOUL})


class LoadDecisions(unittest.TestCase):
    def test_groups_choice_rows_into_their_candidates_by_task(self):
        folder = Path(tempfile.mkdtemp())
        rows = [
            {"state": {"facts": "F", "question": "Q"}, "answers": {"yn": "Yes"}, "split": "test", "task": "answer", "decision": "https://a.example#q1#0"},
            {"state": {"question": "Email"}, "answers": {"fields": "email address"}, "split": "test", "task": "match", "decision": "https://a.example#q2"},
            {"state": {"question": "Phone"}, "answers": {"fields": MATCH_ABSTAIN}, "split": "train", "task": "match", "decision": "https://b.example#q3"},
        ]
        (folder / "rows.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        decisions = load_decisions(folder, {"yn": YES_NO, "fields": FIELDS}, "test", holdout=False, limit=0)
        self.assertEqual(list(decisions["answer"]), ["https://a.example#q1#0"])
        self.assertEqual(list(decisions["match"]), ["https://a.example#q2"])
        self.assertEqual([c["state"]["candidate"] for c in decisions["match"]["https://a.example#q2"]], ["email address", "phone number", MATCH_ABSTAIN])


class ChoiceMetrics(unittest.TestCase):
    def test_a_match_decision_abstains_with_none_of_these(self):
        row = {"decision": "d", "task": "match", "state": {"question": "Email"}, "answers": {"fields": MATCH_ABSTAIN}}
        decision = candidates(row, {"fields": FIELDS})
        for c, p in zip(decision, (0.97, 0.02, 0.01)):
            c["p"] = p
        result = metrics({"d": decision}, 0.95)
        self.assertEqual((result["accepted"], result["wrong_fill"], result["wrong_fill_on_unanswerable"], result["answerable"]), (1, 1, 1, 0))


if __name__ == "__main__":
    unittest.main()
