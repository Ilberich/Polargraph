/**
 * Selecting parts of a drawing, so they can go on a different pen.
 *
 * Two ways to choose: click a whole stroke, or brush across one and take the
 * part covered. The second is the reason this module exists — assigning a pen
 * to half a stroke means that stroke has to be cut in two, and doing that
 * without disturbing the drawing is fiddly enough to deserve testing on its
 * own.
 *
 * Everything here works in a placement's own coordinates. The caller converts
 * from paper coordinates first, because only it knows the placement's
 * transform.
 */

import { distanceToSegment } from '../geom/vec2.js';
import { createPath, polygonArea } from '../geom/path.js';
import { isFillable, isInside } from '../geom/hatch.js';

/**
 * How many segments a path has.
 *
 * A closed path has one more than an open one: the segment joining its last
 * point back to its first.
 */
export function segmentCount(path) {
  const n = path.points.length;
  if (n < 2) return 0;
  return path.closed ? n : n - 1;
}

/** The two endpoints of segment `i`, wrapping for a closed path. */
export function segmentEnds(path, i) {
  const points = path.points;
  return [points[i], points[(i + 1) % points.length]];
}

/** Closest approach from a point to a path, and which segment was closest. */
export function distanceToPath(path, point) {
  let best = Infinity;
  let segment = -1;

  for (let i = 0; i < segmentCount(path); i++) {
    const [a, b] = segmentEnds(path, i);
    const d = distanceToSegment(point, a, b);

    if (d < best) {
      best = d;
      segment = i;
    }
  }

  return { distance: best, segment };
}

/**
 * Segments of a path lying within `radius` of a point.
 *
 * A segment counts when any part of it is within reach, not merely its
 * midpoint — on a coarsely flattened curve a segment can be long enough that
 * the brush covers its middle while both ends sit outside, or vice versa.
 */
export function segmentsWithin(path, point, radius) {
  const hits = [];

  for (let i = 0; i < segmentCount(path); i++) {
    const [a, b] = segmentEnds(path, i);
    if (distanceToSegment(point, a, b) <= radius) hits.push(i);
  }

  return hits;
}

/** The nearest path to a point, within a tolerance, or null. */
export function pickPath(paths, point, tolerance) {
  let best = null;
  let bestDistance = tolerance;

  for (const path of paths) {
    const { distance } = distanceToPath(path, point);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = path;
    }
  }

  return best;
}

/**
 * The shape a fill click landed in.
 *
 * Clicking inside a shape is how a fill tool is used, so containment comes
 * first and the smallest containing shape wins — clicking the hole of a ring
 * should offer the hole, not the ring around it. Landing inside nothing falls
 * back to the nearest outline, so a shape can also be filled by clicking its
 * edge.
 */
export function pickShape(paths, point, tolerance = 0) {
  const outlines = paths.filter(isFillable);

  const containing = outlines.filter((path) => isInside([path], point, 'evenodd'));

  if (containing.length > 0) {
    return containing.reduce((best, path) =>
      polygonArea(path) < polygonArea(best) ? path : best);
  }

  return pickPath(outlines, point, tolerance);
}

/**
 * Group selected segment indices into contiguous runs.
 *
 * On a closed path a run may wrap past the end, which is why the last and
 * first runs are joined when both touch the seam — otherwise brushing across
 * the top of a circle would produce two strokes with a join where the path
 * data happened to start.
 */
