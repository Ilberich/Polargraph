import unittest

from supervisor import Supervisor


class FakeJob:
    def __init__(self):
        self.state = "running"
        self.faults = []

    def fault(self, reason):
        self.faults.append(reason)
        self.state = "error"


class FakeStepper:
    def __init__(self):
        self.aborted = 0

    def abort(self):
        self.aborted += 1


class FakeController:
    def __init__(self, job=None):
        self.job = job
        self.stepper = FakeStepper()
        self.last_error = None
        self.position_trusted = True
        self.ticks = 0

    def tick(self, commands=32):
        self.ticks += 1
        return self.job is not None and self.job.state == "running"


class FakeButton:
    def __init__(self):
        self.polls = 0

    def poll(self, job):
        self.polls += 1
        return False


class Rounds(unittest.TestCase):
    def test_a_round_advances_the_job(self):
        controller = FakeController(FakeJob())
        supervisor = Supervisor(controller)

        self.assertTrue(supervisor.step())
        self.assertEqual(controller.ticks, 1)

    def test_an_idle_machine_says_it_did_nothing(self):
        supervisor = Supervisor(FakeController())
        self.assertFalse(supervisor.step())

    def test_the_button_is_read_every_round(self):
        button = FakeButton()
        supervisor = Supervisor(FakeController(FakeJob()), button=button)

        supervisor.step()
        supervisor.step()

        self.assertEqual(button.polls, 2)

    def test_the_button_is_read_before_the_job_advances(self):
        # On a machine whose emergency stop is a person's finger, this is the
        # difference between stopping now and stopping when it feels like it.
        order = []

        class Watching(FakeController):
            def tick(self, commands=32):
                order.append("tick")
                return False

        class Pressing(FakeButton):
            def poll(self, job):
                order.append("button")
                return False

        Supervisor(Watching(FakeJob()), button=Pressing()).step()

        self.assertEqual(order, ["button", "tick"])


class Faults(unittest.TestCase):
    def test_a_driver_fault_stops_the_job_and_loses_position(self):
        job = FakeJob()
        controller = FakeController(job)
        tripped = [False]

        supervisor = Supervisor(controller, faults=[lambda: tripped[0], lambda: False])
        supervisor.step()
        self.assertEqual(job.faults, [])

        tripped[0] = True
        supervisor.step()

        self.assertEqual(job.faults, ["left driver reported a fault"])
        self.assertFalse(controller.position_trusted)

    def test_the_side_that_tripped_is_named(self):
        job = FakeJob()
        controller = FakeController(job)

        Supervisor(controller, faults=[lambda: False, lambda: True]).step()

        self.assertIn("right", job.faults[0])

    def test_a_latched_fault_is_reported_once(self):
        # A DRV8825 that has overheated holds nFAULT low until it is reset, and
        # re-reporting it every round would fill the log with one event.
        controller = FakeController(FakeJob())
        supervisor = Supervisor(controller, faults=[lambda: True])

        for _ in range(5):
            supervisor.step()

        self.assertEqual(len(supervisor.log), 1)

    def test_a_fault_with_no_job_still_cuts_the_power(self):
        # Nothing is moving, but the drivers should not be left energised into
        # a fault.
        controller = FakeController()
        supervisor = Supervisor(controller, faults=[lambda: True])

        supervisor.step()

        self.assertEqual(controller.stepper.aborted, 1)
        self.assertIn("left driver", controller.last_error)

    def test_a_fault_that_clears_can_trip_again(self):
        controller = FakeController(FakeJob())
        tripped = [True]
        supervisor = Supervisor(controller, faults=[lambda: tripped[0]])

        supervisor.step()
        tripped[0] = False
        supervisor.step()
        tripped[0] = True
        supervisor.step()

        self.assertEqual(len(supervisor.log), 2)


if __name__ == "__main__":
    unittest.main()
