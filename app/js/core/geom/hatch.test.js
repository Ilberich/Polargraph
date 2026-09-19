import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hatchFill, isInside, isFillable, DEFAULTS } from './hatch.js';
import { createPath, pathLength, boundsOf } from './path.js';

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b} within ${tol}`);

const square = (x, y, size) =>
  createPath([
    { x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size },
  ], { closed: true });

/** A regular polygon, as a stand-in for a circle. */
const circle = (cx, cy, r, sides = 64) =>
  createPath(
    Array.from({ length: sides }, (_, i) => {
      const angle = (2 * Math.PI * i) / sides;
      return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
    }),
    { closed: true }
  );

test('a square fills with parallel lines', () => {
  const lines = hatchFill([square(0, 0, 100)], { spacingMm: 10, angleDeg: 0 });

  assert.ok(lines.length >= 9, `expected about ten lines, got ${lines.length}`);
  for (const line of lines) assert.equal(line.points.length, 2);
});

test('spacing controls how many lines are drawn', () => {
  const coarse = hatchFill([square(0, 0, 100)], { spacingMm: 20, angleDeg: 0 });
  const fine = hatchFill([square(0, 0, 100)], { spacingMm: 5, angleDeg: 0 });

  assert.ok(fine.length > coarse.length * 3, `${fine.length} vs ${coarse.length}`);
});

test('hatch lines stay inside the shape', () => {
  // The whole point: a fill that leaks outside its outline is ink on the paper
  // where the drawing is not.
  const lines = hatchFill([square(10, 20, 50)], { spacingMm: 3, angleDeg: 30 });
  const b = boundsOf(lines);

  assert.ok(b.minX >= 10 - 1e-6, `left edge ${b.minX}`);
  assert.ok(b.minY >= 20 - 1e-6, `top edge ${b.minY}`);
  assert.ok(b.maxX <= 60 + 1e-6, `right edge ${b.maxX}`);
  assert.ok(b.maxY <= 70 + 1e-6, `bottom edge ${b.maxY}`);
});

test('a horizontal fill of a square has the expected total length', () => {
  // Ten lines across a 100mm square, each spanning its full width.
  const lines = hatchFill([square(0, 0, 100)], { spacingMm: 10, angleDeg: 0 });
  const total = lines.reduce((sum, l) => sum + pathLength(l), 0);

  close(total, 1000, 1e-6);
});

test('angle rotates the fill', () => {
  const horizontal = hatchFill([square(0, 0, 100)], { spacingMm: 10, angleDeg: 0 });
  const vertical = hatchFill([square(0, 0, 100)], { spacingMm: 10, angleDeg: 90 });

  // A horizontal line varies in x and not in y; a vertical one the reverse.
  const spans = (line) => ({
    dx: Math.abs(line.points[1].x - line.points[0].x),
    dy: Math.abs(line.points[1].y - line.points[0].y),
  });

  const h = spans(horizontal[0]);
  const v = spans(vertical[0]);

  assert.ok(h.dx > h.dy, 'horizontal fill should run across');
  assert.ok(v.dy > v.dx, 'vertical fill should run down');
});

test('crosshatch adds a second pass at a right angle', () => {
  const single = hatchFill([square(0, 0, 100)], { spacingMm: 10, angleDeg: 45 });
  const crossed = hatchFill([square(0, 0, 100)], { spacingMm: 10, angleDeg: 45, cross: true });

  assert.ok(crossed.length > single.length * 1.8, `${crossed.length} vs ${single.length}`);
});

test('a hole is left unfilled', () => {
  // A ring: fill must skip the middle, or the letter O comes out solid.
  const ring = [square(0, 0, 100), square(40, 40, 20)];
  const lines = hatchFill(ring, { spacingMm: 2, angleDeg: 0, rule: 'evenodd' });

  const throughHole = lines.filter(
    (l) => l.points[0].y > 40 && l.points[0].y < 60
  );

  assert.ok(throughHole.length > 0, 'lines should still cross that band');

  for (const line of throughHole) {
    const [a, b] = line.points;
    const spansHole = Math.min(a.x, b.x) < 40 && Math.max(a.x, b.x) > 60;
    assert.ok(!spansHole, 'no line may run straight through the hole');
  }
});

test('the nonzero rule keeps overlapping shapes solid', () => {
  const ring = [square(0, 0, 100), square(40, 40, 20)];

  const evenOdd = hatchFill(ring, { spacingMm: 2, angleDeg: 0, rule: 'evenodd' });
  const nonZero = hatchFill(ring, { spacingMm: 2, angleDeg: 0, rule: 'nonzero' });

  const length = (lines) => lines.reduce((sum, l) => sum + pathLength(l), 0);

  // Both subpaths wind the same way here, so nonzero treats the inner square
  // as part of the shape and fills straight through it.
  assert.ok(length(nonZero) > length(evenOdd));
});

test('opposite windings make a hole under either rule', () => {
  // Worth pinning down because it looks like a broken control: switching the
  // rule on a drawing whose shapes already wind against each other changes
  // nothing, and correctly so. Real SVG exports do this routinely — a polygon
  // and a circle from the same file often disagree in direction.
  const outer = square(0, 0, 100);
  const reversed = createPath([...square(30, 30, 40).points].reverse(), { closed: true });

  const length = (lines) => lines.reduce((sum, l) => sum + pathLength(l), 0);
  const options = { spacingMm: 5, angleDeg: 0 };

  const evenOdd = length(hatchFill([outer, reversed], { ...options, rule: 'evenodd' }));
  const nonZero = length(hatchFill([outer, reversed], { ...options, rule: 'nonzero' }));

  close(evenOdd, nonZero, 1e-6);

  // And the same shapes wound together do differ, so the rule is not inert.
  const together = length(hatchFill([outer, square(30, 30, 40)], { ...options, rule: 'nonzero' }));
  assert.ok(together > nonZero);
});

test('a circle fills without leaking past its radius', () => {
  const lines = hatchFill([circle(50, 50, 40)], { spacingMm: 2, angleDeg: 17 });

  for (const line of lines) {
    for (const p of line.points) {
      assert.ok(
        Math.hypot(p.x - 50, p.y - 50) <= 40 + 0.01,
        `point ${p.x},${p.y} is outside the circle`
      );
    }
  }
});

test('alternate lines reverse, so the return trip is part of the fill', () => {
  // Without this every stroke restarts at the same edge, and on a fixed-pen
  // machine the trip back is drawn across the fill.
  const lines = hatchFill([square(0, 0, 100)], {
    spacingMm: 10, angleDeg: 0, boustrophedon: true,
  });

  const goesRight = (l) => l.points[1].x > l.points[0].x;

  assert.equal(goesRight(lines[0]), true);
  assert.equal(goesRight(lines[1]), false, 'the second line should come back');
});

test('boustrophedon can be turned off', () => {
  const lines = hatchFill([square(0, 0, 100)], {
    spacingMm: 10, angleDeg: 0, boustrophedon: false,
  });

  const goesRight = (l) => l.points[1].x > l.points[0].x;
  assert.ok(lines.every(goesRight), 'every line should run the same way');
});

test('reversing lines does not change what is drawn', () => {
  const on = hatchFill([square(0, 0, 100)], { spacingMm: 7, angleDeg: 22, boustrophedon: true });
  const off = hatchFill([square(0, 0, 100)], { spacingMm: 7, angleDeg: 22, boustrophedon: false });

  assert.equal(on.length, off.length);
  close(
    on.reduce((s, l) => s + pathLength(l), 0),
    off.reduce((s, l) => s + pathLength(l), 0),
    1e-6
  );
});

test('open paths have no inside and are not filled', () => {
  const open = createPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
  assert.deepEqual(hatchFill([open]), []);
});

test('nothing to fill produces nothing', () => {
  assert.deepEqual(hatchFill([]), []);
  assert.deepEqual(hatchFill([createPath([{ x: 1, y: 1 }], { closed: true })]), []);
});

test('a nonsensical spacing is refused rather than hanging', () => {
  // A zero or negative step would loop forever.
  assert.deepEqual(hatchFill([square(0, 0, 100)], { spacingMm: 0 }), []);
  assert.deepEqual(hatchFill([square(0, 0, 100)], { spacingMm: -5 }), []);
});

test('spacing wider than the shape still yields at most a line', () => {
  const lines = hatchFill([square(0, 0, 10)], { spacingMm: 100, angleDeg: 0 });
  assert.ok(lines.length <= 1, `got ${lines.length}`);
});

test('a scanline through a vertex counts one crossing, not two', () => {
  // A diamond has vertices at its extremes; a naive test double-counts them
  // and the fill inverts from that line on.
  const diamond = createPath([
    { x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 },
  ], { closed: true });

  const lines = hatchFill([diamond], { spacingMm: 10, angleDeg: 0 });

  assert.ok(lines.length > 5);
  for (const line of lines) {
    const width = Math.abs(line.points[1].x - line.points[0].x);
    const y = line.points[0].y;
    // Width of a diamond at height y, which the fill must not exceed.
    const expected = 100 - 2 * Math.abs(50 - y);
    assert.ok(width <= expected + 1e-6, `line at y=${y} is ${width} wide, max ${expected}`);
  }
});

test('the inside test agrees with where lines are drawn', () => {
  const ring = [square(0, 0, 100), square(40, 40, 20)];

  assert.equal(isInside(ring, { x: 10, y: 50 }), true, 'in the body');
  assert.equal(isInside(ring, { x: 50, y: 50 }), false, 'in the hole');
  assert.equal(isInside(ring, { x: 150, y: 50 }), false, 'outside entirely');
});

test('the defaults are usable', () => {
  const lines = hatchFill([square(0, 0, 50)], DEFAULTS);
  assert.ok(lines.length > 10);
});

// ------------------------------------------------------- what can be filled --

test('a filled but unclosed path can still be hatched', () => {
  // SVG closes an open path implicitly when filling it, so the shape has an
  // inside however its outline was written. Refusing to fill it told the user
  // their drawing had no closed shapes when it plainly did.
  const open = createPath([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ], { closed: false, meta: { filled: true } });

  const lines = hatchFill([open], { spacingMm: 10, angleDeg: 0 });
  assert.ok(lines.length >= 9, `expected a full fill, got ${lines.length}`);
});

test('an open unfilled path is still not hatched', () => {
  const stroke = createPath([
    { x: 0, y: 0 }, { x: 100, y: 50 }, { x: 20, y: 100 },
  ], { closed: false, meta: { filled: false } });

  assert.deepEqual(hatchFill([stroke]), []);
});

test('fillability covers closed, filled, and neither', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];

  assert.equal(isFillable(createPath(points, { closed: true })), true);
  assert.equal(isFillable(createPath(points, { meta: { filled: true } })), true);
  assert.equal(isFillable(createPath(points)), false);
  assert.equal(isFillable(createPath([{ x: 0, y: 0 }], { closed: true })), false);
  assert.equal(isFillable(null), false);
});
