# Firmware

MicroPython for the Raspberry Pi Pico 2 W. **Phase 4 in progress.** See
[`../docs/ROADMAP.md`](../docs/ROADMAP.md).

Built so far, all **plain Python** with no MicroPython-only imports, so the
desktop simulator in [`../tools/`](../tools/) runs the same modules the Pico
will — what is being validated is the firmware itself, not a model of it.

```
firmware/motion/kinematics.py   XY <-> belt lengths <-> steps
firmware/motion/planner.py      segmentation, step deltas, bounded lookahead
firmware/motion/stepper.py      segments -> pulse trains; timing arithmetic
firmware/motion/pio.py          the state machines. Pico only, unverified.
firmware/motion/pen.py          PenAxis, and NullPen for v1
firmware/gcode/parser.py        streaming line-at-a-time parser
firmware/job.py                 run, pause, resume, stop, error
firmware/button.py              debounced pause button
```

`pio.py` is the only file that needs hardware, and the only one not covered by
tests. That is deliberate: everything it could get wrong that is not wiring —
pulse counts, directions, intervals — was moved into `stepper.py`, where it can
be checked without a motor.

Run their tests with `npm run test:firmware`, or the whole project with
`npm test`.

## Planned layout

```
firmware/
  main.py            entry point; boots WiFi, SD, server, motion
  config.py          reads config.json from SD (WiFi credentials only)
  motion/
    kinematics.py    XY <-> belt lengths <-> steps
    planner.py       lookahead, acceleration and jerk limits
    stepper.py       PIO step generation, one state machine per axis
    pen.py           PenAxis interface; NullPen for v1, servo for v2
  gcode/
    parser.py        streaming line-at-a-time parser
    interpreter.py   executes parsed commands against the planner
  job.py             job state machine: run, pause, resume, stop, error
  server/
    api.py           microdot REST routes
    static.py        serves the app bundle from SD /www
  calibration.py     seed, corner capture, similarity solve, verification
```

## Design constraints

These are not style preferences — each one is load-bearing.

**Step timing belongs to PIO, not Python.** One state machine per axis generates
pulses; Python computes segments and feeds a queue. HTTP traffic must never be
able to perturb step timing. See
[AD-4](../docs/DECISIONS.md#ad-4--step-generation-uses-rp2350-pio).

**Never hold a file in RAM.** Gcode is parsed a line at a time straight off the
SD card, and uploads are streamed to the card as they arrive. Plot files are
routinely larger than available memory. The planner's lookahead window is
bounded by *distance* rather than by segment count, for the same reason: it
holds enough travel to stop from full speed and no more.

**Position trust is firmware-owned.** The `positionTrusted` flag is cleared on
every boot and on any fault that could lose steps. The app may not assume
position across a power cycle. See
[AD-5](../docs/DECISIONS.md#ad-5--calibration-persistence-requires-a-position-trust-flag).

**Z is accepted from day one.** `NullPen` takes Z values, reports them in status
and moves nothing. v1 files are forward-compatible with v2 hardware. See
[AD-2](../docs/DECISIONS.md#ad-2--z-is-a-continuous-axis-from-day-one).

## Contracts

- Gcode dialect: [`../docs/GCODE.md`](../docs/GCODE.md)
- REST API: [`../docs/API.md`](../docs/API.md)
- Pin map: [`../docs/HARDWARE.md`](../docs/HARDWARE.md)
