# Firmware

MicroPython for the Raspberry Pi Pico 2 W. **Not yet implemented** — this lands
in Phase 4. See [`../docs/ROADMAP.md`](../docs/ROADMAP.md).

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
routinely larger than available memory.

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
