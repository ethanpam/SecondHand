"""Reference outputs for the desktop app's JavaScript Laya runtime (desktop/laya*.cjs, #38).

The desktop app ports Laya's tokenizer, prompt builder and calibration to JavaScript and runs
the int8 ONNX export with onnxruntime-node. These fixtures come from the Python side, so the
tests can check the port id for id and probability for probability.

    # A small byte-level BPE tokenizer and its expected outputs (always tested):
    uv run --project ~/Projects/LayaStudio python ML_model/eval/runtime_fixtures.py small
    # A weightless graph with the export's inputs and output, for the ONNX runner tests:
    uv run --project ~/Projects/LayaStudio python ML_model/eval/runtime_fixtures.py tiny

    # A real model: token ids, prompts and probabilities for a fixed sample of rows, built in the
    # model's format. It writes that format's file, parity-noul.json or parity-choice.json, which
    # tests/laya-parity.test.cjs checks when SECONDHAND_LAYA_NOUL_MODEL_DIR or
    # SECONDHAND_LAYA_CHOICE_MODEL_DIR points at the export:
    node ML_model/dataset/build.cjs --format <format> --today 2026-09-26 --households 50 --seed 3 --per-question 2 --out <dir>
    uv run --project ~/Projects/LayaStudio python ML_model/eval/runtime_fixtures.py parity \
        --export <export dir> --checkpoint <run>/model --rows <dir>/rows.jsonl
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "laya"
# Must match BATCH_SIZE in desktop/laya.cjs: decideBatch sorts decisions by length and runs
# them in chunks of this size, and dynamic int8 quantization depends on the batch.
BATCH_SIZE = 8
DECISION = {
    "type": "noul",
    "instructions": "Given the facts about the household, is the candidate the correct answer to the form question?",
}
MATCH = {
    "type": "choice",
    "instructions": "Which saved answer does this form question ask for?",
    "criteria": ["first name", "last name", "email address", "phone number", "none of these"],
}
SPECIAL = ["[UNK]", "[CLS]", "[SEP]", "[PAD]", "[MASK]"]
# Edge cases for the tokenizer: added tokens (special, space runs, placeholders), contractions,
# Unicode whitespace the regex engines disagree on, combining marks, emoji, and NFC.
STRINGS = [
    "",
    "hi",
    "Is anyone in your household 60 or older?",
    "The household’s total income is $3,400 a month ($40,800 a year).",
    "I'm sure they'll say it's what we've done, and you'd agree we're fine.",
    "IT'S ALL CAPS'S",
    "two  spaces,   three,    four and a tab\there\nnewline\r\n",
    " " * 30 + "thirty spaces then text",
    "trailing spaces   ",
    "   leading spaces",
    "[CLS] start [SEP] middle [PAD][UNK] end",
    "a[MASK]b and  [MASK] c",
    "|||EMAIL_ADDRESS||| or |||PHONE_NUMBER||| or |||IP_ADDRESS|||",
    "[unused0][unused12] x",
    "Café, naïve, e\u0301 (combining), ﬁ ligature, ｆｕｌｌ width",
    "Non-breaking\u00a0space, NEL\u0085here, BOM\ufeffthere, ideographic\u3000space",
    "Emoji 👩‍👩‍👧 and 🍎🍞 plus ✓",
    "中文字符 and العربية and हिन्दी",
    "Numbers: 1234567890, 3.14, -42, 1st 2nd ٣",
    "Punctuation!!! ...??? --- (#@$%^&*) ‘quotes’ “double”",
    "<|endoftext|> and <|padding|>",
    "Sr. Jr. IV, P.O. Box 123, Apt #4B",
]


# The reference outputs for each model format the desktop app runs (desktop/laya-model.cjs MODEL_FORMATS).
PARITY_FIXTURES = {"noul-v1": "parity-noul.json", "choice-v2": "parity-choice.json"}


def parity_fixture(model_format):
    """Where a model format's reference outputs live."""
    if model_format not in PARITY_FIXTURES:
        raise ValueError(f"No parity fixture for the {model_format} format")
    return FIXTURES / PARITY_FIXTURES[model_format]


def sha256_ids(ids):
    return hashlib.sha256(json.dumps(list(ids), separators=(",", ":")).encode()).hexdigest()


