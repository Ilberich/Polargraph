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

## Phase 3 — Gcode pipeline — **in progress**

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
- **Pen depth authoring:** per-path and along-path Z, previewed as variable line
  weight.

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

**Done when:** a multi-layer hatched drawing exports with optimized ordering and
an accurate time estimate.

---

## Phase 4 — Firmware core

Built against a host-side simulator first. No hardware required to make progress.

- **CPython simulation harness** (`tools/`): runs planner and kinematics off-target,
  emits step logs, validates resulting geometry against input. This is what
  de-risks AD-4.
- Inverse kinematics: XY → belt lengths → steps
- Motion planner: lookahead, acceleration and jerk limits, per-job config
- **PIO stepper driver** (AD-4): one state machine per axis, segment queue
- `PenAxis` interface + `NullPen` (AD-2)
- Streaming gcode interpreter — one line at a time from SD, never whole-file
- Job state machine: run, pause, resume, stop, error
- Pause/resume button on GPIO
- Error handling and logging per `docs/GCODE.md`

**Done when:** the simulator reproduces input geometry from emitted steps, and
the same code drives real motors.

---

## Phase 5 — REST API and connected mode

- microdot server: upload (**streamed to SD**, never buffered in RAM), start/stop/
  pause/resume, status, jog, config read/write, file list/delete, storage usage
- Static route serving the app bundle from SD `/www` (AD-1)
- `config.json` handling — WiFi credentials only
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
