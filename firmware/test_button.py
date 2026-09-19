import unittest

from button import Debouncer, PauseButton
from job import RUNNING, PAUSED, DONE


class Bounce(unittest.TestCase):
    def setUp(self):
        self.debouncer = Debouncer(0.03)

    def test_a_clean_press_is_reported_once_it_has_settled(self):
        self.assertFalse(self.debouncer.update(True, 0.0), "not yet believed")
        self.assertFalse(self.debouncer.update(True, 0.02))
        self.assertTrue(self.debouncer.update(True, 0.04))

    def test_a_bouncing_press_is_still_one_press(self):
        # The failure this exists to prevent: four events from one push, which
        # would pause and resume a plot twice on the way down.
        presses = 0
        for time_s, raw in [(0.000, True), (0.002, False), (0.004, True),
                            (0.006, False), (0.008, True), (0.050, True),
                            (0.080, True)]:
            if self.debouncer.update(raw, time_s):
                presses += 1

        self.assertEqual(presses, 1)

    def test_letting_go_is_not_a_press(self):
        for time_s, raw in [(0.0, True), (0.05, True), (0.06, False), (0.12, False)]:
            self.debouncer.update(raw, time_s)

        self.assertFalse(self.debouncer.update(False, 0.20))

    def test_the_second_push_is_reported_too(self):
        events = []
        for time_s, raw in [(0.0, True), (0.05, True), (0.06, False), (0.12, False),
                            (0.20, True), (0.26, True)]:
            events.append(self.debouncer.update(raw, time_s))

        self.assertEqual(sum(1 for e in events if e), 2)

    def test_a_line_that_never_settles_reports_nothing(self):
        for i in range(50):
            self.assertFalse(self.debouncer.update(i % 2 == 0, i * 0.005))


class Fake:
    """Just enough of a job for the button to act on."""

    def __init__(self, state):
        self.state = state
        self.calls = []

    def pause(self):
        self.calls.append("pause")
        self.state = PAUSED
        return True

    def resume(self):
        self.calls.append("resume")
        self.state = RUNNING
        return True


class Button(unittest.TestCase):
    def setUp(self):
        self.pressed = False
        self.time = 0.0
        self.button = PauseButton(lambda: self.pressed, lambda: self.time, 0.03)

    def push(self, job):
        """Press and release, polling the way the main loop does."""
        self.pressed = True
        self.button.poll(job)          # the line moved; not believed yet
        self.time += 0.05
        acted = self.button.poll(job)  # settled

        self.pressed = False
        self.button.poll(job)
        self.time += 0.05
        self.button.poll(job)

        return acted

    def test_one_button_does_both_jobs(self):
        # The plotter has no screen to ask which was meant, and a person
        # standing at a paused machine pressing the only button means "go on".
        job = Fake(RUNNING)

        self.assertTrue(self.push(job))
        self.assertEqual(job.state, PAUSED)

        self.assertTrue(self.push(job))
        self.assertEqual(job.state, RUNNING)

        self.assertEqual(job.calls, ["pause", "resume"])

    def test_nothing_happens_while_the_button_is_up(self):
        job = Fake(RUNNING)
        self.time += 1.0

        self.assertFalse(self.button.poll(job))
        self.assertEqual(job.calls, [])


if __name__ == "__main__":
    unittest.main()
