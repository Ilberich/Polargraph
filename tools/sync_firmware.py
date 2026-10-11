#!/usr/bin/env python3
"""Copy the firmware onto a board, into the directories it expects.

Written because the obvious command is wrong in a way that looks right:

    mpremote cp server/app.py :

puts the file at `/app.py` on the board — `cp` takes the *basename* — while
`/server/app.py` keeps whatever it had. mpremote says `Up to date: ./app.py`
and means it. The board then runs a mixture of versions, and the symptom
surfaces somewhere else entirely as an `ImportError` between two files that
are each individually fine.

Tests are left behind: they never run on the board and they are a third of the
tree.

    python3 tools/sync_firmware.py            # copy what has changed
    python3 tools/sync_firmware.py --list     # show what it would do
    python3 tools/sync_firmware.py --clean    # also remove known strays
"""

import os
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FIRMWARE = os.path.join(ROOT, "firmware")

#: Files that have been put at the board's root by the flattening `cp` above.
#: Harmless but confusing: they are never imported and they shadow nothing.
KNOWN_STRAYS = ("app.py", "api.py", "parser.py", "kinematics.py", "planner.py",
                "stepper.py", "pio.py", "pen.py")


def plan(source=FIRMWARE):
    """What to create and what to copy, as (directories, [(local, remote)]).

    Pure, so the thing that gets the paths right is the thing under test.
    """
    directories = []
    files = []

    for base, subdirectories, names in os.walk(source):
        subdirectories[:] = sorted(d for d in subdirectories
                                   if not d.startswith("__") and not d.startswith("."))

        relative_dir = os.path.relpath(base, source)
        if relative_dir != ".":
            directories.append(relative_dir.replace(os.sep, "/"))

        for name in sorted(names):
            if not name.endswith(".py") or name.startswith("test_"):
                continue

            local = os.path.join(base, name)
            remote = os.path.relpath(local, source).replace(os.sep, "/")
            files.append((local, remote))

    return directories, files


def commands(source=FIRMWARE, clean=False):
    """The mpremote invocations, in the order they have to happen."""
    directories, files = plan(source)
    calls = []

    # Directories first, or a copy into one that does not exist fails.
    for directory in directories:
        calls.append(["mpremote", "mkdir", ":" + directory])

    for local, remote in files:
        calls.append(["mpremote", "cp", local, ":" + remote])

    if clean:
        for stray in KNOWN_STRAYS:
            calls.append(["mpremote", "rm", ":" + stray])

    return calls


def main(argv):
    show = "--list" in argv
    clean = "--clean" in argv

    calls = commands(clean=clean)

    if show:
        for call in calls:
            print(" ".join(call))
        return 0

    failures = 0

    for call in calls:
        # mkdir on a directory that exists, and rm of a stray that is not
        # there, both fail and both are fine. A copy that fails is not.
        optional = call[1] in ("mkdir", "rm")
        result = subprocess.run(call, capture_output=True, text=True)

        if result.returncode == 0:
            if call[1] == "cp":
                print("  %s" % call[3][1:])
            continue

        if optional:
            continue

        failures += 1
        print("FAILED %s\n  %s" % (" ".join(call), result.stderr.strip()),
              file=sys.stderr)

    if failures:
        print("\n%d file(s) did not copy." % failures, file=sys.stderr)
        return 1

    _, files = plan()
    print("\n%d files on the board. Hard reset before running: MicroPython "
          "caches imported modules for the life of a session." % len(files))

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
