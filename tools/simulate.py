#!/usr/bin/env python3
"""Command line front end for the motion simulator. See simulator.py."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from simulator import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv))
