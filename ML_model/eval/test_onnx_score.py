"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval"""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

from decisions import ABSTAIN, candidates
from onnx_score import OnnxScorer, calibrated, feeds, load_temperatures, temperature

QUESTIONS = {"correct": {"type": "noul", "instructions": "Is the candidate correct?"}}
YES_NO = {"type": "choice", "instructions": "Which option?", "criteria": ["Yes", "No", ABSTAIN]}


def noul_p(x, scale):
    return calibrated(np.array([0.0, x]), scale)[1]


class Calibrated(unittest.TestCase):
    def test_equal_logits_are_even(self):
        self.assertEqual(calibrated(np.array([0.0, 0.0]), temperature=1.0), [0.5, 0.5])

    def test_temperature_softens_the_top_probability(self):
        sharp = noul_p(2.0, 1.0)
        soft = noul_p(2.0, 2.0)
        self.assertGreater(sharp, soft)
        self.assertEqual(sharp, round(float(np.exp(2) / (1 + np.exp(2))), 4))

    def test_matches_laya_mlx_softmax_and_rounding(self):
        logits, scale = np.array([-1.2, 0.8, 0.1]), 1.5465
        z = logits / scale
        p = np.exp(z - z.max())
        p /= p.sum()
        self.assertEqual(calibrated(logits, temperature=scale), [round(float(v), 4) for v in p])


class Temperatures(unittest.TestCase):
    cfg = {"temperature": [1.6, 1.25, 1.5465], "temperature_by_options": {"noul:2": 1.5465, "choice:11+": 0.1}}

    def test_clamps_like_laya_mlx(self):
        temps = load_temperatures(self.cfg)
        self.assertEqual(temps["by_options"]["choice:11+"], 0.5)
        self.assertAlmostEqual(temps["by_options"]["noul:2"], 1.5465)
        self.assertEqual(temps["by_type"], [1.6, 1.25, 1.5465])

    def test_uses_the_option_bucket_then_the_type(self):
        temps = load_temperatures({"temperature": [1.6, 1.25, 2.0], "temperature_by_options": {"noul:2": 1.5}})
        self.assertEqual(temperature(temps, qtype=2, k=2), 1.5)
        self.assertEqual(temperature(temps, qtype=0, k=3), 1.6)


class Feeds(unittest.TestCase):
    def test_pads_to_the_longest_row_with_the_graph_dtypes(self):
        items = [{"ids": [1, 2, 3], "markers": [1, 2], "qtype": 2}, {"ids": [4, 5], "markers": [0, 1], "qtype": 2}]
        out = feeds(items, pad_id=9, max_len=512)
        self.assertEqual(set(out), {"input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"})
        self.assertEqual(out["input_ids"].tolist(), [[1, 2, 3], [4, 5, 9]])
        self.assertEqual(out["attention_mask"].tolist(), [[1, 1, 1], [1, 1, 0]])
        self.assertEqual(out["marker_pos"].tolist(), [[1, 2], [0, 1]])
        for name in ("input_ids", "attention_mask", "marker_pos", "qtype"):
            self.assertEqual(out[name].dtype, np.int64, name)
        self.assertEqual(out["marker_mask"].dtype, np.bool_)


