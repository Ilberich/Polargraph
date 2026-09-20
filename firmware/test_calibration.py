import math
import unittest

from calibration import (
    Calibration, CalibrationError, solve_similarity, residual, corners_of,
    MIN_SPREAD_MM,
)
from motion.kinematics import apply_transform, invert_transform


def rigid(angle_deg, scale, tx, ty):
    """A truth to measure against: a sheet taped up turned, moved and scaled."""
    angle = math.radians(angle_deg)
    cos, sin = math.cos(angle) * scale, math.sin(angle) * scale

    return [cos, -sin, tx, sin, cos, ty]


PAPER = corners_of(210, 297)


class Fitting(unittest.TestCase):
    def test_perfect_aim_recovers_the_truth_exactly(self):
        truth = rigid(1.2, 1.0, 12.4, 8.9)
        target = [apply_transform(truth, x, y) for x, y in PAPER[:3]]

        fit = solve_similarity(PAPER[:3], target)

        self.assertAlmostEqual(fit["rotationDeg"], 1.2, places=9)
        self.assertAlmostEqual(fit["scale"], 1.0, places=9)
        self.assertAlmostEqual(fit["residualMm"], 0.0, places=9)

        for got, wanted in zip(fit["transform"], truth):
            self.assertAlmostEqual(got, wanted, places=9)

    def test_scale_is_recovered_too(self):
        # A belt that is not quite the pitch it says, or a motor spacing typed
        # in a few millimetres out, both show up here.
        truth = rigid(0.0, 1.004, 0.0, 0.0)
        target = [apply_transform(truth, x, y) for x, y in PAPER[:3]]

        self.assertAlmostEqual(solve_similarity(PAPER[:3], target)["scale"], 1.004,
                               places=9)

    def test_aim_error_shows_up_as_residual_rather_than_being_absorbed(self):
        # The whole point of AD-7. A free affine would fit three clicks
        # perfectly whatever they were, and report nothing wrong.
        truth = rigid(1.2, 1.0, 12.4, 8.9)
        target = [list(apply_transform(truth, x, y)) for x, y in PAPER[:3]]
        target[1][0] += 1.0
        target[1][1] -= 0.6

        fit = solve_similarity(PAPER[:3], target)

        self.assertGreater(fit["residualMm"], 0.3)
        self.assertLess(fit["residualMm"], 1.0)

    def test_the_fit_stays_square_however_sloppy_the_aim(self):
        # Shear and non-uniform scale describe nothing a rigid sheet can do, so
        # they are not offered: the transform that comes out is always a
        # rotation times a scale.
        truth = rigid(3.0, 1.0, 5.0, 5.0)
        target = [list(apply_transform(truth, x, y)) for x, y in PAPER[:3]]
        target[0][0] += 4.0
        target[2][1] -= 3.0

        a, b, _, c, d, _ = solve_similarity(PAPER[:3], target)["transform"]

        self.assertAlmostEqual(a, d, places=9, msg="equal scale on both axes")
        self.assertAlmostEqual(b, -c, places=9, msg="a rotation, not a shear")

    def test_points_too_close_together_are_refused(self):
        tight = [(0, 0), (1, 0), (0, 1)]

        with self.assertRaises(CalibrationError) as caught:
            solve_similarity(tight, tight)

        self.assertEqual(caught.exception.slug, "degenerate")

    def test_recording_three_corners_without_moving_is_refused(self):
        # The likeliest mistake there is, and a least-squares fit is perfectly
        # happy with it: collapse the paper to a point and the residual is zero,
        # because it has indeed fitted what it was given.
        standing_still = [(150.0, 200.0)] * 3

        with self.assertRaises(CalibrationError) as caught:
            solve_similarity(PAPER[:3], standing_still)

        self.assertEqual(caught.exception.slug, "degenerate")

    def test_a_sheet_that_comes_out_the_wrong_size_is_refused(self):
        # Calibration corrects for paper taped up crooked. It does not discover
        # that the paper is a tenth of the size it says.
        tenth = [apply_transform([0.1, 0, 0, 0, 0.1, 0], x, y) for x, y in PAPER[:3]]

        with self.assertRaises(CalibrationError) as caught:
            solve_similarity(PAPER[:3], tenth)

        self.assertEqual(caught.exception.slug, "implausible_scale")

    def test_two_points_are_the_fewest_that_mean_anything(self):
        with self.assertRaises(CalibrationError):
            solve_similarity([(0, 0)], [(0, 0)])

    def test_the_residual_is_a_distance_in_millimetres(self):
        # One point 3mm out of three is 3/sqrt(3) RMS, not 3 and not 1.
        identity = [1, 0, 0, 0, 1, 0]
        target = [(0, 0), (3, 0), (0, 0)]

        self.assertAlmostEqual(
            residual(identity, [(0, 0), (0, 0), (0, 0)], target),
            3 / math.sqrt(3),
            places=9,
        )


