/**
 * Flattening curves again, once it is known how big they will be drawn.
 *
 * Curves are flattened into straight segments at import, against a tolerance in
 * millimetres on paper. That is the right measure, but at import time the size
 * the shape will be plotted at is not known yet — an object dropped on A3 and
 * fitted to the margins is routinely scaled ten or twenty times, and the facets
 * grow with it until a circle plots as a polygon.
 *
 * So each path remembers the curve it came from, and is flattened again when
 * the object is scaled up. The path keeps its id through it, because layer
 * membership and fills are held against ids and a smoother circle is still the
 * same circle.
 */

import { meanScale } from '../geom/matrix.js';
import { createPath, transformPath } from '../geom/path.js';
import { pathDataToPolylines } from './pathdata.js';
import { MM_PER_STEP } from '../machine.js';

/**
 * How much of a change in size is worth re-flattening for.
 *
 * Scale is rounded up to a power of two, so a drag that grows an object
 * smoothly re-flattens a handful of times rather than on every frame, and the
 * facets are never more than twice the tolerance asked for. Below 1 there is
 * nothing to do: an object drawn smaller than it was flattened for already has
 * more points than it needs, which costs nothing but file size.
 */
export function flattenStep(scale) {
  if (!(scale > 1)) return 1;
  return 2 ** Math.ceil(Math.log2(scale));
}

/**
 * The finest flattening worth asking for, in millimetres on paper.
 *
 * Half a motor step. Below this the machine cannot tell one point from the
 * next, so the extra vertices are pure file size — and on a drawing scaled
 * twenty times that is the difference between a circle of five hundred points
 * and one of several thousand.
 */
export const FINEST_TOLERANCE_MM = MM_PER_STEP / 2;

/** Can this path be flattened again, or is it already only points? */
export function hasCurve(path) {
  return path.meta?.curve != null;
}

/**
 * Flatten one path again for a tolerance in its own coordinates.
 *
 * Falls back to the path as it stands whenever the stored curve no longer
 * yields the subpath it should — better a shape flattened coarsely than a
 * shape that changes into something else.
 */
export function reflattenPath(path, toleranceMm) {
  if (!hasCurve(path)) return path;

  const { d, index, matrix } = path.meta.curve;
  const scale = meanScale(matrix);
  const local = scale > 0 ? toleranceMm / scale : toleranceMm;

  const subs = pathDataToPolylines(d, local);
  const sub = subs[index];

  if (!sub || sub.closed !== path.closed) return path;

  return transformPath(
    createPath(sub.points, { closed: sub.closed, meta: path.meta, id: path.id }),
    matrix
  );
}

/**
 * Flatten a set of paths for an object drawn at `scale`.
 *
 * Returns the same array when nothing needed doing, so callers can use it as a
 * cheap identity check.
 */
export function reflatten(paths, scale, toleranceMm) {
  const step = flattenStep(scale);
  if (step === 1 || !paths.some(hasCurve)) return paths;

  const wanted = Math.max(toleranceMm / step, FINEST_TOLERANCE_MM);
  return paths.map((path) => reflattenPath(path, wanted));
}
