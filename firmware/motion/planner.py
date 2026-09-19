"""Turning moves into step segments the stepper queue can run.

Three jobs, in order:

**Segmentation.** A straight line across the paper is not a straight line in
belt space — the belts meet the gondola at angles that change as it travels, so
interpolating belt lengths between two endpoints bows the pen off the line. So
every move is cut into short segments in XY, and each segment's belt lengths are
solved from its own endpoint.

**Step deltas.** Each segment's target is computed as an absolute step count
from the ideal belt length, and the delta is the difference from the step count
actually reached. Rounding error therefore cannot accumulate: every segment is
corrected against the true geometry rather than against the last rounded value.
The alternative — carrying a fractional remainder forward — drifts the moment
anything else touches the position.

**Lookahead.** Speeds are assigned by a forward pass limited by acceleration and
a backward pass that guarantees the machine can still stop. The window is
bounded by *distance*, not by segment count: it holds at least enough travel to
decelerate from full speed to a standstill, which is exactly what makes it safe
to release the front of it. A whole job is never held in memory (see the
firmware README).

Plain Python: the desktop simulator runs this same module.
"""

from . import kinematics as kin


class Limits:
    """Per-job motion limits. The app sends these with the plot."""

    def __init__(
        self,
        max_speed_mm_s=20.0,
        acceleration_mm_s2=200.0,
        junction_speed_mm_s=5.0,
        max_segment_mm=1.0,
        min_speed_mm_s=0.5,
    ):
        self.max_speed_mm_s = float(max_speed_mm_s)
        self.acceleration_mm_s2 = float(acceleration_mm_s2)
        self.junction_speed_mm_s = float(junction_speed_mm_s)
        self.max_segment_mm = float(max_segment_mm)
        # A floor, so a segment can never be assigned a duration of infinity.
        self.min_speed_mm_s = float(min_speed_mm_s)


class Segment:
    """One chunk of motion: how many steps each motor takes, and how long for.

    ``left`` and ``right`` are signed step deltas. ``seconds`` is filled in once
    lookahead has settled the speeds either side of it.
    """

    __slots__ = ("left", "right", "distance_mm", "entry_mm_s", "exit_mm_s",
                 "cruise_mm_s", "exit_cap_mm_s", "seconds", "z_mm")

    def __init__(self, left, right, distance_mm, cruise_mm_s, z_mm):
        self.left = left
        self.right = right
        self.distance_mm = distance_mm
        self.cruise_mm_s = cruise_mm_s
        # Lowered by a corner arriving after this segment was queued.
        self.exit_cap_mm_s = cruise_mm_s
        self.entry_mm_s = 0.0
        self.exit_mm_s = 0.0
        self.seconds = 0.0
        self.z_mm = z_mm

    def __repr__(self):
        return "Segment(left=%d, right=%d, %.4fmm, %.4fs)" % (
            self.left, self.right, self.distance_mm, self.seconds
        )


def _speed_after(entry, distance, acceleration):
    """Fastest reachable after accelerating over `distance` from `entry`."""
    return (entry * entry + 2 * acceleration * distance) ** 0.5


def junction_speed(previous, current, limits):
    """How fast a corner between two unit directions may be taken.

    Straight on, no reason to slow; doubling back, a full stop. In between,
    scaled by the cube of straightness so gentle curves keep their speed and
    sharp corners lose it quickly — the same rule the app's time estimate uses,
    so the two agree about what a job costs.
    """
    if previous is None or current is None:
        return 0.0

    cosine = previous[0] * current[0] + previous[1] * current[1]
    cosine = max(-1.0, min(1.0, cosine))

    if cosine <= -0.999:
        return 0.0

    straightness = (cosine + 1) / 2
    limit = limits.max_speed_mm_s
    jerk = limits.junction_speed_mm_s

    return min(limit, jerk + (limit - jerk) * straightness ** 3)


