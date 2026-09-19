# Gcode Dialect

The contract between the web app's generator and the Pico firmware's
interpreter. Both sides are written against this file.

Deliberately minimal: the firmware parses a line at a time, streaming off SD,
never holding a file in RAM.

## Units and axes

| Axis | Meaning | Units |
|---|---|---|
| `X` | Position across the paper, origin at the calibrated home corner | mm |
| `Y` | Position down the paper | mm |
| `Z` | Pen height. Lower is deeper. See AD-2. | mm |

Feed rate `F` is mm/min, per gcode convention.

All X/Y coordinates pass through the calibration transform before inverse
kinematics. Z does not — it is a machine axis, not a paper-plane coordinate.

## Supported commands

| Code | Meaning |
|---|---|
| `G0 [X] [Y] [Z] [F]` | Rapid move. Travels at the job's max speed cap. |
| `G1 [X] [Y] [Z] [F]` | Controlled move at feed rate `F`. |
| `G28` | Return to the calibrated home corner. **No endstop seek** — there are no endstops. Requires a trusted position. |
| `G90` | Absolute positioning (default at job start). |
| `G91` | Relative positioning. |
| `M0` | Unconditional pause. Gondola returns to the home corner first. Resumed from the app or the physical button. Used for pen swaps at layer breaks. |
| `M2` | End of program. |
| `M30` | End of program. Identical to `M2`. |

Anything else is a parse error and pauses the job (see Error handling).

## Z interpolation

On `G0`/`G1`, Z is linearly interpolated with X and Y across the move. A move
from `Z-1.0` to `Z-2.0` ramps pen depth continuously along the stroke; it does
not step at either end.

Omitting `Z` holds the current Z. A Z-only move (no X/Y change) changes pen
height in place.

On v1 hardware `NullPen` accepts and reports Z without moving anything. Files
are forward-compatible with v2 without regeneration.

## Pen lift semantics

The generator's `penLift` job flag changes what it emits:

- **`penLift: false`** (v1 default, no Z hardware) — the pen marks continuously.
  The optimizer minimizes *visible* travel; `G0` moves are emitted but are
  understood to draw, and the preview renders them as real marks.
- **`penLift: true`** — conventional semantics. `G0` moves are preceded by a Z
  raise to the job's travel height and followed by a lower to the stroke's
  start depth.

## Program structure

```
G90                    ; absolute
G0 X10 Y10 F3000       ; move to first stroke
G1 X50 Y10 Z-1.5 F1200 ; draw, ramping depth
...
M0                     ; layer break — home, swap pen, resume
...
G28                    ; return home
M30                    ; end
```

The firmware does not require a header. A job with no `G90`/`G91` runs absolute.

## Error handling

On any error the firmware pauses the job, logs it, and reports status. There is
no auto-recovery; the user aborts or resumes from the app.

Error classes: SD read failure, malformed gcode, coordinate outside the
calibrated work area, stepper fault, user cancel, untrusted position.

A job will not start at all unless position is trusted and a transform is
locked in (see AD-3, AD-5).

## Closed shapes on import

Gcode has no equivalent of SVG's `Z`, so a shape's closure is not recorded
anywhere in the file — the only evidence is geometry. A stroke whose last move
comes back within 0.1 mm of where it started is read back as closed, and the
repeated point is dropped. That tolerance is far above the writer's rounding
(three decimals by default) and far below any gap a person would have drawn on
purpose.

It matters because the fill tool works on closed shapes. Without this, nothing
imported from gcode could be filled, including gcode this app wrote itself.

Winding direction is a different matter and is **not** preserved: the optimizer
reverses strokes freely to cut travel. Anything depending on the direction a
shape was drawn in — the nonzero fill rule, in practice — should not be trusted
across an export. The even-odd rule, which the fill tool uses by default, does
not care.
