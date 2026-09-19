"""Running the firmware's motion code on a desktop, and checking what it drew.

This is what de-risks AD-4. The planner and kinematics the Pico runs are
imported here unchanged, fed a job, and their step output recorded. Adding the
steps back up and solving the kinematics forwards reconstructs the path the
gondola really took — which can then be compared against the path that was
asked for.

What that catches, without a motor anywhere:

* **Rounding drift.** One conversion is lossy by half a step and nobody would
  notice; a few thousand segments compounding the same way is a visible skew.
  Deriving each target from the true geometry is supposed to prevent it, and
  this is what proves it.
* **Chord error.** A straight line across the paper is a curve in belt space.
  Segment too coarsely and the pen bows off the line.
* **Timing.** Peak step rate per axis says whether PIO is needed at all, and
  how fast it has to be fed.

It stays useful after bring-up: a planner change that distorts geometry fails
in CI rather than on paper.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware"))

from motion import kinematics as kin       # noqa: E402
from motion.planner import Planner, Limits  # noqa: E402
from gcode.parser import parse              # noqa: E402


class Trace:
    """Everything the run produced, in the order it happened."""

    def __init__(self, geometry):
        self.geometry = geometry
        self.segments = []
        self.points = []
        #: Step counts at each segment boundary, left and right.
        self.step_marks = []
        self.seconds = 0.0

    def record(self, segment):
        self.segments.append(segment)
        self.seconds += segment.seconds

    @property
    def steps(self):
        return (
            sum(abs(s.left) for s in self.segments),
            sum(abs(s.right) for s in self.segments),
        )

    def sampled_points(self, per_segment=8):
        """Positions within segments as well as at their ends.

        Sampling only the boundaries would miss the thing chord error is: the
        gondola wanders off the line *between* the points the planner solved
        for, because the machine interpolates belt lengths while the line it
        was asked for is straight in XY. Stepping both axes evenly through a
        segment is what the driver does, so interpolating the step counts is
        what the pen really traces.
        """
        points = []

        for i in range(1, len(self.step_marks)):
            before = self.step_marks[i - 1]
            after = self.step_marks[i]

            for j in range(per_segment):
                fraction = j / per_segment
                left = before[0] + (after[0] - before[0]) * fraction
                right = before[1] + (after[1] - before[1]) * fraction

                points.append(kin.position(
                    self.geometry, kin.steps_mm(left), kin.steps_mm(right)
                ))

        if self.step_marks:
            last = self.step_marks[-1]
            points.append(kin.position(
                self.geometry, kin.steps_mm(last[0]), kin.steps_mm(last[1])
            ))

        return points

    def peak_step_rate(self):
        """Highest steps per second either axis is asked for.

        The number AD-4 turns on: a Python loop cannot hold this rate with
        usable jitter, which is why pulse timing belongs to PIO.
        """
        peak = 0.0

        for segment in self.segments:
            if segment.seconds <= 0:
                continue

            peak = max(peak, abs(segment.left) / segment.seconds,
                       abs(segment.right) / segment.seconds)

        return peak


def run(geometry, limits, moves, start=None):
    """Plan a list of machine-coordinate moves and reconstruct the result.

    ``moves`` is a sequence of ``(x_mm, y_mm)`` or ``(x_mm, y_mm, z_mm, feed)``.
    """
    trace = Trace(geometry)

    start_x, start_y = start if start else geometry.to_machine(0.0, 0.0)
    planner = Planner(geometry, limits, trace.record, start_x, start_y)

    for move in moves:
        x, y = move[0], move[1]
        z = move[2] if len(move) > 2 else None
        feed = move[3] if len(move) > 3 else None
        planner.move_to(x, y, z, feed)

    planner.flush()

    # Walk the steps back out to positions. This is the machine's own view: it
    # knows nothing but how many pulses it sent.
    left = kin.belt_steps(kin.belt_lengths(geometry, start_x, start_y)[0])
    right = kin.belt_steps(kin.belt_lengths(geometry, start_x, start_y)[1])

    trace.step_marks.append((left, right))
    trace.points.append(kin.position(geometry, kin.steps_mm(left), kin.steps_mm(right)))

    for segment in trace.segments:
        left += segment.left
        right += segment.right
        trace.step_marks.append((left, right))
        trace.points.append(
            kin.position(geometry, kin.steps_mm(left), kin.steps_mm(right))
        )

    return trace


# --- comparing what was drawn against what was asked for --------------------

def _distance_to_segment(point, a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length_squared = dx * dx + dy * dy

    if length_squared == 0:
        return math.hypot(point[0] - a[0], point[1] - a[1])

    t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length_squared
    t = max(0.0, min(1.0, t))

    return math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy))


def deviation(trace, path, per_segment=8, window=24):
    """Worst distance from anywhere the pen went to the path asked for.

    Measured against the whole polyline rather than point by point, because the
    planner is free to put its vertices wherever it likes along the line — what
    matters is that the pen never leaves it. Sampled within segments as well as
    at their ends, or coarse segmentation would score well by being measured
    only where it is right.

    Both sequences run in the same order, so the search follows a cursor
    through the path rather than scanning all of it for every sample. A job of
    any size then costs a pass rather than a product of two.
    """
    worst = 0.0
    cursor = 1

    for point in trace.sampled_points(per_segment):
        best = float("inf")
        best_at = cursor

        low = max(1, cursor - window)
        high = min(len(path), cursor + window)

        for i in range(low, high):
            here = _distance_to_segment(point, path[i - 1], path[i])
            if here < best:
                best = here
                best_at = i

        cursor = best_at
        worst = max(worst, best)

    return worst


def endpoint_error(trace, path):
    """How far the last reconstructed point is from where the job should end.

    Drift shows up here first: a rounding error that leans one way accumulates
    into an offset that grows with the length of the job.
    """
    last = trace.points[-1]
    return math.hypot(last[0] - path[-1][0], last[1] - path[-1][1])


# --- a job from a gcode file ------------------------------------------------

def moves_from_gcode(geometry, lines):
    """Machine-coordinate moves from the app's gcode.

    Uses the firmware's own streaming parser, so the simulator and the plotter
    agree about what a file means.
    """
    moves = []
    position = {"X": 0.0, "Y": 0.0, "Z": 0.0}
    feed_mm_s = None
    absolute = True

    for command in parse(lines):
        if command.kind == "G" and command.code == 90:
            absolute = True
        elif command.kind == "G" and command.code == 91:
            absolute = False
        elif command.kind == "G" and command.code in (0, 1):
            if "F" in command.words:
                feed_mm_s = command.words["F"] / 60.0

            for axis in ("X", "Y", "Z"):
                if axis in command.words:
                    position[axis] = (
                        command.words[axis] if absolute
                        else position[axis] + command.words[axis]
                    )

            x, y = geometry.to_machine(position["X"], position["Y"])
            moves.append((x, y, position["Z"], feed_mm_s))

    return moves


def main(argv):
    if len(argv) < 2:
        print("usage: simulate.py FILE.gcode [motor_spacing_mm]", file=sys.stderr)
        return 2

    spacing = float(argv[2]) if len(argv) > 2 else 900.0
    geometry = kin.Geometry(spacing, spacing / 2 - 105, 250, 210, 297)

    with open(argv[1]) as handle:
        moves = moves_from_gcode(geometry, handle)

    if not moves:
        print("no moves in that file", file=sys.stderr)
        return 1

    # The machine starts at the paper origin and travels to the first point.
    # That travel is part of the job — on a machine with no pen lift it is
    # drawn — so it belongs in the path the result is measured against.
    start = geometry.to_machine(0.0, 0.0)
    path = [start] + [(m[0], m[1]) for m in moves]
    trace = run(geometry, Limits(), moves, start=start)

    print("segments        %d" % len(trace.segments))
    print("steps L/R       %d / %d" % trace.steps)
    print("time            %.1f s" % trace.seconds)
    print("peak step rate  %.0f steps/s" % trace.peak_step_rate())
    print("path deviation  %.4f mm" % deviation(trace, path))
    print("endpoint error  %.4f mm" % endpoint_error(trace, path))

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
