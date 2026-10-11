"""Catching Python that CPython accepts and MicroPython does not.

The firmware is plain Python so the desktop can run it, which is what makes
the simulator and the test suite possible. The cost is that CPython is a more
generous compiler than the one on the Pico, and the difference does not show up
in a test — it shows up as a `SyntaxError` at import time on the board, after
the file has been copied across, naming a line number and nothing else.

Two kinds of thing bite.

**Syntax.** `**` unpacking inside a dict literal is not implemented by
MicroPython's compiler. Every test passed, the simulator ran the same file
thousands of times, and the board refused to import it with a bare
`SyntaxError` naming a line number.

**Missing standard library.** `math.hypot` does not exist on MicroPython. That
one is not even an import error: the file loads, and the first call raises
`AttributeError` — which for `hypot` meant the motors worked, the web server
worked, and `/api/status` returned 500, because that endpoint happened to be
the first thing to compute a belt length.

So: walk the AST for both. This is a denylist and therefore incomplete by
nature — it knows about what has been hit and what is documented, not about
everything. It is still the difference between finding these at `npm test` and
finding them at a bench.
"""

import ast
import os
import sys


ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

#: Directories whose Python has to run on the board.
FIRMWARE = os.path.join(ROOT, "firmware")

#: Standard-library names CPython has and MicroPython does not.
#:
#: The second way this bites, after syntax. These are not compile errors — the
#: file imports perfectly and raises `AttributeError` the first time that line
#: is reached, which can be a long way into bring-up. `math.hypot` was reached
#: for the first time by `/api/status`, after the motors already worked.
#:
#: Conservative on purpose: only names confirmed absent, since a false
#: positive here makes people route around the lint.
MISSING_ATTRIBUTES = {
    "math": (
        "hypot", "dist", "prod", "comb", "perm", "isqrt", "remainder",
        "nextafter", "ulp", "tau",
    ),
    "os": ("path", "walk", "makedirs", "replace", "scandir"),
    "time": ("monotonic", "perf_counter", "strftime", "process_time"),
}

#: What to use instead, where there is an obvious answer.
INSTEAD = {
    "math.hypot": "math.sqrt(a * a + b * b)",
    "math.dist": "math.sqrt of the differences",
    "math.isqrt": "int(math.sqrt(n))",
    "os.path": "string joins; MicroPython has no os.path at all",
    "os.walk": "os.listdir and recursion",
    "os.makedirs": "os.mkdir, one level at a time",
    "time.monotonic": "time.ticks_ms and time.ticks_diff",
    "time.perf_counter": "time.ticks_us and time.ticks_diff",
}


class Finding:
    def __init__(self, path, line, message):
        self.path = path
        self.line = line
        self.message = message

    def __str__(self):
        return "%s:%d  %s" % (os.path.relpath(self.path, ROOT), self.line, self.message)


class Scanner(ast.NodeVisitor):
    """Everything known to be unsupported, with why it matters."""

    def __init__(self, path):
        self.path = path
        self.findings = []

    def report(self, node, message):
        self.findings.append(Finding(self.path, node.lineno, message))

    def visit_Dict(self, node):
        # `{**a, "b": 1}` — the compiler rejects the line outright.
        if any(key is None for key in node.keys):
            self.report(node, "`**` unpacking in a dict literal is not supported; "
                              "build the dict with dict() and assignment")

        self.generic_visit(node)

    def visit_Call(self, node):
        # `f(**kwargs)` is fine; `f(**a, **b)` is not, and neither is mixing
        # `**` with a dict display argument in older builds. Flag the double.
        doubles = [kw for kw in node.keywords if kw.arg is None]
        if len(doubles) > 1:
            self.report(node, "more than one `**` in a call is not supported")

        self.generic_visit(node)

    def visit_NamedExpr(self, node):
        self.report(node, "the walrus operator is not supported")
        self.generic_visit(node)

    def visit_AsyncFor(self, node):
        self.report(node, "`async for` needs a build with it enabled")
        self.generic_visit(node)

    def visit_JoinedStr(self, node):
        # f-strings work, but not the `=` debugging form or nested quotes of
        # the same kind, and the failure is again a bare SyntaxError.
        for value in node.values:
            if isinstance(value, ast.FormattedValue) and value.format_spec is None:
                continue

        self.generic_visit(node)

    def visit_Attribute(self, node):
        # Only `module.name`, not `something.attribute`: this is about the
        # standard library, and anything deeper is guesswork.
        if isinstance(node.value, ast.Name):
            missing = MISSING_ATTRIBUTES.get(node.value.id)

            if missing and node.attr in missing:
                name = "%s.%s" % (node.value.id, node.attr)
                advice = INSTEAD.get(name)

                self.report(node, "%s does not exist on MicroPython%s" % (
                    name, "; use %s" % advice if advice else ""))

        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        if node.returns is not None or any(a.annotation for a in node.args.args):
            self.report(node, "annotations cost flash and are not checked here; "
                              "say it in the docstring instead")

        self.generic_visit(node)


def scan_file(path):
    with open(path) as handle:
        source = handle.read()

    scanner = Scanner(path)
    scanner.visit(ast.parse(source, filename=path))

    return scanner.findings


def scan(directory=FIRMWARE, skip_tests=True):
    """Every finding under a directory, in file order."""
    findings = []

    for base, directories, names in os.walk(directory):
        directories[:] = [d for d in directories if not d.startswith("__")]

        for name in sorted(names):
            if not name.endswith(".py"):
                continue
            if skip_tests and name.startswith("test_"):
                continue

            findings.extend(scan_file(os.path.join(base, name)))

    return findings


def main(argv):
    findings = scan(argv[1] if len(argv) > 1 else FIRMWARE)

    for finding in findings:
        print(finding, file=sys.stderr)

    if findings:
        print("\n%d thing(s) the Pico's compiler will refuse." % len(findings),
              file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
