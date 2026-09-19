import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY, multiply, compose, apply, translation, scaling, rotation,
  skewX, determinant, invert, meanScale,
} from './matrix.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b} within ${tol}`);

const closePoint = (p, x, y, tol = 1e-9) => {
  close(p.x, x, tol);
  close(p.y, y, tol);
};

test('identity leaves a point alone', () => {
  closePoint(apply(IDENTITY, { x: 3, y: -7 }), 3, -7);
});

test('translation and scaling apply', () => {
  closePoint(apply(translation(10, 5), { x: 1, y: 2 }), 11, 7);
  closePoint(apply(scaling(2, 3), { x: 4, y: 5 }), 8, 15);
});

test('rotation by 90 degrees turns +x into +y', () => {
  // SVG's y axis points down, so a positive angle turns clockwise on screen.
  closePoint(apply(rotation(90), { x: 1, y: 0 }), 0, 1);
});

test('rotation about a point leaves that point fixed', () => {
  closePoint(apply(rotation(37, 12, -4), { x: 12, y: -4 }), 12, -4);
});

test('compose applies its arguments left to right', () => {
  // Scale first, then translate: (2,0) -> (6,0) -> (16,0).
  const m = compose(scaling(3), translation(10, 0));
  closePoint(apply(m, { x: 2, y: 0 }), 16, 0);
});

test('multiply applies its right operand first', () => {
  // The order SVG nesting needs: multiply(parent, child).
  const m = multiply(translation(10, 0), scaling(3));
  closePoint(apply(m, { x: 2, y: 0 }), 16, 0);
});

test('composition order matters', () => {
  const a = compose(scaling(3), translation(10, 0));
  const b = compose(translation(10, 0), scaling(3));
  assert.notDeepEqual(a, b);
});

test('invert undoes a transform', () => {
  const m = compose(translation(4, -9), rotation(31), scaling(2, 5));
  const back = invert(m);
  const p = { x: 7, y: -3 };

  closePoint(apply(back, apply(m, p)), p.x, p.y, 1e-9);
});

test('a singular matrix has no inverse', () => {
  assert.equal(invert(scaling(0, 0)), null);
});

test('determinant reports area scale and mirroring', () => {
  close(determinant(scaling(2, 3)), 6);
  close(determinant(scaling(-1, 1)), -1, 1e-12);
  close(determinant(rotation(45)), 1, 1e-12);
});

test('meanScale is the geometric mean of the axis scales', () => {
  close(meanScale(scaling(2, 8)), 4);
  close(meanScale(rotation(123)), 1, 1e-12);
});

test('skew leaves points on the skew axis alone', () => {
  closePoint(apply(skewX(30), { x: 5, y: 0 }), 5, 0);
});
