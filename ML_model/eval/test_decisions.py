"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval"""

import json
import tempfile
import unittest
from pathlib import Path

from decisions import training_precision


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


if __name__ == "__main__":
    unittest.main()
