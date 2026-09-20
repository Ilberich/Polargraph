"""The main loop, as something that can be stepped.

What the Pico's loop has to do is small and easy to get subtly wrong: run the
job, watch the button, watch the drivers, and never let any one of them starve
the others. Putting it in a class rather than in `while True:` means it can be
stepped by a test instead of only by time.

The order is the interesting part. The button and the fault lines are read
*before* the job is advanced, so a press or a fault takes effect at the next
command boundary rather than after another slice of plotting. On a machine
whose emergency stop is a person's finger, that is the difference between
stopping now and stopping when it feels like it.
"""


class Supervisor:
    """One round of everything the machine has to attend to."""

    def __init__(self, controller, button=None, faults=(), log=None):
        self.controller = controller
        self.button = button
        #: Callables returning True when a driver is reporting trouble.
        self.faults = list(faults)
        self.log = log if log is not None else []

        self.rounds = 0
        self.faulted = False

    def step(self, commands=32):
        """Returns True if the machine did any plotting this round."""
        self.rounds += 1

        self._check_faults()

        if self.button is not None and self.controller.job is not None:
            self.button.poll(self.controller.job)

        return self.controller.tick(commands)

    def _check_faults(self):
        """A driver in trouble stops the job, and says so.

        Latched: a DRV8825 that has overheated pulls nFAULT low until it is
        reset, and re-reporting it every round would fill the log with one
        event. What matters is that the first one stopped the machine.
        """
        tripped = [i for i, read in enumerate(self.faults) if read()]

        if not tripped:
            self.faulted = False
            return

        if self.faulted:
            return

        self.faulted = True
        side = "left" if 0 in tripped else "right"
        message = "%s driver reported a fault" % side

        self.log.append(message)

        if self.controller.job is not None:
            self.controller.job.fault(message)
            self.controller.last_error = message
            self.controller.position_trusted = False
        else:
            self.controller.last_error = message
            # Nothing is moving, but the drivers should not be left energised
            # into a fault.
            self.controller.stepper.abort()
