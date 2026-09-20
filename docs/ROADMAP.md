# Execution Plan

Phased so that something useful exists early and the two highest-risk
components — PIO step generation and calibration — are proven before anything
depends on them.

The guiding constraint: **the design tool must be fully usable with no hardware
at all.** Phases 1–3 deliver that. Hardware work does not block it.

---

## Phase 0 — Foundation — **complete**

Repo layout, specs, deployment. No application code.

- Repo structure: `app/` (web), `firmware/` (MicroPython), `docs/`, `tools/`
- `docs/DECISIONS.md`, `docs/GCODE.md`, `docs/API.md`, `docs/HARDWARE.md`
- GitHub Actions workflow deploying `app/` to Pages
- Test setup: Node's built-in `node:test` against the pure-logic modules. No
  framework, no dependencies, consistent with "keep it lean".

**Done:** the shell is live on Pages and `npm test` runs in CI.

---

## Phase 1 — Geometry and gcode engine — **complete**

Pure JavaScript, no DOM, fully unit tested. Everything hard lives here, where it
can be tested without a browser or a machine.

- Vector/matrix primitives; affine and similarity transforms
- Path model: polylines with **per-vertex Z** (AD-2)
- SVG parsing → path extraction → Bézier flattening to tolerance, nested
  transform resolution, unit and viewBox handling
- Gcode writer, dialect-aware, honouring `penLift`
- Gcode parser for import, preview and the scrubber

**Done:** an SVG round-trips to gcode and back to identical geometry, under
test. 185 tests.

Two notes for later phases:

- **SVG is parsed by our own reader, not `DOMParser`.** Node has no `DOMParser`,
  so using it would mean the importer behaved one way in production and another
  under test. `svg/xml.js` runs identically in both.
- **Flattening tolerance is a paper measurement.** It is carried back through
  the accumulated transform before curves are subdivided, so a shape scaled up
  tenfold is not flattened ten times too coarsely.

---

## Phase 2 — Design tool — **complete**

The standalone app. Useful on its own, on a Chromebook, with no plotter.

- Canvas2D renderer: paper, margin overlay, grid
- Multiple SVGs at native size; per-object translate/rotate/scale with handles
- Snapping: centre, edge, corner, grid
- Gcode import, repositioning, rotation, scaling on canvas
- Dark theme, single accent, monospace type, card layout, responsive, large tap
  targets
- localStorage persistence of job settings
- Export gcode to file

**Done:** load SVGs, arrange, export plottable gcode — no hardware. 272 tests.

Notes for later phases:

- **Geometry is drawn under the canvas transform, not pre-transformed in JS.**
  A drawing can run to tens of thousands of points and is redrawn on every
  frame of a drag.
- **Snap radius is specified in screen pixels** and converted to paper units at
  the current zoom, so snapping feels the same at every magnification.
- **The scene is immutable.** Undo, when it arrives, is a list of past scenes
  rather than a log of inverse operations.

---

## Phase 3 — Gcode pipeline — **complete**

The features that make output good rather than merely correct.

- **Optimizer:** nearest-neighbour path ordering with a 2-opt improvement pass;
  endpoint merging within tolerance into continuous strokes; per-path direction
  choice. Runs in continuous-line mode while `penLift` is false (AD-2).
- **Hatch fill:** polygon flattening, scanline intersection with fill-rule
  handling, configurable angle and spacing, single and cross. Which shapes are
  filled is chosen with a fill tool, one shape at a time — filling everything
  closed is rarely what a drawing wants. Clicking inside a shape is what picks
  it, and the smallest containing shape wins, so the hole of a ring can be
  chosen separately from the ring.
  - A fill is the shape that was clicked plus everything nested inside it —
    what SVG calls a compound path. A silhouette with holes arrives as separate
    outlines, one per subpath, so a fill that took only the shape clicked would
    cover the holes it is meant to leave open. Nesting goes as deep as the
    drawing does: an island inside a hole is filled again.
  - Holes are not offered as shapes to fill, and "Fill all" fills only the
    outermost shapes. A hole can still be filled in its own right by clicking
    inside it, which makes it a separate fill with its own layer.
  - Every fill is its own group. Two fills that overlap draw over each other
    rather than cancelling out — the fill rule is for what is nested inside one
    fill, not for what two separate fills do to each other.
  - A fill carries its own layer rather than its outline's: filling a blue
    outline with red hatching is the ordinary case.
