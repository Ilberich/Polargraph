import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTransform } from './transform.js';
import { IDENTITY, apply } from '../geom/matrix.js';

const closePoint = (p, x, y, tol = 1e-9) => {
  assert.ok(Math.abs(p.x - x) < tol, `x ${p.x} !== ${x}`);
  assert.ok(Math.abs(p.y - y) < tol, `y ${p.y} !== ${y}`);
};

test('an absent transform is the identity', () => {
  assert.deepEqual(parseTransform(undefined), IDENTITY);
  assert.deepEqual(parseTransform(''), IDENTITY);
});

test('translate, scale and rotate parse', () => {
  closePoint(apply(parseTransform('translate(10 20)'), { x: 1, y: 2 }), 11, 22);
  closePoint(apply(parseTransform('scale(2)'), { x: 3, y: 4 }), 6, 8);
  closePoint(apply(parseTransform('scale(2 3)'), { x: 3, y: 4 }), 6, 12);
  closePoint(apply(parseTransform('rotate(90)'), { x: 1, y: 0 }), 0, 1);
});

test('translate with one argument leaves y alone', () => {
  closePoint(apply(parseTransform('translate(10)'), { x: 1, y: 2 }), 11, 2);
});

test('rotate about a centre leaves that centre fixed', () => {
  closePoint(apply(parseTransform('rotate(45 5 5)'), { x: 5, y: 5 }), 5, 5);
});

test('a transform list applies left to right', () => {
  // scale runs first, in the translated frame
  closePoint(apply(parseTransform('translate(10 0) scale(2)'), { x: 3, y: 0 }), 16, 0);
});

test('commas and extra whitespace are accepted', () => {
  closePoint(apply(parseTransform('  translate( 10 , 20 )  '), { x: 0, y: 0 }), 10, 20);
});

test('matrix() is taken verbatim', () => {
  assert.deepEqual(parseTransform('matrix(1 2 3 4 5 6)'), [1, 2, 3, 4, 5, 6]);
});

test('a malformed function is skipped, not fatal', () => {
  // Dropping one transform distorts a shape; throwing loses the drawing.
  closePoint(apply(parseTransform('bogus(1) translate(5 5)'), { x: 0, y: 0 }), 5, 5);
  assert.deepEqual(parseTransform('matrix(1 2 3)'), IDENTITY);
});

test('skew parses', () => {
  closePoint(apply(parseTransform('skewX(45)'), { x: 0, y: 1 }), 1, 1);
  closePoint(apply(parseTransform('skewY(45)'), { x: 1, y: 0 }), 1, 1);
});
