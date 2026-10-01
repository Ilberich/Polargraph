import os
import shutil
import tempfile
import unittest

import check_bundle
import deploy


class Bundle(unittest.TestCase):
    def setUp(self):
        self.card = tempfile.mkdtemp()
        self.www = os.path.join(self.card, "www")
        deploy.copy_bundle(os.path.join(deploy.ROOT, "app"), self.www)

    def tearDown(self):
        shutil.rmtree(self.card, ignore_errors=True)

    def test_a_fresh_deploy_is_complete(self):
        # The two tools have to agree about what belongs on a card, or the
        # checker is just a second opinion nobody can act on.
        missing, wrong_size, extra = check_bundle.compare(self.www)

        self.assertEqual(missing, [])
        self.assertEqual(wrong_size, [])
        self.assertEqual(extra, [])

    def test_a_missing_module_is_found(self):
        # The failure this exists for: one absent module takes the whole
        # import graph down, the static header still renders, and the only
        # evidence is in a console nobody is looking at.
        os.remove(os.path.join(self.www, "js", "main.js"))

        missing, _, _ = check_bundle.compare(self.www)
        self.assertEqual(missing, [os.path.join("js", "main.js")])

    def test_a_truncated_file_is_found(self):
        # A half-copied file is worse than a missing one: it serves a 200.
        path = os.path.join(self.www, "js", "main.js")
        with open(path, "w") as handle:
            handle.write("// cut short\n")

        _, wrong_size, _ = check_bundle.compare(self.www)
        self.assertEqual(len(wrong_size), 1)
        self.assertIn("main.js", wrong_size[0][0])

    def test_tests_are_not_expected_on_a_card(self):
        self.assertFalse([f for f in check_bundle.wanted_files()
                          if f.endswith(".test.js")])


if __name__ == "__main__":
    unittest.main()
