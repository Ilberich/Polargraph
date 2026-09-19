/**
 * The SVG `d` attribute.
 *
 * Two stages: a scanner that turns the string into commands with numeric
 * parameters, and a walker that plays those commands out into polylines.
 * Splitting them means the scanner's awkward cases can be tested without
 * reasoning about geometry, and vice versa.
 *
 * The scanner is hand written rather than a regex split because path data
 * omits separators wherever it legally can. `10-5` is two numbers, `1.5.5` is
 * two numbers, and — the case that quietly breaks naive parsers — arc flags are
 * single digits that run together with what follows, so `a1 1 0 011 1` ends in
 * flags 0 and 1 then the number 1, not the number 11.
 */

import { flattenCubic, flattenQuadratic, DEFAULT_TOLERANCE } from '../geom/bezier.js';

/** Parameters consumed by each command, per repetition. */
const ARITY = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

/**
 * How close two points must be to count as the same one when closing a
 * subpath. Well below the machine's 0.0125 mm step, so it can never merge
 * points the plotter could have drawn apart.
 */
const CLOSE_EPSILON = 1e-9;

const isDigit = (ch) => ch >= '0' && ch <= '9';
const isCommand = (ch) => /[MmLlHhVvCcSsQqTtAaZz]/.test(ch);

class Scanner {
  constructor(source) {
    this.src = source;
    this.i = 0;
  }

  skipSeparators() {
    while (this.i < this.src.length && /[\s,]/.test(this.src[this.i])) this.i++;
  }

  atEnd() {
    this.skipSeparators();
    return this.i >= this.src.length;
  }

  /** Read a number, or null if what follows is not one. */
  readNumber() {
    this.skipSeparators();

    const start = this.i;
    const src = this.src;

    if (src[this.i] === '+' || src[this.i] === '-') this.i++;
    while (this.i < src.length && isDigit(src[this.i])) this.i++;

    if (src[this.i] === '.') {
      this.i++;
      while (this.i < src.length && isDigit(src[this.i])) this.i++;
    }

    if (src[this.i] === 'e' || src[this.i] === 'E') {
      const mark = this.i;
      this.i++;
      if (src[this.i] === '+' || src[this.i] === '-') this.i++;

      if (isDigit(src[this.i])) {
        while (this.i < src.length && isDigit(src[this.i])) this.i++;
      } else {
        this.i = mark; // not an exponent after all
      }
    }

    if (this.i === start) return null;

    const value = Number(src.slice(start, this.i));
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Read an arc flag: exactly one character, `0` or `1`.
   *
   * Reading it as a number would swallow the digits that follow it.
   */
  readFlag() {
    this.skipSeparators();

    const ch = this.src[this.i];
    if (ch === '0' || ch === '1') {
      this.i++;
      return ch === '1' ? 1 : 0;
    }

    return null;
  }
}

/**
 * Scan path data into `{command, params}` records.
 *
 * Commands repeat implicitly when more parameters follow, and a repeated `M`
 * means `L` — a quirk that silently turns a polygon into a series of jumps if
 * missed.
 *
 * Stops at the first thing it cannot read rather than throwing, so a truncated
 * or malformed tail costs the rest of that path and nothing else.
 */
export function tokenizePathData(d) {
  const scanner = new Scanner(String(d ?? ''));
  const out = [];
  let command = null;

  while (!scanner.atEnd()) {
    const ch = scanner.src[scanner.i];

    if (isCommand(ch)) {
      command = ch;
      scanner.i++;
    } else if (command === null) {
      break; // parameters before any command
    } else if (command === 'M') {
      command = 'L';
    } else if (command === 'm') {
      command = 'l';
    }

    const upper = command.toUpperCase();
    const arity = ARITY[upper];

    if (arity === 0) {
      out.push({ command, params: [] });
      continue;
    }

    const params = [];
    let ok = true;

    for (let k = 0; k < arity; k++) {
      // Arc parameters 4 and 5 are the large-arc and sweep flags.
      const value =
        upper === 'A' && (k === 3 || k === 4)
          ? scanner.readFlag()
          : scanner.readNumber();

      if (value === null) {
        ok = false;
        break;
      }
      params.push(value);
    }

    if (!ok) break;
    out.push({ command, params });
  }

  return out;
}

/** Angle between two vectors, signed. */
function angleBetween(ux, uy, vx, vy) {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  const dot = ux * vx + uy * vy;
  const mag = Math.hypot(ux, uy) * Math.hypot(vx, vy);

  // Clamp: rounding can push the ratio a hair outside acos's domain.
  return sign * Math.acos(Math.max(-1, Math.min(1, dot / mag)));
}

/**
 * Convert an elliptical arc to cubic Béziers.
 *
 * Implements the endpoint-to-centre conversion from the SVG specification's
 * implementation notes. The arc is then split into sweeps of at most 90°,
 * because a single cubic approximates a quarter turn well and a half turn
 * visibly badly.
 */
function arcToCubics(x1, y1, rx, ry, rotationDeg, largeArc, sweep, x2, y2) {
  // Zero radii degenerate to a straight line, per the spec.
  if (rx === 0 || ry === 0) return [];

  rx = Math.abs(rx);
  ry = Math.abs(ry);

  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Radii too small to span the endpoints are scaled up until they fit.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rxSq = rx * rx;
  const rySq = ry * ry;
  const numerator = rxSq * rySq - rxSq * y1p * y1p - rySq * x1p * x1p;
  const denominator = rxSq * y1p * y1p + rySq * x1p * x1p;

  const coefficient =
    (largeArc !== sweep ? 1 : -1) *
    Math.sqrt(Math.max(0, numerator / denominator));

  const cxp = (coefficient * rx * y1p) / ry;
  const cyp = (-coefficient * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const startAngle = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let sweepAngle = angleBetween(
    (x1p - cxp) / rx, (y1p - cyp) / ry,
    (-x1p - cxp) / rx, (-y1p - cyp) / ry
  );

  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  const count = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const delta = sweepAngle / count;
  // Control-point offset that makes a cubic match a circular arc of `delta`.
  const alpha = (4 / 3) * Math.tan(delta / 4);

  const onEllipse = (angle) => ({
    x: cx + rx * Math.cos(angle) * cosPhi - ry * Math.sin(angle) * sinPhi,
    y: cy + rx * Math.cos(angle) * sinPhi + ry * Math.sin(angle) * cosPhi,
  });

  const tangent = (angle) => ({
    x: -rx * Math.sin(angle) * cosPhi - ry * Math.cos(angle) * sinPhi,
    y: -rx * Math.sin(angle) * sinPhi + ry * Math.cos(angle) * cosPhi,
  });

  const cubics = [];

  for (let k = 0; k < count; k++) {
    const a1 = startAngle + k * delta;
    const a2 = a1 + delta;

    const p0 = onEllipse(a1);
    const p3 = onEllipse(a2);
    const t1 = tangent(a1);
    const t2 = tangent(a2);

    cubics.push({
      p1: { x: p0.x + alpha * t1.x, y: p0.y + alpha * t1.y },
      p2: { x: p3.x - alpha * t2.x, y: p3.y - alpha * t2.y },
      p3,
    });
  }

  return cubics;
}

/**
 * Play path data out into polylines.
 *
 * Returns one entry per subpath, each `{points, closed}`. Curves are flattened
 * to `tolerance` in the same units as the path data.
 */
export function pathDataToPolylines(d, tolerance = DEFAULT_TOLERANCE) {
  const commands = tokenizePathData(d);
  const subpaths = [];

  let points = [];
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };

  // Reflected control point for the smooth variants, S and T.
  let lastCubicControl = null;
  let lastQuadControl = null;

  const flush = (closed) => {
    // A closed subpath whose geometry already lands on its start point would
    // otherwise store that point twice — every circle does this, because its
    // final arc returns to the start before `Z` closes it. The closing segment
    // is implied by `closed`, so the duplicate is dropped.
    if (closed && points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];

      if (Math.hypot(last.x - first.x, last.y - first.y) < CLOSE_EPSILON) {
        points.pop();
      }
    }

    if (points.length > 1) subpaths.push({ points, closed });
    points = [];
  };

