import math
import os
import shutil
import tempfile
import unittest

from config import Config
from controller import Controller
from motion.pen import NullPen
from motion.stepper import Stepper, RecordingBackend
from server.api import Api
from calibration import corners_of
from motion.kinematics import apply_transform


def _skewed_truth():
    """A sheet taped up turned and shifted, in machine coordinates."""
    angle = math.radians(1.5)
    cos, sin = math.cos(angle), math.sin(angle)

    return [cos, -sin, 345.0 + 20.0, sin, cos, 251.5 + 6.0]
from store import Store


PLOT = "G21\nG90\nG0 X20 Y20 F3000\nG1 X80 Y20 F1200\nG1 X80 Y80\nM30\n"


class ApiCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()

        store = Store(self.directory,
                      usage=lambda: {"usedBytes": 1024, "totalBytes": 16 * 1024 ** 3})
        config = Config(os.path.join(self.directory, "config.json"))

        self.controller = Controller(
            store, config, Stepper(RecordingBackend(), NullPen()), NullPen(),
            clock=lambda: 1758240000,
        )
        self.api = Api(self.controller)
        self.truth = _skewed_truth()

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    # --- helpers ---

    def upload(self, name="plot.gcode", text=PLOT):
        return self.api.handle("POST", "/api/files/" + name,
                               stream=[text.encode()])

    def seed(self, width=210, height=297):
        return self.api.handle(
            "POST", "/api/position/seed",
            body={"motorSpacing": 900, "dropFromMotorLine": 400,
                  "paperSize": {"width": width, "height": height}},
        )

    def calibrate(self, width=210, height=297, skew=False):
        """Drive the real capture-solve-verify-confirm sequence.

        With `skew`, the captures are told the sheet is where a taped-up sheet
        really would be: turned a degree and a half and shifted.
        """
        for index, (x, y) in enumerate(corners_of(width, height)[:3]):
            at = self.api.handle("GET", "/api/status").body["position"]
            self.api.handle("POST", "/api/jog",
                            body={"dx": x - at["x"], "dy": y - at["y"]})

            if skew:
                # Pretend the user drove to where the real sheet's corner is.
                machine = apply_transform(self.truth, x, y)
                self.controller.calibration.capture(index, (x, y), machine)
            else:
                self.api.handle("POST", "/api/calibration/corner",
                                body={"index": index, "paperPoint": {"x": x, "y": y}})

        self.api.handle("POST", "/api/calibration/solve")
        self.api.handle("POST", "/api/calibration/verify")

        return self.api.handle("POST", "/api/calibration/confirm",
                               body={"accepted": True})

    def calibrate_capture_only(self, width=210, height=297):
        for index, (x, y) in enumerate(corners_of(width, height)[:3]):
            at = self.api.handle("GET", "/api/status").body["position"]
            self.api.handle("POST", "/api/jog",
                            body={"dx": x - at["x"], "dy": y - at["y"]})
            self.api.handle("POST", "/api/calibration/corner",
                            body={"index": index, "paperPoint": {"x": x, "y": y}})

    def ready(self):
        """A seeded, calibrated machine with a file on the card."""
        self.upload()
        self.seed()
        self.calibrate()


class Status(ApiCase):
    def test_status_carries_everything_the_app_needs(self):
        # docs/API.md: enough to rebuild the UI from scratch after a closed tab.
        body = self.api.handle("GET", "/api/status").body

        for key in ("state", "positionTrusted", "calibrated", "position",
                    "beltLengths", "job", "error", "penLift", "storage"):
            self.assertIn(key, body)

    def test_a_machine_boots_untrusted(self):
        # AD-5. Cleared on every boot, and this is every boot.
        body = self.api.handle("GET", "/api/status").body

        self.assertFalse(body["positionTrusted"])
        self.assertFalse(body["calibrated"])
        self.assertIsNone(body["job"])

    def test_v1_reports_that_it_cannot_lift_the_pen(self):
        self.assertFalse(self.api.handle("GET", "/api/status").body["penLift"])

    def test_the_wrong_method_is_refused_with_the_allowed_ones(self):
        response = self.api.handle("DELETE", "/api/status")

        self.assertEqual(response.status, 405)
        self.assertEqual(response.body["error"], "method_not_allowed")


