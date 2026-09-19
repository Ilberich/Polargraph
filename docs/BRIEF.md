# Polargraph Plotter — Project Brief

## Overview
A polargraph (wall plotter) driven by a Raspberry Pi Pico2W. Controlled via a unified web app hosted on GitHub Pages — works standalone as a design tool, and gains machine control features when connected to the Pico over local WiFi.

---

## Hardware — Code-Relevant Specs
- **Microcontroller:** Raspberry Pi Pico2W
- **Motors:** 2x NEMA 17 stepper motors via DRV8825 drivers — 1/16 microstepping, 3200 steps/rev
- **Drive:** GT2 belt, 20 tooth pulley — 40mm circumference per revolution, 0.0125mm per step
- **Storage:** SD card via SPI
- **Pen lift:** None in v1 — fixed pen, no Z axis

---

## Software Architecture

## Pico Firmware (MicroPython)

### Storage
- Gcode files uploaded via app and written to SD card (SPI-connected)
- Pico executes jobs directly from SD card
- SD card accepts files directly via card reader as alternative

### Configuration
- `config.json` on SD card — WiFi credentials only
- All other settings passed per job from the web app

### Calibration
- User-triggered before each plot via connected app
- Corner calibration routine:
  1. Jog gondola to 3 corners of paper, confirm each
  2. Firmware calculates paper position, rotation and scale from 3 points
  3. Gondola moves to calculated 4th corner as confirmation
  4. User confirms or rejects — rejection restarts from corner 1
  5. Transform matrix locked in for the job
- All gcode coordinates passed through transform matrix before execution

### Motion
- 2-axis: left stepper, right stepper only (v1)
- At boot: no movement, no assumed position — waits for calibration
- Steppers remain powered after moves — maintain holding torque
- Polargraph inverse kinematics (XY → left/right belt lengths → steps)
- Transform matrix applied to all coordinates from calibration
- Acceleration and jerk configurable per job
- On job complete: gondola returns to user-defined home corner (left or right)

### Gcode Subset
- `G0` rapid move, `G1` controlled move
- `G28` home, `G90` absolute, `G91` relative
- `M2` / `M30` end of program
- Feed rates (`F`) respected — max speed cap configurable per job

### Physical Controls
- Single pause/resume toggle button — GPIO input
- Press to pause (after current move completes), press to resume

### Error Handling
- On any error: pause job, log error, report status to app
- User decides to abort or resume — no auto-recovery
- Error types: SD card read error, malformed gcode, user cancel, stepper fault

### REST API (for GitHub Pages app)
- Upload gcode file
- Start / stop / pause / resume job
- Get job status — current line, progress, XY position
- Jog controls for calibration
- Read / write config.json
- List / delete files on SD
- SD storage usage

### Connectivity
- Pico2W hosts a lightweight REST API over WiFi — no UI served from Pico
- GitHub Pages app connects to Pico via local IP or mDNS address entered in settings
- When connected: machine control panels become available
- When not connected: app works as standalone design tool
- Recommended Pico library: `microdot` (lightweight MicroPython HTTP server)

---

## Unified Web App (GitHub Pages)

### Overview
- Single app hosted on GitHub Pages — pure HTML/CSS/JS, no backend
- Works on any browser including Chromebook
- Two modes depending on Pico connection:
  - **Standalone** — design, arrange SVGs, generate gcode, export to file
  - **Connected** — all standalone features plus direct upload to Pico, machine control, calibration, job monitoring

### Connection
- Settings panel to enter Pico IP or mDNS address
- App detects connection and unlocks machine control panels
- Graceful fallback to standalone mode if connection lost

### Design Tool
- Paper canvas — user enters dimensions, canvas scales accordingly
- Visual margin overlay — what you see is what gets plotted
- Multiple SVGs loaded simultaneously, each at native size
- Per-SVG transform controls — translate, rotate, scale
- Snapping — center, edge, corner, grid options
- Gcode file upload — import externally generated gcode for preview and sending
- Gcode preview — traces G0 and G1 moves on paper canvas, travel moves (G0) shown as dotted line, draw moves (G1) as solid line
- Gcode translation tools — imported gcode can be repositioned, rotated and scaled on the canvas before export
- Gcode scrubber — playback head scrubs through gcode timeline, renders each move on canvas in real time
- Layer system — add layer breaks at any point in the scrubber timeline, assign a pen/color to each layer
  - All paths per layer plotted together before pause
  - Pen swap pause command (`M0`) inserted at each layer break automatically
  - Gondola returns to home corner on pause for pen swap
- Layer ordering — paths auto-sorted by layer to minimize pen swaps
- Hatch fill — pick shapes to fill with a fill tool, define spacing and angle, single and crosshatch
- Gcode optimization — applied before export or send:
  - Path ordering — nearest neighbor sorting to minimize travel moves
  - Line merging — connect paths sharing endpoints into continuous strokes
  - Direction optimization — traverse each path in whichever direction minimizes travel from current position
- Time estimate — based on path length, feed rate and acceleration, updates live
- Per-job settings persist in browser localStorage — last used settings reload on next session
- Calibration data persists — if paper placement is consistent, skip calibration and use last known position. Manual override always available.
- Export gcode to file (standalone) or upload directly to Pico (connected)

### Machine Control (Connected Only)
- Upload gcode file to Pico
- Job controls — Start, Stop, Pause, Resume
- Progress tracker — percentage complete, current line, estimated time remaining, live XY position
- Per-job settings — motor spacing, paper size, margins, scale, acceleration, max speed, home corner
- Calibration — jog controls, corner confirmation, fourth corner verification
- Settings — WiFi credentials editor, Pico connection address

### UI Design
- Dark mode — deep charcoal background, not pure black
- Single accent color for interactive elements (muted teal, amber, or steel blue TBD)
- Clean monospace or semi-monospace typography
- Card-based layout, clear hierarchy, large tap targets
- Mobile-friendly / responsive
- No heavy frameworks — keep it lean

---

## Execution Flow
1. Open app (GitHub Pages) in browser
2. Load SVG(s) or import gcode — arrange on canvas, set margins, add hatch fills if needed
3. Scrub through gcode preview, add layer breaks and assign pens if multi-color
4. Optimize and export gcode — or send directly to Pico if connected
5. Set per-job parameters — motor spacing, paper size, speed, acceleration, home corner
6. Run corner calibration if needed — or use persisted calibration from last session
7. Hit Start — Pico executes job from SD card independently
8. Monitor progress in app — Chromebook tab can be closed, reopen to check status
9. On pen swap pause — gondola returns to home corner, swap pen, resume from app or physical button
10. On completion — gondola returns to home corner

---

## TODO — Remaining

### Firmware / Pico UI
- [ ] Pin assignments — finalize GPIO mapping for NEMA 17s, DRV8825s, SD card SPI, pause button
- [ ] Pen lift — design and firmware for v2

### Design Tool
- [ ] SVG to gcode conversion — path flattening, ordering optimization
- [ ] Hatch fill algorithm — single and crosshatch
- [ ] Time estimation algorithm
- [ ] GitHub Pages deployment