  for (const { command, params } of commands) {
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const ox = relative ? current.x : 0;
    const oy = relative ? current.y : 0;

    switch (upper) {
      case 'M': {
        flush(false);
        current = { x: params[0] + ox, y: params[1] + oy };
        subpathStart = { ...current };
        points = [{ ...current }];
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'L': {
        current = { x: params[0] + ox, y: params[1] + oy };
        points.push({ ...current });
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'H': {
        current = { x: params[0] + ox, y: current.y };
        points.push({ ...current });
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'V': {
        current = { x: current.x, y: params[0] + oy };
        points.push({ ...current });
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'C':
      case 'S': {
        let c1;
        let c2;
        let end;

        if (upper === 'C') {
          c1 = { x: params[0] + ox, y: params[1] + oy };
          c2 = { x: params[2] + ox, y: params[3] + oy };
          end = { x: params[4] + ox, y: params[5] + oy };
        } else {
          // S reflects the previous cubic's second control point. With no
          // preceding cubic the reflection is the current point itself.
          c1 = lastCubicControl
            ? { x: 2 * current.x - lastCubicControl.x, y: 2 * current.y - lastCubicControl.y }
            : { ...current };
          c2 = { x: params[0] + ox, y: params[1] + oy };
          end = { x: params[2] + ox, y: params[3] + oy };
        }

        points.push(...flattenCubic(current, c1, c2, end, tolerance));
        current = end;
        lastCubicControl = c2;
        lastQuadControl = null;
        break;
      }

      case 'Q':
      case 'T': {
        let control;
        let end;

        if (upper === 'Q') {
          control = { x: params[0] + ox, y: params[1] + oy };
          end = { x: params[2] + ox, y: params[3] + oy };
        } else {
          control = lastQuadControl
            ? { x: 2 * current.x - lastQuadControl.x, y: 2 * current.y - lastQuadControl.y }
            : { ...current };
          end = { x: params[0] + ox, y: params[1] + oy };
        }

        points.push(...flattenQuadratic(current, control, end, tolerance));
        current = end;
        lastQuadControl = control;
        lastCubicControl = null;
        break;
      }

      case 'A': {
        const end = { x: params[5] + ox, y: params[6] + oy };
        const cubics = arcToCubics(
          current.x, current.y,
          params[0], params[1], params[2],
          params[3], params[4],
          end.x, end.y
        );

        if (cubics.length === 0) {
          points.push({ ...end }); // degenerate radii: a straight line
        } else {
          let from = current;
          for (const { p1, p2, p3 } of cubics) {
            points.push(...flattenCubic(from, p1, p2, p3, tolerance));
            from = p3;
          }
        }

        current = end;
        lastCubicControl = lastQuadControl = null;
        break;
      }

      case 'Z': {
        flush(true);
        current = { ...subpathStart };
        // A command after Z continues from the subpath start.
        points = [{ ...current }];
        lastCubicControl = lastQuadControl = null;
        break;
      }
    }
  }

  flush(false);
  return subpaths;
}