class Files(ApiCase):
    def test_an_upload_returns_what_landed(self):
        response = self.upload()

        self.assertEqual(response.status, 201)
        self.assertEqual(response.body, {"name": "plot.gcode", "bytes": len(PLOT)})

    def test_an_upload_arrives_in_chunks_and_is_never_assembled(self):
        chunks = [PLOT[i:i + 7].encode() for i in range(0, len(PLOT), 7)]
        response = self.api.handle("POST", "/api/files/split.gcode", stream=chunks)

        self.assertEqual(response.body["bytes"], len(PLOT))
        self.assertGreater(len(chunks), 3, "genuinely several chunks")

    def test_listing_shows_what_is_on_the_card(self):
        self.upload("a.gcode")
        self.upload("b.gcode")

        names = [f["name"] for f in self.api.handle("GET", "/api/files").body["files"]]
        self.assertEqual(names, ["a.gcode", "b.gcode"])

    def test_a_dangerous_name_is_refused(self):
        response = self.api.handle("POST", "/api/files/..", stream=[b"x"])

        self.assertEqual(response.status, 400)
        self.assertEqual(response.body["error"], "bad_name")

    def test_a_path_rather_than_a_name_is_not_an_endpoint(self):
        # The separator never reaches the name check, because a file lives in
        # one place and a request that says otherwise is addressing nothing.
        response = self.api.handle("POST", "/api/files/../boot.py", stream=[b"x"])

        self.assertEqual(response.status, 404)

    def test_deleting_returns_no_content(self):
        self.upload()
        self.assertEqual(self.api.handle("DELETE", "/api/files/plot.gcode").status, 204)

    def test_deleting_something_that_is_not_there_is_a_404(self):
        response = self.api.handle("DELETE", "/api/files/ghost.gcode")

        self.assertEqual(response.status, 404)
        self.assertEqual(response.body["error"], "not_found")

    def test_the_active_job_cannot_be_deleted_from_under_itself(self):
        self.ready()
        self.api.handle("POST", "/api/job/start", body={"file": "plot.gcode"})

        response = self.api.handle("DELETE", "/api/files/plot.gcode")
        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"], "job_running")


class Seeding(ApiCase):
    def test_seeding_is_what_makes_position_trusted(self):
        # AD-3: the one thing that may be done while position is untrusted,
        # because it is the thing that makes it trusted.
        response = self.api.handle(
            "POST", "/api/position/seed",
            body={"motorSpacing": 900, "dropFromMotorLine": 400,
                  "paperSize": {"width": 210, "height": 297}},
        )

        self.assertEqual(response.status, 200)
        self.assertTrue(response.body["positionTrusted"])
        self.assertAlmostEqual(response.body["position"]["x"], 105)
        self.assertAlmostEqual(response.body["position"]["y"], 148.5)

    def test_a_seed_without_the_geometry_is_refused(self):
        response = self.api.handle("POST", "/api/position/seed", body={})

        self.assertEqual(response.status, 400)
        self.assertEqual(response.body["error"], "bad_body")

    def test_an_unknown_reference_point_is_refused_rather_than_guessed(self):
        response = self.api.handle(
            "POST", "/api/position/seed",
            body={"reference": "top-left", "motorSpacing": 900,
                  "dropFromMotorLine": 400},
        )

        self.assertEqual(response.status, 400)
        self.assertEqual(response.body["error"], "bad_reference")


class Jogging(ApiCase):
    def test_jogging_needs_a_trusted_position(self):
        response = self.api.handle("POST", "/api/jog", body={"dx": -5, "dy": 0})

        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"], "untrusted_position")

    def test_a_jog_moves_in_paper_space(self):
        self.ready()
        before = self.api.handle("GET", "/api/status").body["position"]

        response = self.api.handle("POST", "/api/jog", body={"dx": -5, "dy": 10})
        after = response.body["position"]

        self.assertAlmostEqual(after["x"], before["x"] - 5, delta=0.02)
        self.assertAlmostEqual(after["y"], before["y"] + 10, delta=0.02)

    def test_a_jog_off_the_machine_is_refused(self):
        self.ready()
        response = self.api.handle("POST", "/api/jog", body={"dx": 5000, "dy": 0})

        self.assertEqual(response.status, 400)
        self.assertEqual(response.body["error"], "unreachable")

    def test_a_jog_that_is_not_numbers_is_refused(self):
        self.ready()
        response = self.api.handle("POST", "/api/jog", body={"dx": "left"})

        self.assertEqual(response.status, 400)


