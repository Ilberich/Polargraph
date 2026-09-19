import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createViewport, toScreen, toPaper, pan, zoomAt, setScale, fitToCanvas,
  screenToPaperDistance, MIN_SCALE, MAX_SCALE,
} from './viewport.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

test('paper and screen coordinates round-trip', () => {
  const viewport = createViewport({ scale: 2.5, x: 40, y: -15 });
  const point = { x: 123.4, y: -56.7 };
  const back = toPaper(viewport, toScreen(viewport, point));

  close(back.x, point.x, 1e-9);
  close(back.y, point.y, 1e-9);
});

test('scale is pixels per millimetre', () => {
  const viewport = createViewport({ scale: 3, x: 0, y: 0 });
  assert.deepEqual(toScreen(viewport, { x: 10, y: 20 }), { x: 30, y: 60 });
});

test('panning shifts the origin without changing scale', () => {
  const panned = pan(createViewport({ scale: 2, x: 10, y: 10 }), 5, -5);

  assert.deepEqual(panned, { scale: 2, x: 15, y: 5 });
});

test('zooming keeps the paper point under the cursor fixed', () => {
  // The whole difference between zoom feeling controlled and feeling like the
  // drawing is running away.
  const viewport = createViewport({ scale: 1.7, x: 33, y: -12 });
  const cursor = { x: 220, y: 140 };
  const before = toPaper(viewport, cursor);

  const zoomed = zoomAt(viewport, cursor, 1.8);
  const after = toPaper(zoomed, cursor);

  close(after.x, before.x, 1e-9);
  close(after.y, before.y, 1e-9);
});

test('zooming out then in returns to the same view', () => {
  const viewport = createViewport({ scale: 2, x: 10, y: 20 });
  const cursor = { x: 100, y: 100 };
  const back = zoomAt(zoomAt(viewport, cursor, 0.5), cursor, 2);

  close(back.scale, 2, 1e-9);
  close(back.x, 10, 1e-9);
  close(back.y, 20, 1e-9);
});

test('scale is clamped at both ends', () => {
  const cursor = { x: 0, y: 0 };

  assert.equal(zoomAt(createViewport({ scale: MAX_SCALE }), cursor, 10).scale, MAX_SCALE);
  assert.equal(zoomAt(createViewport({ scale: MIN_SCALE }), cursor, 0.01).scale, MIN_SCALE);
});

test('a zoom swallowed by the clamp does not shift the view', () => {
  const viewport = createViewport({ scale: MAX_SCALE, x: 37, y: 91 });
  assert.deepEqual(zoomAt(viewport, { x: 100, y: 50 }, 2), viewport);
});

test('setScale reaches the requested scale about a point', () => {
  const viewport = createViewport({ scale: 1, x: 0, y: 0 });
  const centre = { x: 400, y: 300 };
  const scaled = setScale(viewport, 4, centre);

  close(scaled.scale, 4);
  close(toPaper(scaled, centre).x, toPaper(viewport, centre).x, 1e-9);
});

test('fitting centres the paper in the canvas', () => {
  const paper = { widthMm: 100, heightMm: 100 };
  const viewport = fitToCanvas(paper, { width: 800, height: 400 }, 20);

  // Height is the binding dimension: (400 - 40) / 100.
  close(viewport.scale, 3.6);

  const topLeft = toScreen(viewport, { x: 0, y: 0 });
  const bottomRight = toScreen(viewport, { x: 100, y: 100 });

  close((topLeft.x + bottomRight.x) / 2, 400, 1e-9);
  close((topLeft.y + bottomRight.y) / 2, 200, 1e-9);
});

test('fitting respects the padding', () => {
  const viewport = fitToCanvas({ widthMm: 100, heightMm: 100 }, { width: 200, height: 200 }, 25);
  close(viewport.scale, 1.5);
});

test('fitting a tall paper into a short canvas still fits', () => {
  const viewport = fitToCanvas({ widthMm: 210, heightMm: 2970 }, { width: 800, height: 600 }, 10);
  const corner = toScreen(viewport, { x: 210, y: 2970 });

  assert.ok(corner.y <= 600 - 10 + 1e-6, `bottom at ${corner.y}`);
});

test('fitting a degenerate canvas does not produce a broken viewport', () => {
  const viewport = fitToCanvas({ widthMm: 100, heightMm: 100 }, { width: 0, height: 0 }, 32);

  assert.ok(Number.isFinite(viewport.scale) && viewport.scale >= MIN_SCALE);
  assert.ok(Number.isFinite(viewport.x) && Number.isFinite(viewport.y));
});

test('screen distances convert to paper distances', () => {
  close(screenToPaperDistance(createViewport({ scale: 4 }), 12), 3);
});
