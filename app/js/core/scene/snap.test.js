import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapPosition, snapTargets, DEFAULT_SNAP } from './snap.js';
import { createScene, addPlacement } from './scene.js';
import { createPlacement } from './placement.js';
import { createPath } from '../geom/path.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

const box = (x, y, w, h) =>
  createPath([
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ], { closed: true });

const paper = { widthMm: 200, heightMm: 100, margins: { top: 10, right: 10, bottom: 10, left: 10 } };
const scene = createScene({ paper });
const size = { width: 20, height: 20 };

test('a position with nothing nearby is left alone', () => {
  const result = snapPosition({ x: 73, y: 47 }, size, scene, { threshold: 1 });

  close(result.x, 73);
  close(result.y, 47);
  assert.deepEqual(result.guides, []);
});

test('the centre snaps to the paper centre', () => {
  const result = snapPosition({ x: 101, y: 51 }, size, scene, { threshold: 2 });

  close(result.x, 100);
  close(result.y, 50);
  assert.ok(result.guides.some((g) => g.kind === 'centre'));
});

test('a leading edge snaps to the margin', () => {
  // Left edge at 11 is 1mm from the 10mm margin, so the centre moves to 20.
  const result = snapPosition({ x: 21, y: 50 }, size, scene, { threshold: 2 });

  close(result.x, 20);
  assert.ok(result.guides.some((g) => g.axis === 'x' && g.kind === 'margin'));
});

test('a trailing edge snaps to the far margin', () => {
  const result = snapPosition({ x: 179, y: 50 }, size, scene, { threshold: 2 });
  close(result.x, 180);
});

test('edges snap to the paper itself', () => {
  const result = snapPosition({ x: 9.5, y: 50 }, size, scene, { threshold: 1 });

  close(result.x, 10, 1e-9);
  assert.ok(result.guides.some((g) => g.kind === 'paper' || g.kind === 'margin'));
});

test('the axes snap independently', () => {
  // X locks to the paper centre while Y is free to stay where the drag put it.
  const result = snapPosition({ x: 100.5, y: 33 }, size, scene, { threshold: 2 });

  close(result.x, 100);
  close(result.y, 33);
  assert.equal(result.guides.length, 1);
});

test('the nearest of several candidates wins', () => {
  // 20 is the margin-aligned centre and 10 the paper edge; from 20.4 the
  // margin is nearer.
  const result = snapPosition({ x: 20.4, y: 50 }, size, scene, { threshold: 5 });
  close(result.x, 20);
});

test('nothing beyond the threshold snaps', () => {
  const result = snapPosition({ x: 105, y: 50 }, size, scene, { threshold: 2 });

  close(result.x, 105);
  assert.ok(!result.guides.some((g) => g.axis === 'x'));
});

test('objects snap to each other', () => {
  const other = createPlacement({ paths: [box(50, 20, 20, 20)] });
  const withObject = addPlacement(scene, other);

  // Align centres vertically: the other object's centre is at y = 30.
  const result = snapPosition({ x: 120, y: 31 }, size, withObject, { threshold: 2 });

  close(result.y, 30);
  assert.ok(result.guides.some((g) => g.kind === 'object'));
});

test('a placement does not snap to itself', () => {
  const self = createPlacement({ paths: [box(50, 20, 20, 20)] });
  const withSelf = addPlacement(scene, self);

  const targets = snapTargets(withSelf, DEFAULT_SNAP, self.id);
  assert.ok(!targets.x.some((t) => t.kind === 'object'));
});

test('hidden objects are not snap targets', () => {
  const hidden = createPlacement({ paths: [box(50, 20, 20, 20)], visible: false });
  const targets = snapTargets(addPlacement(scene, hidden), DEFAULT_SNAP);

  assert.ok(!targets.x.some((t) => t.kind === 'object'));
});

test('snap sources can be turned off individually', () => {
  const result = snapPosition({ x: 100.5, y: 50.5 }, size, scene, {
    threshold: 2,
    paperCentre: false,
    paperEdges: false,
    margins: false,
    objects: false,
  });

  close(result.x, 100.5);
  close(result.y, 50.5);
});

test('the grid snaps when enabled and not otherwise', () => {
  const options = { threshold: 2, gridMm: 10, paperCentre: false, margins: false, paperEdges: false, objects: false };

  close(snapPosition({ x: 41, y: 50 }, size, scene, { ...options, grid: true }).x, 40);
  close(snapPosition({ x: 41, y: 50 }, size, scene, { ...options, grid: false }).x, 41);
});

test('a zero grid spacing does not hang or divide by zero', () => {
  const result = snapPosition({ x: 41, y: 50 }, size, scene, {
    threshold: 2, grid: true, gridMm: 0,
    paperCentre: false, margins: false, paperEdges: false, objects: false,
  });

  close(result.x, 41);
});

test('guides report the line that was snapped to', () => {
  const guide = snapPosition({ x: 101, y: 50 }, size, scene, { threshold: 2 })
    .guides.find((g) => g.axis === 'x');

  assert.equal(guide.value, 100);
});