class Planner:
    """Converts moves into segments and hands them to a sink.

    The sink is whatever runs them: the PIO queue on the Pico, a recorder in
    the simulator. It is called with finished segments, in order, and must not
    block for long.
    """

    def __init__(self, geometry, limits, sink, start_x_mm=None, start_y_mm=None):
        self.geometry = geometry
        self.limits = limits
        self.sink = sink

        origin = geometry.to_machine(0.0, 0.0)
        self.x_mm = origin[0] if start_x_mm is None else float(start_x_mm)
        self.y_mm = origin[1] if start_y_mm is None else float(start_y_mm)
        self.z_mm = 0.0

        left, right = kin.belt_lengths(self.geometry, self.x_mm, self.y_mm)

        # The authority on where the gondola is: whole steps, never millimetres.
        self.left_steps = kin.belt_steps(left)
        self.right_steps = kin.belt_steps(right)

        self._window = []
        self._window_mm = 0.0
        self._entry_mm_s = 0.0
        self._last_direction = None
        self._window_tip = kin.position(
            self.geometry, kin.steps_mm(self.left_steps), kin.steps_mm(self.right_steps)
        )

    # --- position ----------------------------------------------------------

    def position_mm(self):
        """Where the steps say the gondola is, in machine coordinates."""
        return kin.position(
            self.geometry,
            kin.steps_mm(self.left_steps),
            kin.steps_mm(self.right_steps),
        )

    # --- moves -------------------------------------------------------------

    def move_to(self, x_mm, y_mm, z_mm=None, feed_mm_s=None):
        """Queue a straight move to a point in **machine** coordinates."""
        target_z = self.z_mm if z_mm is None else float(z_mm)
        speed = self.limits.max_speed_mm_s if feed_mm_s is None else float(feed_mm_s)
        speed = max(self.limits.min_speed_mm_s, min(speed, self.limits.max_speed_mm_s))

        dx = x_mm - self.x_mm
        dy = y_mm - self.y_mm
        length = (dx * dx + dy * dy) ** 0.5

        if length == 0:
            # No travel across the paper, but the pen may still have moved.
            self.z_mm = target_z
            return

        direction = (dx / length, dy / length)
        corner = junction_speed(self._last_direction, direction, self.limits)

        count = max(1, int(length / self.limits.max_segment_mm) + 1)

        for i in range(1, count + 1):
            fraction = i / count
            px = self.x_mm + dx * fraction
            py = self.y_mm + dy * fraction
            pz = self.z_mm + (target_z - self.z_mm) * fraction

            self._emit(px, py, pz, speed, corner if i == 1 else None)

        self.x_mm = x_mm
        self.y_mm = y_mm
        self.z_mm = target_z
        self._last_direction = direction

    def _emit(self, x_mm, y_mm, z_mm, speed, corner_limit):
        """One segment, ending at the given machine point."""
        left_mm, right_mm = kin.belt_lengths(self.geometry, x_mm, y_mm)

        # Absolute targets, so rounding is corrected rather than carried.
        left_target = kin.belt_steps(left_mm)
        right_target = kin.belt_steps(right_mm)

        dl = left_target - self.left_steps
        dr = right_target - self.right_steps

        if dl == 0 and dr == 0:
            return

        self.left_steps = left_target
        self.right_steps = right_target

        reached = kin.position(
            self.geometry, kin.steps_mm(left_target), kin.steps_mm(right_target)
        )
        # Distance the gondola really covers, which is what the speed applies to.
        tip = self._window_tip
        distance = ((reached[0] - tip[0]) ** 2 + (reached[1] - tip[1]) ** 2) ** 0.5
        self._window_tip = reached

        segment = Segment(dl, dr, max(distance, 1e-9), speed, z_mm)

        if corner_limit is not None and self._window:
            # A corner caps the speed the previous segment may leave at.
            previous = self._window[-1]
            previous.exit_cap_mm_s = min(previous.exit_cap_mm_s, corner_limit)

        self._window.append(segment)
        self._window_mm += segment.distance_mm
        self._drain()

    # --- lookahead ---------------------------------------------------------

    def _stopping_mm(self):
        """Distance needed to stop from full speed."""
        limits = self.limits
        return (limits.max_speed_mm_s ** 2) / (2 * limits.acceleration_mm_s2)

    def _drain(self, final=False):
        """Release segments that later ones can no longer affect.

        Everything still in the window is within stopping distance of the end
        of it, so a hard stop arriving later could still be honoured by slowing
        down inside the window. Once the window is longer than that, the front
        of it is settled and can go.
        """
        keep = self._stopping_mm() * 2

        while self._window and (final or self._window_mm > keep):
            self._plan_window(final)

            segment = self._window.pop(0)
            self._window_mm -= segment.distance_mm
            # Whatever it left at is what the next one starts from.
            self._entry_mm_s = segment.exit_mm_s
            self.sink(segment)

            if not final and self._window_mm <= keep:
                break

    def _plan_window(self, final):
        """Assign speeds across the window: backward first, then forward.

        The tail of the window is always planned as though the job stopped
        there. That costs nothing — the window is kept longer than the distance
        needed to stop from full speed, so a stop at its far end never reaches
        back to slow its front — and it means a segment released from the front
        is never travelling faster than the machine could still bring to rest.
        """
        window = self._window
        if not window:
            return

        acceleration = self.limits.acceleration_mm_s2

        # Backward: nothing may enter a segment faster than it can leave it.
        next_entry = 0.0

        for segment in reversed(window):
            segment.exit_mm_s = min(segment.exit_cap_mm_s, next_entry)
            segment.entry_mm_s = min(
                segment.cruise_mm_s,
                _speed_after(segment.exit_mm_s, segment.distance_mm, acceleration),
            )
            next_entry = segment.entry_mm_s

        # Forward: nothing may leave a segment faster than it can reach.
        entry = self._entry_mm_s

        for segment in window:
            segment.entry_mm_s = min(segment.entry_mm_s, entry)
            segment.exit_mm_s = min(
                segment.exit_mm_s,
                _speed_after(segment.entry_mm_s, segment.distance_mm, acceleration),
            )
            segment.seconds = _duration(segment, acceleration, self.limits.min_speed_mm_s)
            entry = segment.exit_mm_s

    def flush(self):
        """Run out the queue, ending at a standstill."""
        self._drain(final=True)
        self._last_direction = None


def _duration(segment, acceleration, floor):
    """How long a segment takes, given the speeds at its ends.

    Averaging the endpoint speeds is exact for constant acceleration, which is
    what a segment this short is. The floor keeps a segment that starts and
    ends at rest — the first one of a job — from taking forever.
    """
    average = (segment.entry_mm_s + segment.exit_mm_s) / 2

    if average < floor:
        average = max(floor, _speed_after(0.0, segment.distance_mm, acceleration) / 2)

    return segment.distance_mm / average
