import os
import shutil
import tempfile
import unittest

import deploy


class Bundle(unittest.TestCase):
    def setUp(self):
        self.card = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.card, ignore_errors=True)

    def test_the_whole_app_is_copied(self):
        source = os.path.join(deploy.ROOT, "app")
        copied = deploy.copy_bundle(source, os.path.join(self.card, "www"))

        names = [name for name, _ in copied]
        self.assertIn("index.html", names)
        self.assertIn(os.path.join("js", "main.js"), names)

    def test_tests_are_left_behind(self):
        # A third of the tree, and the plotter has no use for them.
        copied = deploy.copy_bundle(os.path.join(deploy.ROOT, "app"),
                                    os.path.join(self.card, "www"))

        self.assertFalse([n for n, _ in copied if n.endswith(".test.js")])

    def test_the_bundle_fits_on_anything(self):
        copied = deploy.copy_bundle(os.path.join(deploy.ROOT, "app"),
                                    os.path.join(self.card, "www"))
        total = sum(size for _, size in copied)

        self.assertLess(total, 1024 * 1024, "%d bytes" % total)

    def test_a_card_gets_a_gcode_directory_too(self):
        deploy.main(["deploy.py", self.card])
        self.assertTrue(os.path.isdir(os.path.join(self.card, "gcode")))


if __name__ == "__main__":
    unittest.main()
