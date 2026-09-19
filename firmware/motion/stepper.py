"""Turning planned segments into step pulses.

Split in two on purpose. Everything in this module is hardware-independent and
tested on the desktop: how many pulses each axis needs, in which direction, and
how far apart in time. The PIO state machines that actually wiggle the pins live
in `pio.py`, which only imports on the Pico.

The division matters because the timing arithmetic is where the bugs are, and
none of it needs a motor to check. What PIO contributes is jitter-free pulse
spacing at a rate Python cannot hold (AD-4) — not arithmetic.

**The two axes are independent and must still finish together.** A segment that
needs 80 steps of the left motor and 10 of the right over the same 100 ms gives
one axis a pulse every 1.25 ms and the other one every 10 ms. Each state machine
counts its own steps at its own interval and they arrive at the end at the same
moment, which is exactly why there is one per axis rather than one shared
interpolator.
"""

#: Minimum time a step pin must be held high, seconds. The DRV8825 datasheet
#: asks for 1.9 us; 3 us is a margin that costs nothing at these rates.
PULSE_HIGH_S = 3e-6

#: Shortest interval between two steps on one axis, seconds. High plus low.
MIN_STEP_INTERVAL_S = PULSE_HIGH_S * 2

#: Fastest either axis can be driven, steps per second.
MAX_STEP_RATE = 1.0 / MIN_STEP_INTERVAL_S


class AxisPulses:
    """What one motor does for one segment."""

    __slots__ = ("direction", "count", "interval_s")

    def __init__(self, direction, count, interval_s):
        #: +1 or -1; 0 when the axis does not move.
        self.direction = direction
        self.count = count
        self.interval_s = interval_s

    def seconds(self):
        return self.count * self.interval_s

    def __repr__(self):
        return "AxisPulses(dir=%+d, %d steps, %.6fs apart)" % (
            self.direction, self.count, self.interval_s
        )


class Pulses:
    """Both axes' pulse trains for one segment.

    ``limited`` says the segment was asked for faster than the drivers can be
    pulsed and has been stretched to fit. The geometry is unaffected — every
    step still happens — but the job takes longer than planned, so it is
    counted rather than swallowed.
    """

    __slots__ = ("left", "right", "seconds", "limited", "z_mm")

    def __init__(self, left, right, seconds, limited, z_mm):
        self.left = left
        self.right = right
        self.seconds = seconds
        self.limited = limited
        self.z_mm = z_mm

    def __repr__(self):
        return "Pulses(%r, %r, %.6fs%s)" % (
            self.left, self.right, self.seconds, ", limited" if self.limited else ""
        )


def _axis(steps, seconds):
    """One axis's pulse train, and the time it really needs."""
    count = abs(steps)

    if count == 0:
        return AxisPulses(0, 0, 0.0), 0.0

    direction = 1 if steps > 0 else -1
    interval = seconds / count if seconds > 0 else 0.0

    if interval < MIN_STEP_INTERVAL_S:
        interval = MIN_STEP_INTERVAL_S

    return AxisPulses(direction, count, interval), count * interval


def plan_pulses(segment):
    """A planned segment as two pulse trains.

    Both axes are stretched together when either one cannot keep up, so they
    still finish at the same moment. Letting only the fast axis slow down would
    bend the segment: the same steps, arriving in the wrong order.
    """
    left, left_seconds = _axis(segment.left, segment.seconds)
    right, right_seconds = _axis(segment.right, segment.seconds)

    needed = max(left_seconds, right_seconds, segment.seconds)
    limited = needed > segment.seconds + 1e-12

    if limited:
        # Re-space both axes over the longer time, keeping them in step.
        left, _ = _axis(segment.left, needed)
        right, _ = _axis(segment.right, needed)

    return Pulses(left, right, needed, limited, segment.z_mm)


class RecordingBackend:
    """Somewhere to send pulses that is not a motor.

    Used by the simulator and the tests. Keeps the same interface the PIO
    backend presents, so the code above it never learns which one it has.
    """

    def __init__(self):
        self.pulses = []
        self.enabled = False
        self.left_steps = 0
        self.right_steps = 0
        self.seconds = 0.0

    def enable(self, on):
        self.enabled = on

    def run(self, pulses):
        if not self.enabled:
            raise RuntimeError("the drivers are not enabled")

        self.pulses.append(pulses)
        self.left_steps += pulses.left.direction * pulses.left.count
        self.right_steps += pulses.right.direction * pulses.right.count
        self.seconds += pulses.seconds

    def wait(self):
        """Block until everything queued has been run. Nothing to wait for."""

    def abort(self):
        self.pulses = []


class Stepper:
    """The planner's sink: takes segments, hands pulses to a backend.

    Deliberately thin. It exists so the planner does not have to know whether
    it is driving silicon or a list, and so the counting of what was actually
    stepped lives in one place rather than in both backends.
    """

    def __init__(self, backend, pen=None):
        self.backend = backend
        self.pen = pen
        self.limited_segments = 0
        self.segments = 0

    def enable(self, on=True):
        self.backend.enable(on)

    def __call__(self, segment):
        """Run one segment. Shaped to be passed straight to the planner."""
        pulses = plan_pulses(segment)

        if pulses.limited:
            self.limited_segments += 1

        self.segments += 1

        # The pen moves alongside the motors rather than between segments, so a
        # depth ramp follows the stroke instead of stepping at every vertex.
        if self.pen is not None:
            self.pen.move_to(pulses.z_mm, pulses.seconds)

        self.backend.run(pulses)

    def abort(self):
        self.backend.abort()
        self.backend.enable(False)
