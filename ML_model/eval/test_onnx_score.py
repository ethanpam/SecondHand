"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval"""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

from onnx_score import OnnxScorer, feeds, load_temperatures, noul_probability, temperature

QUESTIONS = {"correct": {"type": "noul", "instructions": "Is the candidate correct?"}}


class NoulProbability(unittest.TestCase):
    def test_equal_logits_are_half(self):
        self.assertEqual(noul_probability(np.array([0.0, 0.0]), temperature=1.0), 0.5)

    def test_temperature_softens_the_true_probability(self):
        sharp = noul_probability(np.array([0.0, 2.0]), temperature=1.0)
        soft = noul_probability(np.array([0.0, 2.0]), temperature=2.0)
        self.assertGreater(sharp, soft)
        self.assertEqual(sharp, round(float(np.exp(2) / (1 + np.exp(2))), 4))

    def test_matches_laya_mlx_softmax_and_rounding(self):
        logits, scale = np.array([-1.2, 0.8]), 1.5465
        z = logits / scale
        p = np.exp(z - z.max())
        p /= p.sum()
        self.assertEqual(noul_probability(logits, temperature=scale), round(float(p[1]), 4))


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
        # Row i of a batch gets logits [0, x] where x is the row's first token id.
        session.run.side_effect = lambda names, fed: [np.stack([np.zeros(len(fed["input_ids"])), fed["input_ids"][:, 0]], axis=1).astype(np.float32)]
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

    def test_scores_rows_in_batches_and_keeps_their_order(self):
        scorer, session, _ = self.scorer(batch_size=2)
        rows = [{"state": {"candidate": value}} for value in (1, 2, 3, 4, 5)]
        with patch("onnx_score.build_sequence", side_effect=lambda tok, state, q, *a: ([state["candidate"], 7, 7], [1, 2])):
            with redirect_stdout(io.StringIO()):
                scorer.score_rows(rows, QUESTIONS)
        self.assertEqual(session.run.call_count, 3)
        self.assertEqual([len(call.args[1]["input_ids"]) for call in session.run.call_args_list], [2, 2, 1])
        self.assertEqual([row["p"] for row in rows], [noul_probability(np.array([0.0, v]), 1.5) for v in (1, 2, 3, 4, 5)])

    def test_prints_progress(self):
        scorer, _, _ = self.scorer(batch_size=2)
        rows = [{"state": {"candidate": 1}} for _ in range(5)]
        out = io.StringIO()
        with patch("onnx_score.build_sequence", side_effect=lambda tok, state, q, *a: ([1, 7, 7], [1, 2])):
            with redirect_stdout(out):
                scorer.score_rows(rows, QUESTIONS, progress_every=2)
        self.assertEqual([line.split(" in ")[0] for line in out.getvalue().splitlines()], ["scored 2/5 rows", "scored 4/5 rows", "scored 5/5 rows"])

    def test_only_the_single_noul_question_is_scored(self):
        scorer, _, _ = self.scorer()
        with self.assertRaisesRegex(ValueError, "noul"):
            scorer.score_rows([{"state": {}}], {"correct": {"type": "choice", "instructions": "x", "criteria": ["a", "b"]}})
        with self.assertRaisesRegex(ValueError, "single"):
            scorer.score_rows([{"state": {}}], {**QUESTIONS, "other": QUESTIONS["correct"]})

    def test_threads_limit_the_session(self):
        _, _, make = self.scorer(threads=4)
        self.assertEqual(make.call_args.kwargs["sess_options"].intra_op_num_threads, 4)
        self.assertEqual(make.call_args.kwargs["providers"], ["CPUExecutionProvider"])


if __name__ == "__main__":
    unittest.main()
