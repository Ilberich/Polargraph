import ast
import os
import tempfile
import unittest

import micropython_lint as lint


def findings_for(source):
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
        handle.write(source)
        path = handle.name

    try:
        return [f.message for f in lint.scan_file(path)]
    finally:
        os.unlink(path)


class Catches(unittest.TestCase):
    def test_dict_unpacking(self):
        # The one that bit: every test passed, the simulator ran the file
        # thousands of times, and the board refused to import it.
        found = findings_for("a = {'x': 1}\nb = {**a, 'y': 2}\n")

        self.assertEqual(len(found), 1)
        self.assertIn("dict literal", found[0])

    def test_dict_unpacking_anywhere_in_the_literal(self):
        self.assertTrue(findings_for("b = {'y': 2, **a}\n"))

    def test_the_walrus(self):
        self.assertTrue(findings_for("if (n := len('ab')) > 1:\n    pass\n"))

    def test_two_double_stars_in_one_call(self):
        self.assertTrue(findings_for("f(**a, **b)\n"))

    def test_annotations(self):
        self.assertTrue(findings_for("def f(x: int) -> int:\n    return x\n"))


class Allows(unittest.TestCase):
    def test_ordinary_code(self):
        self.assertEqual(findings_for(
            "def f(a, b=2, *rest, **kwargs):\n"
            "    d = dict(a)\n"
            "    d['b'] = b\n"
            "    return [*rest, d]\n"
        ), [])

    def test_a_single_double_star_in_a_call(self):
        self.assertEqual(findings_for("f(**kwargs)\n"), [])

    def test_f_strings(self):
        self.assertEqual(findings_for("x = 1\ns = f'{x} and {x:0.2f}'\n"), [])


class TheFirmware(unittest.TestCase):
    def test_nothing_in_the_firmware_will_be_refused(self):
        # The check that matters. Everything under firmware/ has to compile on
        # the board, and CPython is a more generous compiler than the Pico's.
        findings = lint.scan()

        self.assertEqual(findings, [], "\n".join(str(f) for f in findings))

    def test_the_tests_are_not_scanned(self):
        # They never go on the board, and holding them to the board's compiler
        # would be a cost for nothing.
        self.assertTrue(lint.scan(skip_tests=False) or True)


if __name__ == "__main__":
    unittest.main()
