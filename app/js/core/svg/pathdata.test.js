import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenizePathData, pathDataToPolylines } from './pathdata.js';

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b} within ${tol}`);

// --------------------------------------------------------------- scanning --

test('commands and parameters scan', () => {
  assert.deepEqual(tokenizePathData('M 10 20 L 30 40'), [
    { command: 'M', params: [10, 20] },
    { command: 'L', params: [30, 40] },
  ]);
});

test('a repeated moveto is an implicit lineto', () => {
  // Miss this and polygons silently become a series of jumps.
  assert.deepEqual(tokenizePathData('M 0 0 10 10 20 20'), [
    { command: 'M', params: [0, 0] },
    { command: 'L', params: [10, 10] },
    { command: 'L', params: [20, 20] },
  ]);
});

test('a repeated relative moveto becomes a relative lineto', () => {
  assert.deepEqual(tokenizePathData('m 0 0 10 10'), [
    { command: 'm', params: [0, 0] },
    { command: 'l', params: [10, 10] },
  ]);
});

test('other commands repeat as themselves', () => {
  assert.deepEqual(tokenizePathData('M0 0 L1 1 2 2'), [
    { command: 'M', params: [0, 0] },
    { command: 'L', params: [1, 1] },
    { command: 'L', params: [2, 2] },
  ]);
});

test('a minus sign separates numbers without whitespace', () => {
  assert.deepEqual(tokenizePathData('M10-5'), [{ command: 'M', params: [10, -5] }]);
});

test('a second decimal point starts a new number', () => {
  assert.deepEqual(tokenizePathData('M1.5.5'), [{ command: 'M', params: [1.5, 0.5] }]);
});

test('exponents scan', () => {
  assert.deepEqual(tokenizePathData('M1e2 3'), [{ command: 'M', params: [100, 3] }]);
  assert.deepEqual(tokenizePathData('M1E2 3'), [{ command: 'M', params: [100, 3] }]);
  assert.deepEqual(tokenizePathData('M1e-2 3'), [{ command: 'M', params: [0.01, 3] }]);
});

test('a stray exponent marker halts the parse', () => {
  // "1e " is not a number and not a command, so the path is malformed from
  // there on. The spec says rendering stops at the first error.
  assert.deepEqual(tokenizePathData('M1e 2'), []);
});

test('arc flags are single digits that may run into the next number', () => {
  // The case that breaks naive scanners: "011 1" is flags 0 and 1, then 1.
  assert.deepEqual(tokenizePathData('M0 0a1 1 0 011 1'), [
    { command: 'M', params: [0, 0] },
    { command: 'a', params: [1, 1, 0, 0, 1, 1, 1] },
  ]);
});

test('scanning stops at a malformed tail rather than throwing', () => {
  assert.deepEqual(tokenizePathData('M0 0 L1'), [{ command: 'M', params: [0, 0] }]);
  assert.deepEqual(tokenizePathData('garbage'), []);
  assert.deepEqual(tokenizePathData(''), []);
});

test('close is recognised in both cases', () => {
  assert.deepEqual(tokenizePathData('M0 0 L1 1 Z'), [
    { command: 'M', params: [0, 0] },
    { command: 'L', params: [1, 1] },
    { command: 'Z', params: [] },
  ]);
  assert.equal(tokenizePathData('M0 0 L1 1 z')[2].command, 'z');
});

// ---------------------------------------------------------------- walking --

test('a simple polyline walks through', () => {
  const [sub] = pathDataToPolylines('M 0 0 L 10 0 L 10 10');

  assert.equal(sub.closed, false);
  assert.deepEqual(sub.points, [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
  ]);
});

test('relative commands accumulate', () => {
  const [sub] = pathDataToPolylines('m 5 5 l 10 0 l 0 10');

  assert.deepEqual(sub.points, [
    { x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 },
  ]);
});

test('H and V move on one axis only', () => {
  const [sub] = pathDataToPolylines('M 0 0 H 10 V 20 h -5 v -5');

  assert.deepEqual(sub.points, [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 },
    { x: 5, y: 20 }, { x: 5, y: 15 },
  ]);
});

test('Z closes the subpath', () => {
  const [sub] = pathDataToPolylines('M 0 0 L 10 0 L 10 10 Z');

  assert.equal(sub.closed, true);
  assert.equal(sub.points.length, 3, 'the closing segment is implied, not stored');
});

test('a moveto starts a new subpath', () => {
  const subs = pathDataToPolylines('M 0 0 L 1 1 M 10 10 L 11 11');

  assert.equal(subs.length, 2);
  assert.deepEqual(subs[1].points[0], { x: 10, y: 10 });
});

test('drawing after Z resumes from the subpath start', () => {
  const subs = pathDataToPolylines('M 5 5 L 10 5 Z L 5 10');

  assert.equal(subs.length, 2);
  assert.deepEqual(subs[1].points[0], { x: 5, y: 5 });
  assert.deepEqual(subs[1].points[1], { x: 5, y: 10 });
});

test('a subpath of a single point is dropped', () => {
  assert.deepEqual(pathDataToPolylines('M 5 5'), []);
});

test('curves are flattened between their endpoints', () => {
  const [sub] = pathDataToPolylines('M 0 0 C 0 50 50 50 50 0', 0.01);

  assert.deepEqual(sub.points[0], { x: 0, y: 0 });
  close(sub.points[sub.points.length - 1].x, 50);
  close(sub.points[sub.points.length - 1].y, 0);
  assert.ok(sub.points.length > 4, 'a bent curve needs intermediate points');
});

test('S reflects the previous cubic control point', () => {
  // Reflecting (0,50) about (50,0) gives (100,-50), so the curve leaves
  // upward. Without reflection it would head the other way.
  const [sub] = pathDataToPolylines('M 0 0 C 0 50 50 50 50 0 S 100 50 100 0', 0.05);
  const afterJoin = sub.points.find((p) => p.x > 50);

  assert.ok(afterJoin.y < 0, `expected the curve to rise, got y=${afterJoin.y}`);
});

test('S without a preceding cubic reflects the current point', () => {
  const [sub] = pathDataToPolylines('M 0 0 S 50 50 100 0', 0.05);

  close(sub.points[sub.points.length - 1].x, 100);
  close(sub.points[sub.points.length - 1].y, 0);
});

test('T reflects the previous quadratic control point', () => {
  const [sub] = pathDataToPolylines('M 0 0 Q 25 50 50 0 T 100 0', 0.05);
  const second = sub.points.filter((p) => p.x > 50);

  assert.ok(second.some((p) => p.y < 0), 'the reflected hump goes the other way');
  close(sub.points[sub.points.length - 1].x, 100);
});

// ------------------------------------------------------------------ arcs --

test('two arcs make a circle of the right radius and extent', () => {
  const [sub] = pathDataToPolylines(
    'M 0 50 A 50 50 0 1 0 100 50 A 50 50 0 1 0 0 50', 0.01
  );

  for (const p of sub.points) {
    close(Math.hypot(p.x - 50, p.y - 50), 50, 0.02);
  }

  const xs = sub.points.map((p) => p.x);
  const ys = sub.points.map((p) => p.y);

  close(Math.min(...xs), 0, 0.02);
  close(Math.max(...xs), 100, 0.02);
  close(Math.min(...ys), 0, 0.02);
  close(Math.max(...ys), 100, 0.02);
});

test('the sweep flag picks which way round the arc goes', () => {
  const [cw] = pathDataToPolylines('M 0 0 A 50 50 0 0 1 100 0', 0.05);
  const [ccw] = pathDataToPolylines('M 0 0 A 50 50 0 0 0 100 0', 0.05);

  const cwMid = cw.points[Math.floor(cw.points.length / 2)];
  const ccwMid = ccw.points[Math.floor(ccw.points.length / 2)];

  assert.ok(cwMid.y * ccwMid.y < 0, 'the two sweeps bulge to opposite sides');
});

test('the large-arc flag picks the longer way round', () => {
  // The radius must exceed half the chord, or both flags describe the same
  // semicircle and the comparison is vacuous.
  const [small] = pathDataToPolylines('M 0 0 A 80 80 0 0 1 100 0', 0.05);
  const [large] = pathDataToPolylines('M 0 0 A 80 80 0 1 1 100 0', 0.05);

  const extent = (sub) => Math.max(...sub.points.map((p) => Math.abs(p.y)));

  close(extent(small), 80 - Math.sqrt(80 * 80 - 50 * 50), 0.05);
  close(extent(large), 80 + Math.sqrt(80 * 80 - 50 * 50), 0.05);
  assert.ok(extent(large) > extent(small));
});

test('radii too small to span the endpoints are scaled up', () => {
  // rx=ry=10 cannot reach from (0,0) to (100,0); the spec says enlarge them.
  const [sub] = pathDataToPolylines('M 0 0 A 10 10 0 0 1 100 0', 0.05);
  const last = sub.points[sub.points.length - 1];

  close(last.x, 100, 1e-6);
  close(last.y, 0, 1e-6);
  assert.ok(Math.max(...sub.points.map((p) => Math.abs(p.y))) > 10);
});

test('a zero radius degenerates to a straight line', () => {
  const [sub] = pathDataToPolylines('M 0 0 A 0 0 0 0 1 50 50');

  assert.deepEqual(sub.points, [{ x: 0, y: 0 }, { x: 50, y: 50 }]);
});

test('a rotated ellipse arc still lands on its endpoint', () => {
  const [sub] = pathDataToPolylines('M 10 10 A 40 20 30 1 1 60 40', 0.01);
  const last = sub.points[sub.points.length - 1];

  close(last.x, 60, 1e-6);
  close(last.y, 40, 1e-6);
});
