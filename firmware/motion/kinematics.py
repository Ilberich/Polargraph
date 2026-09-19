"""XY on the paper, belt lengths, and steps.

A polargraph has no axes. The gondola hangs from two belts and its position is
whatever those two lengths imply, so every move is a conversion rather than a
translation. Two things follow from that and shape everything here:

* Position is **absolute**, derived from belt lengths. There is no relative
  jog that can be trusted without first knowing where the gondola started,
  which is what AD-3's manual seed is for.
* Resolution is **not uniform**. One step of a motor moves the gondola a
  different distance depending on where it is on the sheet, because the belts
  meet it at different angles. Near the motor line the geometry is nearly
  degenerate and a step barely moves the pen vertically at all.

Machine coordinates put the origin at the left motor, x to the right along the
motor line, y **downward**. Paper coordinates are the app's: the origin at the
paper's top-left corner, also y downward. The two differ by a fixed offset.

This module is plain Python so the desktop simulator can import the same code
the Pico runs. Nothing here touches hardware.
"""

import math

# --- drivetrain ------------------------------------------------------------
#
# These mirror app/js/core/machine.js, and docs/HARDWARE.md derives them.
# Asserted equal to the app's values under test, because the two halves of the
# project disagreeing about millimetres per step would be very hard to see and
# very easy to do.

GT2_PITCH_MM = 2
PULLEY_TEETH = 20
MICROSTEPS = 16
FULL_STEPS_PER_REV = 200

MM_PER_REV = GT2_PITCH_MM * PULLEY_TEETH
STEPS_PER_REV = FULL_STEPS_PER_REV * MICROSTEPS
MM_PER_STEP = MM_PER_REV / STEPS_PER_REV
STEPS_PER_MM = STEPS_PER_REV / MM_PER_REV


class Geometry:
    """Where the motors are, and where the paper sits under them.

    ``motor_spacing_mm`` is centre to centre along the motor line.
    ``paper_origin`` is the paper's top-left corner in machine coordinates,
    which is what ties the app's millimetres to this machine's.
    """

    def __init__(
        self,
        motor_spacing_mm,
        paper_origin_x_mm,
        paper_origin_y_mm,
        paper_width_mm=0,
        paper_height_mm=0,
    ):
        if motor_spacing_mm <= 0:
            raise ValueError("motor spacing must be positive")

        self.motor_spacing_mm = float(motor_spacing_mm)
        self.paper_origin_x_mm = float(paper_origin_x_mm)
        self.paper_origin_y_mm = float(paper_origin_y_mm)
        self.paper_width_mm = float(paper_width_mm)
        self.paper_height_mm = float(paper_height_mm)

    def to_machine(self, x_mm, y_mm):
        """Paper coordinates to machine coordinates."""
        return (x_mm + self.paper_origin_x_mm, y_mm + self.paper_origin_y_mm)

    def to_paper(self, x_mm, y_mm):
        """Machine coordinates to paper coordinates."""
        return (x_mm - self.paper_origin_x_mm, y_mm - self.paper_origin_y_mm)


def belt_lengths(geometry, x_mm, y_mm):
    """Belt lengths for a point given in **machine** coordinates.

    Straight-line distances from each motor. A real machine adds the gondola's
    own geometry and the wrap around the pulley; both are constants that fall
    out in the subtraction when the seed point is measured the same way, which
    is why AD-3 seeds from a physical reference rather than from a datasheet.
    """
    if y_mm <= 0:
        raise ValueError("the gondola hangs below the motor line")

    right_dx = geometry.motor_spacing_mm - x_mm

    return (
        math.hypot(x_mm, y_mm),
        math.hypot(right_dx, y_mm),
    )


def position(geometry, left_mm, right_mm):
    """Machine coordinates implied by a pair of belt lengths.

    The two belts describe circles about the motors; the gondola is at the
    lower of their two intersections. Solving for x first is the standard
    circle-circle intersection, simplified because the centres share a y.
    """
    spacing = geometry.motor_spacing_mm

    x = (left_mm * left_mm - right_mm * right_mm + spacing * spacing) / (2 * spacing)
    y_squared = left_mm * left_mm - x * x

    if y_squared <= 0:
        raise ValueError("those belt lengths do not meet below the motor line")

    return (x, math.sqrt(y_squared))


def belt_steps(length_mm):
    """Belt length to whole steps, nearest.

    Lossy by up to half a step (0.00625 mm), which is fine for one conversion
    and wrong for a sequence: see the planner, which carries the remainder.
    """
    return int(round(length_mm * STEPS_PER_MM))


def steps_mm(steps):
    """Whole steps to belt length. Exact."""
    return steps * MM_PER_STEP


def resolution_at(geometry, x_mm, y_mm):
    """How far one step moves the gondola here, in mm, worst case.

    Returns the larger singular value of the Jacobian taking belt lengths to
    position: the distance the pen moves for one step in the least favourable
    direction. It grows without bound as the gondola approaches the motor line,
    which is the geometric reason a polargraph cannot draw near the top of its
    own frame.
    """
    left, right = belt_lengths(geometry, x_mm, y_mm)
    spacing = geometry.motor_spacing_mm

    # d(left)/dx, d(left)/dy and the same for the right belt.
    a = (x_mm / left, y_mm / left)
    b = ((x_mm - spacing) / right, y_mm / right)

    # The forward Jacobian's determinant; its reciprocal scales the inverse.
    determinant = a[0] * b[1] - a[1] * b[0]
    if determinant == 0:
        return float("inf")

    # Largest singular value of the inverse Jacobian, via the 2x2 closed form.
    inverse = (
        (b[1] / determinant, -a[1] / determinant),
        (-b[0] / determinant, a[0] / determinant),
    )

    e = (inverse[0][0] ** 2 + inverse[0][1] ** 2 + inverse[1][0] ** 2 + inverse[1][1] ** 2)
    f = inverse[0][0] * inverse[1][1] - inverse[0][1] * inverse[1][0]

    largest = math.sqrt((e + math.sqrt(max(e * e - 4 * f * f, 0.0))) / 2)

    return largest * MM_PER_STEP


def reachable(geometry, x_mm, y_mm, margin_mm=1.0):
    """Can the gondola be here at all?

    Below the motor line, inside the span, and far enough from either motor
    that the belt is not asked to fold back on itself.
    """
    if y_mm <= margin_mm:
        return False
    if x_mm <= margin_mm or x_mm >= geometry.motor_spacing_mm - margin_mm:
        return False

    return True
