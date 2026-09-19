/**
 * The document: a sheet of paper and the objects arranged on it.
 *
 * Updates return a new scene rather than mutating one. That keeps rendering a
 * pure function of state, makes "did anything change?" a reference comparison,
 * and leaves undo as a list of past scenes rather than a log of inverse
 * operations to get subtly wrong.
 */

import { placementBounds, worldPaths } from './placement.js';

export const DEFAULT_PAPER = {
  widthMm: 420,
  heightMm: 594,
  margins: { top: 20, right: 20, bottom: 20, left: 20 },
};

export function createScene({ paper = DEFAULT_PAPER, placements = [] } = {}) {
  return { paper: { ...paper, margins: { ...paper.margins } }, placements };
}

/** The drawable area inside the margins. */
export function marginBox(paper) {
  const { widthMm, heightMm, margins } = paper;

  return {
    minX: margins.left,
    minY: margins.top,
    maxX: widthMm - margins.right,
    maxY: heightMm - margins.bottom,
    width: widthMm - margins.left - margins.right,
    height: heightMm - margins.top - margins.bottom,
  };
}

export function addPlacement(scene, placement) {
  return { ...scene, placements: [...scene.placements, placement] };
}

export function removePlacement(scene, id) {
  return { ...scene, placements: scene.placements.filter((p) => p.id !== id) };
}

export function getPlacement(scene, id) {
  return scene.placements.find((p) => p.id === id) ?? null;
}

export function updatePlacement(scene, id, changes) {
  return {
    ...scene,
    placements: scene.placements.map((p) => (p.id === id ? { ...p, ...changes } : p)),
  };
}

export function setPaper(scene, paper) {
  return { ...scene, paper: { ...scene.paper, ...paper } };
}

/**
 * Move a placement in the draw order.
 *
 * Order decides what is drawn on top and, once the optimizer exists, roughly
 * the order strokes are plotted in.
 */
export function reorderPlacement(scene, id, delta) {
  const index = scene.placements.findIndex((p) => p.id === id);
  if (index === -1) return scene;

  const target = Math.max(0, Math.min(scene.placements.length - 1, index + delta));
  if (target === index) return scene;

  const placements = [...scene.placements];
  const [moved] = placements.splice(index, 1);
  placements.splice(target, 0, moved);

  return { ...scene, placements };
}

/** Topmost placement under a point, so clicking selects what you can see. */
export function pickAt(scene, point, slack = 0) {
  for (let i = scene.placements.length - 1; i >= 0; i--) {
    const placement = scene.placements[i];
    if (!placement.visible) continue;

    const b = placementBounds(placement);
    if (
      point.x >= b.minX - slack && point.x <= b.maxX + slack &&
      point.y >= b.minY - slack && point.y <= b.maxY + slack
    ) {
      return placement;
    }
  }

  return null;
}

/** Every visible placement's geometry, on the paper, ready for gcode. */
export function scenePaths(scene) {
  return scene.placements
    .filter((p) => p.visible)
    .flatMap((p) => worldPaths(p));
}

/**
 * Placements straying outside the margins.
 *
 * Worth surfacing before a plot rather than after: the machine will happily
 * drive off the paper, and on a polargraph that means drawing on the wall.
 */
export function outsideMargins(scene) {
  const box = marginBox(scene.paper);

  return scene.placements.filter((placement) => {
    if (!placement.visible) return false;

    const b = placementBounds(placement);
    return b.minX < box.minX || b.minY < box.minY || b.maxX > box.maxX || b.maxY > box.maxY;
  });
}

/**
 * Scale and centre a placement to fill the margin box.
 *
 * Scales in both directions. An earlier version refused to enlarge, on the
 * theory that growing a drawing past its authored size should be deliberate —
 * but a command called "fit" that silently declines to fit reads as broken,
 * and scaling a small drawing up to fill the sheet is a routine thing to want.
 * The resulting scale is visible and editable in the panel either way.
 */
export function fitToMargins(scene, id) {
  const placement = getPlacement(scene, id);
  if (!placement) return scene;

  const box = marginBox(scene.paper);
  const bounds = placementBounds(placement);
  if (bounds.width === 0 || bounds.height === 0) return scene;

  const factor = Math.min(box.width / bounds.width, box.height / bounds.height);

  return updatePlacement(scene, id, {
    scale: placement.scale * factor,
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
  });
}

/** Centre a placement on the paper without resizing it. */
export function centreOnPaper(scene, id) {
  return updatePlacement(scene, id, {
    x: scene.paper.widthMm / 2,
    y: scene.paper.heightMm / 2,
  });
}
