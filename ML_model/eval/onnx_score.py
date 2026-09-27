"""Score SecondHand decision rows through an ONNX export of a Laya checkpoint, on the CPU.

Prompts, padding and calibration are laya-mlx's own (build_sequence, collate_items, the
clamped temperatures), so a row's `noul` probability is comparable with decisions.py's MLX
path. Rows are padded into batches and each batch is one session.run.
"""

import json
import time
from pathlib import Path

import numpy as np
import onnxruntime
from laya_mlx.agent import collate_items
from laya_mlx.common import QTYPES, build_sequence, clamp_temperature, temp_bucket
from laya_mlx.tokenizer import Tokenizer


def noul_probability(logits, temperature):
    """The true option's probability after temperature scaling, rounded like laya-mlx."""
    z = np.asarray(logits, dtype=np.float64) / float(temperature)
    shifted = np.exp(z - z.max())
    return round(float(shifted[1] / shifted.sum()), 4)


def load_temperatures(cfg):
    """The calibration temperatures in rl_agent_config.json, clamped like laya-mlx."""
    return {
        "by_type": [clamp_temperature(t) for t in cfg.get("temperature", [1.0, 1.0, 1.0])],
        "by_options": {key: clamp_temperature(t) for key, t in cfg.get("temperature_by_options", {}).items()},
    }


def temperature(temps, qtype, k):
    """laya-mlx's choice: the bucket for this type and option count, else the type's own."""
    return temps["by_options"].get(temp_bucket(qtype, k), temps["by_type"][qtype])


def feeds(items, pad_id, max_len):
    """laya-mlx's padded batch, in the dtypes the exported graph takes."""
    batch = collate_items(items, pad_id, max_length=max_len)
    return {
        "input_ids": batch["input_ids"].astype(np.int64),
        "attention_mask": batch["attention_mask"].astype(np.int64),
        "marker_pos": batch["marker_pos"].astype(np.int64),
        "marker_mask": batch["marker_mask"].astype(np.bool_),
        "qtype": batch["qtype"].astype(np.int64),
    }


class OnnxScorer:
    def __init__(self, onnx_dir, batch_size=16, threads=None):
        self.onnx_dir = Path(onnx_dir)
        model = self.onnx_dir / "model.onnx"
        if not model.exists():
            raise FileNotFoundError(f"{model} is missing")
        self.cfg = json.loads((self.onnx_dir / "rl_agent_config.json").read_text())
        self.temps = load_temperatures(self.cfg)
        self.tok = Tokenizer(self.onnx_dir / "tokenizer")
        self.batch_size = batch_size
        options = onnxruntime.SessionOptions()
        if threads:
            options.intra_op_num_threads = threads
        self.session = onnxruntime.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])

    def score_rows(self, rows, questions, progress_every=0):
        """Set row["p"], the calibrated probability that the row's candidate is correct."""
        if len(questions) != 1 or "correct" not in questions:
            raise ValueError("Expected the single 'correct' question SecondHand's rows are labelled with")
        definition = questions["correct"]
        if definition["type"] != "noul":
            raise ValueError(f"The 'correct' question must be noul, not {definition['type']!r}")
        q = {"t": "noul", "ins": definition["instructions"], "crit": definition.get("criteria")}
        max_len, head_max_len = self.cfg.get("max_len", 512), self.cfg.get("head_max_len", 192)
        started, reported = time.time(), 0
        for start in range(0, len(rows), self.batch_size):
            chunk = rows[start : start + self.batch_size]
            items = []
            for row in chunk:
                ids, markers = build_sequence(self.tok, row["state"], q, max_len, head_max_len)
                if len(markers) != 2:
                    raise ValueError(f"Row {row.get('decision')!r} lost an option marker to truncation")
                items.append({"ids": ids, "markers": markers, "qtype": QTYPES["noul"]})
            logits = self.session.run(["logits"], feeds(items, self.tok.pad_token_id, max_len))[0]
            scale = temperature(self.temps, QTYPES["noul"], 2)
            for row, row_logits in zip(chunk, logits):
                row["p"] = noul_probability(row_logits[:2], scale)
            done = start + len(chunk)
            if progress_every and (done - reported >= progress_every or done == len(rows)):
                print(f"scored {done}/{len(rows)} rows in {time.time() - started:.0f}s", flush=True)
                reported = done
