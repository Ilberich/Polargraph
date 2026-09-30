"""Catching Python that CPython accepts and MicroPython does not.

The firmware is plain Python so the desktop can run it, which is what makes
the simulator and the test suite possible. The cost is that CPython is a more
generous compiler than the one on the Pico, and the difference does not show up
in a test — it shows up as a `SyntaxError` at import time on the board, after
the file has been copied across, naming a line number and nothing else.

`**` unpacking inside a dict literal is the one that bit. MicroPython's
compiler simply does not implement it. Every test passed, the simulator ran the
same file thousands of times, and the board refused to import it.

So: walk the AST for constructs the Pico's compiler will not take. This is a
denylist and therefore incomplete by nature — it knows about what has been hit
and what is documented, not about everything. It is still the difference
between finding these at `npm test` and finding them at a bench.
"""

import ast
import os
import sys


ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

#: Directories whose Python has to run on the board.
FIRMWARE = os.path.join(ROOT, "firmware")


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