- **Layers:** done. A layer is a pen. Membership is held against stable path
  ids rather than positions, so it survives the optimizer reordering,
  reversing and merging paths. Optimization runs *within* a layer and never
  across one — reordering a stroke into another pen's section would draw it in
  the wrong colour. Each boundary emits `G28` then `M0`, because the swap
  happens wherever the gondola is standing and reaching into a half-finished
  drawing is how it gets smudged.
- **Paint selection:** done. A mode on one object — the Paint tab is the mode —
  that locks dragging on the canvas and gives two tools: a brush that takes the
  segments it is dragged across, and a picker that takes a whole stroke. Each
  stroke lands on the selected layer when the pointer comes up; nothing about
  the gcode needs a separate step to confirm it. Alt, or the Erase toggle,
  sends strokes back to the object's own layer.
  - A partly painted stroke is cut in two so its painted run can carry a
    different pen. The pieces meet end to end, so the drawn geometry is
    unchanged and the optimizer's merge rejoins them if they end up on the
    same pen again.
  - Cut pieces record what they came from, and a fill is worked out from the
    rejoined outline. Painting half the edge of a filled shape therefore
    leaves its hatch exactly as it was — an outline in pieces has no inside.
  - Applying is deferred to the end of a stroke rather than done per
    pointermove: it splits paths and rebuilds the object's path list, which is
    far too much work to do a hundred times a second.
  - Brush granularity is a whole segment. Curves are flattened finely so the
    brush is fine on them; a long straight run is one segment and is taken
    whole.
- **Re-flattening:** done. Curves are flattened at import against a tolerance
  in millimetres on paper, but the size a shape will be plotted at is not known
  then — fitting an object to the margins routinely scales it ten or twenty
  times, and the facets grow with it until a circle plots as a polygon. Each
  path now remembers the curve it came from and is flattened again for the size
  it is drawn at, keeping its id so layer membership and fills survive.
  - Scale is rounded up to a power of two, so a drag re-flattens a handful of
    times rather than every frame, and facets are never worse than twice the
    tolerance asked for.
  - Flattening stops at half a motor step. Below that the machine cannot tell
    one point from the next, so the extra vertices are pure file size.
  - A stroke cut by the paint tool has no curve left to flatten from and keeps
    the flattening it had. Its pieces are polylines, and re-flattening would
    move the vertices the selection was cut at.
- **Scrubber:** done. A Preview card scrubs and plays the job back, drawing
  the plot so far over a ghost of the whole drawing with the gondola marked —
  filled while drawing, hollow with the pen up, amber while waiting for a pen
  swap.
  - It runs on the same timeline the estimate is folded out of, so what the
    head is doing at a given second is what the machine will really be doing
    then: optimized order, travel moves and pauses included. Two passes over
    the same physics could disagree; one cannot.
  - A pause breaks the speed chain, because the machine is standing still while
    a pen is swapped. The estimator used to carry speed straight through one.
  - Playback advances off the frame's own timestamp rather than a fixed
    increment, so a dropped frame costs smoothness, not time.
  - The slider and its readout are nudged directly during playback rather than
    by rebuilding the panel: sixty rebuilds a second would replace the control
    being watched.
- **Time estimate:** trapezoidal velocity model over path length, feed rate and
  acceleration; live update.
- **Pen depth authoring:** done. Z is a continuous axis rather than up-or-down
  (AD-2), so depth is a value to author. It belongs to the layer, because a
  layer is a pen and how hard a pen presses is a property of that pen. The job
  carries a default for anything unassigned, and a travel height beside it.
  - A layer may also give a depth to finish at, and then every stroke on it
    ramps from one to the other along its own length — calligraphic strokes
    without authoring each one. Setting both the same turns the ramp off.
  - The ramp runs by distance along the stroke, not by vertex, so an unevenly
    flattened curve still ramps evenly across the paper.
  - Depth is applied after the optimizer, not before: it reverses and merges
    strokes, and a ramp authored beforehand would run backwards through half
    the drawing and meet itself at every join.
  - The depth controls only appear with a pen axis fitted. Without one there is
    no Z to write.
  - **Not** previewed as variable line weight, though the plan said so: the
    canvas deliberately draws a constant hairline, and making strokes change
    width would be the app guessing at a tip size it is never told. The numbers
    are on the layer; the depth is in the gcode.

- **Panel layout:** objects, layers, paint and fill share one tabbed card. Only
  one of them is ever being worked on, and stacked they pushed everything else
  off the bottom of the panel.
