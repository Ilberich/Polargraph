/**
 * Snapping.
 *
 * While a placement is dragged, its edges and centre are compared against
 * meaningful lines on the paper — the sheet's own edges and centre, the margin
 * box, a grid, and the other objects. When one is close enough the position is
 * nudged onto it exactly.
 *
 * The threshold is given in paper millimetres but should be computed from a
 * screen distance by the caller, so snapping feels the same when zoomed in as
 * when zoomed out.
 *
 * Each axis snaps independently: an object can lock to a neighbour's left edge
 * while staying free vertically, which is what makes aligning a row of shapes
 * feel like alignment rather than a fight.
 */

import { marginBox } from './scene.js';
import { placementBounds } from './placement.js';

export const DEFAULT_SNAP = {
  /** Snap radius in paper mm. */
  threshold: 2,
  paperEdges: true,
  paperCentre: true,
  margins: true,
  objects: true,
  grid: false,
  gridMm: 10,
};

/**
 * Lines worth snapping to, per axis.
 *
 * `exclude` keeps the dragged object from snapping to where it already is.
 */
export function snapTargets(scene, options = DEFAULT_SNAP, excludeId = null) {
  const settings = { ...DEFAULT_SNAP, ...options };
  const { widthMm, heightMm } = scene.paper;

  const x = [];
  const y = [];

  const push = (axis, value, kind) => axis.push({ value, kind });

  if (settings.paperEdges) {
    push(x, 0, 'paper');
    push(x, widthMm, 'paper');
    push(y, 0, 'paper');
    push(y, heightMm, 'paper');
  }

  if (settings.paperCentre) {
    push(x, widthMm / 2, 'centre');
    push(y, heightMm / 2, 'centre');
  }

  if (settings.margins) {
    const box = marginBox(scene.paper);
    push(x, box.minX, 'margin');
    push(x, box.maxX, 'margin');
    push(y, box.minY, 'margin');
    push(y, box.maxY, 'margin');
  }

  if (settings.objects) {
    for (const placement of scene.placements) {
      if (placement.id === excludeId || !placement.visible) continue;

      const b = placementBounds(placement);
      push(x, b.minX, 'object');
      push(x, (b.minX + b.maxX) / 2, 'object');
      push(x, b.maxX, 'object');
      push(y, b.minY, 'object');
      push(y, (b.minY + b.maxY) / 2, 'object');
      push(y, b.maxY, 'object');
    }
  }

  return { x, y };
}

/**
 * Best snap for one axis.
 *
 * Considers the moving box's leading edge, centre and trailing edge against
 * every target, and keeps the smallest correction. Returns null when nothing is
 * within the threshold.
 */
function snapAxis(centre, halfSize, targets, threshold) {
  let best = null;

  // The three places on the moving object that can align with a line.
  const anchors = [
    { offset: -halfSize, kind: 'min' },
    { offset: 0, kind: 'centre' },
    { offset: halfSize, kind: 'max' },
  ];

  for (const anchor of anchors) {
    const edge = centre + anchor.offset;

    for (const target of targets) {
      const delta = target.value - edge;
      if (Math.abs(delta) > threshold) continue;

      if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, line: target.value, kind: target.kind, anchor: anchor.kind };
      }
    }
  }

  return best;
}

/** Grid lines within reach of a coordinate, so the whole grid is never built. */
function gridTargets(value, gridMm, threshold) {
  if (!(gridMm > 0)) return [];

  const nearest = Math.round(value / gridMm) * gridMm;
  const lines = [nearest - gridMm, nearest, nearest + gridMm];

  return lines
    .filter((line) => Math.abs(line - value) <= threshold)
    .map((line) => ({ value: line, kind: 'grid' }));
}

/**
 * Snap a proposed centre position.
 *
 * Takes where the drag would put the object and the size of its bounding box,
 * and returns a corrected position plus the guides that should be drawn so the
 * user can see *why* it snapped.
 */
export function snapPosition(proposed, size, scene, options = {}, excludeId = null) {
  const settings = { ...DEFAULT_SNAP, ...options };
  const { threshold } = settings;

  const targets = snapTargets(scene, settings, excludeId);

  if (settings.grid) {
    const halfW = size.width / 2;
    const halfH = size.height / 2;

    for (const edge of [proposed.x - halfW, proposed.x, proposed.x + halfW]) {
      targets.x.push(...gridTargets(edge, settings.gridMm, threshold));
    }
    for (const edge of [proposed.y - halfH, proposed.y, proposed.y + halfH]) {
      targets.y.push(...gridTargets(edge, settings.gridMm, threshold));
    }
  }

  const snapX = snapAxis(proposed.x, size.width / 2, targets.x, threshold);
  const snapY = snapAxis(proposed.y, size.height / 2, targets.y, threshold);

  const guides = [];
  if (snapX) guides.push({ axis: 'x', value: snapX.line, kind: snapX.kind });
  if (snapY) guides.push({ axis: 'y', value: snapY.line, kind: snapY.kind });

  return {
    x: proposed.x + (snapX?.delta ?? 0),
    y: proposed.y + (snapY?.delta ?? 0),
    guides,
  };
}
