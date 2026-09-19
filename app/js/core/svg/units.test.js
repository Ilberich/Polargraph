import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseLength, parseLengthMm, parseViewBox, parsePreserveAspectRatio,
  viewBoxTransform, userUnitsToMm, mmToUserUnits,
} from './units.js';
import { apply } from '../geom/matrix.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

test('bare numbers are user units', () => {
  close(parseLength('42'), 42);
  close(parseLength('42px'), 42);
});

test('absolute units convert at 96 dpi', () => {
  close(parseLength('1in'), 96);
  close(parseLength('72pt'), 96);
  close(parseLength('1mm'), 96 / 25.4);
  close(parseLength('1cm'), 960 / 25.4);
});

test('a millimetre round-trips through user units', () => {
  close(userUnitsToMm(mmToUserUnits(123.456)), 123.456, 1e-9);
});

test('parseLengthMm converts physical units exactly', () => {
  close(parseLengthMm('10mm'), 10, 1e-9);
  close(parseLengthMm('1in'), 25.4, 1e-9);
});

test('signs, decimals and exponents parse', () => {
  close(parseLength('-3.5'), -3.5);
  close(parseLength('.5'), 0.5);
  close(parseLength('1e2'), 100);
});

test('percentages need a basis', () => {
  assert.equal(parseLength('50%'), null);
  close(parseLength('50%', { percentBasis: 200 }), 100);
});

test('unparseable or absent lengths are null, not zero', () => {
  // A caller must be able to tell "missing" from a real zero.
  assert.equal(parseLength(null), null);
  assert.equal(parseLength('auto'), null);
  assert.equal(parseLength('12 34'), null);
  assert.equal(parseLength('0'), 0);
});

test('viewBox parses, and rejects malformed or empty boxes', () => {
  assert.deepEqual(parseViewBox('0 0 100 50'), { minX: 0, minY: 0, width: 100, height: 50 });
  assert.deepEqual(parseViewBox('-10,-5, 20, 30'), { minX: -10, minY: -5, width: 20, height: 30 });

  assert.equal(parseViewBox('0 0 100'), null);
  assert.equal(parseViewBox('0 0 0 50'), null, 'zero width has no mapping');
  assert.equal(parseViewBox('a b c d'), null);
  assert.equal(parseViewBox(null), null);
});

test('preserveAspectRatio defaults as the spec says', () => {
  assert.deepEqual(parsePreserveAspectRatio(undefined), { align: 'xMidYMid', meetOrSlice: 'meet' });
  assert.deepEqual(parsePreserveAspectRatio('xMinYMax slice'), { align: 'xMinYMax', meetOrSlice: 'slice' });
  assert.deepEqual(parsePreserveAspectRatio('none'), { align: 'none', meetOrSlice: 'meet' });
});

test('a matching viewBox maps one to one', () => {
  const m = viewBoxTransform({ minX: 0, minY: 0, width: 100, height: 100 }, 100, 100);
  const p = apply(m, { x: 25, y: 75 });

  close(p.x, 25);
  close(p.y, 75);
});

test('viewBox offset shifts the origin', () => {
  const m = viewBoxTransform({ minX: 10, minY: 20, width: 100, height: 100 }, 100, 100);
  const p = apply(m, { x: 10, y: 20 });

  close(p.x, 0);
  close(p.y, 0);
});

test('meet fits the whole box and centres the slack', () => {
  // A square box in a wide viewport: scale by height, centre horizontally.
  const m = viewBoxTransform({ minX: 0, minY: 0, width: 100, height: 100 }, 200, 100);

  close(apply(m, { x: 0, y: 0 }).x, 50, 1e-9);
  close(apply(m, { x: 100, y: 100 }).x, 150, 1e-9);
  close(apply(m, { x: 100, y: 100 }).y, 100, 1e-9);
});

test('none stretches both axes independently', () => {
  const m = viewBoxTransform({ minX: 0, minY: 0, width: 100, height: 100 }, 200, 100, 'none');
  const p = apply(m, { x: 100, y: 100 });

  close(p.x, 200, 1e-9);
  close(p.y, 100, 1e-9);
});

test('slice fills the viewport and overflows', () => {
  const m = viewBoxTransform({ minX: 0, minY: 0, width: 100, height: 100 }, 200, 100, 'xMidYMid slice');
  const p = apply(m, { x: 100, y: 100 });

  close(p.x, 200, 1e-9);
  close(p.y, 150, 1e-9, 'the taller axis runs past the viewport');
});
