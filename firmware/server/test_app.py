import os
import shutil
import tempfile
import unittest

from server.app import (
    content_type, safe_static_path, read_static, MAX_STATIC_BYTES,
)


class ContentTypes(unittest.TestCase):
    def test_the_bundle_s_own_types_are_known(self):
        self.assertEqual(content_type("/sd/www/index.html"), "text/html")
        self.assertEqual(content_type("/sd/www/js/main.js"), "text/javascript")
        self.assertEqual(content_type("/sd/www/css/app.css"), "text/css")

    def test_anything_else_is_bytes(self):
        self.assertEqual(content_type("x.bin"), "application/octet-stream")
        self.assertEqual(content_type("noextension"), "application/octet-stream")


class Paths(unittest.TestCase):
    def test_a_plain_path_lands_in_the_bundle(self):
        self.assertEqual(safe_static_path("/sd/www", "js/main.js"), "/sd/www/js/main.js")

    def test_a_bare_root_is_the_index(self):
        self.assertEqual(safe_static_path("/sd/www", ""), "/sd/www/index.html")
        self.assertEqual(safe_static_path("/sd/www", "js/"), "/sd/www/js/index.html")

    def test_climbing_out_of_the_bundle_is_refused(self):
        for path in ("../boot.py", "a/../../b", "/etc/passwd", "a\\b"):
            self.assertIsNone(safe_static_path("/sd/www", path), path)


class Reading(unittest.TestCase):
    """Whole and synchronous, which is the property that matters.

    Streaming means `await` between block reads, and an await part way through
    an SD transaction lets another task start its own on top of it — not a
    corrupted file but a corrupted bus. A browser fetching the bundle opens
    several connections at once, so this is the first page load, not an edge
    case.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.mkdir(os.path.join(self.root, "js"))

        with open(os.path.join(self.root, "index.html"), "w") as handle:
            handle.write("<!doctype html><title>Polargraph</title>")
        with open(os.path.join(self.root, "js", "main.js"), "w") as handle:
            handle.write("export const BUILD = 'dev';\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_file_comes_back_with_its_type(self):
        body, kind = read_static(self.root, "js/main.js")

        self.assertIn(b"BUILD", body)
        self.assertEqual(kind, "text/javascript")

    def test_the_root_is_the_index(self):
        body, kind = read_static(self.root, "")

        self.assertIn(b"doctype", body)
        self.assertEqual(kind, "text/html")

    def test_a_missing_file_raises(self):
        with self.assertRaises(OSError):
            read_static(self.root, "js/nothing.js")

    def test_a_path_out_of_the_bundle_raises_before_opening_anything(self):
        with self.assertRaises(OSError):
            read_static(self.root, "../secrets")

    def test_something_too_big_to_hold_is_refused(self):
        # On a machine with a few hundred kilobytes, a file that should not be
        # in the bundle is a real category rather than a theoretical one.
        path = os.path.join(self.root, "huge.bin")
        with open(path, "wb") as handle:
            handle.write(b"x" * 2048)

        with self.assertRaises(OSError):
            read_static(self.root, "huge.bin", max_bytes=1024)

    def test_the_bundle_fits_under_the_cap(self):
        # The guard has to be above everything actually deployed, or the app
        # would refuse to serve itself.
        app_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "..", "..", "app")
        biggest = 0

        for base, _, names in os.walk(app_dir):
            for name in names:
                if name.endswith(".test.js"):
                    continue
                biggest = max(biggest, os.path.getsize(os.path.join(base, name)))

        self.assertLess(biggest, MAX_STATIC_BYTES,
                        "the biggest deployed file is %d bytes" % biggest)


if __name__ == "__main__":
    unittest.main()
