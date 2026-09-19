# Architecture Decisions

Decisions taken before implementation, with the reasoning that forced them.
Recorded 2026-09-19, against `docs/BRIEF.md`.

---

## AD-1 — Dual-host the static bundle

**Problem.** The brief specifies a GitHub Pages app that talks to the Pico over
local WiFi. This cannot work. GitHub Pages serves `*.github.io` over HTTPS and
enforces it, and no browser permits an HTTPS page to `fetch()` a plaintext
`http://192.168.x.x/...` endpoint — it is blocked as active mixed content, with
no user override. Every request in connected mode would fail.

**Decision.** One codebase, two deploy targets.

- **GitHub Pages** hosts the standalone design tool. Always available, nothing
  to install, works on the Chromebook.
- **The Pico** serves the identical bundle from `/www` on the SD card via a
  microdot static route. The user opens `http://polargraph.local` when they want
  machine control. Page and API are then same-origin plain HTTP: no mixed
  content, and no CORS.

**Consequences.**
- The app uses relative URLs only. API base is same-origin when served from the
  Pico; there is no cross-origin case to configure.
- The GitHub Pages build detects `location.protocol === 'https:'` and, instead of
  offering a connection form that could only fail, points the user at their
  plotter's local address.
- This bends the brief's "no UI served from Pico". The cost is one static-file
  route and some SD space. The architecture is otherwise unchanged: the Pico
  still serves no *generated* UI, just bytes off the card.
- Deploying the app to a plotter is a file copy to the SD card, so it also works
  over the existing card-reader path.

---

## AD-2 — Z is a continuous axis from day one

**Problem.** The brief has no pen lift in v1 and defers it to v2. But the target
is not a binary up/down lift — it is **variable pen height, interpolated**.
Retrofitting that onto a pipeline built for a binary lift means rewriting the
path model, the gcode dialect, the planner and the preview.

**Decision.** Build the whole stack Z-aware now; stub the hardware.

- `Z` is a real word on `G0`/`G1`, linearly interpolated with X and Y across the
  move. A single stroke can ramp pen depth along its length.
- Canonical unit is **mm of pen height**, standard gcode semantics, so files
  remain meaningful to outside tooling. The app exposes it as **pen depth
  0–100%** mapped to a per-job Z range.
- Firmware defines a `PenAxis` interface. v1 ships `NullPen`: accepts Z, reports
  it in status, moves nothing. v2 ships a servo driver. A class swap and a pin,
  not a redesign.
- The path model carries Z per vertex throughout, from SVG import to gcode
  emission.

**Consequences.**
- A per-job **`penLift` flag**, default `false`. While false the optimizer runs
  in continuous-line mode and the preview draws travel moves as real marks,
  because on v1 hardware they are. Setting it true restores conventional
  travel/draw semantics.
- The preview renders Z as variable line weight, giving a true picture of a
  variable-height plot.
- Gcode emitted for v1 still carries Z. It is forward-compatible with the v2
  machine without regeneration.

---

## AD-3 — Manual seed establishes absolute position

**Problem.** Polargraph kinematics are absolute: gondola position is derived from
belt lengths. The brief says the firmware boots with no assumed position, then
begins calibration by jogging to corners. Jogging is relative, so it can move —
but it cannot convert "the user says this is corner 1" into a machine coordinate
without knowing where it started.

**Decision.** Before calibration, the user parks the gondola at a defined
physical reference point and confirms in the app. The firmware computes initial
belt lengths from motor spacing and that known point, and only then accepts jog
commands as position-tracking moves.

**Consequences.**
- Reference point is a per-machine setting (default: on the centreline, a
  configured distance below the motor line).
- Position validity is firmware-owned state, not something the app may assume.
  See AD-5.

---

## AD-4 — Step generation uses RP2350 PIO

**Problem.** MicroPython cannot bit-bang step pulses at the required rate with
usable timing. 30 mm/s is 2400 steps/s per axis at 0.0125 mm/step, with hard
timing requirements. A Python loop is both too slow and too jittery, and jitter
on a polargraph is directly visible in the line.

**Decision.** One PIO state machine per axis generates step pulses. Python
computes motion segments and feeds a queue; the state machine handles pulse
timing. HTTP serving cannot perturb step timing.

**Consequences.**
- This is the single highest-risk component. It is built and validated early
  (Phase 4), not treated as a late optimization.
- Motion planning is validated in a host-side CPython simulator against expected
  geometry before any hardware is involved.

---

## AD-5 — Calibration persistence requires a position-trust flag

**Problem.** The brief persists calibration in browser localStorage so it can be
reused across sessions. But the transform is only meaningful relative to the
firmware's tracked position, which lives in RAM. Power-cycle the Pico and the
stored calibration is silently wrong while the browser still believes it.

**Decision.** The firmware owns a `positionTrusted` flag, cleared on every boot
and on any fault that could lose steps. The app must read it before offering to
reuse a stored calibration, and must fall back to the seed routine when it is
false. Last known position and transform are also written to SD so a clean
shutdown can be distinguished from a power loss.

---

## AD-6 — Gcode dialect corrections

Three gaps in the brief's subset, resolved in `docs/GCODE.md`:

- **`M0` was missing.** The app inserts it at every layer break for pen swaps,
  but it was absent from the firmware's supported list. It is now specified.
- **`G28` was undefined.** There are no endstops, so a sensorless seek is
  meaningless. `G28` is defined as "return to the calibrated home corner".
- **`Z` added** to `G0`/`G1` per AD-2.

---

## AD-7 — Calibration solves a similarity transform, not a free affine

**Problem.** Three points determine a full 6-DOF affine transform, including
shear and non-uniform scale. Paper is rigid and its dimensions are known, so
those extra degrees of freedom do not describe anything physical — they only
absorb the user's aim error, producing a transform that fits the three clicks
perfectly and the paper badly.

**Decision.** Fit a 4-DOF similarity transform (translation, rotation, uniform
scale) by least squares. Three corners over-determine it, and the residual
becomes a calibration quality metric surfaced in the app.

**Consequences.** Bad calibration is caught at solve time with a number, before
the user walks to the machine for the fourth-corner check.
