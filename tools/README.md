# Tools

Development utilities that do not ship to the plotter. **Not yet implemented** —
these arrive with Phase 4.

## Planned

### Motion simulator

The thing that de-risks
[AD-4](../docs/DECISIONS.md#ad-4--step-generation-uses-rp2350-pio).

Runs the planner and kinematics under desktop CPython, emits a step log, and
reconstructs the resulting toolpath from those steps. Comparing the
reconstruction against the input geometry catches kinematics and rounding errors
without wiring up a single motor — including step-accumulation drift, which is
invisible in a single conversion and obvious over a few thousand segments.

It stays useful after bring-up as a regression harness: a planner change that
distorts geometry fails in CI rather than on paper.

### Deploy script

Copies `app/` to a mounted SD card as `/www`, alongside the gcode directory, for
the plotter-hosted copy of the bundle described in
[AD-1](../docs/DECISIONS.md#ad-1--dual-host-the-static-bundle).
