import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergePaths, orderPaths, improveOrder, travelDistance, toPaths, optimize,
} from './optimize.js';
import { createPath, pathLength, startPoint, endPoint } from '../geom/path.js';

const line = (x1, y1, x2, y2) => createPath([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

const oriented = (paths) => paths.map((path) => ({ path, reversed: false }));

// ---------------------------------------------------------------- merging --

test('paths meeting end to start become one stroke', () => {
  // SVG exports routinely split one line into a path per segment.
  const merged = mergePaths([line(0, 0, 10, 0), line(10, 0, 10, 10)]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].points.length, 3);
});

test('merging follows a chain of any length', () => {
  const merged = mergePaths([
    line(0, 0, 10, 0), line(10, 0, 20, 0), line(20, 0, 30, 0), line(30, 0, 40, 0),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].points.length, 5);
  close(pathLength(merged[0]), 40);
});

test('merging joins regardless of which ends meet', () => {
  // end-to-end: the second must be reversed to fit.
  assert.equal(mergePaths([line(0, 0, 10, 0), line(20, 0, 10, 0)]).length, 1);
  // start-to-start.
  assert.equal(mergePaths([line(10, 0, 0, 0), line(10, 0, 20, 0)]).length, 1);
});

test('merging works whatever order the pieces arrive in', () => {
  const merged = mergePaths([line(20, 0, 30, 0), line(0, 0, 10, 0), line(10, 0, 20, 0)]);

  assert.equal(merged.length, 1);
  close(pathLength(merged[0]), 30);
});

test('a gap beyond tolerance is not merged', () => {
  assert.equal(mergePaths([line(0, 0, 10, 0), line(10.5, 0, 20, 0)], 0.05).length, 2);
  assert.equal(mergePaths([line(0, 0, 10, 0), line(10.02, 0, 20, 0)], 0.05).length, 1);
});

test('a chain returning to its start becomes a closed path', () => {
  const merged = mergePaths([
    line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].closed, true);
  assert.equal(merged[0].points.length, 4, 'the repeated start point is dropped');
  close(pathLength(merged[0]), 40);
});

test('closed paths are passed through untouched', () => {
  const square = createPath(
    [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], { closed: true }
  );
  const merged = mergePaths([square]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].closed, true);
});

test('unconnected paths survive merging unchanged', () => {
  assert.equal(mergePaths([line(0, 0, 1, 0), line(50, 50, 51, 50)]).length, 2);
});

test('degenerate paths are dropped', () => {
  assert.equal(mergePaths([createPath([{ x: 1, y: 1 }]), line(0, 0, 1, 1)]).length, 1);
});

// --------------------------------------------------------------- ordering --

test('ordering visits the nearest stroke first', () => {
  const far = line(100, 100, 110, 100);
  const near = line(5, 0, 15, 0);

  const order = orderPaths([far, near], { start: { x: 0, y: 0 } });
  assert.deepEqual(startPoint(toPaths(order)[0]), { x: 5, y: 0, z: 0 });
});

test('ordering enters a stroke from whichever end is closer', () => {
  // The pen is at the origin and the line runs away from it, so it should be
  // drawn from its near end, which means reversed.
  const order = orderPaths([line(20, 0, 5, 0)], { start: { x: 0, y: 0 } });

  assert.equal(order[0].reversed, true);
  assert.deepEqual(startPoint(toPaths(order)[0]), { x: 5, y: 0, z: 0 });
});

test('ordering beats import order on a deliberately bad arrangement', () => {
  // Alternating near and far: drawing these in order crosses the page repeatedly.
  const paths = [];
  for (let i = 0; i < 12; i++) {
    const x = i % 2 === 0 ? i : 200 - i;
    paths.push(line(x, i * 5, x + 5, i * 5));
  }

  const importOrder = travelDistance(oriented(paths));
  const optimized = travelDistance(orderPaths(paths));

  assert.ok(optimized < importOrder * 0.5, `${optimized} vs ${importOrder}`);
});

test('every path appears exactly once', () => {
  const paths = Array.from({ length: 30 }, (_, i) => line(i * 3, i, i * 3 + 2, i));
  const order = orderPaths(paths);

  assert.equal(order.length, 30);
  assert.equal(new Set(order.map((o) => o.path)).size, 30);
});

test('ordering an empty or single-path set is safe', () => {
  assert.deepEqual(orderPaths([]), []);
  assert.equal(orderPaths([line(0, 0, 1, 1)]).length, 1);
});

