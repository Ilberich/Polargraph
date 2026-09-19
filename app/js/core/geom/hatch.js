/**
 * Hatch fill.
 *
 * A pen plotter cannot fill a shape; it can only draw lines close enough
 * together to read as one. So a filled region becomes a set of parallel
 * strokes clipped to the outline.
 *
 * The method is a scanline sweep. Lines are generated across the shape's
 * extent at the requested angle and spacing, each intersected with every edge
 * of the outline, and the crossings sorted along the line. Which spans between
 * crossings are inside the shape is decided by a fill rule, so shapes with
 * holes — a letter O, a ring — come out hollow rather than solid.
 *
 * Rather than rotate every scanline, the geometry is rotated into a frame
 * where scanlines are horizontal, swept there, and the resulting segments
 * rotated back. Horizontal intersection is a comparison against a y value
 * instead of a line-line solve, which is both faster and far harder to get
 * subtly wrong.
 */

import { compose, rotation, apply } from './matrix.js';
import { createPath, isDegenerate } from './path.js';

export const DEFAULTS = {
  /** Distance between strokes, mm. Below the pen width this reads as solid. */
  spacingMm: 2,
  /** Direction of the strokes, degrees. */
  angleDeg: 45,
  /** Also hatch at a right angle to the first pass. */
  cross: false,
  /**
   * Fill rule for deciding what is inside.
   *
   * `evenodd` treats every other span as a hole, which is what makes a ring
   * hollow. `nonzero` uses winding direction, matching SVG's default and
   * keeping overlapping subpaths solid.
   */
  rule: 'evenodd',
  /**
   * Draw alternate lines in opposite directions.
   *
   * On by default: it halves the travel between strokes, and on a machine
   * with no pen lift that travel would otherwise be drawn across the fill.
   */
  boustrophedon: true,
};

/**
 * Does this path enclose an area a fill could go inside?
 *
 * Not the same question as "is it flagged closed". A path is fillable if it
 * is explicitly closed, or if the renderer would fill it anyway — SVG closes
 * an open path implicitly when filling it, so a filled shape has an inside
 * however its outline was written. Tools omit the closing command far more
 * often than one would hope.
 */
export function isFillable(path) {
  if (!path || path.points.length < 3) return false;
  return path.closed || path.meta?.filled === true;
}

/** Edges of a closed polygon, skipping any that are horizontal after rotation. */
function edgesOf(points) {
  const edges = [];

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];

    // A horizontal edge lies along the scanline and produces no clean
    // crossing; the edges meeting it at each end already carry that boundary.
    if (a.y !== b.y) edges.push({ a, b });
  }

  return edges;
}

/**
 * Where a horizontal line at `y` crosses the polygon.
 *
 * Each crossing carries the edge's winding direction, which the nonzero rule
 * needs and the even-odd rule ignores.
 *
 * The half-open test — a vertex counts for the edge below it and not the one
 * above — is what stops a scanline passing exactly through a vertex from
 * registering two crossings where there is really one.
 */
function crossingsAt(edges, y) {
  const crossings = [];

  for (const { a, b } of edges) {
    const lower = Math.min(a.y, b.y);
    const upper = Math.max(a.y, b.y);
    if (y < lower || y >= upper) continue;

    const t = (y - a.y) / (b.y - a.y);
    crossings.push({ x: a.x + t * (b.x - a.x), winding: b.y > a.y ? 1 : -1 });
  }

  return crossings.sort((p, q) => p.x - q.x);
}

/** Pair crossings into the spans that lie inside the shape. */
function spansFrom(crossings, rule) {
  const spans = [];

  if (rule === 'nonzero') {
    let winding = 0;

    for (let i = 0; i < crossings.length - 1; i++) {
      winding += crossings[i].winding;
      // A non-zero winding number between two crossings means inside.
      if (winding !== 0) spans.push([crossings[i].x, crossings[i + 1].x]);
    }

    return spans;
  }

  // Even-odd: every second span is inside.
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    spans.push([crossings[i].x, crossings[i + 1].x]);
  }

  return spans;
}

/**
 * Hatch one set of closed outlines at a single angle.
 *
 * All the outlines are swept together rather than one at a time, so a shape
 * and the hole inside it interact the way the fill rule says they should.
 */
function hatchOnce(outlines, { spacingMm, angleDeg, rule, boustrophedon }) {
  if (!(spacingMm > 0)) return [];

  // Work in a frame where the strokes are horizontal, then rotate back.
  const toScanFrame = rotation(-angleDeg);
  const fromScanFrame = rotation(angleDeg);

  const rotated = outlines
    .map((path) => path.points.map((p) => apply(toScanFrame, p)))
    .filter((points) => points.length >= 3);

  if (rotated.length === 0) return [];

  const edges = rotated.flatMap(edgesOf);
  if (edges.length === 0) return [];

  const ys = rotated.flat().map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  // Start half a space in, so the first line is not flush against the edge.
  const segments = [];
  let flip = false;

  for (let y = minY + spacingMm / 2; y < maxY; y += spacingMm) {
    const spans = spansFrom(crossingsAt(edges, y), rule);

    // Reversing alternate lines turns the return trip into part of the fill.
    const ordered = boustrophedon && flip ? [...spans].reverse() : spans;

    for (const [from, to] of ordered) {
      // A span narrower than this is a grazed corner, not a line to draw.
      if (Math.abs(to - from) < 1e-9) continue;

      const [x1, x2] = boustrophedon && flip ? [to, from] : [from, to];

      segments.push(
        createPath([
          apply(fromScanFrame, { x: x1, y }),
          apply(fromScanFrame, { x: x2, y }),
        ])
      );
    }

    flip = !flip;
  }

  return segments;
}

/**
 * Fill closed outlines with hatch lines.
 *
 * Takes the outlines as a group so holes work: an inner ring counts as a hole
 * of the outer one under the even-odd rule. Open paths are ignored — there is
 * no inside to fill.
 */
export function hatchFill(paths, options = {}) {
  const settings = { ...DEFAULTS, ...options };

  const outlines = paths.filter((p) => isFillable(p) && !isDegenerate(p));
  if (outlines.length === 0) return [];

  const first = hatchOnce(outlines, settings);
  if (!settings.cross) return first;

  return [
    ...first,
    ...hatchOnce(outlines, { ...settings, angleDeg: settings.angleDeg + 90 }),
  ];
}

/** Is a point inside the outlines, under the given fill rule? Used by tests. */
export function isInside(outlines, point, rule = DEFAULTS.rule) {
  const edges = outlines.flatMap((path) => edgesOf(path.points));
  const crossings = crossingsAt(edges, point.y);

  return spansFrom(crossings, rule).some(
    ([from, to]) => point.x >= from && point.x <= to
  );
}
