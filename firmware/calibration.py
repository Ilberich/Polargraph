"""Squaring the app's idea of the paper with the paper that is on the wall.

Nobody tapes a sheet up perfectly. It sits a few millimetres off, a degree or
two out of square, and the machine's own geometry is never quite the number
that was typed in. Calibration measures that once: the user drives the gondola
to three corners of the real sheet, and what comes out is the transform taking
the app's coordinates to the machine's.

**A similarity, not a free affine** (AD-7). Three points determine six degrees
of freedom, which is enough for shear and non-uniform scale — and paper has
neither. Those extra freedoms describe nothing physical; all they can do is
absorb the user's aim error, fitting the three clicks perfectly and the paper
badly. Four degrees of freedom — move, turn, scale — is what a rigid sheet
actually has, so three corners over-determine it and the leftover becomes a
number worth reading.

That number is the point. A calibration that is going to plot crooked says so
at solve time, before anybody walks to the machine for the fourth-corner check.
"""

import math

from motion.kinematics import apply_transform


class CalibrationError(Exception):
    """Refused. Carries the API's stable error slug."""

    def __init__(self, slug, message, status=409):
        Exception.__init__(self, message)
        self.slug = slug
        self.message = message
        self.status = status


#: How far apart the captured corners must be for the fit to mean anything.
MIN_SPREAD_MM = 20.0

#: Above this the app warns before the user walks to the machine.
DEFAULT_WARN_RESIDUAL_MM = 2.0

#: A calibration is correcting for a sheet taped up slightly crooked, not
#: discovering that the paper is a different size. Anything outside this band
#: is a mistake in the capture rather than a measurement worth keeping.
MIN_SCALE = 0.5
MAX_SCALE = 2.0


def corners_of(width_mm, height_mm):
    """The paper's four corners, clockwise from the top left."""
    return [
        (0.0, 0.0),
        (float(width_mm), 0.0),
        (float(width_mm), float(height_mm)),
        (0.0, float(height_mm)),
    ]


def solve_similarity(source, target):
    """Least-squares similarity taking `source` points to `target` points.

    The closed form: line the two sets up on their centroids, and the rotation
    that best matches them falls out of one cross term against one dot term.
    No iteration, no matrix library, and no chance of converging somewhere odd
    — which matters on a microcontroller.

    Returns the transform as a row-major 2x3, `[a, b, tx, c, d, ty]`, meaning
    `x' = a*x + b*y + tx`. That is the shape docs/API.md publishes. It is *not*
    SVG's `matrix(a b c d e f)` column order, which the app uses elsewhere; the
    two are transposes of each other in their first four values, and mixing
    them up shows as a drawing mirrored about its diagonal.
    """
    count = len(source)

    if count < 2 or count != len(target):
        raise CalibrationError(
            "not_enough_points", "at least two paired points are needed", 400)

    source_centre = _centroid(source)
    target_centre = _centroid(target)

    dot = 0.0             # how much the two sets agree in direction
    cross = 0.0           # how much one is turned against the other
    spread = 0.0          # how far the source points reach from their centre
    target_spread = 0.0   # and how far the measured ones reach from theirs

    for (sx, sy), (tx, ty) in zip(source, target):
        ax, ay = sx - source_centre[0], sy - source_centre[1]
        bx, by = tx - target_centre[0], ty - target_centre[1]

        dot += ax * bx + ay * by
        cross += ax * by - ay * bx
        spread += ax * ax + ay * ay
        target_spread += bx * bx + by * by

    # Both sets have to describe a sheet. Checking only the source would miss
    # the likelier mistake by far: recording three corners without driving to
    # them, which gives three identical measurements. A least-squares fit is
    # perfectly happy to collapse the paper to a point and report a residual of
    # zero, because it has indeed fitted what it was given — and that is a
    # transform that would plot the whole drawing on one spot.
    if spread < MIN_SPREAD_MM ** 2 or target_spread < MIN_SPREAD_MM ** 2:
        raise CalibrationError(
            "degenerate",
            "those measurements are too close together to calibrate from \u2014 "
            "drive the gondola to each corner before recording it",
            400,
        )

    angle = math.atan2(cross, dot)
    scale = math.hypot(dot, cross) / spread

    if not MIN_SCALE <= scale <= MAX_SCALE:
        raise CalibrationError(
            "implausible_scale",
            "the corners imply a sheet %.1f times the size it should be" % scale,
            400,
        )

    cos = math.cos(angle) * scale
    sin = math.sin(angle) * scale

    # Translation is whatever is left once the rotation and scale are applied
    # to the source centroid.
    tx = target_centre[0] - (cos * source_centre[0] - sin * source_centre[1])
    ty = target_centre[1] - (sin * source_centre[0] + cos * source_centre[1])

    transform = [cos, -sin, tx, sin, cos, ty]

    return {
        "transform": transform,
        "residualMm": residual(transform, source, target),
        "rotationDeg": math.degrees(angle),
        "scale": scale,
    }