class Jobs(ApiCase):
    def test_a_job_will_not_start_untrusted(self):
        self.upload()
        response = self.api.handle("POST", "/api/job/start", body={"file": "plot.gcode"})

        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"], "untrusted_position")

    def test_a_job_will_not_start_uncalibrated(self):
        self.upload()
        self.seed()

        response = self.api.handle("POST", "/api/job/start", body={"file": "plot.gcode"})
        self.assertEqual(response.body["error"], "not_calibrated")

    def test_starting_a_file_that_is_not_there_is_a_404(self):
        self.ready()
        response = self.api.handle("POST", "/api/job/start", body={"file": "ghost.gcode"})

        self.assertEqual(response.status, 404)

    def test_a_started_job_reports_progress_against_the_whole_file(self):
        self.ready()
        response = self.api.handle("POST", "/api/job/start", body={"file": "plot.gcode"})

        job = response.body["job"]
        self.assertEqual(job["file"], "plot.gcode")
        self.assertEqual(job["totalLines"], 6)
        self.assertEqual(job["startedAt"], 1758240000)

    def test_a_job_runs_to_the_end_and_the_machine_goes_idle(self):
        self.ready()
        self.api.handle("POST", "/api/job/start", body={"file": "plot.gcode"})

        while self.controller.tick():
            pass

        body = self.api.handle("GET", "/api/status").body
        self.assertEqual(body["state"], "idle")
        self.assertAlmostEqual(body["position"]["x"], 80, delta=0.02)

    def test_pausing_and_resuming(self):
        self.ready()
        self.api.handle("POST", "/api/job/start", body={"file": "plot.gcode"})
        self.controller.tick(commands=1)

        self.assertEqual(self.api.handle("POST", "/api/job/pause").body["state"], "paused")
        self.assertEqual(self.api.handle("POST", "/api/job/resume").body["state"], "running")

    def test_stopping_gives_up_position_trust(self):
        # A stop abandons what the state machines were part way through, which
        # loses steps. AD-5.
        self.ready()
        self.api.handle("POST", "/api/job/start", body={"file": "plot.gcode"})

        body = self.api.handle("POST", "/api/job/stop").body
        self.assertFalse(body["positionTrusted"])
        self.assertIsNone(body["job"])

    def test_job_control_without_a_job_is_a_404(self):
        self.assertEqual(self.api.handle("POST", "/api/job/pause").status, 404)

    def test_a_start_with_no_file_named_is_refused(self):
        self.ready()
        response = self.api.handle("POST", "/api/job/start", body={})

        self.assertEqual(response.status, 400)
        self.assertEqual(response.body["error"], "bad_body")

    def test_per_job_settings_are_taken_at_start(self):
        self.ready()
        self.api.handle("POST", "/api/job/start", body={
            "file": "plot.gcode",
            "settings": {"paperSize": {"width": 297, "height": 420}, "maxSpeed": 600},
        })

        self.assertEqual(self.controller.geometry.paper_width_mm, 297)


class Configuration(ApiCase):
    def test_the_password_is_never_sent_back(self):
        self.api.handle("PUT", "/api/config", body={"ssid": "home", "password": "hunter2"})
        body = self.api.handle("GET", "/api/config").body

        self.assertEqual(body["ssid"], "home")
        self.assertNotIn("password", body)

    def test_an_update_is_a_merge(self):
        self.api.handle("PUT", "/api/config", body={"ssid": "home"})
        self.api.handle("PUT", "/api/config", body={"hostname": "plotter"})

        body = self.api.handle("GET", "/api/config").body
        self.assertEqual(body["ssid"], "home")
        self.assertEqual(body["hostname"], "plotter")

    def test_a_body_that_is_not_an_object_is_refused(self):
        self.assertEqual(self.api.handle("PUT", "/api/config", body=[1]).status, 400)


class Routing(ApiCase):
    def test_an_unknown_endpoint_is_a_404(self):
        for path in ("/api/nope", "/api/", "/nothing", "/api/job/fly",
                     "/api/position/elsewhere"):
            self.assertEqual(self.api.handle("GET", path).status, 404, path)

    def test_a_real_action_with_the_wrong_method_says_which_is_allowed(self):
        self.assertEqual(self.api.handle("GET", "/api/job/pause").status, 405)

    def test_an_unknown_calibration_step_is_a_404(self):
        self.assertEqual(self.api.handle("POST", "/api/calibration/guess").status, 404)

    def test_every_failure_carries_a_slug_and_a_message(self):
        for response in (self.api.handle("GET", "/api/nope"),
                         self.api.handle("DELETE", "/api/status"),
                         self.api.handle("POST", "/api/jog", body={"dx": 1})):
            self.assertIn("error", response.body)
            self.assertIn("message", response.body)