- **Pinch to zoom:** every pointer on the canvas is tracked, not only the one
  that started a gesture, so a second finger can take over as a pinch. Each
  frame is worked out from where the fingers started rather than from the frame
  before, which keeps rounding from creeping in over a long gesture and makes
  the zoom clamp independent of the path taken to reach it. The pinch pans by
  its centre as well, which is the only way to move the view while the paint or
  fill tab holds the single-finger drag.
  - Whatever the first finger had begun is rewound when the pinch takes over:
    the second finger lands a moment after the first, and anything dragged,
    filled or brushed in between was never meant.

**Done:** a multi-layer hatched drawing exports with optimized ordering, an
accurate time estimate, authored pen depth, and a scrubber to watch it back.
451 tests.

---

## Phase 4 — Firmware core — **in progress**

Built against a host-side simulator first. No hardware required to make progress.

- **CPython simulation harness** (`tools/`): done. Runs the firmware's own
  planner and kinematics off-target — the same modules, imported unchanged, not
  a model of them — emits a step log, and reconstructs the toolpath from it.
  - The firmware's motion code is plain Python with no MicroPython-only imports,
    which is what makes that possible. `npm test` runs both halves of the
    project.
  - Measured on a job exported by the app (a circle and a square, optimized):
    path deviation 0.0114 mm, endpoint error 0.0007 mm, peak 1600 steps/s.
    Deviation is under one step (0.0125 mm), and the endpoint error is a
    twentieth of one after 100 000 steps.
  - Deviation is sampled *within* segments, not only at their ends. Sampling
    the ends alone scores coarse segmentation well by measuring it only where
    it is right — chord error is exactly what happens in between.
- **Inverse kinematics:** done. XY ↔ belt lengths ↔ steps, plus the resolution
  at a point: one step is worth a different distance depending on where the
  gondola is, and it collapses entirely near the motor line. That is the
  geometric reason a polargraph cannot draw near the top of its own frame.
- **Motion planner:** done. Segmentation (a straight line on the paper is a
  curve in belt space), absolute step targets, and bounded lookahead.
  - Every segment's target is solved from the true geometry rather than from
    the last rounded value, so rounding is corrected rather than carried.
    Seven thousand segments and 690 000 steps later the gondola is still within
    a twentieth of a step of where it should be.
  - The lookahead window is bounded by *distance*, not by segment count: it
    holds twice the travel needed to stop from full speed, which is what makes
    releasing its front provably safe. A 400-move job never holds more than 20
    segments.
  - A 200 mm move plans to 10.101 s against an ideal trapezoid of 10.100 s.
- **Streaming gcode interpreter:** parser done. One line at a time from an
  iterable, so a job of any size costs one line of memory. Unknown words and
  unsupported commands are refused with a line number rather than ignored — a
  plotter that skips a word it does not understand draws the wrong picture.
- **PIO stepper driver** (AD-4): split in two. The timing arithmetic —
  how many pulses each axis needs, in which direction, how far apart — is
  hardware-independent and tested on the desktop; the state machines live in
  `motion/pio.py`, which only imports on the Pico and is **unverified pending
  Phase 7 bring-up**.
  - One state machine per axis, each counting its own steps at its own
    interval. A segment needing 80 left steps and 10 right over the same 100 ms
    pulses one axis eight times as often as the other, and they finish
    together. That is the reason there is one per axis rather than a shared
    interpolator.
  - A segment asked for faster than the drivers can be pulsed is stretched,
    both axes together, rather than dropped: every step still happens, so the
    geometry survives, and the stretch is counted rather than swallowed.
  - Direction is a plain output, and the state machine is drained before it
    changes. That costs nothing, because a reversal is the one junction the
    planner always plans a full stop for.
- **`PenAxis` + `NullPen`** (AD-2): done. v1 has no pen hardware, so `NullPen`
  accepts depths, reports them in status and moves nothing — not a stub to be
  replaced but the v1 implementation, and what makes v1 files
  forward-compatible with v2 hardware. It says `can_lift = False` rather than
  letting the app believe travel moves miss the paper.
- **Job state machine:** done. run, pause, resume, stop, error, over a stream
  of gcode lines.
  - **Pausing leaves position trustworthy; stopping does not.** A pause takes
    effect at a command boundary, so the queue drains and the gondola stops
    somewhere the planner knew about. A stop abandons what the state machines
    were part way through, which loses steps, and clears `positionTrusted`
    (AD-5).
  - `M0` pauses until something resumes it. A pen swap is not a timed wait.
  - A move outside what the machine can reach is refused before it is
    attempted, rather than driving the gondola into the frame.
  - Status is reported in paper coordinates. The app never has to know where
    this machine's motors are.
