import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlacement, placementMatrix, placementBounds, worldPaths, hitTest,
  placementLength, resetIds, placementPaths, canHatch,
} from './placement.js';
import { createPath } from '../geom/path.js';
import { apply } from '../geom/matrix.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

/** A 10x20 rectangle whose top-left sits at (100, 200). */
const rect = () =>
  createPath([
    { x: 100, y: 200 }, { x: 110, y: 200 }, { x: 110, y: 220 }, { x: 100, y: 220 },
  ], { closed: true });

test('a placement lands where the source put it', () => {
  const placement = createPlacement({ paths: [rect()] });
  const b = placementBounds(placement);

  assert.deepEqual(
    [b.minX, b.minY, b.maxX, b.maxY],
    [100, 200, 110, 220],
    'an import must appear where it was authored'
  );
});

test('the pivot is the centre of the source bounds', () => {
  const placement = createPlacement({ paths: [rect()] });
  assert.deepEqual(placement.pivot, { x: 105, y: 210 });
});

test('position is the centre, so moving it centres it there', () => {
  const placement = createPlacement({ paths: [rect()], x: 0, y: 0 });
  const b = placementBounds(placement);

  assert.deepEqual([b.minX, b.minY, b.maxX, b.maxY], [-5, -10, 5, 10]);
});

test('scaling grows about the centre, not a corner', () => {
  const placement = createPlacement({ paths: [rect()], scale: 2 });
  const b = placementBounds(placement);

  close(b.width, 20);
  close(b.height, 40);
  close((b.minX + b.maxX) / 2, 105, 1e-9);
  close((b.minY + b.maxY) / 2, 210, 1e-9);
});

test('rotation spins about the centre', () => {
  const placement = createPlacement({ paths: [rect()], rotation: 90 });
  const b = placementBounds(placement);

  close(b.width, 20, 1e-9);
  close(b.height, 10, 1e-9);
  close((b.minX + b.maxX) / 2, 105, 1e-9);
  close((b.minY + b.maxY) / 2, 210, 1e-9);
});

test('rotating by 360 degrees returns the original bounds', () => {
  const b = placementBounds(createPlacement({ paths: [rect()], rotation: 360 }));

  close(b.minX, 100, 1e-9);
  close(b.maxY, 220, 1e-9);
});

test('source paths are never modified', () => {
  const source = rect();
  const placement = createPlacement({ paths: [source], x: 0, y: 0, scale: 3 });

  worldPaths(placement);
  placementBounds(placement);

  assert.deepEqual(source.points[0], { x: 100, y: 200, z: 0 });
});

test('world paths carry the placement transform', () => {
  const placement = createPlacement({ paths: [rect()], x: 0, y: 0 });
  const [path] = worldPaths(placement);

  assert.deepEqual(
    { x: path.points[0].x, y: path.points[0].y },
    { x: -5, y: -10 }
  );
});

test('world paths preserve Z', () => {
  const path = createPath([{ x: 0, y: 0, z: -2 }, { x: 10, y: 0, z: -3 }]);
  const [out] = worldPaths(createPlacement({ paths: [path], scale: 5 }));

  assert.deepEqual(out.points.map((p) => p.z), [-2, -3]);
});

test('the matrix and the bounds agree', () => {
  const placement = createPlacement({ paths: [rect()], rotation: 30, scale: 1.5, x: 7, y: 9 });
  const matrix = placementMatrix(placement);
  const b = placementBounds(placement);

  for (const path of placement.paths) {
    for (const point of path.points) {
      const world = apply(matrix, point);
      assert.ok(world.x >= b.minX - 1e-9 && world.x <= b.maxX + 1e-9);
      assert.ok(world.y >= b.minY - 1e-9 && world.y <= b.maxY + 1e-9);
    }
  }
});

test('hit testing covers the bounds, with optional slack', () => {
  const placement = createPlacement({ paths: [rect()] });

  assert.equal(hitTest(placement, { x: 105, y: 210 }), true);
  assert.equal(hitTest(placement, { x: 99, y: 210 }), false);
  assert.equal(hitTest(placement, { x: 99, y: 210 }, 2), true);
});

test('length scales with the placement', () => {
  const placement = createPlacement({ paths: [rect()] });

  close(placementLength(placement), 60, 1e-9);
  close(placementLength({ ...placement, scale: 2 }), 120, 1e-9);
});

test('an empty placement has zero extent and does not throw', () => {
  const placement = createPlacement({ paths: [] });
  const b = placementBounds(placement);

  assert.equal(b.width, 0);
  assert.equal(placementLength(placement), 0);
});

test('ids are unique', () => {
  resetIds();
  const a = createPlacement({ paths: [] });
  const b = createPlacement({ paths: [] });

  assert.notEqual(a.id, b.id);
});

// ------------------------------------------------------------ hatch fill --

test('a placement starts with hatch off', () => {
  const placement = createPlacement({ paths: [rect()] });

  assert.equal(placement.hatch.enabled, false);
  assert.deepEqual(placementPaths(placement), placement.paths);
});

test('closed shapes can be hatched, open ones cannot', () => {
  assert.equal(canHatch(createPlacement({ paths: [rect()] })), true);
  assert.equal(
    canHatch(createPlacement({ paths: [createPath([{ x: 0, y: 0 }, { x: 5, y: 5 }])] })),
    false
  );
});

test('enabling hatch adds fill lines to the placement', () => {
  const placement = createPlacement({
    paths: [rect()],
    hatch: { enabled: true, spacingMm: 2, angleDeg: 0 },
  });

  const paths = placementPaths(placement);
  assert.ok(paths.length > 1, 'the outline plus fill lines');
  assert.equal(paths[0], placement.paths[0], 'the outline is still first');
});

test('hatch is included in the placement length', () => {
  const plain = createPlacement({ paths: [rect()] });
  const filled = createPlacement({
    paths: [rect()],
    hatch: { enabled: true, spacingMm: 2, angleDeg: 0 },
  });

  assert.ok(placementLength(filled) > placementLength(plain));
});

test('hatch transforms with the shape', () => {
  const placement = createPlacement({
    paths: [rect()],
    hatch: { enabled: true, spacingMm: 5, angleDeg: 0 },
    scale: 2,
  });

  // Every hatch line must still land inside the scaled outline.
  const b = placementBounds(placement);
  for (const path of worldPaths(placement)) {
    for (const p of path.points) {
      assert.ok(p.x >= b.minX - 1e-6 && p.x <= b.maxX + 1e-6);
      assert.ok(p.y >= b.minY - 1e-6 && p.y <= b.maxY + 1e-6);
    }
  }
});

test('hatch is computed once and reused across moves', () => {
  // Moving a placement makes a new object but keeps the same source paths, so
  // the fill must not be recomputed on every frame of a drag.
  const placement = createPlacement({
    paths: [rect()],
    hatch: { enabled: true, spacingMm: 1, angleDeg: 0 },
  });

  const before = placementPaths(placement);
  const moved = { ...placement, x: placement.x + 50 };

  assert.equal(placementPaths(moved), before, 'same array, not merely equal');
});

test('changing hatch settings recomputes', () => {
  const placement = createPlacement({
    paths: [rect()],
    hatch: { enabled: true, spacingMm: 5, angleDeg: 0 },
  });

  const coarse = placementPaths(placement);
  const fine = placementPaths({ ...placement, hatch: { ...placement.hatch, spacingMm: 1 } });

  assert.ok(fine.length > coarse.length);
});
