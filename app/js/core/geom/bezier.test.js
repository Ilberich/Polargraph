import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flattenCubic, flattenQuadratic, cubicAt } from './bezier.js';
import { distance } from './vec2.js';

/** Largest distance from any true curve point to the flattened polyline. */
function maxDeviation(polyline, curveAt, samples = 400) {
  let worst = 0;

  for (let i = 0; i <= samples; i++) {
    const p = curveAt(i / samples);
    let best = Infinity;

    for (let j = 1; j < polyline.length; j++) {
      best = Math.min(best, pointToSegment(p, polyline[j - 1], polyline[j]));
    }
    worst = Math.max(worst, best);
  }

  return worst;
}

function pointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

const P0 = { x: 0, y: 0 };
const P1 = { x: 0, y: 100 };
const P2 = { x: 100, y: 100 };
const P3 = { x: 100, y: 0 };

test('flattening omits the start point and ends on the endpoint', () => {
  const pts = flattenCubic(P0, P1, P2, P3, 0.1);

  assert.notDeepEqual(pts[0], P0, 'caller already holds the start point');
  assert.deepEqual(pts[pts.length - 1], P3);
});

test('a flattened curve stays within tolerance of the true curve', () => {
  for (const tolerance of [1, 0.25, 0.05, 0.01]) {
    const pts = flattenCubic(P0, P1, P2, P3, tolerance);
    const deviation = maxDeviation([P0, ...pts], (t) => cubicAt(P0, P1, P2, P3, t));

    assert.ok(
      deviation <= tolerance,
      `tolerance ${tolerance} gave deviation ${deviation}`
    );
  }
});

test('tighter tolerance costs more points', () => {
  const coarse = flattenCubic(P0, P1, P2, P3, 1).length;
  const fine = flattenCubic(P0, P1, P2, P3, 0.01).length;

  assert.ok(fine > coarse, `expected more than ${coarse} points, got ${fine}`);
});

test('a straight cubic needs no subdivision', () => {
  // Controls sit on the chord, so the curve is already a line.
  const pts = flattenCubic(
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }, 0.05
  );

  assert.equal(pts.length, 1, 'one point: the endpoint');
});

test('subdivision terminates on a degenerate curve', () => {
  // All control points coincident: a cusp with no extent.
  const p = { x: 5, y: 5 };
  const pts = flattenCubic(p, p, p, p, 0.01);

  assert.ok(pts.length >= 1 && pts.length < 100, `got ${pts.length} points`);
});

test('quadratics flatten within tolerance too', () => {
  const q0 = { x: 0, y: 0 };
  const q1 = { x: 50, y: 100 };
  const q2 = { x: 100, y: 0 };
  const tolerance = 0.05;

  const pts = flattenQuadratic(q0, q1, q2, tolerance);
  const quadAt = (t) => {
    const u = 1 - t;
    return {
      x: u * u * q0.x + 2 * u * t * q1.x + t * t * q2.x,
      y: u * u * q0.y + 2 * u * t * q1.y + t * t * q2.y,
    };
  };

  assert.ok(maxDeviation([q0, ...pts], quadAt) <= tolerance);
});
