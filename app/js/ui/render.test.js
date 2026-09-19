import { test } from 'node:test';
import assert from 'node:assert/strict';

import { strokeWidth } from './render.js';

// strokeWidth returns a width in the placement's own units, because the canvas
// already carries both the viewport and placement transforms. Multiplying back
// through gives what appears on screen.
const onScreen = (penWidthMm, viewportScale, placementScale, selected = false) =>
  strokeWidth(penWidthMm, { scale: viewportScale }, placementScale, selected) *
  viewportScale *
  Math.abs(placementScale);

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

test('a stroke is drawn at the pen width when that is visible', () => {
  // 0.5mm pen at 10 px/mm should be 5px on screen.
  close(onScreen(0.5, 10, 1), 5);
});

test('pen width scales with zoom, not with the object', () => {
  // The pen does not get wider because the drawing was scaled up; it lays the
  // same line either way.
  close(onScreen(0.5, 10, 1), onScreen(0.5, 10, 4));
});

test('a hairline is used when the pen would be thinner than one', () => {
  // Zoomed out, a 0.5mm pen is a fraction of a pixel and would vanish.
  close(onScreen(0.5, 0.5, 1), 1.1);
});

test('a selected object gets a slightly heavier hairline', () => {
  assert.ok(onScreen(0.5, 0.5, 1, true) > onScreen(0.5, 0.5, 1, false));
});

test('a wide pen beats the hairline floor', () => {
  close(onScreen(2, 5, 1), 10);
});

test('no pen width still draws a visible hairline', () => {
  close(onScreen(0, 10, 1), 1.1);
});

test('a degenerate scale does not produce a broken width', () => {
  for (const [pen, viewport, placement] of [[0.5, 0, 1], [0.5, 10, 0], [0.5, 0, 0]]) {
    const width = strokeWidth(pen, { scale: viewport }, placement, false);
    assert.ok(Number.isFinite(width) && width > 0, `${viewport}/${placement} gave ${width}`);
  }
});