class Scorer(unittest.TestCase):
    def export_dir(self, with_model=True):
        folder = Path(tempfile.mkdtemp())
        config = {"max_len": 512, "head_max_len": 192, "temperature": [1.0, 1.0, 1.5], "temperature_by_options": {"noul:2": 1.5}}
        (folder / "rl_agent_config.json").write_text(json.dumps(config))
        if with_model:
            (folder / "model.onnx").write_bytes(b"not a real graph")
        return folder

    def scorer(self, batch_size=2, threads=None):
        session = MagicMock()
        # Row i of a batch gets logits [0, x, 2x, ...], one per option, where x is its first token id.
        session.run.side_effect = lambda names, fed: [(fed["input_ids"][:, :1] * np.arange(fed["marker_pos"].shape[1])).astype(np.float32)]
        with (
            patch("onnx_score.onnxruntime.InferenceSession", return_value=session) as make,
            patch("onnx_score.Tokenizer") as tokenizer,
        ):
            tokenizer.return_value.pad_token_id = 0
            scorer = OnnxScorer(self.export_dir(), batch_size=batch_size, threads=threads)
        return scorer, session, make

    def test_a_missing_graph_is_refused(self):
        with self.assertRaisesRegex(FileNotFoundError, "model.onnx"):
            OnnxScorer(self.export_dir(with_model=False))

    def test_scores_noul_rows_one_prompt_each_in_batches_and_keeps_their_order(self):
        scorer, session, _ = self.scorer(batch_size=2)
        rows = [{"state": {"candidate": value}} for value in (1, 2, 3, 4, 5)]
        with patch("onnx_score.build_sequence", side_effect=lambda tok, state, q, *a: ([state["candidate"], 7, 7], [1, 2])):
            with redirect_stdout(io.StringIO()):
                scorer.score_decisions([rows[:3], rows[3:]], QUESTIONS)
        self.assertEqual(session.run.call_count, 3)
        self.assertEqual([len(call.args[1]["input_ids"]) for call in session.run.call_args_list], [2, 2, 1])
        self.assertEqual([row["p"] for row in rows], [noul_p(v, 1.5) for v in (1, 2, 3, 4, 5)])

    def test_scores_a_choice_decision_in_one_prompt_with_its_option_bucket_temperature(self):
        scorer, session, _ = self.scorer(batch_size=8)
        scorer.temps["by_options"]["choice:3-5"] = 2.0
        row = {"decision": "d", "task": "answer", "state": {"facts": "F", "question": "Q"}, "answers": {"yn": "No"}}
        decision = candidates(row, {"yn": YES_NO})
        asked = []

        def sequence(tok, state, q, *args):
            asked.append((state, q))
            return [3, 7, 7, 7], [1, 2, 3]

        with patch("onnx_score.build_sequence", side_effect=sequence):
            scorer.score_decisions([decision], {"yn": YES_NO})
        self.assertEqual(session.run.call_count, 1)
        self.assertEqual(asked, [({"facts": "F", "question": "Q"}, {"t": "choice", "ins": "Which option?", "crit": dict.fromkeys(YES_NO["criteria"])})])
        self.assertEqual([c["p"] for c in decision], calibrated(np.array([0.0, 3.0, 6.0]), 2.0))

    def test_a_prompt_that_loses_an_option_is_refused(self):
        scorer, _, _ = self.scorer()
        decision = candidates({"decision": "d", "task": "answer", "state": {"question": "Q"}, "answers": {"yn": "No"}}, {"yn": YES_NO})
        with patch("onnx_score.build_sequence", side_effect=lambda *a: ([1, 7], [1, 2])):
            with self.assertRaisesRegex(ValueError, "option"):
                scorer.score_decisions([decision], {"yn": YES_NO})

    def test_prints_progress(self):
        scorer, _, _ = self.scorer(batch_size=2)
        rows = [{"state": {"candidate": 1}} for _ in range(5)]
        out = io.StringIO()
        with patch("onnx_score.build_sequence", side_effect=lambda tok, state, q, *a: ([1, 7, 7], [1, 2])):
            with redirect_stdout(out):
                scorer.score_decisions([rows], QUESTIONS, progress_every=2)
        self.assertEqual([line.split(" in ")[0] for line in out.getvalue().splitlines()], ["scored 2/5 prompts", "scored 4/5 prompts", "scored 5/5 prompts"])

    def test_noul_rows_need_the_single_noul_question(self):
        scorer, _, _ = self.scorer()
        with self.assertRaisesRegex(ValueError, "noul"):
            scorer.score_decisions([[{"state": {"candidate": "a"}}]], {"correct": {"type": "choice", "instructions": "x", "criteria": ["a", "b"]}})
        with self.assertRaisesRegex(ValueError, "single"):
            scorer.score_decisions([[{"state": {"candidate": "a"}}]], {**QUESTIONS, "other": QUESTIONS["correct"]})

    def test_threads_limit_the_session(self):
        _, _, make = self.scorer(threads=4)
        self.assertEqual(make.call_args.kwargs["sess_options"].intra_op_num_threads, 4)
        self.assertEqual(make.call_args.kwargs["providers"], ["CPUExecutionProvider"])


if __name__ == "__main__":
    unittest.main()
