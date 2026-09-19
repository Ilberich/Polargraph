import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flattenStep, hasCurve, reflattenPath, reflatten } from './reflatten.js';
import { importSvg, DEFAULT_TOLERANCE_MM } from './import.js';
import { createPath } from '../geom/path.js';

/** A circle of radius 40mm, as an importer would produce it. */
const circleSvg = (r = 40) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 200 200">
     <circle cx="100" cy="100" r="${r}" fill="none"/>
   </svg>`;

/** Worst gap between the polyline and the true circle, in millimetres. */
function sagitta(path, centre, radius) {
  let worst = 0;

  for (let i = 0; i < path.points.length; i++) {
    const a = path.points[i];
    const b = path.points[(i + 1) % path.points.length];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    worst = Math.max(worst, radius - Math.hypot(mid.x - centre.x, mid.y - centre.y));
  }

  return worst;
}

test('scale is rounded up to a power of two', () => {
  // So a drag that grows an object smoothly re-flattens a handful of times
  // rather than on every frame.
  assert.equal(flattenStep(0.2), 1);
  assert.equal(flattenStep(1), 1);
  assert.equal(flattenStep(1.1), 2);
  assert.equal(flattenStep(8), 8);
  assert.equal(flattenStep(8.1), 16);
  assert.equal(flattenStep(18), 32);
});

test('imported paths remember the curve they came from', () => {
  const [path] = importSvg(circleSvg()).paths;

  assert.equal(hasCurve(path), true);
  assert.equal(typeof path.meta.curve.d, 'string');
  assert.equal(path.meta.curve.index, 0);
});

test('a path with no curve behind it is left alone', () => {
  const plain = createPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]);

  assert.equal(hasCurve(plain), false);
  assert.equal(reflattenPath(plain, 0.001), plain);
  assert.equal(reflatten([plain], 32, DEFAULT_TOLERANCE_MM)[0], plain);
});

test('flattening again keeps the path identical in every way but its points', () => {
  // Layer membership and fills are held against ids, and a smoother circle is
  // still the same circle.
  const [path] = importSvg(circleSvg()).paths;
  const finer = reflattenPath(path, DEFAULT_TOLERANCE_MM / 32);

  assert.equal(finer.id, path.id);
  assert.equal(finer.closed, path.closed);
  assert.equal(finer.meta.filled, path.meta.filled);
  assert.ok(finer.points.length > path.points.length);
});

test('an object scaled up is flattened finely enough for the size it is drawn', () => {
  const { paths } = importSvg(circleSvg());
  const centre = { x: 100, y: 100 };

  // The importer measures its tolerance on paper at scale 1, and hits it.
  const radius = Math.hypot(paths[0].points[0].x - centre.x, paths[0].points[0].y - centre.y);
  assert.ok(sagitta(paths[0], centre, radius) <= DEFAULT_TOLERANCE_MM * 1.01);

  // Drawn twenty times bigger, those same facets would be twenty times wider.
  const asDrawn = sagitta(paths[0], centre, radius) * 20;
  assert.ok(asDrawn > DEFAULT_TOLERANCE_MM * 10, 'the problem is real');

  // Flattened again for that size, they are back under tolerance — within the
  // factor of two the power-of-two stepping allows.
  const [finer] = reflatten(paths, 20, DEFAULT_TOLERANCE_MM);
  assert.ok(
    sagitta(finer, centre, radius) * 20 <= DEFAULT_TOLERANCE_MM * 2,
    'still faceted once scaled up'
  );
});

test('flattening again does not move the shape', () => {
  const { paths } = importSvg(circleSvg());
  const [finer] = reflatten(paths, 20, DEFAULT_TOLERANCE_MM);
  const centre = { x: 100, y: 100 };

  // Not exact, and it never was: an SVG circle becomes arcs and arcs become
  // cubics, and a cubic is only ever a very good approximation of a circle.
  // What matters is that the finer points sit on the same curve the coarse
  // ones did, rather than on a different one.
  const off = (path) =>
    Math.max(...path.points.map((p) => Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - 40)));

  assert.ok(off(paths[0]) < 0.02, 'the arc approximation is good to start with');
  assert.ok(off(finer) <= off(paths[0]) + 1e-3, `moved: ${off(paths[0])} -> ${off(finer)}`);
});

test('flattening stops at what the machine can resolve', () => {
  // Below half a step the extra points are pure file size: the motors cannot
  // tell one from the next.
  const { paths } = importSvg(circleSvg());

  const huge = reflatten(paths, 4096, DEFAULT_TOLERANCE_MM)[0];
  const larger = reflatten(paths, 65536, DEFAULT_TOLERANCE_MM)[0];

  assert.ok(huge.points.length > paths[0].points.length);
  assert.equal(larger.points.length, huge.points.length);
});

test('the right subpath is flattened again', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 200 200">
      <path d="M10 10 A 40 40 0 0 1 90 10 Z M120 10 A 10 10 0 0 1 140 10 Z" fill="none"/>
    </svg>`;

  const { paths } = importSvg(svg);
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.map((p) => p.meta.curve.index), [0, 1]);

  const finer = reflatten(paths, 16, DEFAULT_TOLERANCE_MM);

  // Each keeps its own extent: a swapped index would put the big arc where the
  // small one was.
  paths.forEach((path, i) => {
    const width = (p) => Math.max(...p.points.map((q) => q.x)) - Math.min(...p.points.map((q) => q.x));
    assert.ok(Math.abs(width(finer[i]) - width(path)) < 0.1);
  });
});
