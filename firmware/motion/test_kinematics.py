import math
import unittest

from motion import kinematics as kin


class Drivetrain(unittest.TestCase):
    def test_constants_match_the_documented_derivation(self):
        # docs/HARDWARE.md: GT2 2mm x 20T = 40mm/rev, 200 x 16 = 3200 steps/rev.
        # The app asserts the same numbers in app/js/core/machine.test.js. The
        # two halves of the project disagreeing about millimetres per step
        # would be very hard to see and very easy to do.
        self.assertEqual(kin.MM_PER_REV, 40)
        self.assertEqual(kin.STEPS_PER_REV, 3200)
        self.assertEqual(kin.MM_PER_STEP, 0.0125)
        self.assertEqual(kin.STEPS_PER_MM, 80)

    def test_steps_round_trip_within_half_a_step(self):
        for mm in (0.0, 0.006, 12.3456, 999.9999):
            back = kin.steps_mm(kin.belt_steps(mm))
            self.assertLessEqual(abs(back - mm), kin.MM_PER_STEP / 2 + 1e-12)


class Coordinates(unittest.TestCase):
    def setUp(self):
        self.geometry = kin.Geometry(900, 250, 300, 300, 400)

    def test_paper_and_machine_coordinates_are_an_offset_apart(self):
        self.assertEqual(self.geometry.to_machine(0, 0), (250, 300))
        self.assertEqual(self.geometry.to_paper(250, 300), (0, 0))

    def test_position_recovers_the_point_the_belts_were_taken_from(self):
        for x in range(60, 841, 60):
            for y in range(60, 901, 60):
                left, right = kin.belt_lengths(self.geometry, x, y)
                back = kin.position(self.geometry, left, right)

                self.assertAlmostEqual(back[0], x, places=9)
                self.assertAlmostEqual(back[1], y, places=9)

    def test_the_gondola_hangs_below_the_motor_line(self):
        with self.assertRaises(ValueError):
            kin.belt_lengths(self.geometry, 400, 0)
        with self.assertRaises(ValueError):
            kin.belt_lengths(self.geometry, 400, -10)

    def test_belts_that_do_not_meet_are_refused(self):
        # Too short to span the gap between the motors.
        with self.assertRaises(ValueError):
            kin.position(self.geometry, 100, 100)


class Resolution(unittest.TestCase):
    def setUp(self):
        self.geometry = kin.Geometry(900, 250, 300, 300, 400)

    def test_a_step_is_worth_about_a_step_in_the_middle_of_the_sheet(self):
        # Directly under the span and well below the motors, the belts pull at
        # useful angles and a step is worth roughly its own length.
        resolution = kin.resolution_at(self.geometry, 450, 500)

        self.assertGreater(resolution, kin.MM_PER_STEP)
        self.assertLess(resolution, kin.MM_PER_STEP * 2)

    def test_resolution_collapses_towards_the_motor_line(self):
        # The geometric reason a polargraph cannot draw near the top of its own
        # frame: both belts become nearly horizontal, so neither can say much
        # about how high the gondola is.
        near = kin.resolution_at(self.geometry, 450, 20)
        far = kin.resolution_at(self.geometry, 450, 600)

        self.assertGreater(near, far * 5)

    def test_reachable_rejects_the_motor_line_and_beyond_the_span(self):
        self.assertTrue(kin.reachable(self.geometry, 450, 500))
        self.assertFalse(kin.reachable(self.geometry, 450, 0))
        self.assertFalse(kin.reachable(self.geometry, -5, 500))
        self.assertFalse(kin.reachable(self.geometry, 905, 500))


class Setup(unittest.TestCase):
    def test_motor_spacing_must_be_positive(self):
        with self.assertRaises(ValueError):
            kin.Geometry(0, 0, 0)


if __name__ == "__main__":
    unittest.main()
