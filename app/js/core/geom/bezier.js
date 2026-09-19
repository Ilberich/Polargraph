/**
 * Curve flattening.
 *
 * Every curve in an SVG becomes a polyline before it reaches gcode, because the
 * machine only moves in straight lines. How finely a curve is subdivided is a
 * direct trade: too coarse and circles look like polygons, too fine and the
 * planner drowns in segments the plotter cannot distinguish.
 *
 * Subdivision is adaptive rather than fixed-step. A fixed number of segments
 * per curve wastes points on gentle arcs and starves tight ones; splitting only
 * where the curve is still visibly bent spends points where they show.
 */

import { lerp } from './vec2.js';

/** Default flatness tolerance, in the same units as the input geometry. */
export const DEFAULT_TOLERANCE = 0.05;

/** Guards against pathological curves (cusps, coincident controls). */
const MAX_DEPTH = 24;

/**
 * Is this cubic close enough to its chord to stop subdividing?
 *
 * Measures how far the control points stray from the line joining the
 * endpoints, which bounds the true deviation of the curve without evaluating
 * it. Comparing squared distances avoids a square root per test.
 */
function cubicIsFlat(p0, p1, p2, p3, tolerance) {
  const ux = 3 * p1.x - 2 * p0.x - p3.x;
  const uy = 3 * p1.y - 2 * p0.y - p3.y;
  const vx = 3 * p2.x - p0.x - 2 * p3.x;
  const vy = 3 * p2.y - p0.y - 2 * p3.y;

  const deviation = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy);
  return deviation <= 16 * tolerance * tolerance;
}

/** de Casteljau split at the midpoint, returning both halves. */
function splitCubic(p0, p1, p2, p3) {
  const p01 = lerp(p0, p1, 0.5);
  const p12 = lerp(p1, p2, 0.5);
  const p23 = lerp(p2, p3, 0.5);
  const p012 = lerp(p01, p12, 0.5);
  const p123 = lerp(p12, p23, 0.5);
  const mid = lerp(p012, p123, 0.5);

  return {
    left: [p0, p01, p012, mid],
    right: [mid, p123, p23, p3],
  };
}

function subdivide(p0, p1, p2, p3, tolerance, depth, out) {
  if (depth >= MAX_DEPTH || cubicIsFlat(p0, p1, p2, p3, tolerance)) {
    out.push(p3);
    return;
  }

  const { left, right } = splitCubic(p0, p1, p2, p3);
  subdivide(left[0], left[1], left[2], left[3], tolerance, depth + 1, out);
  subdivide(right[0], right[1], right[2], right[3], tolerance, depth + 1, out);
}

/**
 * Flatten a cubic Bézier to a list of points.
 *
 * The start point is not included — callers are appending to a path that
 * already ends there, and emitting it again would create a zero-length segment.
 */
export function flattenCubic(p0, p1, p2, p3, tolerance = DEFAULT_TOLERANCE) {
  const out = [];
  subdivide(p0, p1, p2, p3, tolerance, 0, out);
  return out;
}

/**
 * Flatten a quadratic Bézier.
 *
 * Raised to an equivalent cubic rather than given its own subdivision routine:
 * the conversion is exact, so there is no accuracy cost, and one flattening
 * path means one place for a bug to live.
 */
export function flattenQuadratic(p0, p1, p2, tolerance = DEFAULT_TOLERANCE) {
  const c1 = {
    x: p0.x + (2 / 3) * (p1.x - p0.x),
    y: p0.y + (2 / 3) * (p1.y - p0.y),
  };
  const c2 = {
    x: p2.x + (2 / 3) * (p1.x - p2.x),
    y: p2.y + (2 / 3) * (p1.y - p2.y),
  };

  return flattenCubic(p0, c1, c2, p2, tolerance);
}

/** Point on a cubic at parameter `t`. Used by tests to check flattening error. */
export function cubicAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;

  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}
