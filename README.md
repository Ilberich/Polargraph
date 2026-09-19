# Polargraph

A wall plotter driven by a Raspberry Pi Pico2W, with a web app that doubles as a
standalone SVG-to-gcode design tool.

**Status:** Phase 0 complete — shell, specs and build pipeline. The design
tool itself starts in Phase 1.

## What it is

Two pieces:

- **`firmware/`** — MicroPython on a Pico2W. Two NEMA 17 steppers via DRV8825s,
  gcode on an SD card, a REST API over WiFi. Runs jobs autonomously; the browser
  tab can be closed mid-plot.
- **`app/`** — a static web app, no backend, no framework. Loads SVGs, arranges
  them on a paper canvas, generates and optimizes gcode, previews the result.
  Gains machine control when opened from the plotter.

## Layout

```
app/          static web app — no build step, no dependencies
  css/        design tokens and styles
  js/core/    DOM-free logic, unit tested
firmware/     MicroPython for the Pico 2 W (Phase 4)
tools/        motion simulator and SD deploy script (Phase 4)
docs/         specifications and decisions
```

## Development

```sh
npm test      # node's built-in runner; no dependencies to install
```

There is no build step. Serve `app/` with any static file server to run it
locally.

## Deployment

The app deploys to GitHub Pages from `main` via `.github/workflows/pages.yml`,
gated on the test suite. Two settings have to be right, and neither can be set
from a workflow:

1. **Settings → Pages → Source: GitHub Actions.** Until this is set, the deploy
   fails at `configure-pages` with *Get Pages site failed / Not Found*. The
   workflow passes `enablement: true` to try to create the site itself, but the
   default `GITHUB_TOKEN` may not administer the repository and then fails with
   *Resource not accessible by integration*.

2. **`main` must be the repository's default branch.** Enabling Pages creates a
   `github-pages` environment whose deployment branch policy allows the default
   branch only. A deploy from any other branch is rejected before a single step
   runs — the job fails in about two seconds with no steps and no logs, which
   looks like an infrastructure fault but is a policy denial.

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
