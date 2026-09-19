# Tools

Development utilities that do not ship to the plotter.

## Motion simulator — `simulator.py`, `simulate.py`

The thing that de-risks
[AD-4](../docs/DECISIONS.md#ad-4--step-generation-uses-rp2350-pio).

Runs the planner and kinematics under desktop CPython — the firmware's own
modules, imported unchanged — emits a step log, and reconstructs the resulting
toolpath from those steps. Comparing the reconstruction against the input
geometry catches kinematics and rounding errors without wiring up a single
motor, including step-accumulation drift, which is invisible in a single
conversion and obvious over a few thousand segments.

```
npm run simulate -- job.gcode [motor_spacing_mm]
```

```
segments        1018
steps L/R       53692 / 50063
time            49.1 s
peak step rate  1600 steps/s
path deviation  0.0114 mm
endpoint error  0.0007 mm
```

*Path deviation* is the worst distance from anywhere the pen went to the line
it was asked to draw — sampled **within** segments, not only at their ends,
since chord error is precisely what happens in between. *Endpoint error* is
where drift shows up first.

It stays useful after bring-up as a regression harness: a planner change that
distorts geometry fails in CI rather than on paper.

### Deploy script

Copies `app/` to a mounted SD card as `/www`, alongside the gcode directory, for
the plotter-hosted copy of the bundle described in
[AD-1](../docs/DECISIONS.md#ad-1--dual-host-the-static-bundle).
