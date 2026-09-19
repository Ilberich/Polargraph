import math
import unittest

from motion import kinematics as kin
from motion.planner import Planner, Limits, junction_speed


def collect(geometry, limits, points, start=None):
    """Plan a run of machine-coordinate points and return its segments."""
    segments = []
    begin = start if start else points[0]
    planner = Planner(geometry, limits, segments.append, begin[0], begin[1])

    for point in points:
        planner.move_to(point[0], point[1])

    planner.flush()
    return segments, planner


class Segmentation(unittest.TestCase):
    def setUp(self):
        self.geometry = kin.Geometry(900, 250, 300, 300, 400)

    def test_a_move_is_cut_into_short_segments(self):
        # A straight line across the paper is a curve in belt space, so it has
        # to be followed in pieces or the pen bows off it.
        limits = Limits(max_segment_mm=1.0)
        segments, _ = collect(self.geometry, limits, [(300, 500), (500, 500)])

        self.assertGreater(len(segments), 190)
        for segment in segments:
            self.assertLessEqual(segment.distance_mm, 1.2)

    def test_a_coarser_segment_limit_makes_fewer_segments(self):
        fine, _ = collect(self.geometry, Limits(max_segment_mm=0.5), [(300, 500), (500, 500)])
        coarse, _ = collect(self.geometry, Limits(max_segment_mm=4.0), [(300, 500), (500, 500)])

        self.assertGreater(len(fine), len(coarse) * 4)

    def test_a_move_that_goes_nowhere_emits_nothing(self):
        segments, _ = collect(self.geometry, Limits(), [(400, 500), (400, 500)])
        self.assertEqual(segments, [])


class Steps(unittest.TestCase):
    def setUp(self):
        self.geometry = kin.Geometry(900, 250, 300, 300, 400)

    def test_the_steps_add_up_to_the_exact_target(self):
        # Every segment's target is solved from the true geometry rather than
        # from the last rounded value, so the total cannot drift.
        start = (300, 500)
        end = (600, 800)
        segments, planner = collect(self.geometry, Limits(), [start, end])

        left, right = kin.belt_lengths(self.geometry, *start)
        expected_left = kin.belt_steps(left) + sum(s.left for s in segments)
        expected_right = kin.belt_steps(right) + sum(s.right for s in segments)

        wanted_left, wanted_right = kin.belt_lengths(self.geometry, *end)
        self.assertEqual(expected_left, kin.belt_steps(wanted_left))
        self.assertEqual(expected_right, kin.belt_steps(wanted_right))
        self.assertEqual(planner.left_steps, kin.belt_steps(wanted_left))

    def test_the_planner_knows_where_it_is_in_whole_steps(self):
        _, planner = collect(self.geometry, Limits(), [(300, 500), (600, 800)])
        x, y = planner.position_mm()

        self.assertAlmostEqual(x, 600, places=1)
        self.assertAlmostEqual(y, 800, places=1)


class Speeds(unittest.TestCase):
    def setUp(self):
        self.geometry = kin.Geometry(900, 250, 300, 300, 400)
        self.limits = Limits(max_speed_mm_s=20, acceleration_mm_s2=200)

    def test_a_long_move_takes_about_its_trapezoid(self):
        segments, _ = collect(self.geometry, self.limits, [(300, 600), (500, 600)])
        total = sum(s.seconds for s in segments)

        # 200mm at 20mm/s, plus the time lost accelerating at each end.
        ideal = 200 / 20 + 20 / 200
        self.assertAlmostEqual(total, ideal, delta=ideal * 0.01)

    def test_nothing_exceeds_the_speed_limit(self):
        segments, _ = collect(self.geometry, self.limits, [(300, 600), (500, 600)])

        for segment in segments:
            self.assertLessEqual(segment.entry_mm_s, self.limits.max_speed_mm_s + 1e-9)
            self.assertLessEqual(segment.exit_mm_s, self.limits.max_speed_mm_s + 1e-9)

    def test_speed_changes_stay_within_the_acceleration_limit(self):
        segments, _ = collect(self.geometry, self.limits, [(300, 600), (500, 600)])

        for segment in segments:
            reachable = math.sqrt(
                segment.entry_mm_s ** 2
                + 2 * self.limits.acceleration_mm_s2 * segment.distance_mm
            )
            self.assertLessEqual(segment.exit_mm_s, reachable + 1e-6)

    def test_a_job_starts_and_finishes_at_rest(self):
        segments, _ = collect(self.geometry, self.limits, [(300, 600), (500, 600)])

        self.assertEqual(segments[0].entry_mm_s, 0.0)
        self.assertEqual(segments[-1].exit_mm_s, 0.0)

    def test_speed_carries_through_a_straight_join(self):
        # Two moves in the same direction are one straight line; braking at the
        # join would be time thrown away.
        straight, _ = collect(self.geometry, self.limits,
                              [(300, 600), (400, 600), (500, 600)])
        whole, _ = collect(self.geometry, self.limits, [(300, 600), (500, 600)])

        self.assertAlmostEqual(
            sum(s.seconds for s in straight),
            sum(s.seconds for s in whole),
            delta=0.05,
        )

    def test_a_reversal_costs_a_full_stop(self):
        there_and_back, _ = collect(self.geometry, self.limits,
                                    [(300, 600), (500, 600), (300, 600)])
        twice_straight, _ = collect(self.geometry, self.limits, [(300, 600), (700, 600)])

        self.assertGreater(
            sum(s.seconds for s in there_and_back),
            sum(s.seconds for s in twice_straight),
        )

    def test_a_corner_is_slower_than_no_corner(self):
        corner, _ = collect(self.geometry, self.limits,
                            [(300, 600), (500, 600), (500, 800)])
        straight, _ = collect(self.geometry, self.limits, [(300, 600), (700, 600)])

        self.assertGreater(sum(s.seconds for s in corner),
                           sum(s.seconds for s in straight))


class Junctions(unittest.TestCase):
    def setUp(self):
        self.limits = Limits(max_speed_mm_s=20, junction_speed_mm_s=5)

    def test_straight_on_keeps_full_speed(self):
        self.assertAlmostEqual(junction_speed((1, 0), (1, 0), self.limits), 20)

    def test_doubling_back_is_a_full_stop(self):
        self.assertEqual(junction_speed((1, 0), (-1, 0), self.limits), 0.0)

    def test_a_right_angle_is_taken_at_about_the_jerk_speed(self):
        speed = junction_speed((1, 0), (0, 1), self.limits)
        self.assertGreater(speed, 5)
        self.assertLess(speed, 10)

    def test_the_first_move_of_a_job_has_no_junction(self):
        self.assertEqual(junction_speed(None, (1, 0), self.limits), 0.0)


class Lookahead(unittest.TestCase):
    def test_the_window_stays_bounded_however_long_the_job(self):
        # The Pico cannot hold a plot file, let alone a planned one. The window
        # is capped by distance, not by segment count.
        geometry = kin.Geometry(900, 250, 300, 300, 400)
        limits = Limits(max_speed_mm_s=20, acceleration_mm_s2=200, max_segment_mm=1.0)

        widest = [0]
        planner = Planner(geometry, limits, lambda s: None, 300, 600)

        for i in range(400):
            planner.move_to(300 + (i % 2) * 200, 600 + i * 0.5)
            widest[0] = max(widest[0], len(planner._window))

        planner.flush()

        # Two stopping distances at 20mm/s and 200mm/s^2 is 2mm, so a handful
        # of 1mm segments — not four hundred moves' worth.
        self.assertLess(widest[0], 20)


if __name__ == "__main__":
    unittest.main()