class Inverse(unittest.TestCase):
    def test_a_transform_and_its_inverse_round_trip(self):
        transform = rigid(2.5, 1.01, -30.0, 44.0)
        back = invert_transform(transform)

        for x, y in PAPER:
            moved = apply_transform(transform, x, y)
            returned = apply_transform(back, moved[0], moved[1])

            self.assertAlmostEqual(returned[0], x, places=9)
            self.assertAlmostEqual(returned[1], y, places=9)

    def test_a_collapsed_transform_has_no_inverse(self):
        with self.assertRaises(ValueError):
            invert_transform([1, 1, 0, 1, 1, 0])


class Sequence(unittest.TestCase):
    def setUp(self):
        self.calibration = Calibration(210, 297)
        self.truth = rigid(1.5, 1.0, 20.0, 10.0)

    def capture_all(self):
        for index, corner in enumerate(PAPER[:3]):
            self.calibration.capture(
                index, corner, apply_transform(self.truth, *corner))

    def test_nothing_is_locked_until_it_is_confirmed(self):
        self.capture_all()
        self.assertIsNone(self.calibration.transform)

        self.calibration.solve()
        self.assertIsNone(self.calibration.transform, "solved is not locked")

        self.calibration.verify()
        self.assertIsNone(self.calibration.transform, "verifying is not locked")

        self.calibration.confirm(True)
        self.assertIsNotNone(self.calibration.transform)

    def test_solving_early_is_refused(self):
        self.calibration.capture(0, PAPER[0], (0, 0))

        with self.assertRaises(CalibrationError) as caught:
            self.calibration.solve()

        self.assertEqual(caught.exception.slug, "not_enough_points")

    def test_verifying_before_solving_is_refused(self):
        self.capture_all()

        with self.assertRaises(CalibrationError) as caught:
            self.calibration.verify()

        self.assertEqual(caught.exception.slug, "not_solved")

    def test_confirming_before_verifying_is_refused(self):
        self.capture_all()
        self.calibration.solve()

        with self.assertRaises(CalibrationError) as caught:
            self.calibration.confirm(True)

        self.assertEqual(caught.exception.slug, "not_verifying")

    def test_the_corner_to_check_is_the_one_nobody_drove_to(self):
        # Asking the fit about a place it was shown would be asking it about
        # itself.
        self.capture_all()
        self.calibration.solve()

        self.assertEqual(self.calibration.verify()["paperPoint"], {"x": 0.0, "y": 297.0})

    def test_rejecting_throws_the_captures_away(self):
        # If the fourth corner is wrong then one of the three is wrong, and
        # there is no way to know which. Keeping them carries the mistake.
        self.capture_all()
        self.calibration.solve()
        self.calibration.verify()

        self.calibration.confirm(False)

        self.assertEqual(self.calibration.state, Calibration.IDLE)
        self.assertEqual(self.calibration.captured, {})
        self.assertIsNone(self.calibration.transform)

    def test_a_corner_out_of_range_is_refused(self):
        with self.assertRaises(CalibrationError) as caught:
            self.calibration.capture(7, (0, 0), (0, 0))

        self.assertEqual(caught.exception.slug, "bad_index")

    def test_a_corner_can_be_captured_again_before_solving(self):
        self.calibration.capture(0, PAPER[0], (10, 10))
        self.calibration.capture(0, PAPER[0], (11, 11))

        self.assertEqual(self.calibration.captured[0][1], (11, 11))
        self.assertEqual(self.calibration.progress()["captured"], [0])

    def test_capturing_after_locking_is_refused(self):
        self.capture_all()
        self.calibration.solve()
        self.calibration.verify()
        self.calibration.confirm(True)

        with self.assertRaises(CalibrationError) as caught:
            self.calibration.capture(0, PAPER[0], (0, 0))

        self.assertEqual(caught.exception.slug, "already_locked")

    def test_progress_says_how_far_along_it_is(self):
        self.calibration.capture(0, PAPER[0], (0, 0))
        self.calibration.capture(2, PAPER[2], (0, 0))

        self.assertEqual(self.calibration.progress(),
                         {"state": "capturing", "captured": [0, 2], "needed": 3})


if __name__ == "__main__":
    unittest.main()
