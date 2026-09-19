/**
 * Gcode optimization: what order to draw things in, and which way round.
 *
 * On a machine with a pen lift this saves time. On this machine — v1, fixed
 * pen — it decides whether the drawing looks right at all, because every
 * travel move puts ink on the paper. A drawing plotted in import order can be
 * covered in lines nobody asked for.
 *
 * Either way the objective is the same: minimise the total distance travelled
 * between the end of one stroke and the start of the next. So there is one
 * implementation, and `penLift` changes only how the result is described to
 * the user.
 *
 * Three stages, in this order:
 *
 *   1. Merge paths that share an endpoint into continuous strokes. Doing this
 *      first shrinks the problem the later stages have to solve.
 *   2. Order the strokes greedily, nearest first, choosing the better end of
 *      each to enter from.
 *   3. Improve that order with 2-opt, which fixes the long backtracks a greedy
 *      pass characteristically leaves behind.
 */

import { createPath, startPoint, endPoint, reversePath, isDegenerate } from '../geom/path.js';

export const DEFAULTS = {
  /** Endpoints closer than this are treated as the same point, in mm. */
  mergeToleranceMm: 0.05,
  /** Join paths that share an endpoint into one stroke. */
  merge: true,
  /** Reorder strokes to reduce travel. */
  reorder: true,
  /** Run the 2-opt improvement pass. */
  twoOpt: true,
  /** Where the pen starts. Travel to the first stroke counts from here. */
  start: { x: 0, y: 0 },
  /** Cap on 2-opt passes, so a pathological input cannot spin forever. */
  maxPasses: 12,
  /**
   * Wall-clock budget for the 2-opt pass, in milliseconds.
   *
   * 2-opt is quadratic per pass: measured on scattered strokes it costs 0.6s
   * at 1000 paths and 28s at 5000, which would lock up the tab on a hatched
   * drawing. Every accepted swap strictly shortens the route, so stopping
   * early simply means less improvement — never a worse result than greedy.
   */
  twoOptBudgetMs: 600,
};

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * A spatial hash over endpoints.
 *
 * Merging and nearest-neighbour search are both "what is near this point?"
 * questions. Asked of every path against every other, that is quadratic, and a
 * hatched drawing reaches many thousands of strokes. Bucketing by cell keeps
 * each query proportional to the local density instead.
 */
class PointGrid {
  constructor(cellSize) {
    // A degenerate cell size would put everything in one bucket.
    this.cellSize = cellSize > 0 ? cellSize : 1;
    this.cells = new Map();
  }

  key(x, y) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  add(point, value) {
    const key = this.key(point.x, point.y);
    const bucket = this.cells.get(key);

    if (bucket) bucket.push(value);
    else this.cells.set(key, [value]);
  }

  /** Everything in the cells touching a square of `radius` about the point. */
  near(point, radius) {
    const span = Math.max(1, Math.ceil(radius / this.cellSize));
    const cx = Math.floor(point.x / this.cellSize);
    const cy = Math.floor(point.y / this.cellSize);
    const found = [];

    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const bucket = this.cells.get(`${cx + dx},${cy + dy}`);
        if (bucket) found.push(...bucket);
      }
    }

    return found;
  }
}

/**
 * Join paths whose endpoints coincide.
 *
 * SVG exports routinely split what reads as one line into many segments —
 * every corner of a polyline can arrive as its own path. Left alone, each
 * becomes a separate stroke with a travel move between, which on a fixed-pen
 * machine means retracing the same line repeatedly.
 *
 * Closed paths are left alone: they have no free ends to join to.
 */