def _centroid(points):
    count = len(points)
    return (sum(p[0] for p in points) / count, sum(p[1] for p in points) / count)


def residual(transform, source, target):
    """Root-mean-square distance between the fit and the points, in mm.

    RMS rather than the worst one: a single sloppy corner should raise the
    number without dominating it, since the whole point is to notice a
    calibration that is generally bad.
    """
    total = 0.0

    for point, wanted in zip(source, target):
        got = apply_transform(transform, point[0], point[1])
        total += (got[0] - wanted[0]) ** 2 + (got[1] - wanted[1]) ** 2

    return math.sqrt(total / len(source))


class Calibration:
    """The capture-solve-verify-confirm sequence, one step at a time.

    Deliberately a state machine rather than one call: each step needs the user
    to walk to the machine and look at it, and the app drives it from the other
    side of that.
    """

    IDLE = "idle"
    CAPTURING = "capturing"
    SOLVED = "solved"
    VERIFYING = "verifying"
    LOCKED = "locked"

    #: How many corners are captured before solving. Three over-determines the
    #: four degrees of freedom a rigid sheet has, which is what makes the
    #: residual mean something.
    CORNERS = 3

    def __init__(self, width_mm, height_mm):
        self.width_mm = float(width_mm)
        self.height_mm = float(height_mm)
        self.reset()

    def reset(self):
        self.state = self.IDLE
        self.captured = {}
        self.result = None

    # --- capture ------------------------------------------------------------

    def capture(self, index, paper_point, machine_point):
        """Record where the gondola is as a given corner of the paper."""
        if self.state == self.LOCKED:
            raise CalibrationError("already_locked",
                                   "restart calibration to capture again")

        if not 0 <= index < self.CORNERS:
            raise CalibrationError(
                "bad_index",
                "corners are numbered 0 to %d" % (self.CORNERS - 1),
                400,
            )

        self.captured[index] = (tuple(paper_point), tuple(machine_point))
        self.state = self.CAPTURING
        self.result = None

        return self.progress()

    def progress(self):
        return {
            "state": self.state,
            "captured": sorted(self.captured),
            "needed": self.CORNERS,
        }

    # --- solve --------------------------------------------------------------

    def solve(self):
        if len(self.captured) < self.CORNERS:
            raise CalibrationError(
                "not_enough_points",
                "capture all %d corners first" % self.CORNERS,
            )

        pairs = [self.captured[i] for i in sorted(self.captured)]
        self.result = solve_similarity([p[0] for p in pairs], [p[1] for p in pairs])

        self.state = self.SOLVED
        return dict(self.result)

    # --- verify -------------------------------------------------------------

    def fourth_corner(self):
        """The corner nobody drove to, which is the one worth checking.

        Taken from the paper's own rectangle rather than from the three
        captured points: the whole question is whether the fit predicts a place
        it was not shown, and deriving it from the measurements would be asking
        the fit about itself.
        """
        captured = {tuple(p[0]) for p in self.captured.values()}

        for corner in corners_of(self.width_mm, self.height_mm):
            if corner not in captured:
                return corner

        raise CalibrationError("no_corner_left", "all four corners were captured")

    def verify(self):
        """Where the gondola should go for the user to judge the fit."""
        if self.state not in (self.SOLVED, self.VERIFYING):
            raise CalibrationError("not_solved", "solve before verifying")

        corner = self.fourth_corner()
        self.state = self.VERIFYING

        return {
            "paperPoint": {"x": corner[0], "y": corner[1]},
            "residualMm": self.result["residualMm"],
        }

    def confirm(self, accepted):
        """Lock the transform in, or throw the lot away and start again.

        Rejecting restarts from corner zero rather than keeping the captures.
        If the fourth corner is wrong, one of the three is wrong, and there is
        no way to know which — re-using them would carry the mistake forward.
        """
        if self.state != self.VERIFYING:
            raise CalibrationError("not_verifying", "verify before confirming")

        if not accepted:
            self.reset()
            return {"state": self.state, "transform": None}

        self.state = self.LOCKED

        return {"state": self.state, **self.result}

    @property
    def transform(self):
        return self.result["transform"] if self.state == self.LOCKED else None
