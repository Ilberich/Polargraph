# REST API

The contract between the web app and the Pico firmware. Implemented in Phase 5;
specified now so both sides are written against the same document.

Served by microdot over plain HTTP on the local network. The app bundle is
served from the same origin (see [AD-1](DECISIONS.md#ad-1--dual-host-the-static-bundle)),
so there is no CORS configuration and no cross-origin case to support.

Base path: `/api`. All request and response bodies are JSON unless noted.

---

## Conventions

Errors return a non-2xx status and:

```json
{ "error": "untrusted_position", "message": "Position lost at boot; seed required." }
```

`error` is a stable machine-readable slug; `message` is for humans and may change.

Coordinates are millimetres, in paper space, unless a field says otherwise.

---

## Machine state

### `GET /api/status`

The endpoint the app polls. Everything needed to rebuild the UI from scratch
after a closed tab.

```json
{
  "state": "idle",
  "positionTrusted": true,
  "calibrated": true,
  "position": { "x": 120.5, "y": 88.0, "z": 0.0 },
  "beltLengths": { "left": 412.88, "right": 508.19 },
  "job": {
    "file": "mandala.gcode",
    "line": 1840,
    "totalLines": 9021,
    "progress": 0.204,
    "startedAt": 1758240000,
    "elapsedSec": 512
  },
  "calibration": {
    "state": "capturing",
    "captured": [0, 1],
    "needed": 3,
    "residualMm": null,
    "rotationDeg": null,
    "scale": null
  },
  "error": null,
  "penLift": false,
  "storage": { "usedBytes": 2411724, "totalBytes": 15931539456 }
}
```

`state` is one of `idle`, `running`, `paused`, `error`, `calibrating`.

`calibration.state` is one of `idle`, `capturing`, `solved`, `verifying`,
`locked`. The fit figures are `null` until a solve has happened. This is here
so the app can rebuild the calibration UI after a closed tab rather than
having to remember a sequence the machine is already part way through.

`job` is `null` when no job is loaded. `error` carries the last error object when
`state` is `error`, otherwise `null`.

`positionTrusted` is firmware-owned and cleared on every boot
([AD-5](DECISIONS.md#ad-5--calibration-persistence-requires-a-position-trust-flag)).
The app must not offer to reuse a stored calibration while it is `false`.

---

## Files

### `GET /api/files`

```json
{ "files": [ { "name": "mandala.gcode", "bytes": 241172, "modified": 1758240000 } ] }
```

### `POST /api/files/:name`

Raw gcode as the request body, **streamed to SD as it arrives**. The firmware
never buffers a whole file — see the risk register in
[`ROADMAP.md`](ROADMAP.md#risk-register).

Returns `201` with `{ "name": "...", "bytes": 241172 }`.

### `DELETE /api/files/:name`

Returns `204`. Fails with `409 job_running` if the file is the active job.

---

## Job control

### `POST /api/job/start`

```json
{ "file": "mandala.gcode", "settings": { "...": "see below" } }
```

Rejected with `409` unless `positionTrusted` and `calibrated` are both true.

Per-job settings, passed at start and held for the job's duration:

| Field | Meaning |
|---|---|
| `motorSpacing` | Distance between motor shafts, mm |
| `paperSize` | `{ width, height }`, mm |
| `margins` | `{ top, right, bottom, left }`, mm |
| `maxSpeed` | Speed cap, mm/min |
| `acceleration` | mm/s² |
| `jerk` | mm/s |
| `homeCorner` | `"left"` or `"right"` |
| `penLift` | Whether a pen axis is installed ([AD-2](DECISIONS.md#ad-2--z-is-a-continuous-axis-from-day-one)) |
| `zRange` | `{ up, down }` in mm, maps the app's 0–100% pen depth |

### `POST /api/job/pause` · `POST /api/job/resume` · `POST /api/job/stop`

No body. `pause` takes effect after the current move completes, matching the
physical button. `stop` abandons the job and returns the gondola to the home
corner.

---

## Motion

### `POST /api/jog`

```json
{ "dx": -5.0, "dy": 0, "feed": 1500 }
```

Relative move in paper space. Requires `positionTrusted`. Used by calibration
and manual positioning.

### `POST /api/position/seed`

Establishes absolute position from a known physical reference point
([AD-3](DECISIONS.md#ad-3--manual-seed-establishes-absolute-position)).

```json
{ "reference": "center", "motorSpacing": 900.0, "dropFromMotorLine": 400.0 }
```

Sets belt lengths from the geometry and sets `positionTrusted` to `true`. This
is the only endpoint that may be called while position is untrusted.

---

## Calibration

A short state machine; the app drives it one step at a time.

### `POST /api/calibration/corner`

```json
{ "index": 0, "paperPoint": { "x": 0, "y": 0 } }
```

Records the current machine position as the given paper corner. Called three
times with `index` 0, 1, 2.

### `POST /api/calibration/solve`

No body. Fits a similarity transform by least squares over the three captured
corners ([AD-7](DECISIONS.md#ad-7--calibration-solves-a-similarity-transform-not-a-free-affine)).

```json
{
  "transform": [ 0.9998, -0.0181, 12.4, 0.0181, 0.9998, 8.9 ],
  "residualMm": 0.42,
  "rotationDeg": 1.04,
  "scale": 1.0002
}
```

`residualMm` is the calibration quality metric. The app surfaces it and should
warn above a configurable threshold before the user walks to the machine.

### `POST /api/calibration/verify`

No body. Moves the gondola to the computed fourth corner and returns `202` with
the corner it went to. The app then asks the user to accept or reject.

The move goes through the *candidate* transform, not a locked one — that is the
question being asked: does this fit put the pen where the paper actually is?

### `POST /api/calibration/confirm`

```json
{ "accepted": true }
```

`true` locks the transform in for subsequent jobs. `false` discards it and
restarts capture from corner 0 — if the fourth corner is wrong then one of the
three is wrong, and there is no way to know which, so keeping them would carry
the mistake forward.

Re-seeding also discards a locked transform: the machine's idea of itself has
changed, so a transform measured against the old one describes nothing.

---

## Configuration

### `GET /api/config` · `PUT /api/config`

`config.json` on the SD card. **WiFi credentials only** — every other setting is
passed per job.

```json
{ "ssid": "...", "password": "...", "hostname": "polargraph" }
```

`GET` omits `password`. `PUT` accepts a partial object and merges.
