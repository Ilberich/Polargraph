/**
 * Direct manipulation: what dragging a handle means.
 *
 * Kept out of the event handlers so it can be tested without a browser.
 * Getting these wrong produces objects that swim away from the cursor or
 * rotate about the wrong point, which is obvious to a user and invisible to a
 * test that only checks the handler ran.
 */

import { placementBounds } from './placement.js';

/** Scale below which a placement would be invisible and unrecoverable. */
export const MIN_SCALE = 0.01;
export const MAX_SCALE = 1000;

const clampScale = (scale) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

/** The corner diagonally opposite the one being dragged. */
export function oppositeCorner(bounds, corner) {
  const left = bounds.minX;
  const right = bounds.maxX;
  const top = bounds.minY;
  const bottom = bounds.maxY;

  switch (corner) {
    case 'nw': return { x: right, y: bottom };
    case 'ne': return { x: left, y: bottom };
    case 'se': return { x: left, y: top };
    case 'sw': return { x: right, y: top };
    default: return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
}

/**
 * Resize by dragging a corner handle.
 *
 * The opposite corner stays put, which is what makes the gesture feel like
 * grabbing the shape rather than nudging a number. Scaling stays uniform —
 * a polargraph draws lines, and a non-uniformly scaled drawing is a different
 * drawing, not a resized one.
 *
 * The centre has to move as well as the scale: holding the anchor fixed while
 * growing about the centre is a contradiction, so the centre is pushed away
 * from the anchor by the same factor.
 */
export function scaleFromHandle(placement, corner, pointer) {
  const bounds = placementBounds(placement);
  const anchor = oppositeCorner(bounds, corner);

  const ratios = [];
  if (bounds.width > 1e-9) ratios.push(Math.abs(pointer.x - anchor.x) / bounds.width);
  if (bounds.height > 1e-9) ratios.push(Math.abs(pointer.y - anchor.y) / bounds.height);

  // Nothing to scale against: a zero-extent placement has no size to change.
  if (ratios.length === 0) return { scale: placement.scale, x: placement.x, y: placement.y };

  // The larger ratio, so the shape always reaches the cursor rather than
  // lagging behind whichever axis moved less.
  const factor = Math.max(...ratios);
  const scale = clampScale(placement.scale * factor);

  // Recover the factor actually applied, in case the clamp bit.
  const applied = placement.scale === 0 ? 1 : scale / placement.scale;

  return {
    scale,
    x: anchor.x + (placement.x - anchor.x) * applied,
    y: anchor.y + (placement.y - anchor.y) * applied,
  };
}

/** Round an angle to the nearest step. Used for constrained rotation. */
export function snapAngle(degrees, step = 15) {
  if (!(step > 0)) return degrees;
  return Math.round(degrees / step) * step;
}

/** Wrap to [0, 360) so the panel never shows 720° or -45°. */
export function normaliseAngle(degrees) {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Rotation that points the object's top at the cursor.
 *
 * Measured from the placement's stored centre rather than from its bounding
 * box: the bounding box of a rotating object changes shape as it turns, so
 * using it would make the object chase its own handle.
 */
export function rotationTowards(placement, pointer, { step = 0 } = {}) {
  const dx = pointer.x - placement.x;
  const dy = pointer.y - placement.y;

  // Degenerate grab at the exact centre: no direction to point in.
  if (dx === 0 && dy === 0) return placement.rotation;

  // +90 because the handle sits above the object, not to its right.
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI + 90;

  return normaliseAngle(step > 0 ? snapAngle(degrees, step) : degrees);
}

/**
 * Move by a drag, in paper coordinates.
 *
 * Takes the placement's position when the drag began rather than its current
 * one, so rounding from snapping cannot accumulate over a long drag.
 */
export function moveBy(origin, delta) {
  return { x: origin.x + delta.x, y: origin.y + delta.y };
}
