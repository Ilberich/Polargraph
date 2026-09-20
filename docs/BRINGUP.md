# Bring-up

Getting from a box of parts to a first plot. Written to be followed in order,
because each step is the one that makes the next one's failure readable.

Nothing here has been run on hardware yet. Every step says what it should look
like, so a step that looks different is a finding rather than a puzzle — and
`docs/HARDWARE.md` has the wiring and the current tuning it assumes.

---

## 0. What is already known to work

Everything that can be checked without a motor has been:

| Piece | How it is known |
|---|---|
| Kinematics, planner, step deltas | Host simulator reproduces input geometry from the emitted steps: 0.0114 mm deviation on a real exported job, 0.0007 mm endpoint error |
| Gcode parsing, job state machine | 182 firmware tests |
| REST API, storage, calibration | Same, plus a browser driving the real firmware over a bridge |
| Step timing arithmetic | `motion/stepper.py`, tested |

Two files are **not** covered, deliberately, because what they do needs the
hardware: [`motion/pio.py`](../firmware/motion/pio.py) and
[`server/app.py`](../firmware/server/app.py). Everything they could get wrong
that is not wiring was moved into the tested files. That is the wager this
phase settles.

---

## 1. Flash MicroPython

Get the **RP2350 / Pico 2 W** build from micropython.org — not the RP2040 one.
Hold BOOTSEL, plug in, copy the `.uf2` to the drive that appears.

Check over serial:

```python
>>> import sys; sys.implementation
(name='micropython', version=(1, 2, 3), _machine='Raspberry Pi Pico 2 W with RP2350')
```

If `_machine` says RP2040, the wrong build is on and nothing below will behave.

---

## 2. Prove the board before adding anything

```python
>>> from machine import Pin
>>> Pin(6, Pin.OUT).value(1)      # EN high: drivers disabled
>>> import rp2                     # PIO is present
```

---

## 3. The card

Wire the SD breakout per the pin map, then:

```python
>>> import hardware
>>> hardware.mount_sd()
'/sd'
>>> import os; os.listdir('/sd')
['www', 'gcode']
```

**If it raises `no SD card`:** the probe runs at 1 MHz on purpose — cards must
be addressed slowly until they answer — so a failure here is wiring, a card
that wants formatting as FAT32, or a breakout without a level shifter on a 3V3
part.

Put the app bundle and a config on it from a computer:

```
python3 tools/deploy.py /media/you/PLOTTER
```

That writes `/www` (39 files, 252 KB) and creates `/gcode`. Add
`/sd/config.json` by hand:

```json
{ "ssid": "your-network", "password": "...", "hostname": "polargraph" }
```

It holds WiFi credentials and nothing else. It is gitignored and has never been
committed.

---

## 4. The network

```python
>>> from config import Config
>>> import hardware
>>> c = Config.load('/sd/config.json')
>>> hardware.connect_wifi(c['ssid'], c['password'], c['hostname'])
'192.168.1.47'
```

Then, from a browser on the same network, `http://polargraph.local`. The app
should load and the Plotter card should say the position is not trusted, which
is correct — nothing has been homed.

**If the address works but the name does not**, mDNS is the suspect, not the
firmware. The hostname is set before the interface is activated, because that
is what gets advertised; some networks still will not resolve `.local` from
every client. The IP works regardless.

---

## 5. One motor, off the machine

Before anything is bolted to a wall. One driver, one motor, clamped to the
bench.

```python
>>> from motion.pio import PioBackend
>>> from motion.stepper import Stepper, plan_pulses
>>> from motion.planner import Segment
>>> b = PioBackend(2, 3, 4, 5, 6)
>>> b.enable(True)
>>> s = Segment(3200, 0, 40.0, 20.0, 0.0); s.seconds = 2.0
>>> b.run(plan_pulses(s))
```

That is one full revolution of the left motor over two seconds: 3200 microsteps
at 1600 steps/s, which is about the peak a real job asks for.

**What to look for**

- One revolution, not most of one. Short means steps are being dropped: check
  `Vref`, then the pulse width on a scope — the state machine holds `STEP` high
  for 3 µs against the DRV8825's 1.9 µs minimum, so there is margin, but only if
  the clock divider is right.
- Smooth, not lumpy. Lumpy at a constant commanded rate points at the PIO delay
  arithmetic in `pio.py`, which is the one piece of timing not covered by tests.
- Reverse it with `Segment(-3200, 0, ...)` and confirm it turns the other way
  and returns to the same mark.

Repeat for the right motor on the other state machine, then both at once.

---

## 6. Homing and jogging

Belts on, gondola hung, nothing drawing yet — tape a pen up clear of the paper
or leave the holder empty.

Open the app from the plotter, set the motor spacing to what you measured
between the shafts, park the gondola at the centre of the sheet and **Set
home**. Then jog.

**What to look for**

- Left jogs left. If it goes right, swap `DIR_L`'s meaning by reversing the
  motor's coil pair rather than editing the firmware — the pin map is the
  contract.
- 50 mm commanded is 50 mm measured. A consistent error is the motor spacing
  being wrong, not the kinematics; calibration in the next step will measure it
  out, but a large one is worth fixing first.

---

## 7. Calibration

Pen down, paper up. Drive to three corners and record each, then solve.

**Read the residual.** Under 1 mm is good. Over 2 mm the app says the corners
disagree, and it is right to: one of the three is out and there is no way to
tell which, so record them again. The fourth-corner check is the honest test —
the fit was never shown that corner.

---

## 8. First plot

Something small and forgiving. A 50 mm circle in the middle of the sheet will
show more than a complicated drawing will:

- **Not closing** → steps lost. Current, or speed.
- **An oval** → motor spacing wrong, or the belts are not at the same height.
- **Flat spots or facets** → segmentation. The planner cuts at 1 mm; the app
  re-flattens curves for the size they are drawn at.
- **A closed circle in the wrong place** → calibration, not motion. Re-run it.

---

## Troubleshooting

**The plot shears progressively rather than jumping.** Lost steps. Position on a
polargraph comes from belt lengths, so a dropped step is not a visible jolt — it
is a permanent error in where the machine thinks it is, and everything after it
leans. Raise `Vref` a little, or lower the speed.

**`nFAULT` trips partway through a long plot.** Thermal. The drivers hold
current continuously to hold the gondola up, so this is the expected failure of
too high a current limit. Heatsinks, airflow, lower `Vref`.

**The job pauses and will not resume.** Look at status: `M0` is a pen change and
waits for a person, by design. An error carries its own message — a malformed
line can be resumed past, a fault cannot.

**Position is not trusted after a stop.** Correct and deliberate (AD-5). A stop
abandons whatever the state machines were mid-way through, which loses steps, so
the machine no longer knows where it is. Re-home.

**The Pages copy of the app will not connect.** It cannot, and it says so. An
HTTPS page is forbidden from contacting a plain-HTTP device on your network;
open the app from the plotter instead (AD-1).

**The estimate says two hours and the plot takes three.** Check whether the
firmware reported limited segments — if the drivers cannot be pulsed as fast as
a segment asked for, the segment is stretched rather than dropped, so the
geometry survives and the clock slips.

---

## When this phase is done

- A circle closes.
- Two plots of the same file land on top of each other.
- A plot survives a pause, a pen change and a resume.
- `nFAULT` never trips during a full-sheet drawing.
