"""PIO step generation. Pico only.

**Unverified against hardware.** Nothing is wired yet; this is written to the
RP2350 datasheet and the DRV8825's timing, and gets checked in Phase 7. The
arithmetic it depends on is tested on the desktop in `stepper.py`, so what
bring-up has to confirm is the wiring and the pulse shape, not the maths.

One state machine per axis (AD-4). Each is fed two words per segment — a step
count and an interval — and produces that many evenly spaced pulses without
further attention. Python's job is to keep the FIFOs from running dry, and at
the rates a polargraph actually works at that is undemanding: a 1 mm segment at
20 mm/s lasts 50 ms, so there are tens of milliseconds to spare between pushes
even at full speed.

Direction is a plain output rather than something encoded in the FIFO data,
because changing it mid-train would step the motor the wrong way. Instead the
state machine is drained before a direction change. That costs nothing: the
planner has already brought the axis to a standstill, since a reversal is the
one junction it always plans a full stop for.
"""

try:
    import rp2
    from machine import Pin
except ImportError:  # pragma: no cover - desktop import, for reading and tests
    rp2 = None
    Pin = None

#: State machine clock. One cycle per microsecond keeps the arithmetic plain.
SM_FREQ_HZ = 1_000_000

#: Cycles the pulse itself and the loop bookkeeping take, subtracted from the
#: requested interval so the *period* comes out right rather than the gap.
LOOP_OVERHEAD_CYCLES = 6


if rp2 is not None:  # pragma: no cover - needs the Pico

    @rp2.asm_pio(set_init=rp2.PIO.OUT_LOW)
    def _step_train():
        """Pulse `count` times, `delay` cycles apart.

        Two words per segment: the step count less one, then the delay less
        one. Both are pre-decremented because `jmp x--` tests before
        decrementing, so a loop written this way runs exactly n times.
        """
        wrap_target()

        pull(block)              # step count - 1
        mov(x, osr)
        pull(block)              # delay cycles - 1
        mov(isr, osr)            # keep it; osr is reloaded every pulse

        label("pulse")
        set(pins, 1)[2]          # 3 cycles high: past the DRV8825's 1.9us
        set(pins, 0)
        mov(y, isr)

        label("wait")
        jmp(y_dec, "wait")

        jmp(x_dec, "pulse")

        wrap()


class PioBackend:
    """Two state machines, two direction pins, one shared enable.

    Presents the same interface as `stepper.RecordingBackend`, so nothing above
    it knows which one it is driving.
    """

    def __init__(self, step_left, step_right, dir_left, dir_right, enable_pin,
                 sm_left=0, sm_right=1):
        if rp2 is None:
            raise RuntimeError("PIO is only available on the Pico")

        self._dir_left = Pin(dir_left, Pin.OUT, value=0)
        self._dir_right = Pin(dir_right, Pin.OUT, value=0)

        # The DRV8825's enable is active low, so a high pin means coasting.
        self._enable = Pin(enable_pin, Pin.OUT, value=1)

        self._left = rp2.StateMachine(
            sm_left, _step_train, freq=SM_FREQ_HZ,
            set_base=Pin(step_left, Pin.OUT, value=0),
        )
        self._right = rp2.StateMachine(
            sm_right, _step_train, freq=SM_FREQ_HZ,
            set_base=Pin(step_right, Pin.OUT, value=0),
        )

        self._left.active(1)
        self._right.active(1)

        self._left_direction = 0
        self._right_direction = 0

    # --- power -------------------------------------------------------------

    def enable(self, on):
        self._enable.value(0 if on else 1)

    # --- running -----------------------------------------------------------

    def run(self, pulses):
        self._feed(self._left, self._dir_left, "_left_direction", pulses.left)
        self._feed(self._right, self._dir_right, "_right_direction", pulses.right)

    def _feed(self, machine, direction_pin, attribute, axis):
        if axis.count == 0:
            return

        if axis.direction != getattr(self, attribute):
            # Never change direction under a running pulse train. The planner
            # has already stopped this axis, so the drain is instant.
            self._drain(machine)
            direction_pin.value(1 if axis.direction > 0 else 0)
            setattr(self, attribute, axis.direction)

        cycles = int(round(axis.interval_s * SM_FREQ_HZ)) - LOOP_OVERHEAD_CYCLES
        if cycles < 1:
            cycles = 1

        # Blocking puts, so a full FIFO paces the caller rather than losing steps.
        machine.put(axis.count - 1)
        machine.put(cycles - 1)

    @staticmethod
    def _drain(machine):
        while machine.tx_fifo() > 0:
            pass

    def wait(self):
        self._drain(self._left)
        self._drain(self._right)

    def abort(self):
        """Stop now, wherever the gondola is.

        Restarting the state machines discards whatever they were part way
        through, which loses steps on purpose: position is no longer trusted
        after this and the firmware says so (AD-5).
        """
        for machine in (self._left, self._right):
            machine.active(0)
            machine.restart()
            machine.active(1)

        self.enable(False)