export function mergePaths(paths, tolerance = DEFAULTS.mergeToleranceMm) {
  const open = [];
  const result = [];

  for (const path of paths) {
    if (isDegenerate(path)) continue;
    if (path.closed) result.push(path);
    else open.push({ points: [...path.points], meta: path.meta, used: false });
  }

  // Cells sized to the tolerance: a match can only be in a touching cell.
  const grid = new PointGrid(Math.max(tolerance * 2, 1e-6));
  open.forEach((entry, index) => {
    grid.add(entry.points[0], { index, end: 'start' });
    grid.add(entry.points[entry.points.length - 1], { index, end: 'end' });
  });

  for (const entry of open) {
    if (entry.used) continue;
    entry.used = true;

    // Extend in both directions until nothing else connects.
    let extended = true;
    while (extended) {
      extended = false;

      for (const atEnd of [true, false]) {
        const tip = atEnd ? entry.points[entry.points.length - 1] : entry.points[0];

        for (const candidate of grid.near(tip, tolerance)) {
          const other = open[candidate.index];
          if (other === entry || other.used) continue;

          const otherStart = other.points[0];
          const otherEnd = other.points[other.points.length - 1];

          let joinPoints = null;
          if (distance(tip, otherStart) <= tolerance) joinPoints = other.points;
          else if (distance(tip, otherEnd) <= tolerance) joinPoints = [...other.points].reverse();
          else continue;

          // The shared point exists in both paths; keep one copy.
          if (atEnd) entry.points.push(...joinPoints.slice(1));
          else entry.points.unshift(...joinPoints.slice(1).reverse());

          other.used = true;
          extended = true;
          break;
        }
      }
    }

    // A stroke that has come back to where it began is a closed shape.
    const first = entry.points[0];
    const last = entry.points[entry.points.length - 1];
    const closed = entry.points.length > 2 && distance(first, last) <= tolerance;

    if (closed) entry.points.pop();
    result.push(createPath(entry.points, { closed, meta: entry.meta }));
  }

  return result;
}

/** A path plus which way round it is being drawn. */
function orient(path, reversed) {
  return { path, reversed };
}

function entry(oriented) {
  const { path, reversed } = oriented;
  return reversed ? endPoint(path) : startPoint(path);
}

function exit(oriented) {
  const { path, reversed } = oriented;
  // A closed path finishes where it started whichever way it is drawn.
  if (path.closed) return entry(oriented);
  return reversed ? startPoint(path) : endPoint(path);
}

/** Total distance travelled between strokes, which is what we are minimising. */
export function travelDistance(ordered, start = DEFAULTS.start) {
  let total = 0;
  let at = start;

  for (const oriented of ordered) {
    total += distance(at, entry(oriented));
    at = exit(oriented);
  }

  return total;
}

/**
 * Greedy nearest-neighbour ordering.
 *
 * At each step, take whichever unused stroke has an end closest to where the
 * pen is, and enter it from that end. Cheap, and gets most of the benefit; the
 * 2-opt pass afterwards cleans up what greed gets wrong.
 *
 * The search radius grows until something is found, so a sparse drawing still
 * finds its next stroke without scanning everything.
 */
export function orderPaths(paths, { start = DEFAULTS.start } = {}) {
  const drawable = paths.filter((p) => !isDegenerate(p));
  if (drawable.length === 0) return [];

  const grid = new PointGrid(estimateCellSize(drawable));
  const used = new Array(drawable.length).fill(false);

  drawable.forEach((path, index) => {
    grid.add(startPoint(path), { index, reversed: false });
    if (!path.closed) grid.add(endPoint(path), { index, reversed: true });
  });

  const ordered = [];
  let at = start;
  let remaining = drawable.length;

  while (remaining > 0) {
    let best = null;
    let bestDistance = Infinity;
    let radius = grid.cellSize;

    // Grow the search until a candidate is found, then one ring further so a
    // nearer stroke in an adjacent cell cannot be missed.
    for (let attempt = 0; attempt < 32; attempt++) {
      for (const candidate of grid.near(at, radius)) {
        if (used[candidate.index]) continue;

        const path = drawable[candidate.index];
        const point = candidate.reversed ? endPoint(path) : startPoint(path);
        const d = distance(at, point);

        if (d < bestDistance) {
          bestDistance = d;
          best = candidate;
        }
      }

      if (best && radius > bestDistance) break;
      radius *= 2;
    }

    // Fall back to a full scan if the grid somehow yielded nothing.
    if (!best) {
      for (let index = 0; index < drawable.length; index++) {
        if (used[index]) continue;

        for (const reversed of drawable[index].closed ? [false] : [false, true]) {
          const path = drawable[index];
          const point = reversed ? endPoint(path) : startPoint(path);
          const d = distance(at, point);

          if (d < bestDistance) {
            bestDistance = d;
            best = { index, reversed };
          }
        }
      }
    }

    used[best.index] = true;
    remaining--;

    const oriented = orient(drawable[best.index], best.reversed);
    ordered.push(oriented);
    at = exit(oriented);
  }

  return ordered;
}

/** Cell size from the average stroke spacing, so buckets stay small but useful. */
function estimateCellSize(paths) {
  const points = paths.map((p) => startPoint(p));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);

  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const extent = Math.max(width, height);

  if (!(extent > 0)) return 1;
  return Math.max(extent / Math.ceil(Math.sqrt(paths.length)), 1e-3);
}

