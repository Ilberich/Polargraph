import os
import shutil
import tempfile
import unittest

from config import Config, DEFAULTS


class Loading(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.path = os.path.join(self.directory, "config.json")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_a_missing_file_gives_defaults_rather_than_refusing_to_boot(self):
        config = Config.load(self.path)
        self.assertEqual(config.values, DEFAULTS)

    def test_a_corrupt_file_gives_defaults_too(self):
        # The machine comes up and the app can write a real one over the
        # network. Refusing to boot over a bad config leaves no way to fix it.
        with open(self.path, "w") as handle:
            handle.write("{ not json")

        self.assertEqual(Config.load(self.path).values, DEFAULTS)

    def test_what_was_saved_comes_back(self):
        config = Config(self.path)
        config.merge({"ssid": "home", "password": "hunter2"})
        config.save()

        self.assertEqual(Config.load(self.path)["ssid"], "home")
        self.assertEqual(Config.load(self.path)["password"], "hunter2")


class Merging(unittest.TestCase):
    def setUp(self):
        self.config = Config("/tmp/unused.json")

    def test_a_partial_update_leaves_the_rest_alone(self):
        self.config.merge({"ssid": "home", "password": "hunter2"})
        self.config.merge({"hostname": "plotter"})

        self.assertEqual(self.config["ssid"], "home")
        self.assertEqual(self.config["hostname"], "plotter")

    def test_settings_that_are_not_ours_are_ignored(self):
        # WiFi credentials only. A plotter that remembers a paper size is a
        # plotter that will one day draw on the wrong paper without being
        # asked.
        self.config.merge({"paperSize": {"width": 999}, "maxSpeed": 99})

        self.assertNotIn("paperSize", self.config.values)
        self.assertNotIn("maxSpeed", self.config.values)

    def test_the_password_never_leaves_the_machine(self):
        self.config.merge({"ssid": "home", "password": "hunter2"})

        self.assertNotIn("password", self.config.public())
        self.assertEqual(self.config.public()["ssid"], "home")


if __name__ == "__main__":
    unittest.main()