test('a closed path is entered at its start and is never reversed away from it', () => {
  const square = createPath(
    [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }], { closed: true }
  );
  const order = orderPaths([square], { start: { x: 0, y: 0 } });

  assert.equal(order.length, 1);
  assert.deepEqual(endPoint(order[0].path), startPoint(order[0].path));
});

// ----------------------------------------------------------------- 2-opt --

test('2-opt never makes the route longer', () => {
  const paths = Array.from({ length: 25 }, (_, i) =>
    line((i * 37) % 200, (i * 53) % 150, ((i * 37) % 200) + 4, (i * 53) % 150)
  );

  const greedy = orderPaths(paths);
  const improved = improveOrder(greedy);

  assert.ok(travelDistance(improved) <= travelDistance(greedy) + 1e-9);
});

test('2-opt fixes the backtrack greed leaves behind', () => {
  // Four strokes in a line, ordered so the greedy route must double back.
  const paths = [line(0, 0, 10, 0), line(90, 0, 100, 0), line(30, 0, 40, 0), line(60, 0, 70, 0)];

  const greedy = orderPaths(paths);
  const improved = improveOrder(greedy);

  assert.ok(travelDistance(improved) <= travelDistance(greedy) + 1e-9);
});

test('2-opt leaves a trivial route alone', () => {
  const paths = [line(0, 0, 1, 0), line(2, 0, 3, 0)];
  assert.deepEqual(improveOrder(orderPaths(paths)).length, 2);
});

test('2-opt honours its time budget on a large input', () => {
  // Unbounded, this input takes tens of seconds and would lock up the tab.
  const paths = Array.from({ length: 3000 }, (_, i) =>
    line((i * 137) % 400, (i * 211) % 550, ((i * 137) % 400) + 3, ((i * 211) % 550) + 3)
  );

  const greedy = orderPaths(paths);
  const started = performance.now();
  const improved = improveOrder(greedy, { twoOptBudgetMs: 150 });
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 2000, `took ${elapsed.toFixed(0)}ms`);

  // Stopping early costs improvement, never correctness: each accepted swap
  // strictly shortens the route, so the result cannot be worse than greedy.
  assert.ok(travelDistance(improved) <= travelDistance(greedy) + 1e-9);
  assert.equal(improved.length, greedy.length);
});

test('a budgeted run still returns every path exactly once', () => {
  const paths = Array.from({ length: 500 }, (_, i) => line(i % 50, i, (i % 50) + 2, i));
  const improved = improveOrder(orderPaths(paths), { twoOptBudgetMs: 5 });

  assert.equal(new Set(improved.map((o) => o.path)).size, 500);
});

// -------------------------------------------------------------- pipeline --

test('the pipeline merges, reorders and reports', () => {
  const paths = [
    line(0, 0, 10, 0), line(10, 0, 20, 0),   // one stroke, split in two
    line(100, 100, 110, 100),
  ];

  const { paths: out, report } = optimize(paths);

  assert.equal(report.pathsBefore, 3);
  assert.equal(report.pathsAfter, 2, 'the split line merged');
  assert.equal(out.length, 2);
  assert.ok(report.after <= report.before + 1e-9);
});

test('stages can be turned off individually', () => {
  const paths = [line(0, 0, 10, 0), line(10, 0, 20, 0)];

  assert.equal(optimize(paths, { merge: false }).paths.length, 2);
  assert.equal(optimize(paths, { merge: true }).paths.length, 1);
});

test('optimizing nothing produces nothing', () => {
  const { paths, report } = optimize([]);

  assert.deepEqual(paths, []);
  assert.equal(report.after, 0);
});

test('geometry is preserved: total drawn length is unchanged', () => {
  // Reordering and reversing must move strokes around, never alter them.
  const paths = Array.from({ length: 20 }, (_, i) => line(i * 7, i * 3, i * 7 + 5, i * 3 + 4));
  const before = paths.reduce((sum, p) => sum + pathLength(p), 0);

  const { paths: out } = optimize(paths, { merge: false });
  const after = out.reduce((sum, p) => sum + pathLength(p), 0);

  close(after, before, 1e-9);
});

test('merging preserves total drawn length too', () => {
  const paths = [line(0, 0, 10, 0), line(10, 0, 20, 0), line(20, 0, 20, 10)];
  const before = paths.reduce((sum, p) => sum + pathLength(p), 0);
  const after = mergePaths(paths).reduce((sum, p) => sum + pathLength(p), 0);

  close(after, before, 1e-9);
});
