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
import { hatchFill, isFillable, DEFAULTS as HATCH_DEFAULTS } from '../geom/hatch.js';
import { rejoinCuts } from './select.js';

/**
 * Hatch settings a placement starts with.
 *
 * These describe *how* a fill is drawn. *What* is filled is a separate
 * question, answered per shape by `fills` — filling everything closed is
 * rarely what a drawing wants.
 */
export const DEFAULT_HATCH = { ...HATCH_DEFAULTS };

/**
 * Computed hatch lines, keyed by the source paths and the settings used.
 *
 * Hatching a dense shape is far too slow to redo on every frame of a drag.
 * Keying on the paths array rather than the placement means the cache survives
 * moving and scaling — those produce a new placement object but reuse the same
 * source geometry — while any change to the hatch settings misses and
 * recomputes. A WeakMap so an object dropped from the scene takes its cache
 * with it.
 */
const hatchCache = new WeakMap();

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
  hatch = DEFAULT_HATCH,
  fills = {},
  layerId = null,
  pathLayers = {},
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
    hatch: { ...DEFAULT_HATCH, ...hatch },
    /**
     * Which shapes are filled, and on which layer.
     *
     * Keyed by the stable id of the shape's outline, with the layer its hatch
     * draws on — null meaning the placement's own. Absent means not filled.
     */
    fills: { ...fills },
    /** Default pen for everything in this placement. */
    layerId,
    /** Per-path overrides, keyed by stable path id. */
    pathLayers: { ...pathLayers },
  };
}

/**
 * Does this placement contain anything a fill could go inside?
 *
 * Measured against the rejoined outlines, so painting part of a shape onto
 * another pen does not make it look as though the shape stopped being closed.
 */
export function canHatch(placement) {
  return fillableShapes(placement).length > 0;
}

/**
 * The shapes in this placement that a fill could go inside.
 *
 * Outlines are rejoined first, so painting part of a shape onto another layer
 * does not make it look as though the shape stopped being closed.
 */
export function fillableShapes(placement) {
  return rejoinCuts(placement.paths).filter(isFillable);
}

/**
 * Filled shapes grouped by the layer their hatch draws on.
 *
 * Grouped rather than hatched one at a time because the fill rule only means
 * anything across a set of outlines: a ring is hollow because its inner circle
 * is counted against its outer one. Shapes filled in the same colour are the
 * natural group — one fill, one colour, holes and all.
 */
function fillGroups(placement) {
  const groups = new Map();

  for (const shape of fillableShapes(placement)) {
    const layerId = placement.fills?.[shape.id];
    if (layerId === undefined) continue;

    const key = layerId ?? '';
    if (!groups.has(key)) groups.set(key, { layerId: layerId ?? null, shapes: [] });
    groups.get(key).shapes.push(shape);
  }

  return [...groups.values()];
}

/**
 * The placement's own geometry: its source paths plus any hatch fill.
 *
 * Hatch spacing is given in millimetres **on paper**, not in the source
 * drawing's units. It is the one fill parameter chosen against a physical
 * object — the pen — so the number a user types is the gap they expect to
 * measure on the sheet. An object scaled 3.5x would otherwise turn a stated
 * 0.2 mm into 0.7 mm, which is both surprising and impossible to reason about
 * against a pen width.
 *
 * The fill is still generated in source coordinates so it rotates with the
 * shape and caches across moves; the spacing is simply divided back through
 * the scale first. A consequence worth knowing: scaling a filled object up
 * adds lines rather than spreading them, which is honest — a larger filled
 * area does take longer to draw.
 */
export function placementPaths(placement) {
  const fills = placement.fills ?? {};
  if (Object.keys(fills).length === 0) return placement.paths;

  const { angleDeg, cross, rule, boustrophedon } = placement.hatch;

  // Guard a zero or negative scale, which would make the spacing meaningless.
  const scale = Math.abs(placement.scale) || 1;
  const spacingMm = placement.hatch.spacingMm / scale;

  const key = `${spacingMm}|${angleDeg}|${cross}|${rule}|${boustrophedon}|${
    Object.entries(fills).map(([id, layerId]) => `${id}:${layerId ?? ''}`).sort().join(',')
  }`;

  let cached = hatchCache.get(placement.paths);
  if (!cached) {
    cached = new Map();
    hatchCache.set(placement.paths, cached);
  }

  // The combined array is cached too, not just the fill. It is rebuilt on
  // every render frame otherwise, which for a dense fill is a copy of
  // thousands of entries per frame for no gain.
  if (!cached.has(key)) {
    const lines = fillGroups(placement).flatMap((group) =>
      hatchFill(group.shapes, { ...placement.hatch, spacingMm }).map((line) => ({
        ...line,
        // A fill draws on its own layer, not the shape's — see layerIdFor.
        meta: { ...line.meta, fillLayerId: group.layerId },
      })));

    cached.set(key, [...placement.paths, ...lines]);
  }

  return cached.get(key);
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
  return placementPaths(placement).map((path) => transformPath(path, matrix));
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

  for (const path of placementPaths(placement)) {
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
