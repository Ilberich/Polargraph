"""The pause button.

A switch on a long wire bounces for a few milliseconds every time it is pressed
or let go, and each bounce looks exactly like another press. A plotter that
paused and resumed four times per push would be unusable, so a press only counts
once the line has been quiet for long enough to believe.

The debounce is pure arithmetic and tested on the desktop; the only thing that
needs hardware is reading a pin.
"""

DEFAULT_DEBOUNCE_S = 0.03


class Debouncer:
    """Turns a noisy line into press events.

    Fed the raw reading and the current time, it reports a press the moment the
    line has been settled in the pressed position for `debounce_s`. Reporting on
    the settled edge rather than the first change costs a few milliseconds
    nobody notices and removes the bounce entirely.
    """

    def __init__(self, debounce_s=DEFAULT_DEBOUNCE_S):
        self.debounce_s = float(debounce_s)
        self._stable = False
        self._candidate = False
        self._since = None

    def update(self, pressed, now):
        """Returns True exactly once per genuine press."""
        pressed = bool(pressed)

        if pressed != self._candidate:
            # The line moved. Start the clock again; it has proved nothing yet.
            self._candidate = pressed
            self._since = now
            return False

        if self._since is None or pressed == self._stable:
            return False

        if now - self._since < self.debounce_s:
            return False

        self._stable = pressed
        self._since = None

        # A release is settled too, but only a press is an event.
        return pressed


class PauseButton:
    """A debounced button wired to a job.

    One button, both jobs: press to pause, press again to resume. The plotter
    has no screen, so it cannot ask which was meant — and a person standing at
    a paused machine pressing the only button means "go on".
    """

    def __init__(self, read, now, debounce_s=DEFAULT_DEBOUNCE_S):
        self._read = read
        self._now = now
        self._debouncer = Debouncer(debounce_s)

    def poll(self, job):
        """Check the button and act on it. Returns True if it did something."""
        if not self._debouncer.update(self._read(), self._now()):
            return False

        if job.state == "running":
            return job.pause()

        return job.resume()


def gpio_pause_button(pin_number, debounce_s=DEFAULT_DEBOUNCE_S):  # pragma: no cover
    """The real thing: a switch to ground with the internal pull-up.

    Pico only. Pressed reads low, which is why the reading is inverted here
    rather than everywhere else.
    """
    from machine import Pin
    import time

    pin = Pin(pin_number, Pin.IN, Pin.PULL_UP)

    return PauseButton(lambda: not pin.value(), lambda: time.ticks_ms() / 1000.0,
                       debounce_s)
