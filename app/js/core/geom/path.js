/**
 * The path model.
 *
 * A path is a polyline: an ordered list of points, optionally closed. Curves
 * are already flattened by the time they get here, so everything downstream —
 * optimizer, hatch fill, gcode writer, preview — deals with straight segments
 * only and never needs to know what produced them.
 *
 * Points carry Z as well as X and Y, per AD-2. Pen height is per-vertex from
 * the very start, so a stroke can ramp depth along its length rather than being
 * stuck at one value. A path whose points all share a Z is the ordinary case,
 * not a special one.
 */

import { distance } from './vec2.js';
import { apply } from './matrix.js';

let nextPathId = 1;

/** Reset path id allocation. Tests only. */
export function resetPathIds() {
  nextPathId = 1;
}

/**
 * Build a path.
 *
 * Z defaults to 0 so callers that do not care about pen height — an SVG
 * importer, say — can pass plain `{x, y}` points and get valid paths.
 *
 * Every path carries a stable id. Layer membership is held against that id
 * rather than against a position in an array, so assigning a stroke to a pen
 * survives reordering, optimization, and anything else that shuffles paths
 * around. An explicit id can be passed to keep identity through a transform.
 */
export function createPath(points, { closed = false, meta = {}, id = null } = {}) {
  return {
    id: id ?? `s${nextPathId++}`,
    points: points.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
    closed,
    meta,
  };
}

export function isEmpty(path) {
  return path.points.length === 0;
}

/** A path with fewer than two points draws nothing. */
export function isDegenerate(path) {
  return path.points.length < 2;
}

export function startPoint(path) {
  return path.points[0];
}

export function endPoint(path) {
  // A closed path finishes where it started, whether or not the closing point
  // is stored explicitly.
  return path.closed ? path.points[0] : path.points[path.points.length - 1];
}

/**
 * Total drawn length in XY.
 *
 * Z is excluded deliberately. This measures distance across the paper, which is
 * what feed rates and time estimates are about; pen height changes do not move
 * the gondola.
 */
export function pathLength(path) {
  let total = 0;

  for (let i = 1; i < path.points.length; i++) {
    total += distance(path.points[i - 1], path.points[i]);
  }

  if (path.closed && path.points.length > 1) {
    total += distance(path.points[path.points.length - 1], path.points[0]);
  }

  return total;
}

/** Apply an affine transform. Z passes through: the matrix is planar. */
/**
 * Area enclosed by a path, treating it as closed.
 *
 * The shoelace formula, unsigned — direction is not interesting here, only
 * size, which is what tells a shape apart from the shape inside it.
 */
export function polygonArea(path) {
  const points = path.points;
  let twice = 0;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }

  return Math.abs(twice) / 2;
}

export function transformPath(path, matrix) {
  return {
    ...path,
    points: path.points.map((p) => {
      const { x, y } = apply(matrix, p);
      return { x, y, z: p.z };
    }),
  };
}

/**
 * Reverse a path's direction.
 *
 * The optimizer uses this to enter a stroke from whichever end is closer to the
 * pen. Per-vertex Z reverses with the points, so a depth ramp still runs along
 * the same physical stroke, just travelled the other way.
 */
export function reversePath(path) {
  return { ...path, points: [...path.points].reverse() };
}

/** Axis-aligned XY bounds, or null for an empty path. */
export function pathBounds(path) {
  if (isEmpty(path)) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of path.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Bounds enclosing several paths, or null when none has any points. */
export function boundsOf(paths) {
  const all = paths.map(pathBounds).filter(Boolean);
  if (all.length === 0) return null;

  const minX = Math.min(...all.map((b) => b.minX));
  const minY = Math.min(...all.map((b) => b.minY));
  const maxX = Math.max(...all.map((b) => b.maxX));
  const maxY = Math.max(...all.map((b) => b.maxY));

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Set a uniform pen depth across a path. */
export function withZ(path, z) {
  return { ...path, points: path.points.map((p) => ({ ...p, z })) };
}

/**
 * Ramp pen depth linearly along a path, by distance travelled rather than by
 * point index — otherwise a densely sampled curve would ramp faster than a
 * sparse straight line covering the same ground.
 */
export function rampZ(path, fromZ, toZ) {
  const total = pathLength(path);
  if (total === 0) return withZ(path, toZ);

  let travelled = 0;
  const points = path.points.map((p, i) => {
    if (i > 0) travelled += distance(path.points[i - 1], p);
    return { ...p, z: fromZ + (toZ - fromZ) * (travelled / total) };
  });

  return { ...path, points };
}