- **Pause/resume button on GPIO:** done. One button does both jobs — the
  plotter has no screen to ask which was meant. The debounce is arithmetic and
  tested off-target; only reading the pin needs hardware.
- **Error handling and logging** per `docs/GCODE.md`: done, and the
  distinction that matters is whether anything was lost. A malformed line or an
  unreachable coordinate moves nothing, so the job stops, logs, and may be
  resumed past. A fault or a stop is not resumable.
  - The job holds the *line* iterator rather than a command generator: a
    generator that raises is finished, and an error a user may resume past must
    not take the rest of the file with it.

**Done when:** the simulator reproduces input geometry from emitted steps, and
the same code drives real motors.

---

## Phase 5 — REST API and connected mode — **in progress**

- **REST API:** done, as dispatch rather than as a framework. Method, path and
  body in; a status and a dictionary out, with no web framework anywhere near
  it. Same split as the PIO driver: what the API can get wrong is route
  matching, argument checking and error slugs, and none of that needs a socket.
  - Upload takes an iterable of chunks and writes them straight to the card.
    Nothing on that path ever holds a file, which is what lets a 4 MB plot land
    on a machine with 512 KB of memory.
  - File names are refused rather than sanitised. Quietly rewriting a name the
    client chose means the file uploaded and the file asked for can differ,
    which is worse than saying no.
  - An unknown action is a 404 and a known one with the wrong method is a 405.
    Calibration returns 501 `not_implemented`, because it is in `docs/API.md`
    and a 404 would be misleading about whether it exists.
- **Machine controller:** done. Position trust, calibration and the loaded job
  live here rather than on a job, because AD-5 makes trust a property of the
  machine: it is cleared at boot, before any job exists, and a job that owned
  it would hand it back every time it finished.
  - Seeding is the only thing permitted while position is untrusted, since it
    is the thing that makes it trusted (AD-3).
  - `tick()` runs a bounded slice of the job so the server and the button still
    get a look in. A plotter that cannot be paused while it plots is not one
    anybody wants.
- **microdot binding and the static route** (AD-1): written, **unverified** —
  it needs sockets, SPI and a WiFi stack, like `motion/pio.py`.
- **`config.json` handling:** done — WiFi credentials only, and the password is
  never sent back even to the client that set it. A plotter that remembers a
  paper size is a plotter that will one day draw on the wrong paper without
  being asked.
- **Deploy script** (`tools/deploy.py`): copies the bundle to `/www` on the
  card and makes the gcode directory. 39 files, 252 KB; tests stay behind.
- App side: connection manager, machine control panels, progress tracker,
  graceful fallback to standalone
- Pages build detects HTTPS and directs the user to their plotter's local address

**Done when:** the app served from the Pico uploads a job and runs it, and the
Pages build degrades cleanly.

---

## Phase 6 — Calibration

- Seed routine: park at reference point, confirm, derive belt lengths (AD-3)
- Jog controls with live position
- Three-corner capture → **least-squares similarity fit** with residual reported
  as a quality metric (AD-7)
- Fourth-corner verification; reject restarts from corner 1
- Transform lock-in for the job
- Persistence with `positionTrusted` gating (AD-5)

**Done when:** a calibrated job lands on paper where the preview said it would.

---

## Phase 7 — Bring-up and documentation

- Finalize GPIO pin map: steppers, DRV8825s, SD SPI, pause button, servo header
  reserved for v2
- Wiring guide, DRV8825 current tuning (they stay powered for holding torque —
  current limit matters thermally)
- First-plot walkthrough, tuning guide, troubleshooting

---

## Deferred to v2

- Servo pen axis hardware; swap `NullPen` for the driver, set `penLift: true`
- Anything requiring endstops

---

## Risk register

| Risk | Phase | Mitigation |
|---|---|---|
| PIO step timing insufficient | 4 | Host simulator validates before hardware; earliest possible spike |
| SVG parsing breadth (arcs, nested transforms, units) | 1 | Tolerance-based flattening, tested against real-world files |
| Streaming upload exhausts Pico RAM | 5 | Stream to SD; never buffer a whole file |
| Hatch fill on self-intersecting paths | 3 | Explicit fill-rule handling, tested against pathological shapes |
| Calibration drift across power cycles | 6 | `positionTrusted` flag, firmware-owned (AD-5) |
