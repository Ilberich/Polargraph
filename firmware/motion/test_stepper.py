import unittest

from motion.planner import Segment
from motion.stepper import (
    plan_pulses, Stepper, RecordingBackend, MIN_STEP_INTERVAL_S, MAX_STEP_RATE,
)
from motion.pen import NullPen


def segment(left, right, seconds, z_mm=0.0):
    piece = Segment(left, right, 1.0, 20.0, z_mm)
    piece.seconds = seconds
    return piece


class Timing(unittest.TestCase):
    def test_each_axis_gets_its_own_interval(self):
        # Eighty steps and ten over the same tenth of a second: one axis pulses
        # eight times as often as the other, and they finish together. That is
        # the whole reason there is a state machine per axis.
        pulses = plan_pulses(segment(80, 10, 0.1))

        self.assertEqual(pulses.left.count, 80)
        self.assertEqual(pulses.right.count, 10)
        self.assertAlmostEqual(pulses.left.interval_s, 0.1 / 80)
        self.assertAlmostEqual(pulses.right.interval_s, 0.1 / 10)
        self.assertAlmostEqual(pulses.left.seconds(), pulses.right.seconds())

    def test_direction_comes_from_the_sign(self):
        pulses = plan_pulses(segment(-5, 5, 0.01))

        self.assertEqual(pulses.left.direction, -1)
        self.assertEqual(pulses.right.direction, 1)

    def test_an_axis_that_does_not_move_has_no_direction(self):
        pulses = plan_pulses(segment(0, 5, 0.01))

        self.assertEqual(pulses.left.direction, 0)
        self.assertEqual(pulses.left.count, 0)

    def test_a_segment_asked_for_too_fast_is_stretched_not_dropped(self):
        # Every step still happens — the geometry is never sacrificed — but the
        # segment takes longer than planned, and that is counted rather than
        # swallowed.
        impossible = segment(1000, 0, 1e-6)
        pulses = plan_pulses(impossible)

        self.assertTrue(pulses.limited)
        self.assertEqual(pulses.left.count, 1000)
        self.assertGreaterEqual(pulses.left.interval_s, MIN_STEP_INTERVAL_S)
        self.assertGreater(pulses.seconds, impossible.seconds)

    def test_stretching_keeps_both_axes_together(self):
        # Slowing only the axis that cannot keep up would bend the segment:
        # the same steps, arriving in the wrong order.
        pulses = plan_pulses(segment(1000, 100, 1e-6))

        self.assertAlmostEqual(pulses.left.seconds(), pulses.right.seconds(), places=9)

    def test_a_normal_plot_is_nowhere_near_the_limit(self):
        # The simulator measures a real job peaking around 1600 steps/s.
        self.assertGreater(MAX_STEP_RATE, 100_000)


class Driving(unittest.TestCase):
    def setUp(self):
        self.backend = RecordingBackend()
        self.stepper = Stepper(self.backend)

    def test_the_drivers_must_be_enabled_first(self):
        with self.assertRaises(RuntimeError):
            self.stepper(segment(10, 10, 0.01))

    def test_steps_reach_the_backend_with_their_signs(self):
        self.stepper.enable(True)
        self.stepper(segment(10, -4, 0.01))
        self.stepper(segment(-3, 7, 0.01))

        self.assertEqual(self.backend.left_steps, 7)
        self.assertEqual(self.backend.right_steps, 3)
        self.assertEqual(self.stepper.segments, 2)

    def test_limited_segments_are_counted(self):
        self.stepper.enable(True)
        self.stepper(segment(10, 10, 0.01))
        self.stepper(segment(1000, 1000, 1e-7))

        self.assertEqual(self.stepper.limited_segments, 1)

    def test_aborting_cuts_the_power(self):
        self.stepper.enable(True)
        self.stepper(segment(10, 10, 0.01))
        self.stepper.abort()

        self.assertFalse(self.backend.enabled)
        self.assertEqual(self.backend.pulses, [])


class Pen(unittest.TestCase):
    def test_the_pen_is_moved_with_the_segment_not_between_them(self):
        # So a depth ramp follows the stroke rather than stepping at each
        # vertex: the pen is told where to be by the end and how long it has.
        pen = NullPen()
        backend = RecordingBackend()
        stepper = Stepper(backend, pen)
        stepper.enable(True)

        stepper(segment(10, 10, 0.01, z_mm=-2.5))
        self.assertEqual(pen.position_mm(), -2.5)

    def test_the_null_pen_admits_it_cannot_lift(self):
        # v1 has no pen hardware. Reporting otherwise would have the app
        # believing travel moves do not draw.
        self.assertFalse(NullPen.can_lift)

    def test_the_null_pen_still_remembers_the_depth_it_was_given(self):
        # AD-2: v1 files carry Z and are forward-compatible with v2 hardware,
        # so status tells the truth about what the file asked for.
        pen = NullPen()
        pen.move_to(-1.5)

        self.assertEqual(pen.position_mm(), -1.5)
        pen.park()
        self.assertEqual(pen.position_mm(), -1.5, "there is nothing to park")


if __name__ == "__main__":
    unittest.main()
