#!/usr/bin/env python3
"""Copy the app bundle onto a plotter's SD card.

AD-1's other deploy target. The same files GitHub Pages serves go to `/www` on
the card, so the plotter can serve them itself and the page and the API end up
same-origin plain HTTP — no mixed content, no CORS.

Tests do not go: they are a third of the tree and the plotter has no use for
them.

    python3 tools/deploy.py /media/me/PLOTTER
"""

import os
import shutil
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

#: Everything the browser needs and nothing it does not.
SKIP_SUFFIXES = (".test.js",)
SKIP_NAMES = ("node_modules", ".DS_Store")


def wanted(path):
    name = os.path.basename(path)

    if name in SKIP_NAMES:
        return False

    return not any(name.endswith(suffix) for suffix in SKIP_SUFFIXES)


def copy_bundle(source, destination):
    """Returns the files copied and the bytes they took."""
    copied = []

    for directory, subdirectories, names in os.walk(source):
        subdirectories[:] = [d for d in subdirectories if wanted(d)]

        for name in names:
            path = os.path.join(directory, name)
            if not wanted(path):
                continue

            relative = os.path.relpath(path, source)
            target = os.path.join(destination, relative)

            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copy2(path, target)
            copied.append((relative, os.path.getsize(path)))

    return copied


def main(argv):
    if len(argv) < 2:
        print("usage: deploy.py /path/to/sd-card", file=sys.stderr)
        return 2

    card = argv[1]
    if not os.path.isdir(card):
        print("%s is not a directory" % card, file=sys.stderr)
        return 1

    www = os.path.join(card, "www")
    gcode = os.path.join(card, "gcode")

    copied = copy_bundle(os.path.join(ROOT, "app"), www)
    os.makedirs(gcode, exist_ok=True)

    total = sum(size for _, size in copied)
    print("%d files, %.0f KB -> %s" % (len(copied), total / 1024, www))
    print("gcode directory ready at %s" % gcode)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
