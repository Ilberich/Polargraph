import os
import shutil
import tempfile
import unittest

from store import Store, Writer, safe_name, StoreError


class Names(unittest.TestCase):
    """A plotter has no business accepting anything a filesystem might find
    interesting."""

    def test_a_plain_name_is_fine(self):
        self.assertEqual(safe_name("mandala.gcode"), "mandala.gcode")
        self.assertEqual(safe_name("wrench 2 final.gcode"), "wrench 2 final.gcode")

    def test_paths_are_refused_rather_than_sanitised(self):
        # Quietly rewriting a name means the file uploaded and the file asked
        # for can differ, which is worse than saying no.
        for bad in ("../boot.py", "a/b.gcode", "/etc/passwd", "..", "x\\y"):
            with self.assertRaises(StoreError, msg=bad):
                safe_name(bad)

    def test_leading_dots_and_spaces_are_refused(self):
        for bad in (".hidden", " leading", "trailing "):
            with self.assertRaises(StoreError, msg=bad):
                safe_name(bad)

    def test_empty_and_overlong_names_are_refused(self):
        with self.assertRaises(StoreError):
            safe_name("")
        with self.assertRaises(StoreError):
            safe_name("x" * 65)

    def test_the_refusal_carries_an_api_slug(self):
        with self.assertRaises(StoreError) as caught:
            safe_name("../x")

        self.assertEqual(caught.exception.slug, "bad_name")


class Files(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.store = Store(self.directory, usage=lambda: {"usedBytes": 1, "totalBytes": 2})

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_an_upload_is_written_as_it_arrives(self):
        # Nothing on this path ever holds the whole file: a 4MB plot lands on a
        # machine with 512KB of memory because no part of it sees more than a
        # chunk.
        writer = self.store.open_write("job.gcode")
        for chunk in (b"G90\n", b"G1 X10 Y10\n", b"M30\n"):
            writer.write(chunk)

        self.assertEqual(writer.close(), 19)
        self.assertTrue(self.store.exists("job.gcode"))

    def test_an_upload_can_be_used_as_a_context_manager(self):
        with self.store.open_write("job.gcode") as writer:
            writer.write(b"G90\n")

        self.assertEqual(self.store.list()[0]["bytes"], 4)

    def test_listing_reports_size_and_time(self):
        with self.store.open_write("a.gcode") as writer:
            writer.write(b"G90\n")
        with self.store.open_write("b.gcode") as writer:
            writer.write(b"G90\nG91\n")

        listing = self.store.list()
        self.assertEqual([f["name"] for f in listing], ["a.gcode", "b.gcode"])
        self.assertEqual(listing[1]["bytes"], 8)
        self.assertGreater(listing[0]["modified"], 0)

    def test_reading_streams_rather_than_slurping(self):
        with self.store.open_write("job.gcode") as writer:
            writer.write(b"G90\nG1 X1\nM30\n")

        with self.store.open_read("job.gcode") as handle:
            self.assertEqual(next(iter(handle)), "G90\n")

    def test_deleting_a_file_that_is_not_there_is_refused(self):
        with self.assertRaises(StoreError) as caught:
            self.store.delete("nothing.gcode")

        self.assertEqual(caught.exception.slug, "not_found")

    def test_reading_a_file_that_is_not_there_is_refused(self):
        with self.assertRaises(StoreError):
            self.store.open_read("nothing.gcode")

    def test_a_bad_name_never_opens_a_file(self):
        with self.assertRaises(StoreError):
            self.store.open_write("../escape.gcode")

        self.assertFalse(os.path.exists(os.path.join(self.directory, "..", "escape.gcode")))

    def test_usage_is_reported_for_the_storage_readout(self):
        self.assertEqual(self.store.usage(), {"usedBytes": 1, "totalBytes": 2})


if __name__ == "__main__":
    unittest.main()