def small(args):
    """Train a small tokenizer in ModernBERT's layout, then record what Python makes of it."""
    from laya_mlx.agent import Agent
    from laya_mlx.common import build_sequence
    from laya_mlx.tokenizer import Tokenizer as LayaTokenizer
    from tokenizers import AddedToken, Tokenizer, decoders, models, normalizers, pre_tokenizers, trainers

    corpus = [
        *STRINGS,
        "The applicant is 41 years old. The household has 3 people: 2 adults and 1 child under 18.",
        "Nobody in the household is 60 or older. The applicant lives in Polk County, Iowa.",
        "Is this candidate the correct answer to the form question, given the facts?",
        "false: no, the statement does not hold. true: yes, the statement holds.",
        "Which saved answer does this form question ask for? first name, last name, email address.",
    ] * 4
    tokenizer = Tokenizer(models.BPE())
    tokenizer.normalizer = normalizers.NFC()
    tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=True)
    tokenizer.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(
        vocab_size=700, min_frequency=2, initial_alphabet=pre_tokenizers.ByteLevel.alphabet(), show_progress=False
    )
    tokenizer.train_from_iterator(corpus, trainer=trainer)
    tokenizer.add_tokens(
        [AddedToken(" " * n, normalized=True) for n in range(24, 1, -1)]
        + [AddedToken(t, normalized=True) for t in ("|||IP_ADDRESS|||", "|||EMAIL_ADDRESS|||", "|||PHONE_NUMBER|||")]
        + [AddedToken(f"[unused{n}]", normalized=True) for n in range(3)]
    )
    tokenizer.add_special_tokens(
        [AddedToken(t, normalized=False, special=True) for t in ("<|endoftext|>", "<|padding|>", *SPECIAL[:4])]
        + [AddedToken("[MASK]", normalized=False, special=True, lstrip=True)]
    )
    directory = FIXTURES / "small-tokenizer"
    directory.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(directory / "tokenizer.json"))
    (directory / "tokenizer_config.json").write_text(
        json.dumps(
            {"cls_token": "[CLS]", "mask_token": "[MASK]", "pad_token": "[PAD]", "sep_token": "[SEP]", "unk_token": "[UNK]"},
            indent=2,
        )
        + "\n"
    )

    laya = LayaTokenizer(directory)
    encode = [{"text": text, "ids": laya(text)["input_ids"]} for text in STRINGS]
    long_facts = " ".join(["The household has 3 people: 2 adults and 1 child under 18."] * 60)
    questions = {
        "noul": DECISION,
        "noul-criteria": {**DECISION, "criteria": {"false": "it is not", "true": {"desc": "it is", "n": 1}}},
        "choice": MATCH,
        "choice-descriptions": {
            "type": "choice",
            "instructions": {"ask": "Pick one", "note": "[MASK] is removed"},
            "criteria": {"yes": "the facts say yes", "no": "", "unsure": None, "count": 3},
        },
        "choice-long": {
            "type": "choice",
            "instructions": "Which county? " * 40,
            "criteria": [f"option {n} " + "with a long description " * 8 for n in range(12)],
        },
    }
    states = [
        "plain text state",
        {"facts": "The applicant is 41 years old.", "question": "Age?", "candidate": "41"},
        {"question": "Email \"work\"\\home\n\ttab", "candidate": "Saved answer: email [MASK] address", "nested": [1, True, None, {"k": "v"}]},
        {"facts": long_facts, "question": "How many children?", "candidate": "One"},
    ]
    sequences = []
    for state in states:
        for qid, definition in questions.items():
            ids, markers = build_sequence(laya, state, Agent._to_internal(definition), 512, 192)
            sequences.append({"state": state, "question": qid, "ids": ids, "markers": markers})
    out = {"questions": questions, "encode": encode, "sequences": sequences}
    (FIXTURES / "small-tokenizer-cases.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"Wrote {directory} and {len(encode)} strings, {len(sequences)} sequences")


def tiny(args):
    """A weightless five-input graph with the export's signature, for testing the ONNX runner.

    logits = where(marker_mask, marker_pos / 100 + tokens / 1000 + qtype / 10 + 0 * sum(input_ids), -1e4)
    """
    import onnx
    from onnx import TensorProto, helper

    def const(name, value, dtype=TensorProto.FLOAT):
        return helper.make_node("Constant", [], [name], value=helper.make_tensor(name, dtype, [], [value]))

    nodes = [
        const("c100", 100.0), const("c1000", 1000.0), const("c10", 10.0), const("zero", 0.0), const("fill", -1e4),
        helper.make_node("Constant", [], ["axis1"], value=helper.make_tensor("axis1", TensorProto.INT64, [1], [1])),
        helper.make_node("Cast", ["marker_pos"], ["pos"], to=TensorProto.FLOAT),
        helper.make_node("Div", ["pos", "c100"], ["a"]),
        helper.make_node("ReduceSum", ["attention_mask", "axis1"], ["tokens_i"], keepdims=1),
        helper.make_node("Cast", ["tokens_i"], ["tokens"], to=TensorProto.FLOAT),
        helper.make_node("Div", ["tokens", "c1000"], ["b"]),
        helper.make_node("Unsqueeze", ["qtype", "axis1"], ["qtype2"]),
        helper.make_node("Cast", ["qtype2"], ["qtypef"], to=TensorProto.FLOAT),
        helper.make_node("Div", ["qtypef", "c10"], ["c"]),
        helper.make_node("ReduceSum", ["input_ids", "axis1"], ["ids_i"], keepdims=1),
        helper.make_node("Cast", ["ids_i"], ["idsf"], to=TensorProto.FLOAT),
        helper.make_node("Mul", ["idsf", "zero"], ["d"]),
        helper.make_node("Add", ["a", "b"], ["ab"]),
        helper.make_node("Add", ["ab", "c"], ["abc"]),
        helper.make_node("Add", ["abc", "d"], ["scores"]),
        helper.make_node("Where", ["marker_mask", "scores", "fill"], ["logits"]),
    ]
    inputs = [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "tokens"]),
        helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "tokens"]),
        helper.make_tensor_value_info("marker_pos", TensorProto.INT64, ["batch", "options"]),
        helper.make_tensor_value_info("marker_mask", TensorProto.BOOL, ["batch", "options"]),
        helper.make_tensor_value_info("qtype", TensorProto.INT64, ["batch"]),
    ]
    output = helper.make_tensor_value_info("logits", TensorProto.FLOAT, ["batch", "options"])
    graph = helper.make_graph(nodes, "tiny-laya-signature", inputs, [output])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)], producer_name="runtime_fixtures.py")
    model.ir_version = 8
    onnx.checker.check_model(model)
    target = FIXTURES / "tiny-graph.onnx"
    onnx.save(model, str(target))
    print(f"Wrote {target} ({target.stat().st_size} bytes)")


