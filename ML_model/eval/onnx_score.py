"""Score SecondHand decisions through an ONNX export of a Laya checkpoint, on the CPU.

Prompts, padding and calibration are laya-mlx's own (build_sequence, collate_items, the
clamped temperatures), so a candidate's probability is comparable with decisions.py's MLX
path. A noul-v1 decision is one prompt per candidate row; a choice-v1 decision is one prompt
whose options are its candidates. Prompts are padded into batches and each batch is one
session.run.
"""

import json
import time
from pathlib import Path

import numpy as np
import onnxruntime
from laya_mlx.agent import Agent, collate_items
from laya_mlx.common import QTYPES, build_sequence, clamp_temperature, render_options, temp_bucket
from laya_mlx.tokenizer import Tokenizer


def calibrated(logits, temperature):
    """Each option's probability after temperature scaling, rounded like laya-mlx."""
    z = np.asarray(logits, dtype=np.float64) / float(temperature)
    shifted = np.exp(z - z.max())
    return [round(float(p), 4) for p in shifted / shifted.sum()]


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


def noul_question(questions):
    """The single noul question every noul-v1 row is labelled with."""
    if len(questions) != 1 or "correct" not in questions:
        raise ValueError("Expected the single 'correct' question SecondHand's noul-v1 rows are labelled with")
    if questions["correct"]["type"] != "noul":
        raise ValueError(f"The 'correct' question must be noul, not {questions['correct']['type']!r}")
    return Agent._to_internal(questions["correct"])


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

    def prompts(self, decisions, questions):
        """(state, question, rows its probabilities go to) for every prompt the decisions need."""
        prompts = []
        for rows in decisions:
            source = rows[0].get("source")
            if source:
                definition = questions[source["qid"]]
                if definition["type"] != "choice" or [row["state"]["candidate"] for row in rows] != definition["criteria"]:
                    raise ValueError(f"Decision {rows[0].get('decision')!r} doesn't list the choices of its question {source['qid']}")
                prompts.append((source["state"], Agent._to_internal(definition), rows))
            else:
                question = noul_question(questions)
                prompts.extend((row["state"], question, [row]) for row in rows)
        return prompts

    def score_decisions(self, decisions, questions, progress_every=0):
        """Set each candidate row's p, the calibrated probability that it is its decision's answer."""
        prompts = self.prompts(decisions, questions)
        max_len, head_max_len = self.cfg.get("max_len", 512), self.cfg.get("head_max_len", 192)
        started, reported = time.time(), 0
        for start in range(0, len(prompts), self.batch_size):
            chunk = prompts[start : start + self.batch_size]
            items = []
            for state, question, rows in chunk:
                ids, markers = build_sequence(self.tok, state, question, max_len, head_max_len)
                if len(markers) != len(render_options(question)):
                    raise ValueError(f"Decision {rows[0].get('decision')!r} lost an option marker to truncation")
                items.append({"ids": ids, "markers": markers, "qtype": QTYPES[question["t"]]})
            logits = self.session.run(["logits"], feeds(items, self.tok.pad_token_id, max_len))[0]
            for (_, question, rows), item, row_logits in zip(chunk, items, logits):
                k = len(item["markers"])
                p = calibrated(row_logits[:k], temperature(self.temps, item["qtype"], k))
                if question["t"] == "noul":
                    rows[0]["p"] = p[1]
                else:
                    for row, value in zip(rows, p):
                        row["p"] = value
            done = start + len(chunk)
            if progress_every and (done - reported >= progress_every or done == len(prompts)):
                print(f"scored {done}/{len(prompts)} prompts in {time.time() - started:.0f}s", flush=True)
                reported = done
