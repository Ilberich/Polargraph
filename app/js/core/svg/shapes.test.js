import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shapeToPathData, SHAPE_TAGS } from './shapes.js';
import { pathDataToPolylines } from './pathdata.js';

const node = (tag, attrs) => ({ tag, attrs, children: [], text: '' });
const close = (a, b, tol = 0.05) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

const bounds = (d) => {
  const pts = pathDataToPolylines(d, 0.01).flatMap((s) => s.points);
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
};

test('every shape tag is handled', () => {
  for (const tag of SHAPE_TAGS) {
    assert.ok(tag === 'path' || shapeToPathData(node(tag, {})) !== undefined);
  }
});

test('a path passes its own d through', () => {
  assert.equal(shapeToPathData(node('path', { d: 'M0 0 L1 1' })), 'M0 0 L1 1');
  assert.equal(shapeToPathData(node('path', {})), null);
});

test('a rect becomes a closed rectangle', () => {
  const [sub] = pathDataToPolylines(
    shapeToPathData(node('rect', { x: '10', y: '20', width: '30', height: '40' }))
  );

  assert.equal(sub.closed, true);
  assert.deepEqual(sub.points, [
    { x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 60 }, { x: 10, y: 60 },
  ]);
});

test('a rect with no extent draws nothing', () => {
  assert.equal(shapeToPathData(node('rect', { width: '0', height: '10' })), null);
  assert.equal(shapeToPathData(node('rect', {})), null);
});

test('a rounded rect keeps its outer bounds', () => {
  const b = bounds(shapeToPathData(
    node('rect', { x: '0', y: '0', width: '100', height: '60', rx: '10' })
  ));

  close(b.minX, 0);
  close(b.maxX, 100);
  close(b.minY, 0);
  close(b.maxY, 60);
});

test('one corner radius implies the other', () => {
  const withRx = shapeToPathData(node('rect', { width: '100', height: '60', rx: '10' }));
  const withRy = shapeToPathData(node('rect', { width: '100', height: '60', ry: '10' }));

  assert.equal(withRx, withRy);
});

test('corner radii are clamped to half the side', () => {
  // rx=500 on a 100-wide rect must not turn it inside out.
  const b = bounds(shapeToPathData(
    node('rect', { width: '100', height: '60', rx: '500', ry: '500' })
  ));

  close(b.minX, 0);
  close(b.maxX, 100);
  close(b.maxY, 60);
});

test('a circle has the right centre and radius', () => {
  const d = shapeToPathData(node('circle', { cx: '50', cy: '50', r: '25' }));
  const pts = pathDataToPolylines(d, 0.01).flatMap((s) => s.points);

  for (const p of pts) close(Math.hypot(p.x - 50, p.y - 50), 25, 0.02);
  assert.equal(pathDataToPolylines(d)[0].closed, true);
});

test('a zero-radius circle draws nothing', () => {
  assert.equal(shapeToPathData(node('circle', { cx: '5', cy: '5', r: '0' })), null);
});

test('an ellipse spans its two radii', () => {
  const b = bounds(shapeToPathData(node('ellipse', { cx: '0', cy: '0', rx: '40', ry: '20' })));

  close(b.minX, -40);
  close(b.maxX, 40);
  close(b.minY, -20);
  close(b.maxY, 20);
});

test('a line is two points', () => {
  const [sub] = pathDataToPolylines(
    shapeToPathData(node('line', { x1: '1', y1: '2', x2: '3', y2: '4' }))
  );

  assert.deepEqual(sub.points, [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  assert.equal(sub.closed, false);
});

test('polyline stays open and polygon closes', () => {
  const attrs = { points: '0,0 10,0 10,10' };

  assert.equal(pathDataToPolylines(shapeToPathData(node('polyline', attrs)))[0].closed, false);
  assert.equal(pathDataToPolylines(shapeToPathData(node('polygon', attrs)))[0].closed, true);
});

test('points accept commas or whitespace, and an odd tail is dropped', () => {
  const spaced = shapeToPathData(node('polyline', { points: '0 0 10 0' }));
  const commas = shapeToPathData(node('polyline', { points: '0,0 10,0' }));

  assert.equal(spaced, commas);
  assert.equal(shapeToPathData(node('polyline', { points: '0,0 10,0 5' })), commas);
});

test('a polyline of one point draws nothing', () => {
  assert.equal(shapeToPathData(node('polyline', { points: '1,1' })), null);
});

test('shape attributes may carry units', () => {
  const [sub] = pathDataToPolylines(
    shapeToPathData(node('rect', { width: '1in', height: '1in' }))
  );

  close(sub.points[1].x, 96, 1e-6);
});

test('a non-shape element yields nothing', () => {
  assert.equal(shapeToPathData(node('g', {})), null);
});
