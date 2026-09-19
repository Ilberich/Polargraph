/**
 * End-to-end: SVG in, gcode out, gcode back in, same geometry.
 *
 * This is Phase 1's exit criterion. Each layer is unit tested on its own, but
 * agreeing individually is not the same as composing: a convention mismatch
 * between the importer and the writer, or between the writer and the parser,
 * passes every unit test and ruins every plot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importSvg } from './svg/import.js';
import { writeGcode } from './gcode/writer.js';
import { gcodeToPaths, measureGcode } from './gcode/parser.js';
import { pathLength, boundsOf } from './geom/path.js';

/** The points a path is expected to produce: a closed one returns to its start. */
function expectedPoints(path) {
  return path.closed ? [...path.points, path.points[0]] : path.points;
}

/**
 * Drop points that repeat the previous XY.
 *
 * A pen-lift file legitimately contains one: the pen lowers to the stroke's
 * depth after arriving, which is a real move in Z at a stationary XY. The
 * gondola did not go anywhere, so it is not part of the drawn shape.
 */
function xyPolyline(points) {
  return points.filter(
    (p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y
  );
}

function assertSameGeometry(original, recovered, tolerance = 0.002) {
  assert.equal(recovered.length, original.length, 'path count');

  original.forEach((path, i) => {
    // Closure has to survive too, not only the points. Gcode has no `Z`, so a
    // stroke that comes back to where it began is the only evidence there is —
    // and without it nothing imported from gcode could ever be filled.
    assert.equal(recovered[i].closed, path.closed, `path ${i} closed`);

    const expected = xyPolyline(expectedPoints(path));
    const actual = xyPolyline(expectedPoints(recovered[i]));

    assert.equal(actual.length, expected.length, `path ${i} point count`);

    expected.forEach((point, j) => {
      const got = actual[j];
      assert.ok(
        Math.abs(got.x - point.x) <= tolerance && Math.abs(got.y - point.y) <= tolerance,
        `path ${i} point ${j}: expected (${point.x}, ${point.y}), got (${got.x}, ${got.y})`
      );
    });
  });
}

// Paths deliberately do not start where the previous one ends: with no pen
// lift, a stroke continuing from the last position is genuinely one continuous
// line, and the writer is right not to invent a travel move between them.
const DRAWING = `<?xml version="1.0"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="150mm" viewBox="0 0 200 150">
    <g transform="translate(20 20)">
      <rect x="0" y="0" width="60" height="40"/>
      <circle cx="120" cy="20" r="15"/>
    </g>
    <path d="M 20 100 C 40 60, 80 60, 100 100 S 160 140, 180 100"/>
    <path d="M 20 130 A 25 25 0 0 1 70 130"/>
    <polygon points="100,120 140,120 120,145"/>
  </svg>`;

test('an SVG round-trips through gcode with its geometry intact', () => {
  const { paths } = importSvg(DRAWING);
  assert.equal(paths.length, 5, 'all five shapes imported');

  const recovered = gcodeToPaths(writeGcode(paths));
  assertSameGeometry(paths, recovered);
});

test('the round trip holds at a finer flattening tolerance', () => {
  const { paths } = importSvg(DRAWING, { toleranceMm: 0.005 });
  assertSameGeometry(paths, gcodeToPaths(writeGcode(paths)));
});

test('the round trip holds with a pen axis fitted', () => {
  const { paths } = importSvg(DRAWING);
  const withDepth = paths.map((p) => ({
    ...p,
    points: p.points.map((q) => ({ ...q, z: -1.5 })),
  }));

  const gcode = writeGcode(withDepth, { penLift: true, travelZ: 4 });
  assertSameGeometry(withDepth, gcodeToPaths(gcode));
});

test('per-vertex pen depth survives the round trip', () => {
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M0 0 L100 0"/></svg>'
  );

  // Depths start at -1 rather than 0: `-0` is a distinct value in JavaScript,
  // and the writer deliberately normalises it to `0`, so a ramp starting at
  // -0 would compare unequal for a reason that has nothing to do with Z.
  const ramped = {
    ...paths[0],
    points: paths[0].points.map((p, i) => ({ ...p, z: -(i + 1) })),
  };

  const recovered = gcodeToPaths(writeGcode([ramped]));
  assert.deepEqual(
    recovered[0].points.map((p) => p.z),
    ramped.points.map((p) => p.z)
  );
});

test('physical size is preserved end to end', () => {
  // A 100 mm square must still be 100 mm after the whole pipeline.
  const { paths } = importSvg(
    '<svg width="120mm" height="120mm" viewBox="0 0 120 120">' +
      '<rect x="10" y="10" width="100" height="100"/></svg>'
  );

  const recovered = gcodeToPaths(writeGcode(paths));
  const b = boundsOf(recovered);

  assert.ok(Math.abs(b.width - 100) < 0.01, `width ${b.width}`);
  assert.ok(Math.abs(b.height - 100) < 0.01, `height ${b.height}`);
  assert.ok(Math.abs(b.minX - 10) < 0.01, `origin ${b.minX}`);
});

test('drawn length survives the round trip', () => {
  const { paths } = importSvg(DRAWING);
  const before = paths.reduce((sum, p) => sum + pathLength(p), 0);
  const after = measureGcode(writeGcode(paths)).draw;

  assert.ok(
    Math.abs(after - before) < 0.05,
    `drawn length changed: ${before} -> ${after}`
  );
});

test('strokes that meet end to end are one continuous line without a pen lift', () => {
  // Not a round-trip failure but a physical truth: with a fixed pen the gondola
  // never left the paper, so this really is one stroke. The writer emits no
  // travel and the parser is right to read it back as one path.
  const paths = [
    { points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], closed: false, meta: {} },
    { points: [{ x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }], closed: false, meta: {} },
  ];

  const merged = gcodeToPaths(writeGcode(paths, { penLift: false }));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].points.length, 3);

  // With a pen axis the lift separates them again.
  const separate = gcodeToPaths(writeGcode(paths, { penLift: true, travelZ: 5 }));
  assert.equal(separate.length, 2);
});

test('an empty drawing produces a valid, empty program', () => {
  const { paths } = importSvg('<svg width="10mm" height="10mm"></svg>');
  const gcode = writeGcode(paths);

  assert.deepEqual(paths, []);
  assert.deepEqual(gcodeToPaths(gcode), []);
  assert.match(gcode, /M30/);
});
