# Hardware

## Bill of materials

| Part | Spec |
|---|---|
| Microcontroller | Raspberry Pi Pico 2 W (RP2350) |
| Motors | 2 × NEMA 17 stepper |
| Drivers | 2 × DRV8825, 1/16 microstepping |
| Belt | GT2, 2 mm pitch |
| Pulleys | 20 tooth |
| Storage | microSD via SPI |
| Input | 1 × momentary pushbutton (pause/resume) |
| Pen axis | None in v1. Servo header reserved — see [AD-2](DECISIONS.md#ad-2--z-is-a-continuous-axis-from-day-one). |

## Derived constants

```
GT2 2 mm pitch × 20 teeth   = 40 mm travel per revolution
1/16 microstepping          = 3200 steps per revolution
40 ÷ 3200                   = 0.0125 mm per step
```

These live in code at `app/js/core/machine.js` and are asserted under test.

---

## Pin map

**Status: final in firmware, unverified on hardware.** The numbers live in
[`firmware/hardware.py`](../firmware/hardware.py) and this table describes them.
The code is the source of truth — a wiring document that has drifted from the
firmware is a bring-up session spent chasing a fault that was never in the
hardware.

| Function | GPIO | Notes |
|---|---|---|
| `STEP_L` | GP2 | PIO-driven |
| `STEP_R` | GP3 | PIO-driven, adjacent to `STEP_L` on purpose |
| `DIR_L` | GP4 | Plain output |
| `DIR_R` | GP5 | Plain output |
| `EN` | GP6 | Shared driver enable, **active low** |
| `FAULT_L` | GP7 | DRV8825 `nFAULT`, input with pull-up |
| `FAULT_R` | GP8 | DRV8825 `nFAULT`, input with pull-up |
| `PAUSE_BTN` | GP15 | Input, internal pull-up, switch to GND |
| `SD_MISO` | GP16 | SPI0 RX |
| `SD_CS` | GP17 | SPI0 CSn |
| `SD_SCK` | GP18 | SPI0 SCK |
| `SD_MOSI` | GP19 | SPI0 TX |
| `PEN_SERVO` | GP14 | **Reserved for v2.** Unused by `NullPen`. |

### Why these

**`STEP_L` and `STEP_R` are adjacent** so the two state machines sit in the same
PIO block with consecutive `set` bases. Nothing forces it, but it keeps the
initialisation symmetric and leaves the second PIO block free for v2.

**`DIR` is a plain output, not PIO data.** Direction only ever changes with the
axis stopped — a reversal is the one junction the planner always plans a full
stop for — so the state machine is drained and the pin is set between trains.
Encoding direction in the FIFO would mean a mid-train change could step a motor
the wrong way. See [`firmware/motion/pio.py`](../firmware/motion/pio.py).

**`EN` is shared and active low**, so an un-driven pin coasts both motors rather
than energising them. That is the safe direction for a wire that falls off.

**Both `nFAULT` lines are watched.** A DRV8825 that overheats or detects an
overcurrent pulls its line low and holds it there until reset. The firmware
stops the job, clears `positionTrusted`, and logs it once — see
[`firmware/supervisor.py`](../firmware/supervisor.py).

Avoid GP23, GP24, GP25 and GP29 — they are committed to internal functions on
the Pico W form factor (SMPS mode, VBUS sense, and the wireless module).

### Why `STEP_L` and `STEP_R` are adjacent

The plan is one PIO state machine per axis, which needs no adjacency at all —
each machine drives a single pin. But putting the two step pins next to each
other keeps a second design open: a single state machine driving both axes via a
2-bit `set`, with Bresenham stepping in the PIO program itself. That would
guarantee the two axes never drift apart in time.

Costs nothing now, and forecloses nothing later. If Phase 4 shows per-axis
machines are fine, the adjacency is simply unused.

---

## Driver notes

**Logic levels.** The DRV8825 reads a logic high at 2.2 V, so the Pico's 3.3 V
outputs drive it directly. No level shifting.

**Step pulse width.** The DRV8825 requires a minimum step pulse of roughly
1.9 µs high and low. This is a hard constraint on the PIO program's timing —
verify against the datasheet during bring-up before tuning for speed.

**Current limit.** The steppers stay energised between moves to hold the gondola
against gravity, so the drivers idle at full holding current rather than
dropping out. Set `Vref` conservatively and check driver temperature during the
first long plot. This is a thermal question, not a code one, but it will look
like a motion bug if the drivers go into thermal shutdown mid-job.

**Enable is active low.** `EN` high disables the drivers and the gondola falls.
The firmware drives it low on init and never releases it during a job.

---

## Wiring

To be documented at bring-up (Phase 7), once the pin map above is confirmed
against real hardware.


---

## Driver current

The DRV8825s stay energised while a job runs — a polargraph holds the gondola
up with motor torque, so cutting current mid-plot drops the pen. That makes the
current limit a thermal setting as much as a torque one: whatever you set is
dissipated continuously, not in bursts.

Set it with the onboard trimmer, measuring `Vref` between the pot and a ground
pin:

```
Vref = current_limit_amps / 2
```

So 1.0 A per coil is `Vref = 0.5 V`. Start at **0.5 A** (`Vref = 0.25 V`), which
is more than enough to hold and move a gondola, and only raise it if the motors
stall or lose steps under load. Symptoms of too much:

- Drivers too hot to touch after a few minutes — they will thermally shut down
  mid-plot and pull `nFAULT`, which the firmware reports.
- Motors hot enough to soften a printed mount.

Symptoms of too little: skipped steps, which on a polargraph show as the drawing
progressively shearing rather than as a visible jump, because position is
derived from belt lengths that are now wrong.

Heatsinks on the driver chips are worth the fifty pence. Airflow is worth more.

---

## Before power

- [ ] `EN` pulled high (disabled) at reset — check with a meter before the
      drivers are in their sockets.
- [ ] Driver orientation matches the silkscreen. Backwards is instantly fatal
      to a DRV8825.
- [ ] `Vref` set with the motors **disconnected**.
- [ ] Motor coil pairs identified with a continuity test. A DRV8825 driving
      one winding from two half-bridges will not move and may not survive.
- [ ] Belts routed so neither can reach a pulley flange at full extension.
- [ ] Gondola hangs freely at the reference point without fouling.