/**
 * 2-opt improvement.
 *
 * Greedy ordering paints itself into corners: it takes the nearest stroke
 * every time and leaves stragglers that cost a long trip back later. 2-opt
 * reverses a run of strokes when doing so shortens the route, which is exactly
 * the shape of that mistake.
 *
 * Reversing a run also reverses each stroke within it, which is free here
 * because strokes are drawable in either direction.
 */
export function improveOrder(ordered, {
  start = DEFAULTS.start,
  maxPasses = DEFAULTS.maxPasses,
  twoOptBudgetMs = DEFAULTS.twoOptBudgetMs,
} = {}) {
  const count = ordered.length;
  if (count < 3) return ordered;

  const route = [...ordered];

  // Endpoints are held in flat arrays rather than read back through the
  // oriented-path helpers. The inner loop runs on the order of n squared per
  // pass, where property lookups and function calls dominate the arithmetic.
  const entryX = new Float64Array(count);
  const entryY = new Float64Array(count);
  const exitX = new Float64Array(count);
  const exitY = new Float64Array(count);

  for (let k = 0; k < count; k++) {
    const inPoint = entry(route[k]);
    const outPoint = exit(route[k]);

    entryX[k] = inPoint.x;
    entryY[k] = inPoint.y;
    exitX[k] = outPoint.x;
    exitY[k] = outPoint.y;
  }

  /** Reverse a run, which also reverses each stroke inside it. */
  const reverseRun = (from, to) => {
    for (let k = from; k <= to; k++) {
      route[k] = orient(route[k].path, !route[k].reversed);

      // A closed path starts and ends in the same place, so this is a no-op
      // for one; for an open path the two ends trade places.
      const tx = entryX[k]; const ty = entryY[k];
      entryX[k] = exitX[k]; entryY[k] = exitY[k];
      exitX[k] = tx; exitY[k] = ty;
    }

    for (let a = from, b = to; a < b; a++, b--) {
      [route[a], route[b]] = [route[b], route[a]];
      [entryX[a], entryX[b]] = [entryX[b], entryX[a]];
      [entryY[a], entryY[b]] = [entryY[b], entryY[a]];
      [exitX[a], exitX[b]] = [exitX[b], exitX[a]];
      [exitY[a], exitY[b]] = [exitY[b], exitY[a]];
    }
  };

  const deadline = globalThis.performance.now() + twoOptBudgetMs;

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (let i = 0; i < count - 1; i++) {
      // Checked per outer step rather than per comparison: often enough to
      // honour the budget, rarely enough not to cost anything itself.
      if (globalThis.performance.now() > deadline) return route;

      const beforeX = i === 0 ? start.x : exitX[i - 1];
      const beforeY = i === 0 ? start.y : exitY[i - 1];

      for (let j = i + 1; j < count; j++) {
        const last = j === count - 1;
        const afterX = last ? 0 : entryX[j + 1];
        const afterY = last ? 0 : entryY[j + 1];

        const current =
          Math.hypot(entryX[i] - beforeX, entryY[i] - beforeY) +
          (last ? 0 : Math.hypot(afterX - exitX[j], afterY - exitY[j]));

        // Reversing [i..j] means entering at what was the run's last exit and
        // leaving from what was its first entry.
        const swapped =
          Math.hypot(exitX[j] - beforeX, exitY[j] - beforeY) +
          (last ? 0 : Math.hypot(afterX - entryX[i], afterY - entryY[i]));

        if (swapped < current - 1e-9) {
          reverseRun(i, j);
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return route;
}

/** Materialise an ordering back into paths, applying each stroke's direction. */
export function toPaths(ordered) {
  return ordered.map(({ path, reversed }) => (reversed ? reversePath(path) : path));
}

/**
 * Run the whole pipeline.
 *
 * Returns the optimized paths and a report of what changed, which the app
 * shows so the user can see whether it was worth it.
 */
export function optimize(paths, options = {}) {
  const opts = { ...DEFAULTS, ...options };

  const merged = opts.merge ? mergePaths(paths, opts.mergeToleranceMm) : paths.filter((p) => !isDegenerate(p));
  const before = travelDistance(merged.map((p) => orient(p, false)), opts.start);

  if (!opts.reorder) {
    return { paths: merged, report: { before, after: before, pathsBefore: paths.length, pathsAfter: merged.length } };
  }

  const greedy = orderPaths(merged, { start: opts.start });
  const route = opts.twoOpt ? improveOrder(greedy, opts) : greedy;
  const after = travelDistance(route, opts.start);

  return {
    paths: toPaths(route),
    report: {
      before,
      after,
      saved: before - after,
      pathsBefore: paths.length,
      pathsAfter: merged.length,
    },
  };
}
