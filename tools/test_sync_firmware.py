import os
import unittest

import sync_firmware


class Plan(unittest.TestCase):
    """The thing that gets the paths right is the thing under test.

    `mpremote cp server/app.py :` puts the file at `/app.py` — cp takes the
    basename — while `/server/app.py` keeps whatever it had. mpremote reports
    success and means it. The board then runs a mixture of versions, and the
    symptom surfaces somewhere else entirely.
    """

    def setUp(self):
        self.directories, self.files = sync_firmware.plan()
        self.remotes = [remote for _, remote in self.files]

    def test_a_nested_module_keeps_its_directory(self):
        self.assertIn("server/app.py", self.remotes)
        self.assertIn("server/api.py", self.remotes)
        self.assertIn("motion/kinematics.py", self.remotes)
        self.assertIn("gcode/parser.py", self.remotes)

    def test_nothing_is_flattened_to_the_root(self):
        # The bug this tool exists for: every file that lives in a directory
        # must arrive in one.
        for local, remote in self.files:
            depth_local = os.path.relpath(local, sync_firmware.FIRMWARE).count(os.sep)
            self.assertEqual(remote.count("/"), depth_local, remote)

    def test_the_entry_point_is_at_the_root(self):
        self.assertIn("main.py", self.remotes)

    def test_the_directories_come_before_the_files_that_need_them(self):
        calls = sync_firmware.commands()
        last_mkdir = max(i for i, c in enumerate(calls) if c[1] == "mkdir")
        first_cp = min(i for i, c in enumerate(calls) if c[1] == "cp")

        self.assertLess(last_mkdir, first_cp)

    def test_every_directory_a_file_needs_is_created(self):
        needed = {r.rsplit("/", 1)[0] for r in self.remotes if "/" in r}
        self.assertEqual(needed - set(self.directories), set())

    def test_tests_are_left_behind(self):
        # They never run on the board and they are a third of the tree.
        self.assertFalse([r for r in self.remotes if r.split("/")[-1].startswith("test_")])

    def test_the_whole_firmware_goes(self):
        on_disk = set()

        for base, dirs, names in os.walk(sync_firmware.FIRMWARE):
            dirs[:] = [d for d in dirs if not d.startswith("__")]
            for name in names:
                if name.endswith(".py") and not name.startswith("test_"):
                    path = os.path.join(base, name)
                    on_disk.add(os.path.relpath(path, sync_firmware.FIRMWARE)
                                .replace(os.sep, "/"))

        self.assertEqual(set(self.remotes), on_disk)


class Commands(unittest.TestCase):
    def test_a_copy_names_both_ends(self):
        for call in sync_firmware.commands():
            if call[1] != "cp":
                continue

            self.assertTrue(os.path.isfile(call[2]), call[2])
            self.assertTrue(call[3].startswith(":"), call[3])
            self.assertNotEqual(call[3], ":", "cp to a bare colon flattens")

    def test_cleaning_removes_the_strays_the_flattening_left(self):
        calls = sync_firmware.commands(clean=True)
        removed = [c[2][1:] for c in calls if c[1] == "rm"]

        self.assertIn("app.py", removed)
        self.assertIn("api.py", removed)

    def test_cleaning_is_not_the_default(self):
        self.assertFalse([c for c in sync_firmware.commands() if c[1] == "rm"])

    def test_a_stray_never_shares_a_name_with_something_that_belongs(self):
        # Removing /app.py must not remove anything the firmware needs. The
        # root-level modules are the ones to be careful about.
        _, files = sync_firmware.plan()
        at_root = {r for _, r in files if "/" not in r}

        self.assertEqual(at_root & set(sync_firmware.KNOWN_STRAYS), set())


if __name__ == "__main__":
    unittest.main()
