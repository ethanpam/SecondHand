"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/train"""

import json
import tempfile
import unittest
from pathlib import Path

from export import sample_questions, view


def choice(n):
    return {"type": "choice", "instructions": "Which?", "criteria": [f"option {i}" for i in range(n)]}


class SampleQuestions(unittest.TestCase):
    def test_keeps_the_first_question_of_each_task_and_option_count_bucket(self):
        questions = {"answer-b": choice(3), "answer-a": choice(4), "answer-c": choice(2), "answer-d": choice(7), "match-z": choice(20), "match-y": choice(2), "match-x": choice(12)}
        self.assertEqual(list(sample_questions(questions)), ["answer-a", "answer-c", "answer-d", "match-x", "match-y"])

    def test_a_noul_checkpoint_keeps_its_one_question(self):
        noul = {"correct": {"type": "noul", "instructions": "Is it?"}}
        self.assertEqual(sample_questions(noul), noul)


class View(unittest.TestCase):
    def test_links_every_file_but_questions_which_it_replaces(self):
        model = Path(tempfile.mkdtemp())
        (model / "model.safetensors").write_bytes(b"weights")
        (model / "tokenizer").mkdir()
        (model / "tokenizer" / "tokenizer.json").write_text("{}")
        (model / "questions.json").write_text(json.dumps({"answer-a": choice(3), "answer-b": choice(3)}))
        folder = view(model, {"answer-a": choice(3)}, tempfile.mkdtemp())
        self.assertEqual(sorted(entry.name for entry in folder.iterdir()), ["model.safetensors", "questions.json", "tokenizer"])
        self.assertTrue((folder / "model.safetensors").is_symlink())
        self.assertEqual((folder / "tokenizer" / "tokenizer.json").read_text(), "{}")
        self.assertEqual(json.loads((folder / "questions.json").read_text()), {"answer-a": choice(3)})
        self.assertEqual(len(json.loads((model / "questions.json").read_text())), 2, "the checkpoint itself is untouched")


if __name__ == "__main__":
    unittest.main()
