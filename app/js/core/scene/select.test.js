import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  segmentCount, segmentEnds, distanceToPath, segmentsWithin, pickPath,
  runsOf, splitPathBySelection, assignSelection, rejoinCuts,
} from './select.js';
import { createPath, pathLength } from '../geom/path.js';
import { createPlacement, canHatch } from './placement.js';

/** A horizontal run of unit-length segments along y. */
const run = (n, y = 0) => createPath(
  Array.from({ length: n + 1 }, (_, i) => ({ x: i, y })),
);

/** A unit square, closed: four segments, side 10. */
const square = () => createPath(
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  { closed: true },
);

/** Start a closed path's points at a different index — the same loop. */
const rotate = (points, by) => [...points.slice(by), ...points.slice(0, by)];

const totalLength = (paths) => paths.reduce((sum, p) => sum + pathLength(p), 0);

test('a closed path has one more segment than an open one', () => {
  assert.equal(segmentCount(run(3)), 3);
  assert.equal(segmentCount(square()), 4);
  assert.equal(segmentCount(createPath([{ x: 0, y: 0 }])), 0);
  assert.equal(segmentCount(createPath([])), 0);
});

test('the last segment of a closed path wraps to the start', () => {
  const path = square();
  const [a, b] = segmentEnds(path, 3);

  assert.deepEqual([a.x, a.y], [0, 10]);
  assert.deepEqual([b.x, b.y], [0, 0]);
});

test('distance to a path reports which segment was nearest', () => {
  const path = run(4);
  const hit = distanceToPath(path, { x: 2.5, y: 3 });

  assert.equal(hit.segment, 2);
  assert.equal(hit.distance, 3);
});

