# Polargraph

A wall plotter driven by a Raspberry Pi Pico2W, with a web app that doubles as a
standalone SVG-to-gcode design tool.

**Status:** planning complete, implementation not started.

## What it is

Two pieces:

- **`firmware/`** — MicroPython on a Pico2W. Two NEMA 17 steppers via DRV8825s,
  gcode on an SD card, a REST API over WiFi. Runs jobs autonomously; the browser
  tab can be closed mid-plot.
- **`app/`** — a static web app, no backend, no framework. Loads SVGs, arranges
  them on a paper canvas, generates and optimizes gcode, previews the result.
  Gains machine control when opened from the plotter.

## Where to start

| Document | Contents |
|---|---|
| [`docs/BRIEF.md`](docs/BRIEF.md) | Original project brief |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Architecture decisions and what forced them |
| [`docs/GCODE.md`](docs/GCODE.md) | The gcode dialect — contract between app and firmware |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased execution plan |

## Two ways to run the app

The same bundle is deployed twice ([AD-1](docs/DECISIONS.md#ad-1--dual-host-the-static-bundle)):

- **GitHub Pages** — the design tool. Works anywhere, no plotter needed.
- **From the plotter** — `http://polargraph.local`, served off the SD card. Adds
  machine control, calibration and job monitoring.

An HTTPS page cannot talk to a plaintext device on your LAN, so machine control
lives at the local address. The Pages build will tell you so rather than
offering a connection that could only fail.

## Machine constants

GT2 belt, 20-tooth pulley, 1/16 microstepping:

```
40 mm per revolution ÷ 3200 steps per revolution = 0.0125 mm per step
```

## Pen

v1 has no pen axis — the pen is fixed and every move marks the paper. The
software is nonetheless built around a **continuous, interpolated Z axis**
rather than a binary up/down lift, so v2 is a servo and a class swap rather than
a rewrite. See [AD-2](docs/DECISIONS.md#ad-2--z-is-a-continuous-axis-from-day-one).
