"""The machine, as something the API can ask questions of.

A job is one plot. This is everything that outlives one: where the gondola is
and whether that is believed, what the calibration says, which file is loaded,
and the hardware the job will borrow when it starts.

The split matters because of AD-5. Position trust is a property of the
*machine*, not of a job — it is cleared at boot, before any job exists, and it
survives a job ending. A job that owned it would hand it back every time it
finished.
"""

import time

from motion import kinematics as kin
from motion.planner import Limits
from calibration import Calibration, CalibrationError
from job import Job, JobError, IDLE, RUNNING, PAUSED, DONE, ERROR


class ControllerError(Exception):
    """Refused. Carries the API's stable error slug."""

    def __init__(self, slug, message, status=409):
        Exception.__init__(self, message)
        self.slug = slug
        self.message = message
        self.status = status


#: Per-job settings the app sends with `POST /api/job/start`, and the defaults
#: used when it leaves one out. See docs/API.md.
JOB_DEFAULTS = {
    "motorSpacing": 900.0,
    "paperSize": {"width": 210.0, "height": 297.0},
    "margins": {"top": 20.0, "right": 20.0, "bottom": 20.0, "left": 20.0},
    "maxSpeed": 1200.0,
    "acceleration": 200.0,
    "jerk": 5.0,
    "homeCorner": "left",
    "penLift": False,
    "zRange": {"up": 5.0, "down": -2.0},
}


