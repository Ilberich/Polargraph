import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scaleFromHandle, oppositeCorner, rotationTowards, snapAngle, normaliseAngle,
  moveBy, MIN_SCALE, MAX_SCALE,
} from './manipulate.js';
import { createPlacement, placementBounds } from './placement.js';
import { createPath } from '../geom/path.js';

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

/** A 100x100 square with its top-left at the origin. */
const square = () =>
  createPlacement({
    paths: [createPath([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    ], { closed: true })],
  });

test('the opposite corner is the diagonal one', () => {
  const b = { minX: 0, minY: 0, maxX: 10, maxY: 20 };

  assert.deepEqual(oppositeCorner(b, 'nw'), { x: 10, y: 20 });
  assert.deepEqual(oppositeCorner(b, 'ne'), { x: 0, y: 20 });
  assert.deepEqual(oppositeCorner(b, 'se'), { x: 0, y: 0 });
  assert.deepEqual(oppositeCorner(b, 'sw'), { x: 10, y: 0 });
});

test('dragging a corner outward doubles the size', () => {
  const placement = square();
  const next = scaleFromHandle(placement, 'se', { x: 200, y: 200 });

  close(next.scale, 2);
});

test('the opposite corner stays put while scaling', () => {
  // The whole point of the gesture: the shape grows from where it is pinned.
  const placement = square();
  const next = { ...placement, ...scaleFromHandle(placement, 'se', { x: 300, y: 300 }) };
  const b = placementBounds(next);

  close(b.minX, 0);
  close(b.minY, 0);
});

test('dragging the north-west corner pins the south-east one', () => {
  const placement = square();
  const next = { ...placement, ...scaleFromHandle(placement, 'nw', { x: -100, y: -100 }) };
  const b = placementBounds(next);

  close(b.maxX, 100);
  close(b.maxY, 100);
  close(next.scale, 2);
});

test('scaling stays uniform', () => {
  // A non-uniformly scaled drawing is a different drawing, not a resized one.
  const placement = square();
  const next = { ...placement, ...scaleFromHandle(placement, 'se', { x: 400, y: 150 }) };
  const b = placementBounds(next);

  close(b.width, b.height);
});

test('scale is clamped, and the centre follows the clamped factor', () => {
  const placement = square();

  const tiny = scaleFromHandle(placement, 'se', { x: 0, y: 0 });
  assert.ok(tiny.scale >= MIN_SCALE);

  const huge = scaleFromHandle({ ...placement, scale: MAX_SCALE }, 'se', { x: 1e9, y: 1e9 });
  assert.equal(huge.scale, MAX_SCALE);
  close(huge.x, placement.x, 1e-6);
});

test('scaling a zero-extent placement does nothing', () => {
  const empty = createPlacement({ paths: [] });
  assert.deepEqual(scaleFromHandle(empty, 'se', { x: 50, y: 50 }), {
    scale: empty.scale, x: empty.x, y: empty.y,
  });
});

test('rotation points the top of the object at the cursor', () => {
  const placement = square(); // centred at (50, 50)

  // Cursor directly above: the object is already upright.
  close(rotationTowards(placement, { x: 50, y: 0 }), 0);
  // Cursor to the right: a quarter turn clockwise.
  close(rotationTowards(placement, { x: 100, y: 50 }), 90);
  // Cursor below.
  close(rotationTowards(placement, { x: 50, y: 100 }), 180);
  // Cursor to the left.
  close(rotationTowards(placement, { x: 0, y: 50 }), 270);
});

test('rotation is measured from the stored centre, not the bounding box', () => {
  // A rotated object's bounding box changes shape as it turns; measuring from
  // it would make the object chase its own handle.
  const placement = { ...square(), rotation: 37 };
  close(rotationTowards(placement, { x: 50, y: 0 }), 0);
});

test('rotation can be constrained to a step', () => {
  const placement = square();
  const free = rotationTowards(placement, { x: 100, y: 45 });
  const stepped = rotationTowards(placement, { x: 100, y: 45 }, { step: 15 });

  assert.ok(free !== stepped);
  close(stepped % 15, 0);
});

test('grabbing exactly at the centre leaves the rotation alone', () => {
  const placement = { ...square(), rotation: 42 };
  assert.equal(rotationTowards(placement, { x: 50, y: 50 }), 42);
});

test('angles normalise into a single turn', () => {
  assert.equal(normaliseAngle(370), 10);
  assert.equal(normaliseAngle(-45), 315);
  assert.equal(normaliseAngle(720), 0);
});

test('angle snapping rounds to the nearest step', () => {
  assert.equal(snapAngle(44, 15), 45);
  assert.equal(snapAngle(7, 15), 0);
  assert.equal(snapAngle(33, 0), 33, 'a zero step is no snapping');
});

test('moving applies a delta to the position at drag start', () => {
  // Using the start position rather than the current one keeps snapping
  // corrections from accumulating over a long drag.
  assert.deepEqual(moveBy({ x: 10, y: 20 }, { x: -3, y: 4 }), { x: 7, y: 24 });
});
