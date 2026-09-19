import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPath, pathLength, transformPath, reversePath, pathBounds, boundsOf,
  startPoint, endPoint, withZ, rampZ, isDegenerate,
} from './path.js';
import { translation, rotation, scaling, compose } from './matrix.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

test('points default to z = 0 so 2D callers need not care', () => {
  const path = createPath([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.equal(path.points[0].z, 0);
});

test('an explicit z is preserved', () => {
  const path = createPath([{ x: 0, y: 0, z: -1.5 }]);
  assert.equal(path.points[0].z, -1.5);
});

test('length measures XY only, ignoring pen height', () => {
  const flat = createPath([{ x: 0, y: 0 }, { x: 3, y: 4 }]);
  const ramped = createPath([{ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: -99 }]);

  close(pathLength(flat), 5);
  close(pathLength(ramped), 5, 1e-9);
});

test('closing a path adds the segment back to the start', () => {
  const square = createPath(
    [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
    { closed: true }
  );

  close(pathLength(square), 8);
});

test('a closed path ends where it starts', () => {
  const path = createPath([{ x: 0, y: 0 }, { x: 5, y: 5 }], { closed: true });
  assert.deepEqual(endPoint(path), startPoint(path));
});

test('transforms move XY and leave Z alone', () => {
  const path = createPath([{ x: 1, y: 0, z: -2 }]);
  const moved = transformPath(path, compose(rotation(90), translation(10, 0)));

  close(moved.points[0].x, 10);
  close(moved.points[0].y, 1);
  assert.equal(moved.points[0].z, -2, 'Z is a machine axis, not a paper one');
});

test('reversing carries per-vertex Z with the points', () => {
  const path = createPath([
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: -1 },
    { x: 2, y: 0, z: -2 },
  ]);
  const back = reversePath(path);

  assert.deepEqual(
    back.points.map((p) => [p.x, p.z]),
    [[2, -2], [1, -1], [0, 0]],
    'the depth ramp must still run along the same physical stroke'
  );
});

test('bounds cover the extents', () => {
  const b = pathBounds(createPath([{ x: -1, y: 4 }, { x: 3, y: -2 }]));

  assert.deepEqual(
    [b.minX, b.minY, b.maxX, b.maxY, b.width, b.height],
    [-1, -2, 3, 4, 4, 6]
  );
});

test('bounds of no drawable paths is null', () => {
  assert.equal(pathBounds(createPath([])), null);
  assert.equal(boundsOf([createPath([])]), null);
  assert.equal(boundsOf([]), null);
});

test('boundsOf unions several paths', () => {
  const b = boundsOf([
    createPath([{ x: 0, y: 0 }, { x: 1, y: 1 }]),
    createPath([{ x: 10, y: -5 }]),
  ]);

  assert.deepEqual([b.minX, b.minY, b.maxX, b.maxY], [0, -5, 10, 1]);
});

test('a path of fewer than two points draws nothing', () => {
  assert.equal(isDegenerate(createPath([{ x: 1, y: 1 }])), true);
  assert.equal(isDegenerate(createPath([{ x: 1, y: 1 }, { x: 2, y: 2 }])), false);
});

test('withZ sets a uniform depth', () => {
  const path = withZ(createPath([{ x: 0, y: 0 }, { x: 1, y: 0 }]), -3);
  assert.deepEqual(path.points.map((p) => p.z), [-3, -3]);
});

test('rampZ interpolates by distance, not by point index', () => {
  // Points are bunched at the start; a naive index ramp would reach halfway
  // depth at the midpoint of the list rather than of the stroke.
  const path = createPath([
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 10, y: 0 },
  ]);
  const ramped = rampZ(path, 0, -10);

  close(ramped.points[0].z, 0);
  close(ramped.points[1].z, -1, 1e-9);
  close(ramped.points[2].z, -2, 1e-9);
  close(ramped.points[3].z, -10, 1e-9);
});

test('rampZ on a zero-length path takes the end depth', () => {
  const ramped = rampZ(createPath([{ x: 1, y: 1 }, { x: 1, y: 1 }]), 0, -5);
  assert.deepEqual(ramped.points.map((p) => p.z), [-5, -5]);
});

test('scaling scales length', () => {
  const path = createPath([{ x: 0, y: 0 }, { x: 0, y: 10 }]);
  close(pathLength(transformPath(path, scaling(3))), 30);
});