export function runsOf(selected, total, closed) {
  const inSelection = new Set(selected);
  const runs = [];
  let current = null;

  for (let i = 0; i < total; i++) {
    if (inSelection.has(i)) {
      if (current) current.push(i);
      else current = [i];
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }

  if (current) runs.push(current);

  // Join a run ending at the seam with one starting at it.
  if (closed && runs.length > 1) {
    const first = runs[0];
    const last = runs[runs.length - 1];

    if (first[0] === 0 && last[last.length - 1] === total - 1) {
      runs.pop();
      runs.shift();
      runs.unshift([...last, ...first]);
    }
  }

  return runs;
}

/**
 * Split a path into the selected and unselected parts.
 *
 * Returns pieces in drawing order, each flagged. The pieces meet end to end —
 * a shared point appears in both — so the drawn geometry is unchanged; only
 * its division into strokes differs.
 *
 * A wholly selected or wholly unselected path is returned as it is, keeping
 * its identity. Cutting a path that did not need cutting would churn ids and
 * lose any assignment already made against them.
 */
export function splitPathBySelection(path, selected) {
  const total = segmentCount(path);
  const chosen = new Set(selected);

  if (total === 0 || chosen.size === 0) return [{ path, selected: false }];
  if (chosen.size === total) return [{ path, selected: true }];

  const pieces = [];

  // Pieces remember the shape they came from, so a fill can still be worked
  // out from the whole outline (see rejoinCuts).
  const meta = {
    ...path.meta,
    cutFrom: path.meta?.cutFrom ?? path.id,
    cutClosed: path.meta?.cutClosed ?? path.closed,
  };

  const pointsFor = (run) => {
    // A run of segments uses one more point than it has segments.
    const points = run.map((i) => path.points[i]);
    const last = run[run.length - 1];
    points.push(path.points[(last + 1) % path.points.length]);
    return points;
  };

  // Start the sweep at a boundary between selected and unselected. On a closed
  // path that keeps a run spanning the seam in one piece, and stops the cut
  // introducing a join at whatever point the path data happened to start.
  let start = 0;

  if (path.closed) {
    for (let i = 0; i < total; i++) {
      if (chosen.has(i) !== chosen.has((i + total - 1) % total)) {
        start = i;
        break;
      }
    }
  }

  let current = [];
  let currentSelected = chosen.has(start);

  for (let step = 0; step < total; step++) {
    const i = (start + step) % total;
    const isSelected = chosen.has(i);

    if (isSelected !== currentSelected && current.length > 0) {
      pieces.push({
        path: createPath(pointsFor(current), { meta }),
        selected: currentSelected,
      });
      current = [];
    }

    currentSelected = isSelected;
    current.push(i);
  }

  if (current.length > 0) {
    pieces.push({
      path: createPath(pointsFor(current), { meta }),
      selected: currentSelected,
    });
  }

  return pieces;
}

/**
 * Put cut pieces back together.
 *
 * Brushing part of a closed shape cuts its outline, and an outline in pieces
 * has no inside — a fill worked out from the pieces would be nonsense. The
 * pieces remember what they were cut from, so the fill can be taken from the
 * whole shape while the drawing keeps its pieces on separate pens.
 *
 * Pieces of one shape stay next to each other in the paths array, in drawing
 * order, which is what makes rejoining them a single pass.
 */
export function rejoinCuts(paths) {
  const result = [];
  let group = null;

  const flush = () => {
    if (!group) return;
    result.push(group.parts.length > 1 ? joinParts(group) : group.parts[0]);
    group = null;
  };

  for (const path of paths) {
    const origin = path.meta?.cutFrom;

    if (origin == null) {
      flush();
      result.push(path);
    } else if (group && group.origin === origin) {
      group.parts.push(path);
    } else {
      flush();
      group = { origin, parts: [path] };
    }
  }

  flush();
  return result;
}

function joinParts({ origin, parts }) {
  // Consecutive pieces share the point where they were cut; keep one copy.
  const points = [...parts[0].points];
  for (const part of parts.slice(1)) points.push(...part.points.slice(1));

  const closed = parts[0].meta?.cutClosed === true;
  // A closed path does not store its start point twice.
  if (closed) points.pop();

  const meta = { ...parts[0].meta };
  delete meta.cutFrom;
  delete meta.cutClosed;

  return createPath(points, { closed, meta, id: origin });
}

/**
 * Put a selection onto a pen.
 *
 * Paths that are wholly in or wholly out of the selection keep their identity;
 * only a partly selected path is cut, and only into as many pieces as the
 * selection actually requires.
 *
 * Returns a new paths array and a new overrides map for the placement.
 */
export function assignSelection(placement, selection, layerId) {
  const paths = [];
  const pathLayers = { ...(placement.pathLayers ?? {}) };

  for (const path of placement.paths) {
    const selected = selection.get(path.id);

    if (!selected || selected.size === 0) {
      paths.push(path);
      continue;
    }

    const pieces = splitPathBySelection(path, selected);
    const inherited = pathLayers[path.id];
    const cut = pieces.length > 1;

    // The original stops existing once it is cut up.
    if (cut && inherited != null) delete pathLayers[path.id];

    for (const piece of pieces) {
      paths.push(piece.path);

      // A new piece starts out carrying whatever the original did.
      if (piece.path.id !== path.id && inherited != null) {
        pathLayers[piece.path.id] = inherited;
      }

      if (!piece.selected) continue;

      // Assigning to the placement's own default means no override, so that
      // "this object is all one pen" stays expressible.
      if (layerId == null || layerId === placement.layerId) {
        delete pathLayers[piece.path.id];
      } else {
        pathLayers[piece.path.id] = layerId;
      }
    }
  }

  return { paths, pathLayers };
}
