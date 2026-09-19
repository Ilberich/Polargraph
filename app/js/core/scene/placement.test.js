import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlacement, placementMatrix, placementBounds, worldPaths, hitTest,
  placementLength, resetIds, placementPaths, canHatch, fillableShapes, topLevelShapes,
} from './placement.js';
import { createPath } from '../geom/path.js';
import { apply } from '../geom/matrix.js';
import { isInside } from '../geom/hatch.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

/** A 10x20 rectangle whose top-left sits at (100, 200). */
const rect = () =>
  createPath([
    { x: 100, y: 200 }, { x: 110, y: 200 }, { x: 110, y: 220 }, { x: 100, y: 220 },
  ], { closed: true });

/** A placement with every closed shape in it filled. */
const filledPlacement = (options) => {
  const placement = createPlacement(options);
  const fills = Object.fromEntries(fillableShapes(placement).map((s) => [s.id, null]));

  return { ...placement, fills };
};

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

test('a placement starts with nothing filled', () => {
  const placement = createPlacement({ paths: [rect()] });

  assert.deepEqual(placement.fills, {});
  assert.deepEqual(placementPaths(placement), placement.paths);
});

test('closed shapes can be hatched, open ones cannot', () => {
  assert.equal(canHatch(createPlacement({ paths: [rect()] })), true);
  assert.equal(
    canHatch(createPlacement({ paths: [createPath([{ x: 0, y: 0 }, { x: 5, y: 5 }])] })),
    false
  );
});

test('a closed shape is only filled once it is chosen', () => {
  // Filling everything closed is rarely what a drawing wants, so nothing is
  // filled until the fill tool says so.
  const placement = createPlacement({
    paths: [rect()],
    hatch: { spacingMm: 2, angleDeg: 0 },
  });

  assert.equal(placementPaths(placement), placement.paths);

  const chosen = { ...placement, fills: { [placement.paths[0].id]: null } };
  const paths = placementPaths(chosen);

  assert.ok(paths.length > 1, 'the outline plus fill lines');
  assert.equal(paths[0], placement.paths[0], 'the outline is still first');
});

test('a fill draws on its own layer, not the shape\u2019s', () => {
  const placement = createPlacement({
    paths: [rect()],
    hatch: { spacingMm: 2, angleDeg: 0 },
    layerId: 'l1',
  });

  const filled = { ...placement, fills: { [placement.paths[0].id]: 'l2' } };
  const lines = placementPaths(filled).slice(1);

  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => line.meta.fillLayerId === 'l2'));
});

test('hatch is included in the placement length', () => {
  const plain = createPlacement({ paths: [rect()] });
  const filled = filledPlacement({
    paths: [rect()],
    hatch: { spacingMm: 2, angleDeg: 0 },
  });

  assert.ok(placementLength(filled) > placementLength(plain));
});

