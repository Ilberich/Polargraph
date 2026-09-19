import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layerDepth, applyDepth } from './depth.js';
import { createLayer, resetLayerIds } from './layers.js';
import { createPath, pathLength } from '../geom/path.js';

const line = (length) => createPath([{ x: 0, y: 0 }, { x: length, y: 0 }]);

test('a layer with no depth of its own draws at the job depth', () => {
  resetLayerIds();
  const layer = createLayer();

  assert.deepEqual(layerDepth(layer, -1.5), { z: -1.5, zEnd: null });
  assert.deepEqual(layerDepth(null, -1.5), { z: -1.5, zEnd: null });
});

test('a layer can set its own depth', () => {
  resetLayerIds();
  assert.deepEqual(layerDepth(createLayer({ z: -3 }), -1), { z: -3, zEnd: null });
});

test('equal ends are not a ramp', () => {
  // So setting both fields the same turns the ramp off, rather than ramping
  // from a value to itself and paying for it.
  resetLayerIds();
  assert.deepEqual(layerDepth(createLayer({ z: -2, zEnd: -2 }), 0), { z: -2, zEnd: null });
  assert.deepEqual(layerDepth(createLayer({ z: -2, zEnd: -4 }), 0), { z: -2, zEnd: -4 });
});

test('a depth with no ramp puts the same Z on every point', () => {
  const [path] = applyDepth([line(50)], { z: -2, zEnd: null });
  assert.deepEqual(path.points.map((p) => p.z), [-2, -2]);
});

test('a ramp runs by distance along the stroke, not by vertex', () => {
  // A stroke flattened unevenly would otherwise ramp unevenly: the depth has
  // to follow the paper, not the point count.
  const uneven = createPath([
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 100, y: 0 },
  ]);

  const [path] = applyDepth([uneven], { z: 0, zEnd: -10 });
  const depths = path.points.map((p) => p.z);

  assert.deepEqual(depths, [0, -0.1, -0.2, -10]);
});

test('every stroke ramps along its own length', () => {
  // Not across the drawing: each stroke is a mark of its own, and a ramp
  // shared over the whole job would depend on the order the optimizer chose.
  const paths = applyDepth([line(10), line(100)], { z: 0, zEnd: -4 });

  for (const path of paths) {
    assert.equal(path.points[0].z, 0);
    assert.equal(path.points[path.points.length - 1].z, -4);
  }
});

test('depth does not move the stroke', () => {
  const original = line(30);
  const [path] = applyDepth([original], { z: -1, zEnd: -5 });

  assert.equal(pathLength(path), pathLength(original));
  assert.deepEqual(
    path.points.map((p) => [p.x, p.y]),
    original.points.map((p) => [p.x, p.y])
  );
});

test('the source paths are left alone', () => {
  const original = line(30);
  const before = JSON.stringify(original);

  applyDepth([original], { z: -1, zEnd: -5 });
  assert.equal(JSON.stringify(original), before);
});
