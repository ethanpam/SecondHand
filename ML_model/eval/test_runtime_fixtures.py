"""uv run --project ~/Projects/LayaStudio python -m unittest discover -s ML_model/eval"""

import unittest

from runtime_fixtures import FIXTURES, parity_fixture


class ParityFixture(unittest.TestCase):
    def test_each_model_format_has_its_own_reference_file(self):
        self.assertEqual(parity_fixture("noul-v1"), FIXTURES / "parity-noul.json")
        self.assertEqual(parity_fixture("choice-v1"), FIXTURES / "parity-choice.json")

    def test_a_format_the_app_does_not_run_is_refused(self):
        with self.assertRaisesRegex(ValueError, "noul-v9"):
            parity_fixture("noul-v9")


if __name__ == "__main__":
    unittest.main()