test('hatch transforms with the shape', () => {
  const placement = filledPlacement({
    paths: [rect()],
    hatch: { spacingMm: 5, angleDeg: 0 },
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

test('hatch spacing is measured on paper, not in source units', () => {
  // A stated 0.5mm must be 0.5mm on the sheet whatever the object is scaled
  // to — it is chosen against a physical pen.
  const plain = filledPlacement({
    paths: [rect()],
    hatch: { spacingMm: 2, angleDeg: 0 },
  });
  const scaled = filledPlacement({
    paths: [rect()],
    hatch: { spacingMm: 2, angleDeg: 0 },
    scale: 4,
  });

  // Four times the area across, so four times the lines at the same paper gap.
  const lines = (p) => placementPaths(p).length - p.paths.length;
  assert.ok(lines(plain) > 0);
  assert.ok(
    lines(scaled) >= lines(plain) * 3.5,
    `expected about 4x the lines, got ${lines(scaled)} vs ${lines(plain)}`
  );
});

test('a zero scale does not make spacing meaningless', () => {
  const placement = filledPlacement({
    paths: [rect()],
    hatch: { spacingMm: 2, angleDeg: 0 },
    scale: 0,
  });

  assert.doesNotThrow(() => placementPaths(placement));
});

test('hatch is computed once and reused across moves', () => {
  // Moving a placement makes a new object but keeps the same source paths, so
  // the fill must not be recomputed on every frame of a drag.
  const placement = filledPlacement({
    paths: [rect()],
    hatch: { spacingMm: 1, angleDeg: 0 },
  });

  const before = placementPaths(placement);
  const moved = { ...placement, x: placement.x + 50 };

  assert.ok(before.length > 1);
  assert.equal(placementPaths(moved), before, 'same array, not merely equal');
});

test('changing hatch settings recomputes', () => {
  const placement = filledPlacement({
    paths: [rect()],
    hatch: { spacingMm: 5, angleDeg: 0 },
  });

  const coarse = placementPaths(placement);
  const fine = placementPaths({ ...placement, hatch: { ...placement.hatch, spacingMm: 1 } });

  assert.ok(fine.length > coarse.length);
});

test('choosing a different shape recomputes', () => {
  const a = rect();
  const b = createPath(
    [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
    { closed: true }
  );
  const placement = createPlacement({ paths: [a, b], hatch: { spacingMm: 2, angleDeg: 0 } });

  const small = placementPaths({ ...placement, fills: { [a.id]: null } });
  const large = placementPaths({ ...placement, fills: { [b.id]: null } });

  assert.ok(large.length > small.length);
});

// --------------------------------------------------------- shapes with holes --

/** A square outline, centred on the origin. */
const box = (half) => createPath([
  { x: -half, y: -half }, { x: half, y: -half }, { x: half, y: half }, { x: -half, y: half },
], { closed: true });

test('filling a shape leaves the shapes nested inside it open', () => {
  // A silhouette with a hole arrives as two outlines, one per subpath. Filling
  // the outer one has to leave the inner one alone or the hole disappears.
  const outer = box(50);
  const hole = box(20);
  const placement = createPlacement({
    paths: [outer, hole],
    hatch: { spacingMm: 2, angleDeg: 0 },
    fills: { [outer.id]: null },
  });

  const lines = placementPaths(placement).slice(2);
  assert.ok(lines.length > 0, 'the shape is filled');

  // A hatch line may end *on* the hole's edge; what it must not do is cross it.
  for (const line of lines) {
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1];
      const b = line.points[i];
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

      assert.ok(!isInside([hole], middle), `hatch crosses the hole at ${middle.x},${middle.y}`);
    }

    for (const point of line.points) {
      assert.ok(!isInside([box(19)], point), `hatch at ${point.x},${point.y} is in the hole`);
    }
  }
});

test('the hole can be filled in its own right', () => {
  const outer = box(50);
  const hole = box(20);
  const placement = createPlacement({
    paths: [outer, hole],
    hatch: { spacingMm: 2, angleDeg: 0 },
    fills: { [outer.id]: null },
  });

  const open = placementPaths(placement).length;
  const both = placementPaths({
    ...placement,
    fills: { [outer.id]: null, [hole.id]: 'l2' },
  });

  assert.ok(both.length > open, 'filling the hole adds lines back inside it');
  assert.ok(
    both.slice(open).some((line) => line.meta.fillLayerId === 'l2'),
    'and they are on the layer the hole was filled onto'
  );
});

test('an island inside a hole is filled again', () => {
  const outer = box(50);
  const hole = box(30);
  const island = box(10);
  const placement = createPlacement({
    paths: [outer, hole, island],
    hatch: { spacingMm: 2, angleDeg: 0 },
    fills: { [outer.id]: null },
  });

  const centre = { x: 0, y: 0 };
  const lines = placementPaths(placement).slice(3);

  assert.ok(
    lines.some((line) => line.points.some((p) => isInside([island], p))),
    'the island is filled, though it sits in a hole'
  );
  assert.ok(isInside([island], centre));
});

test('two separate fills draw over each other rather than cancelling', () => {
  // The fill rule is for what is nested inside one fill, not for what two
  // fills do to each other: a bucket tool does not rub out what it lands on.
  const left = createPath([
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
  ], { closed: true });
  const right = createPath([
    { x: 20, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 20, y: 40 },
  ], { closed: true });

  const placement = createPlacement({
    paths: [left, right],
    hatch: { spacingMm: 4, angleDeg: 0 },
  });

  const one = placementPaths({ ...placement, fills: { [left.id]: null } }).length;
  const two = placementPaths({ ...placement, fills: { [left.id]: null, [right.id]: null } }).length;

  assert.ok(two > one, 'the second fill adds lines, it does not remove them');
});

test('holes are not offered as shapes to fill', () => {
  const outer = box(50);
  const hole = box(20);
  const placement = createPlacement({ paths: [outer, hole] });

  assert.equal(fillableShapes(placement).length, 2);
  assert.deepEqual(topLevelShapes(placement).map((s) => s.id), [outer.id]);
});