def clamp(t):
    from laya_mlx.common import clamp_temperature

    return clamp_temperature(t)


def calibrated(logits, k, qtype, config):
    from laya_mlx.common import temp_bucket

    by_options = {key: clamp(value) for key, value in config.get("temperature_by_options", {}).items()}
    scale = by_options.get(temp_bucket(qtype, k), clamp(config.get("temperature", [1.0, 1.0, 1.0])[qtype]))
    z = np.asarray(logits[:k], dtype=np.float64) / scale
    p = np.exp(z - z.max())
    return (p / p.sum()).tolist()


def collate(items, pad_id):
    n, length = len(items), max(len(item["ids"]) for item in items)
    count = max(2, max(len(item["markers"]) for item in items))
    batch = {
        "input_ids": np.full((n, length), pad_id, dtype=np.int64),
        "attention_mask": np.zeros((n, length), dtype=np.int64),
        "marker_pos": np.zeros((n, count), dtype=np.int64),
        "marker_mask": np.zeros((n, count), dtype=bool),
        "qtype": np.array([item["qtype"] for item in items], dtype=np.int64),
    }
    for i, item in enumerate(items):
        batch["input_ids"][i, : len(item["ids"])] = item["ids"]
        batch["attention_mask"][i, : len(item["ids"])] = 1
        batch["marker_pos"][i, : len(item["markers"])] = item["markers"]
        batch["marker_mask"][i, : len(item["markers"])] = True
    return batch


