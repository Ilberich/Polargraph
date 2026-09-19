/**
 * A placed object: imported geometry plus where it sits on the paper.
 *
 * Source paths are never modified. Position, rotation and scale are stored as
 * values and resolved to a matrix on demand, so dragging something around and
 * putting it back leaves the geometry bit-for-bit as imported — no accumulated
 * rounding from repeatedly transforming points in place.
 *
 * Position is the object's *centre* on the paper rather than a corner. Rotation
 * and scale then behave the way a person expects: an object spins about itself
 * and grows from the middle, instead of swinging around a corner.
 */

import { compose, translation, scaling, rotation as rotate, apply } from '../geom/matrix.js';
import { transformPath, boundsOf } from '../geom/path.js';

let nextId = 1;

/** Reset id allocation. Tests only — ids must be stable within a session. */
export function resetIds() {
  nextId = 1;
}

/**
 * Wrap imported paths as a placed object.
 *
 * Source bounds are measured once here. Paths do not change after import, and
 * remeasuring thousands of points on every drag frame would be wasteful.
 */
export function createPlacement({
  name = 'Untitled',
  kind = 'svg',
  paths = [],
  x = null,
  y = null,
  rotation = 0,
  scale = 1,
  visible = true,
  id = null,
} = {}) {
  const sourceBounds = boundsOf(paths) ?? {
    minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0,
  };

  const pivot = {
    x: (sourceBounds.minX + sourceBounds.maxX) / 2,
    y: (sourceBounds.minY + sourceBounds.maxY) / 2,
  };

  return {
    id: id ?? `p${nextId++}`,
    name,
    kind,
    paths,
    sourceBounds,
    pivot,
    // Default to where the source said, so an import lands as authored.
    x: x ?? pivot.x,
    y: y ?? pivot.y,
    rotation,
    scale,
    visible,
  };
}

/**
 * The matrix taking source coordinates to paper coordinates.
 *
 * Move the pivot to the origin, scale, rotate, then move to the placed centre.
 * Doing it in that order is what makes rotation and scaling act about the
 * object rather than about the paper's corner.
 */
export function placementMatrix(placement) {
  return compose(
    translation(-placement.pivot.x, -placement.pivot.y),
    scaling(placement.scale),
    rotate(placement.rotation),
    translation(placement.x, placement.y)
  );
}

/** Source paths transformed onto the paper. Used for export, not for drawing. */
export function worldPaths(placement) {
  const matrix = placementMatrix(placement);
  return placement.paths.map((path) => transformPath(path, matrix));
}

/**
 * Axis-aligned bounds on the paper.
 *
 * Transforms the four corners of the source bounds rather than every point.
 * For a rotated object that is the bounding box of the rotated box, which can
 * be slightly larger than the bounding box of the rotated content — an
 * overestimate, and the safe direction to err for fitting and margin checks.
 */
export function placementBounds(placement) {
  const { minX, minY, maxX, maxY } = placement.sourceBounds;
  const matrix = placementMatrix(placement);

  const corners = [
    apply(matrix, { x: minX, y: minY }),
    apply(matrix, { x: maxX, y: minY }),
    apply(matrix, { x: maxX, y: maxY }),
    apply(matrix, { x: minX, y: maxY }),
  ];

  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);

  const bounds = {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };

  return {
    ...bounds,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}

/** Is this point inside the placement's bounds? Used for click selection. */
export function hitTest(placement, point, slack = 0) {
  const b = placementBounds(placement);

  return (
    point.x >= b.minX - slack &&
    point.x <= b.maxX + slack &&
    point.y >= b.minY - slack &&
    point.y <= b.maxY + slack
  );
}

/** Total drawn length in mm, at the placement's current scale. */
export function placementLength(placement) {
  let total = 0;

  for (const path of placement.paths) {
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1];
      const b = path.points[i];
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }

    if (path.closed && path.points.length > 1) {
      const a = path.points[path.points.length - 1];
      const b = path.points[0];
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }

  return total * placement.scale;
}