class Controller:
    def __init__(self, store, config, stepper, pen, clock=None):
        self.store = store
        self.config = config
        self.stepper = stepper
        self.pen = pen
        self._clock = clock if clock is not None else time.time

        #: Cleared on every boot, and this *is* every boot (AD-5). The app may
        #: not offer to reuse a stored calibration while it is false.
        self.position_trusted = False

        #: Where the paper really is. Nothing plots until this is locked in,
        #: which is the contract in docs/GCODE.md.
        self.calibration = Calibration(
            JOB_DEFAULTS["paperSize"]["width"], JOB_DEFAULTS["paperSize"]["height"])

        self.geometry = kin.Geometry(
            JOB_DEFAULTS["motorSpacing"],
            JOB_DEFAULTS["motorSpacing"] / 2 - JOB_DEFAULTS["paperSize"]["width"] / 2,
            400.0,
            JOB_DEFAULTS["paperSize"]["width"],
            JOB_DEFAULTS["paperSize"]["height"],
        )

        self.job = None
        self.job_file = None
        self.job_lines = 0
        self.started_at = None
        self.last_error = None

        #: Where the gondola is between jobs, in paper coordinates.
        self._resting_x = 0.0
        self._resting_y = 0.0

    # --- state --------------------------------------------------------------

    @property
    def transform(self):
        return self.calibration.transform

    @property
    def calibrated(self):
        return self.transform is not None

    def state(self):
        if self.job is not None:
            return self.job.state

        if self.calibration.state not in (Calibration.IDLE, Calibration.LOCKED):
            return "calibrating"

        return IDLE if self.last_error is None else ERROR

    def status(self):
        """Everything the app needs to rebuild its UI from scratch."""
        x, y = self._position()
        machine = self.geometry.to_machine(x, y)
        left, right = kin.belt_lengths(self.geometry, machine[0], machine[1])

        return {
            "state": self.state(),
            "positionTrusted": self.position_trusted,
            "calibrated": self.calibrated,
            "position": {"x": x, "y": y, "z": self.pen.position_mm()},
            "beltLengths": {"left": left, "right": right},
            "job": self._job_status(),
            "calibration": self._calibration_status(),
            "error": self._error_status(),
            "penLift": self.pen.can_lift,
            "storage": self.store.usage(),
        }

    def _position(self):
        if self.job is not None:
            status = self.job.status()
            return status["x"], status["y"]

        return self._resting_x, self._resting_y

    def _job_status(self):
        if self.job is None:
            return None

        progress = (self.job.line_number / self.job_lines) if self.job_lines else 0.0

        return {
            "file": self.job_file,
            "line": self.job.line_number,
            "totalLines": self.job_lines,
            "progress": min(1.0, progress),
            "startedAt": self.started_at,
            "elapsedSec": int(self._clock() - self.started_at) if self.started_at else 0,
        }

    def _calibration_status(self):
        """Enough to rebuild the calibration UI after a closed tab.

        Which corners are in and what the last fit was worth — the app should
        not have to remember a sequence the machine is already in the middle
        of.
        """
        progress = self.calibration.progress()
        result = self.calibration.result

        return {
            **progress,
            "residualMm": result["residualMm"] if result else None,
            "rotationDeg": result["rotationDeg"] if result else None,
            "scale": result["scale"] if result else None,
        }

    def _error_status(self):
        message = self.job.error if self.job is not None else self.last_error
        if not message:
            return None

        return {"error": "job_failed", "message": message}

    # --- position -----------------------------------------------------------

    def seed(self, reference, motor_spacing_mm, drop_from_motor_line_mm,
             paper_size=None):
        """Establish absolute position from a known physical point (AD-3).

        The only thing that may be done while position is untrusted, because it
        is the thing that makes it trusted. Everything else waits for it.
        """
        if self.job is not None and self.job.state == RUNNING:
            raise ControllerError("job_running", "cannot re-seed while plotting")

        if reference != "center":
            raise ControllerError(
                "bad_reference",
                "only the centreline reference point is supported",
                status=400,
            )

        size = paper_size or {
            "width": self.geometry.paper_width_mm,
            "height": self.geometry.paper_height_mm,
        }

        self.geometry = kin.Geometry(
            motor_spacing_mm,
            motor_spacing_mm / 2 - size["width"] / 2,
            drop_from_motor_line_mm - size["height"] / 2,
            size["width"],
            size["height"],
        )

        # The reference point is the centre of the paper, on the centreline.
        self._resting_x = size["width"] / 2
        self._resting_y = size["height"] / 2

        # Re-homing means the machine's idea of itself has changed, so a
        # transform measured against the old one no longer describes anything.
        self.calibration = Calibration(size["width"], size["height"])

        self.position_trusted = True
        self.last_error = None

        return self.status()

    def jog(self, dx_mm, dy_mm, feed_mm_min=None):
        """A relative move in paper space, for calibration and positioning."""
        if not self.position_trusted:
            raise ControllerError(
                "untrusted_position", "seed the position before moving")

        if self.job is not None and self.job.state == RUNNING:
            raise ControllerError("job_running", "cannot jog while plotting")

        x = self._resting_x + dx_mm
        y = self._resting_y + dy_mm
        machine_x, machine_y = self.geometry.to_machine(x, y)

        if not kin.reachable(self.geometry, machine_x, machine_y):
            raise ControllerError(
                "unreachable",
                "(%.1f, %.1f) is outside what the machine can reach" % (x, y),
                status=400,
            )

        limits = self._limits({"maxSpeed": feed_mm_min or JOB_DEFAULTS["maxSpeed"]})
        moves = ["G90", "G0 X%.4f Y%.4f F%.1f" % (x, y, limits.max_speed_mm_s * 60)]

        jog = Job(self.geometry, limits, self.stepper, moves, self.pen,
                  *self.geometry.to_machine(self._resting_x, self._resting_y))
        jog.start()
        jog.run()

        if jog.state == ERROR:
            raise ControllerError("jog_failed", jog.error)

        self._resting_x = x
        self._resting_y = y

        return self.status()

    # --- calibration --------------------------------------------------------

    def capture_corner(self, index, paper_point):
        """Record where the gondola is standing as a corner of the paper."""
        if not self.position_trusted:
            raise ControllerError(
                "untrusted_position", "seed the position before calibrating")

        machine = self.geometry.to_machine(self._resting_x, self._resting_y)

        return self.calibration.capture(
            index, (paper_point["x"], paper_point["y"]), machine)

    def solve_calibration(self):
        return self.calibration.solve()

    def verify_calibration(self):
        """Drive to the corner nobody visited, so the user can judge the fit."""
        target = self.calibration.verify()
        corner = target["paperPoint"]

        # Moved through the *candidate* transform rather than the locked one,
        # which is the whole question being asked: does this fit put the pen
        # where the paper actually is?
        candidate = self.geometry.with_transform(self.calibration.result["transform"])
        machine = candidate.to_machine(corner["x"], corner["y"])

        if not kin.reachable(candidate, machine[0], machine[1]):
            raise ControllerError(
                "unreachable",
                "the fourth corner lands outside what the machine can reach",
                400,
            )

        self._move_to_machine(candidate, machine)

        return target

    def confirm_calibration(self, accepted):
        result = self.calibration.confirm(accepted)

        if accepted:
            self.geometry = self.geometry.with_transform(self.transform)

        return result

    def _move_to_machine(self, geometry, machine_point):
        """Drive the gondola somewhere, without going through paper space."""
        paper = geometry.to_paper(machine_point[0], machine_point[1])
        limits = self._limits({})

        moves = ["G90", "G0 X%.4f Y%.4f" % (paper[0], paper[1])]
        start = geometry.to_machine(self._resting_x, self._resting_y)

        move = Job(geometry, limits, self.stepper, moves, self.pen, start[0], start[1])
        move.start()
        move.run()

        if move.state == ERROR:
            raise ControllerError("move_failed", move.error)

        self._resting_x, self._resting_y = paper

    # --- jobs ---------------------------------------------------------------

    def _limits(self, settings):
        merged = dict(JOB_DEFAULTS)
        merged.update(settings or {})

        return Limits(
            # The app speaks mm/min, as gcode does; the planner works in mm/s.
            max_speed_mm_s=merged["maxSpeed"] / 60.0,
            acceleration_mm_s2=merged["acceleration"],
            junction_speed_mm_s=merged["jerk"],
        )

    def start(self, name, settings=None):
        if not self.position_trusted:
            raise ControllerError(
                "untrusted_position", "seed the position before plotting")

        if not self.calibrated:
            raise ControllerError("not_calibrated", "calibrate before plotting")

        if self.job is not None and self.job.state in (RUNNING, PAUSED):
            raise ControllerError("job_running", "a job is already loaded")

        if not self.store.exists(name):
            raise ControllerError("not_found", "%s is not on the card" % name, 404)

        settings = dict(settings or {})
        self._apply_geometry(settings)

        # Counted up front so progress has a denominator. One pass over the
        # card, never into memory.
        self.job_lines = self._count_lines(name)

        handle = self.store.open_read(name)
        start = self.geometry.to_machine(self._resting_x, self._resting_y)

        self.job = Job(self.geometry, self._limits(settings), self.stepper,
                       handle, self.pen, start[0], start[1])
        self.job_file = name
        self.started_at = int(self._clock())
        self.last_error = None

        self.job.start()

        return self.status()

    def _apply_geometry(self, settings):
        size = settings.get("paperSize") or {
            "width": self.geometry.paper_width_mm,
            "height": self.geometry.paper_height_mm,
        }
        spacing = settings.get("motorSpacing", self.geometry.motor_spacing_mm)

        self.geometry = kin.Geometry(
            spacing,
            spacing / 2 - size["width"] / 2,
            self.geometry.paper_origin_y_mm,
            size["width"],
            size["height"],
            # Every move in the job goes through the calibration, because
            # to_machine is the one place paper becomes millimetres of belt.
            self.transform,
        )

    def _count_lines(self, name):
        count = 0

        with self.store.open_read(name) as handle:
            for _ in handle:
                count += 1

        return count

    def _require_job(self):
        if self.job is None:
            raise ControllerError("no_job", "no job is loaded", 404)

        return self.job

    def pause(self):
        job = self._require_job()
        job.pause()
        job.step()

        return self.status()

    def resume(self):
        self._require_job().resume()
        return self.status()

    def stop(self):
        """Abandon the job. Steps are lost, so position is no longer trusted."""
        job = self._require_job()
        job.stop("stopped by the app")
        job.close()

        self.last_error = job.error
        self.position_trusted = False
        self.job = None
        self.job_file = None
        self.started_at = None

        return self.status()

    def tick(self, commands=32):
        """Run a slice of the loaded job. Called from the main loop.

        Bounded so the web server and the button still get a look in: the job
        is the point of the machine, but a plotter that cannot be paused while
        it plots is not one anybody wants.
        """
        job = self.job
        if job is None or job.state != RUNNING:
            return False

        job.run(limit=commands)

        if job.state in (DONE, ERROR):
            if job.state == ERROR:
                self.last_error = job.error

            self._resting_x, self._resting_y = self._position()
            self.job = None if job.state == DONE else self.job

        return True