if __name__ == "__main__":
    unittest.main()


class Calibrating(ApiCase):
    """docs/API.md: a short state machine the app drives one step at a time."""

    def test_calibrating_needs_a_position_to_calibrate_from(self):
        response = self.api.handle("POST", "/api/calibration/corner",
                                   body={"index": 0, "paperPoint": {"x": 0, "y": 0}})

        self.assertEqual(response.status, 409)
        self.assertEqual(response.body["error"], "untrusted_position")

    def test_capturing_reports_how_far_along_it_is(self):
        self.seed()
        body = self.api.handle("POST", "/api/calibration/corner",
                               body={"index": 0, "paperPoint": {"x": 0, "y": 0}}).body

        self.assertEqual(body, {"state": "capturing", "captured": [0], "needed": 3})

    def test_the_machine_says_it_is_calibrating(self):
        self.seed()
        self.api.handle("POST", "/api/calibration/corner",
                        body={"index": 0, "paperPoint": {"x": 0, "y": 0}})

        self.assertEqual(self.api.handle("GET", "/api/status").body["state"], "calibrating")

    def test_solving_reports_the_quality_of_the_fit(self):
        # AD-7: a bad calibration is caught with a number, before anybody walks
        # to the machine for the fourth-corner check.
        self.seed()
        self.calibrate_capture_only()

        body = self.api.handle("POST", "/api/calibration/solve").body

        for key in ("transform", "residualMm", "rotationDeg", "scale"):
            self.assertIn(key, body)

        self.assertLess(body["residualMm"], 0.5)

    def test_verifying_drives_to_the_unvisited_corner(self):
        self.seed()
        self.calibrate_capture_only()
        self.api.handle("POST", "/api/calibration/solve")

        response = self.api.handle("POST", "/api/calibration/verify")

        self.assertEqual(response.status, 202, "on its way; go and look")
        self.assertEqual(response.body["paperPoint"], {"x": 0.0, "y": 297.0})

        at = self.api.handle("GET", "/api/status").body["position"]
        self.assertAlmostEqual(at["x"], 0.0, delta=0.05)
        self.assertAlmostEqual(at["y"], 297.0, delta=0.05)

    def test_rejecting_starts_again_from_the_first_corner(self):
        self.seed()
        self.calibrate_capture_only()
        self.api.handle("POST", "/api/calibration/solve")
        self.api.handle("POST", "/api/calibration/verify")

        body = self.api.handle("POST", "/api/calibration/confirm",
                               body={"accepted": False}).body

        self.assertIsNone(body["transform"])
        self.assertFalse(self.api.handle("GET", "/api/status").body["calibrated"])
        self.assertEqual(self.controller.calibration.progress()["captured"], [])

    def test_accepting_locks_it_in_for_the_jobs_that_follow(self):
        self.seed()
        self.calibrate()

        self.assertTrue(self.api.handle("GET", "/api/status").body["calibrated"])

    def test_re_homing_throws_a_calibration_away(self):
        # The machine's idea of itself has changed, so a transform measured
        # against the old one no longer describes anything.
        self.seed()
        self.calibrate()
        self.assertTrue(self.controller.calibrated)

        self.seed()
        self.assertFalse(self.controller.calibrated)

    def test_a_calibrated_job_lands_where_the_paper_is(self):
        # Phase 6's exit criterion. The sheet is taped up 1.5 degrees out and
        # 20mm over; after calibration a move to a paper coordinate puts the
        # gondola where that coordinate really is.
        self.upload("square.gcode", "G90\nG0 X0 Y0 F3000\nG1 X210 Y0 F1200\nM30\n")
        self.seed()
        self.calibrate(skew=True)

        self.api.handle("POST", "/api/job/start", body={"file": "square.gcode"})
        while self.controller.tick():
            pass

        # In paper space the job finished at the sheet's top-right corner...
        at = self.api.handle("GET", "/api/status").body["position"]
        self.assertAlmostEqual(at["x"], 210, delta=0.1)
        self.assertAlmostEqual(at["y"], 0, delta=0.1)

        # ...and in machine space, where the skewed sheet's corner actually is.
        wanted = apply_transform(self.truth, 210.0, 0.0)
        got = self.controller.geometry.to_machine(at["x"], at["y"])

        self.assertAlmostEqual(got[0], wanted[0], delta=0.1)
        self.assertAlmostEqual(got[1], wanted[1], delta=0.1)
