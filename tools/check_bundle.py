#!/usr/bin/env python3
"""Does a deployed card have everything the app needs?

An incomplete copy is invisible from the outside: the page loads, the header
renders — it is static HTML — and nothing works, because one missing module
takes the whole import graph down with it and the only evidence is in a
browser console nobody is looking at.

    python3 tools/check_bundle.py /media/you/PLOTTER/www

Compares what is on the card against what `deploy.py` would put there.
"""

import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
APP = os.path.join(ROOT, "app")


def wanted_files(source=APP):
    """Every file the plotter should be serving, as relative paths."""
    files = {}

    for base, directories, names in os.walk(source):
        directories[:] = [d for d in directories if d != "node_modules"]

        for name in names:
            if name.endswith(".test.js") or name == ".DS_Store":
                continue

            path = os.path.join(base, name)
            files[os.path.relpath(path, source)] = os.path.getsize(path)

    return files


def compare(card_dir, source=APP):
    """Returns (missing, wrong_size, extra)."""
    wanted = wanted_files(source)

    missing = []
    wrong_size = []

    for relative, size in sorted(wanted.items()):
        path = os.path.join(card_dir, relative)

        if not os.path.isfile(path):
            missing.append(relative)
        elif os.path.getsize(path) != size:
            wrong_size.append((relative, size, os.path.getsize(path)))

    on_card = set()
    for base, _, names in os.walk(card_dir):
        for name in names:
            on_card.add(os.path.relpath(os.path.join(base, name), card_dir))

    return missing, wrong_size, sorted(on_card - set(wanted))


def main(argv):
    if len(argv) < 2:
        print("usage: check_bundle.py /path/to/card/www", file=sys.stderr)
        return 2

    card = argv[1]
    if not os.path.isdir(card):
        print("%s is not a directory" % card, file=sys.stderr)
        return 1

    missing, wrong_size, extra = compare(card)

    for name in missing:
        print("MISSING  %s" % name)
    for name, wanted, got in wrong_size:
        print("TRUNCATED %s: %d bytes on the card, %d expected" % (name, got, wanted))
    for name in extra:
        print("extra    %s" % name)

    total = len(wanted_files())

    if missing or wrong_size:
        print("\n%d of %d files are wrong. Re-run tools/deploy.py."
              % (len(missing) + len(wrong_size), total), file=sys.stderr)
        return 1

    print("all %d files present and the right size" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