def parity(args):
    import onnxruntime
    from laya_mlx.agent import Agent, collate_items
    from laya_mlx.common import QTYPES, build_sequence
    from laya_mlx.tokenizer import Tokenizer

    from decisions import dataset_format

    export = Path(args.export)
    config = json.loads((export / "rl_agent_config.json").read_text())
    tok = Tokenizer(export / "tokenizer")
    rows = [json.loads(line) for line in Path(args.rows).read_text().splitlines() if line.strip()]
    questions = json.loads((Path(args.rows).parent / "questions.json").read_text())
    model_format = dataset_format(questions)
    step = len(rows) // args.count
    picked = [rows[i * step] for i in range(args.count)]
    if model_format == "noul-v1":
        labels = ["Email address", "First name", "Last name", "Phone number", "Do you have a pet?"]
        decisions = [{"state": row["state"], "questions": {"correct": DECISION}} for row in picked]
        decisions += [{"state": {"question": label}, "questions": {"match": MATCH}} for label in labels]
    else:
        # A choice-v2 row's one question, under the name the desktop asks it by (desktop/laya-decisions.cjs).
        decisions = [{"state": row["state"], "questions": {"choice": questions[next(iter(row["answers"]))]}} for row in picked]

    items = []
    for d in decisions:
        for qid, definition in d["questions"].items():
            q = Agent._to_internal(definition)
            ids, markers = build_sequence(tok, d["state"], q, config["max_len"], config["head_max_len"])
            items.append({"ids": ids, "markers": markers, "qtype": QTYPES[q["t"]], "qid": qid})

    session = onnxruntime.InferenceSession(str(export / "model.onnx"), providers=["CPUExecutionProvider"])

    def run(chunk):
        return session.run(["logits"], collate(chunk, tok.pad_token_id))[0]

    single = [calibrated(run([item])[0], len(item["markers"]), item["qtype"], config) for item in items]
    batched = [None] * len(items)
    order = sorted(range(len(items)), key=lambda i: len(items[i]["ids"]))
    for start in range(0, len(order), BATCH_SIZE):
        chunk = order[start : start + BATCH_SIZE]
        for i, logits in zip(chunk, run([items[i] for i in chunk])):
            batched[i] = calibrated(logits, len(items[i]["markers"]), items[i]["qtype"], config)

    # The trained model in MLX, in the precision it was trained in, for the report.
    mlx = []
    agent = Agent(args.checkpoint, dtype="bfloat16", batch_size=BATCH_SIZE)
    for start in range(0, len(items), BATCH_SIZE):
        chunk = items[start : start + BATCH_SIZE]
        logits, _ = agent.forward(collate_items(chunk, tok.pad_token_id, max_length=config["max_len"]))
        for row, item in enumerate(chunk):
            mlx.append(calibrated(np.asarray(logits)[row], len(item["markers"]), item["qtype"], config))

    gap = max(abs(a - b) for s, m in zip(single, mlx) for a, b in zip(s, m))
    out = {
        "format": model_format,
        "export": {
            "files": {
                name: {"size": (export / name).stat().st_size, "sha256": hashlib.sha256((export / name).read_bytes()).hexdigest()}
                for name in ("model.onnx", "model.onnx.data", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json", "rl_agent_config.json")
            },
            "checkpoint": json.loads((Path(args.checkpoint) / "laya_finetune.json").read_text())["run_id"],
            "onnxruntime": onnxruntime.__version__,
        },
        "batchSize": BATCH_SIZE,
        "strings": [{"text": text, "ids": tok(text)["input_ids"]} for text in STRINGS],
        "decisions": [
            {
                "state": d["state"],
                "questions": d["questions"],
                "length": len(item["ids"]),
                "idsSha256": sha256_ids(item["ids"]),
                "markers": item["markers"],
                "onnx": s,
                "onnxBatched": b,
                "mlxBfloat16": m,
            }
            for d, item, s, b, m in zip(decisions, items, single, batched, mlx)
        ],
        "maxGapToMlxBfloat16": gap,
    }
    if not all(math.isfinite(p) for s in single + batched for p in s):
        raise SystemExit("Non-finite probabilities")
    target = Path(args.out) if args.out else parity_fixture(model_format)
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    diff = max(abs(a - b) for s, b in zip(single, batched) for a, b in zip(s, b))
    print(f"Wrote {len(items)} decisions to {target}; batched vs single {diff:.2e}; ONNX int8 vs MLX bf16 {gap:.2e}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("small")
    sub.add_parser("tiny")
    p = sub.add_parser("parity")
    p.add_argument("--export", required=True)
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--rows", required=True)
    p.add_argument("--count", type=int, default=50)
    p.add_argument("--out", help="where to write the outputs (default: the format's file in tests/fixtures/laya)")
    args = parser.parse_args()
    {"small": small, "tiny": tiny, "parity": parity}[args.command](args)


if __name__ == "__main__":
    main()