test('distance is measured to the segment, not to its ends', () => {
  // A point beside the middle of a long segment is close to the path even
  // though both of its endpoints are far away.
  const path = createPath([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  assert.equal(distanceToPath(path, { x: 50, y: 1 }).distance, 1);
});

test('brushing takes every segment the brush touches', () => {
  const path = run(6);

  // Centred on the vertex between segments 2 and 3, reaching one either side.
  assert.deepEqual(segmentsWithin(path, { x: 3, y: 0 }, 0.5), [2, 3]);
  assert.deepEqual(segmentsWithin(path, { x: 3, y: 0 }, 1.5), [1, 2, 3, 4]);
  assert.deepEqual(segmentsWithin(path, { x: 3, y: 5 }, 0.5), []);
});

test('a long segment is taken when the brush covers its middle', () => {
  const path = createPath([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  assert.deepEqual(segmentsWithin(path, { x: 50, y: 0 }, 1), [0]);
});

test('picking takes the nearest path within tolerance', () => {
  const near = run(4, 0);
  const far = run(4, 5);

  assert.equal(pickPath([near, far], { x: 2, y: 1 }, 3), near);
  assert.equal(pickPath([near, far], { x: 2, y: 4 }, 3), far);
  assert.equal(pickPath([near, far], { x: 2, y: 2.5 }, 1), null);
});

test('runs are contiguous stretches of selected segments', () => {
  assert.deepEqual(runsOf([0, 1, 4, 5, 6], 8, false), [[0, 1], [4, 5, 6]]);
  assert.deepEqual(runsOf([], 4, false), []);
  assert.deepEqual(runsOf([0, 1, 2, 3], 4, false), [[0, 1, 2, 3]]);
});

test('a run across the seam of a closed path is one run, not two', () => {
  // Brushing the top of a circle should not leave a join wherever the path
  // data happened to start.
  assert.deepEqual(runsOf([0, 1, 5], 6, true), [[5, 0, 1]]);
  assert.deepEqual(runsOf([0, 1, 5], 6, false), [[0, 1], [5]]);
});

test('an open path keeps its identity when wholly selected or wholly not', () => {
  const path = run(4);

  assert.deepEqual(
    splitPathBySelection(path, new Set([0, 1, 2, 3])),
    [{ path, selected: true }],
  );
  assert.deepEqual(splitPathBySelection(path, new Set()), [{ path, selected: false }]);
});

test('a partly selected path is cut into pieces that meet end to end', () => {
  const path = run(6);
  const pieces = splitPathBySelection(path, new Set([2, 3]));

  assert.deepEqual(pieces.map((p) => p.selected), [false, true, false]);
  assert.deepEqual(pieces.map((p) => p.path.points.length), [3, 3, 3]);

  // Each piece starts where the last one ended, and nothing is lost.
  for (let i = 1; i < pieces.length; i++) {
    const previous = pieces[i - 1].path.points;
    assert.deepEqual(previous[previous.length - 1], pieces[i].path.points[0]);
  }
  assert.equal(totalLength(pieces.map((p) => p.path)), pathLength(path));
});

test('cutting a closed path gives open pieces covering the whole loop', () => {
  const path = square();
  const pieces = splitPathBySelection(path, new Set([1]));

  // Two pieces, not three: the unselected remainder runs across the seam.
  assert.deepEqual(pieces.map((p) => p.selected), [true, false]);
  assert.deepEqual(pieces.map((p) => pathLength(p.path)), [10, 30]);
  assert.ok(pieces.every((p) => !p.path.closed));
  assert.equal(totalLength(pieces.map((p) => p.path)), pathLength(path));
});

test('a selection across the seam comes out as one piece', () => {
  const path = square();
  const pieces = splitPathBySelection(path, new Set([3, 0]));
  const selected = pieces.filter((p) => p.selected);

  assert.equal(selected.length, 1);
  assert.equal(pathLength(selected[0].path), 20);
  assert.equal(totalLength(pieces.map((p) => p.path)), pathLength(path));
});

test('assigning a whole path to a pen leaves the path alone', () => {
  const a = run(4, 0);
  const b = run(4, 5);
  const placement = createPlacement({ paths: [a, b], layerId: 'l1' });
  const selection = new Map([[b.id, new Set([0, 1, 2, 3])]]);

  const result = assignSelection(placement, selection, 'l2');

  assert.deepEqual(result.paths, [a, b]);
  assert.deepEqual(result.pathLayers, { [b.id]: 'l2' });
});

test('assigning part of a path splits it and moves only that part', () => {
  const path = run(6);
  const placement = createPlacement({ paths: [path], layerId: 'l1' });
  const result = assignSelection(placement, new Map([[path.id, new Set([2, 3])]]), 'l2');

  assert.equal(result.paths.length, 3);
  assert.equal(totalLength(result.paths), pathLength(path));

  const assigned = result.paths.filter((p) => result.pathLayers[p.id] === 'l2');
  assert.equal(assigned.length, 1);
  assert.equal(pathLength(assigned[0]), 2);

  // The pieces left behind stay on the placement's own pen.
  assert.equal(Object.keys(result.pathLayers).length, 1);
});

test('pieces inherit the override the original carried', () => {
  const path = run(6);
  const placement = createPlacement({
    paths: [path], layerId: 'l1', pathLayers: { [path.id]: 'l2' },
  });
  const result = assignSelection(placement, new Map([[path.id, new Set([0])]]), 'l3');

  const [first, rest] = result.paths;
  assert.equal(result.pathLayers[first.id], 'l3');
  assert.equal(result.pathLayers[rest.id], 'l2');
  assert.equal(result.pathLayers[path.id], undefined);
});

test('assigning back to the placement default drops the override', () => {
  const path = run(4);
  const placement = createPlacement({
    paths: [path], layerId: 'l1', pathLayers: { [path.id]: 'l2' },
  });
  const selection = new Map([[path.id, new Set([0, 1, 2, 3])]]);

  const result = assignSelection(placement, selection, 'l1');
  assert.deepEqual(result.pathLayers, {});
});

test('the source paths are not modified', () => {
  const path = run(6);
  const before = JSON.stringify(path);
  const placement = createPlacement({ paths: [path], layerId: 'l1' });

  assignSelection(placement, new Map([[path.id, new Set([2, 3])]]), 'l2');

  assert.equal(JSON.stringify(path), before);
  assert.deepEqual(placement.paths, [path]);
});

test('cut pieces rejoin into the shape they came from', () => {
  const path = square();
  const pieces = splitPathBySelection(path, new Set([1])).map((p) => p.path);
  const [rejoined, ...rest] = rejoinCuts(pieces);

  assert.equal(rest.length, 0);
  assert.equal(rejoined.id, path.id);
  assert.equal(rejoined.closed, true);

  // The same loop, though it may start at a different point: a cut of a closed
  // shape has to begin somewhere, and where a loop starts does not matter.
  assert.deepEqual(rejoined.points, rotate(path.points, 1));
});

test('rejoining leaves uncut paths alone', () => {
  const a = run(3);
  const b = square();

  assert.deepEqual(rejoinCuts([a, b]), [a, b]);
});

test('a piece cut again still rejoins to the original', () => {
  const path = run(6);
  const pieces = splitPathBySelection(path, new Set([2, 3])).map((p) => p.path);
  const again = pieces.flatMap((piece) =>
    splitPathBySelection(piece, new Set([0])).map((p) => p.path));

  const [rejoined] = rejoinCuts(again);
  assert.equal(rejoined.id, path.id);
  assert.deepEqual(rejoined.points, path.points);
});

test('painting part of a closed shape keeps it fillable', () => {
  const path = square();
  const placement = createPlacement({ paths: [path], layerId: 'l1' });
  const result = assignSelection(placement, new Map([[path.id, new Set([1])]]), 'l2');

  // The outline is now two strokes on two pens, but the region is still there.
  assert.equal(result.paths.length, 2);
  assert.equal(canHatch({ ...placement, paths: result.paths }), true);
});
