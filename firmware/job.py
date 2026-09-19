"""Running a plot, and everything that can interrupt one.

A job is a gcode file being streamed through the interpreter into the planner
into the stepper. The states are what the app asks about and what the pause
button acts on:

    idle --- start ---> running --- pause ---> paused
                          |  ^                   |
                          |  +----- resume ------+
                          |
                          +--- stop / fault ---> error
                          +--- end of file ----> done

Two rules shape all of it.

**Pausing must leave position trustworthy; stopping need not.** A pause lets
the queue drain and the machine stop where it was going to stop anyway, so
resuming is exact. A stop is an emergency: it abandons whatever the state
machines were part way through, which loses steps, and says so by clearing
``position_trusted`` (AD-5).

**The file is never held in memory.** The job pulls one line at a time, which
is what makes pausing between lines both possible and cheap.
"""

from motion import kinematics as kin
from motion.planner import Planner
from gcode.parser import parse_line, GcodeError


IDLE = "idle"
RUNNING = "running"
PAUSED = "paused"
DONE = "done"
ERROR = "error"


class JobError(Exception):
    """A job that cannot continue. The message is what the app shows."""


class Job:
    """One plot, from a stream of gcode lines.

    ``step()`` runs a single command and returns whether there is more to do,
    so the caller keeps control: on the Pico that is the main loop, which also
    has a web server and a button to attend to, and on the desktop it is a test.
    """

    def __init__(self, geometry, limits, stepper, lines, pen=None,
                 start_x_mm=None, start_y_mm=None, log=None):
        self.geometry = geometry
        self.limits = limits
        self.stepper = stepper
        self.pen = pen

        self.state = IDLE
        self.error = None
        self.line_number = 0
        self.lines_run = 0
        self.pauses = 0

        #: Cleared by anything that could have lost steps. See AD-5.
        self.position_trusted = True

        #: Where trouble is written down. On the Pico this goes to the SD card
        #: and the serial console; in a test it is a list to read back.
        self._log = log if log is not None else []

        # The line iterator, not a command generator: a generator that raises
        # is finished, and an error a user may resume past must not take the
        # rest of the file with it.
        self._lines = iter(lines)
        self._planner = Planner(geometry, limits, stepper, start_x_mm, start_y_mm)

        # Modal state, per docs/GCODE.md.
        self._absolute = True
        self._position = {"X": 0.0, "Y": 0.0, "Z": 0.0}
        self._feed_mm_s = None

        #: Set when a pause is wanted but the current command is still running.
        self._pause_requested = False

    # --- what the app asks about -------------------------------------------

    def status(self):
        x, y = self._planner.position_mm()
        paper_x, paper_y = self.geometry.to_paper(x, y)

        return {
            "state": self.state,
            "line": self.line_number,
            "linesRun": self.lines_run,
            "pauses": self.pauses,
            "positionTrusted": self.position_trusted,
            "x": paper_x,
            "y": paper_y,
            "z": self.pen.position_mm() if self.pen else 0.0,
            "error": self.error,
        }

    @property
    def log(self):
        return self._log

    def _record(self, message):
        """Write trouble down before doing anything about it.

        docs/GCODE.md: on any error the firmware pauses, logs it, and reports
        status. A plot that stops with no record of why is a plot nobody can
        fix.
        """
        self._log.append(message)

    # --- control -----------------------------------------------------------

    def start(self):
        if self.state not in (IDLE, PAUSED, ERROR):
            raise JobError("a job in state %r cannot be started" % self.state)

        if not self.position_trusted:
            raise JobError("position is not trusted; calibrate before plotting")

        self.stepper.enable(True)
        self.state = RUNNING

    def pause(self):
        """Stop cleanly at the end of the command in progress.

        Takes effect at a command boundary rather than immediately, so the
        queue drains and the gondola ends up somewhere the planner knew about.
        Position stays trustworthy.
        """
        if self.state != RUNNING:
            return False

        self._pause_requested = True
        return True

    def resume(self):
        """Carry on.

        An error is resumable when nothing was lost — a malformed line does not
        move the gondola, and binning a long plot over one bad line would be a
        poor trade. A fault or a stop is not resumable, because the steps it
        abandoned are gone and the machine no longer knows where it is.
        """
        if self.state == ERROR:
            if not self.position_trusted:
                return False

            self._record("resumed past: %s" % self.error)
            self.error = None
            self.state = PAUSED

        if self.state != PAUSED:
            return False

        self._pause_requested = False
        self.stepper.enable(True)
        self.state = RUNNING
        return True

    def stop(self, reason="stopped"):
        """Abandon the job now.

        Whatever the state machines were part way through is discarded, so
        steps are lost and position can no longer be trusted.
        """
        self.stepper.abort()
        self.position_trusted = False
        self.error = reason
        self._record("%s; position is no longer trusted" % reason)
        self.state = ERROR

    def fault(self, reason):
        """A driver reported trouble. Same consequences as a stop."""
        self.stop(reason)

    # --- running -----------------------------------------------------------

    def step(self):
        """Run one command.

        Returns True while the job is running and has more to do. A pause
        returns False: there is more to do, but not until somebody resumes,
        and a caller looping on this should stop rather than spin.
        """
        if self.state != RUNNING:
            return False

        if self._pause_requested:
            self._settle()
            self.state = PAUSED
            self.pauses += 1
            self._pause_requested = False
            return False

        command = None

        while command is None:
            try:
                line = next(self._lines)
            except StopIteration:
                self._finish()
                return False

            self.line_number += 1

            try:
                # Blank lines and comments carry no command; keep reading.
                command = parse_line(line, self.line_number)
            except GcodeError as problem:
                # A line that cannot be read moves nothing, so position
                # survives it and the user may choose to carry on past it.
                self._settle()
                self.stepper.enable(False)
                self.error = str(problem)
                self._record(self.error)
                self.state = ERROR
                return False

        try:
            self._run(command)
        except (ValueError, JobError) as problem:
            # Refused before it was attempted, so nothing has been lost.
            self._settle()
            self.stepper.enable(False)
            self.error = "line %d: %s" % (command.line_number, problem)
            self._record(self.error)
            self.state = ERROR
            return False

        self.lines_run += 1

        # M0 and M30 change the state from inside the command.
        return self.state == RUNNING

    def run(self, limit=None):
        """Run until the job stops needing attention, and say how it ended.

        Stops on completion, on an error, and on a pause — a pause is a state
        somebody else has to leave. The limit is for tests and for a caller
        that wants to interleave other work; the Pico's main loop calls `step`
        itself.
        """
        count = 0

        while self.step():
            count += 1
            if limit is not None and count >= limit:
                break

        return self.state

    # --- commands ----------------------------------------------------------

    def _run(self, command):
        kind, code, words = command.kind, command.code, command.words

        if kind == "G" and code in (0, 1):
            self._move(words)
        elif kind == "G" and code == 4:
            # A dwell still has to leave the machine stationary.
            self._settle()
        elif kind == "G" and code == 28:
            self._home()
        elif kind == "G" and code == 90:
            self._absolute = True
        elif kind == "G" and code == 91:
            self._absolute = False
        elif kind == "G" and code == 20:
            raise JobError("inches are not supported; the app emits millimetres")
        elif kind == "G" and code == 21:
            pass
        elif kind == "M" and code == 0:
            self._pen_swap()
        elif kind == "M" and code in (2, 30):
            self._finish()
        # Anything else was refused by the parser.

    def _move(self, words):
        if "F" in words:
            self._feed_mm_s = words["F"] / 60.0

        for axis in ("X", "Y", "Z"):
            if axis in words:
                self._position[axis] = (
                    words[axis] if self._absolute
                    else self._position[axis] + words[axis]
                )

        x, y = self.geometry.to_machine(self._position["X"], self._position["Y"])

        if not kin.reachable(self.geometry, x, y):
            raise JobError("(%.1f, %.1f) is outside what the machine can reach"
                           % (self._position["X"], self._position["Y"]))

        self._planner.move_to(x, y, self._position["Z"], self._feed_mm_s)

    def _home(self):
        """Return to the paper origin, which is what G28 means here.

        Not a limit-switch seek: a polargraph has no switches, and its position
        comes from belt lengths rather than from finding an edge.
        """
        x, y = self.geometry.to_machine(0.0, 0.0)

        self._planner.move_to(x, y, self._position["Z"], None)
        self._position["X"] = 0.0
        self._position["Y"] = 0.0
        self._settle()

    def _pen_swap(self):
        """M0: stop and wait for a person.

        The pause is not optional and not timed — the job stays paused until
        something resumes it, which is the whole point of stopping for a pen.
        """
        self._settle()
        self.state = PAUSED
        self.pauses += 1

    def _settle(self):
        """Run the queue out and come to a stop, keeping position exact."""
        self._planner.flush()
        self.stepper.backend.wait()

    def _finish(self):
        self._settle()

        if self.pen is not None:
            self.pen.park()

        self.stepper.enable(False)
        self.state = DONE
