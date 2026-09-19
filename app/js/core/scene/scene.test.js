import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createScene, marginBox, addPlacement, removePlacement, updatePlacement,
  getPlacement, reorderPlacement, pickAt, scenePaths, outsideMargins,
  fitToMargins, centreOnPaper, setPaper, DEFAULT_PAPER,
  addLayer, updateLayer, removeLayer, reorderLayer, scenePathsByLayer,
} from './scene.js';
import { createLayer } from './layers.js';
import { createPlacement, placementBounds } from './placement.js';
import { createPath } from '../geom/path.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

const box = (x, y, w, h) =>
  createPath([
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ], { closed: true });

const paper = { widthMm: 200, heightMm: 100, margins: { top: 10, right: 10, bottom: 10, left: 10 } };

test('the margin box is the paper inset by its margins', () => {
  const b = marginBox(paper);

  assert.deepEqual(
    [b.minX, b.minY, b.maxX, b.maxY, b.width, b.height],
    [10, 10, 190, 90, 180, 80]
  );
});

test('asymmetric margins are respected', () => {
  const b = marginBox({ widthMm: 100, heightMm: 100, margins: { top: 1, right: 2, bottom: 3, left: 4 } });

  assert.deepEqual([b.minX, b.minY, b.maxX, b.maxY], [4, 1, 98, 97]);
});

test('adding and removing placements does not mutate the scene', () => {
  const scene = createScene({ paper });
  const placement = createPlacement({ paths: [box(0, 0, 10, 10)] });

  const added = addPlacement(scene, placement);

  assert.equal(scene.placements.length, 0, 'the original is untouched');
  assert.equal(added.placements.length, 1);
  assert.equal(removePlacement(added, placement.id).placements.length, 0);
});

test('updating a placement leaves the others alone', () => {
  const a = createPlacement({ paths: [box(0, 0, 10, 10)], name: 'a' });
  const b = createPlacement({ paths: [box(0, 0, 10, 10)], name: 'b' });
  const scene = addPlacement(addPlacement(createScene({ paper }), a), b);

  const updated = updatePlacement(scene, a.id, { rotation: 45 });

  assert.equal(getPlacement(updated, a.id).rotation, 45);
  assert.equal(getPlacement(updated, b.id).rotation, 0);
  assert.equal(getPlacement(scene, a.id).rotation, 0, 'the original is untouched');
});

test('updating an unknown id changes nothing', () => {
  const scene = createScene({ paper });
  assert.deepEqual(updatePlacement(scene, 'nope', { rotation: 1 }), scene);
});

test('reordering moves within bounds and clamps at the ends', () => {
  const ids = ['a', 'b', 'c'].map((name) =>
    createPlacement({ paths: [box(0, 0, 1, 1)], name })
  );
  const scene = ids.reduce(addPlacement, createScene({ paper }));
  const order = (s) => s.placements.map((p) => p.name);

  assert.deepEqual(order(reorderPlacement(scene, ids[0].id, 1)), ['b', 'a', 'c']);
  assert.deepEqual(order(reorderPlacement(scene, ids[0].id, -1)), ['a', 'b', 'c'], 'clamped');
  assert.deepEqual(order(reorderPlacement(scene, ids[0].id, 99)), ['b', 'c', 'a']);
});

test('picking returns the topmost placement under a point', () => {
  const lower = createPlacement({ paths: [box(0, 0, 50, 50)], name: 'lower' });
  const upper = createPlacement({ paths: [box(0, 0, 50, 50)], name: 'upper' });
  const scene = addPlacement(addPlacement(createScene({ paper }), lower), upper);

  assert.equal(pickAt(scene, { x: 25, y: 25 }).name, 'upper');
  assert.equal(pickAt(scene, { x: 500, y: 500 }), null);
});

test('picking ignores hidden placements', () => {
  const hidden = createPlacement({ paths: [box(0, 0, 50, 50)], visible: false });
  const scene = addPlacement(createScene({ paper }), hidden);

  assert.equal(pickAt(scene, { x: 25, y: 25 }), null);
});

test('scene paths gather visible geometry only', () => {
  const shown = createPlacement({ paths: [box(0, 0, 10, 10)] });
  const hidden = createPlacement({ paths: [box(0, 0, 10, 10)], visible: false });
  const scene = addPlacement(addPlacement(createScene({ paper }), shown), hidden);

  assert.equal(scenePaths(scene).length, 1);
});

test('placements straying outside the margins are reported', () => {
  // The machine will happily drive off the paper; on a polargraph that means
  // drawing on the wall.
  const inside = createPlacement({ paths: [box(0, 0, 20, 20)], x: 100, y: 50 });
  const outside = createPlacement({ paths: [box(0, 0, 20, 20)], x: 5, y: 50 });
  const scene = addPlacement(addPlacement(createScene({ paper }), inside), outside);

  const strays = outsideMargins(scene);

  assert.equal(strays.length, 1);
  assert.equal(strays[0].id, outside.id);
});

test('a hidden stray is not reported', () => {
  const stray = createPlacement({ paths: [box(0, 0, 20, 20)], x: 0, y: 0, visible: false });
  assert.deepEqual(outsideMargins(addPlacement(createScene({ paper }), stray)), []);
});

test('fitting scales down and centres inside the margins', () => {
  const big = createPlacement({ paths: [box(0, 0, 400, 400)] });
  const scene = fitToMargins(addPlacement(createScene({ paper }), big), big.id);
  const b = placementBounds(getPlacement(scene, big.id));
  const inner = marginBox(paper);

  close(b.height, 80, 1e-9);
  assert.ok(b.width <= inner.width + 1e-9);
  close((b.minX + b.maxX) / 2, 100, 1e-9);
  close((b.minY + b.maxY) / 2, 50, 1e-9);
});

test('fitting enlarges a small drawing to fill the margins', () => {
  // A command called "fit" that declines to fit reads as broken.
  const small = createPlacement({ paths: [box(0, 0, 5, 5)] });
  const scene = fitToMargins(addPlacement(createScene({ paper }), small), small.id);
  const b = placementBounds(getPlacement(scene, small.id));

  close(b.height, 80, 1e-9);
  close(b.width, 80, 1e-9);
  assert.ok(b.width <= marginBox(paper).width + 1e-9);
});

test('fitting keeps the aspect ratio', () => {
  const wide = createPlacement({ paths: [box(0, 0, 40, 10)] });
  const scene = fitToMargins(addPlacement(createScene({ paper }), wide), wide.id);
  const b = placementBounds(getPlacement(scene, wide.id));

  close(b.width / b.height, 4, 1e-9);
  assert.ok(b.width <= marginBox(paper).width + 1e-9);
  assert.ok(b.height <= marginBox(paper).height + 1e-9);
});

test('fitting a zero-extent placement is a no-op', () => {
  const empty = createPlacement({ paths: [] });
  const scene = addPlacement(createScene({ paper }), empty);

  assert.deepEqual(fitToMargins(scene, empty.id), scene);
});

test('centring uses the paper, not the margins', () => {
  const p = createPlacement({ paths: [box(0, 0, 10, 10)] });
  const scene = centreOnPaper(addPlacement(createScene({ paper }), p), p.id);
  const b = placementBounds(getPlacement(scene, p.id));

  close((b.minX + b.maxX) / 2, 100);
  close((b.minY + b.maxY) / 2, 50);
});

test('paper changes merge and do not mutate', () => {
  const scene = createScene({ paper });
  const wider = setPaper(scene, { widthMm: 500 });

  assert.equal(wider.paper.widthMm, 500);
  assert.equal(wider.paper.heightMm, 100, 'other fields survive');
  assert.equal(scene.paper.widthMm, 200, 'the original is untouched');
});

test('the default paper has sane margins', () => {
  const b = marginBox(DEFAULT_PAPER);
  assert.ok(b.width > 0 && b.height > 0);
});

// ----------------------------------------------------------------- layers --

test('layers can be added, renamed and reordered', () => {
  const a = createLayer({ name: 'A' });
  const b = createLayer({ name: 'B' });
  let scene = addLayer(addLayer(createScene({ paper }), a), b);

  assert.deepEqual(scene.layers.map((l) => l.name), ['A', 'B']);

  scene = updateLayer(scene, a.id, { name: 'Renamed' });
  assert.equal(scene.layers[0].name, 'Renamed');

  scene = reorderLayer(scene, a.id, 1);
  assert.deepEqual(scene.layers.map((l) => l.name), ['B', 'Renamed']);
});

test('removing a layer keeps the strokes drawn with it', () => {
  const layer = createLayer({ name: 'Red' });
  const path = box(0, 0, 10, 10);
  const placement = createPlacement({ paths: [path], layerId: layer.id });

  let scene = addPlacement(addLayer(createScene({ paper }), layer), placement);
  scene = removeLayer(scene, layer.id);

  assert.equal(scene.layers.length, 0);
  assert.equal(scene.placements.length, 1, 'the object survives');
  assert.equal(getPlacement(scene, placement.id).layerId, null);
  assert.equal(scenePaths(scene).length, 1, 'and is still plotted');
});

test('paths are grouped by layer in plot order', () => {
  const first = createLayer({ name: 'First' });
  const second = createLayer({ name: 'Second' });

  const a = box(0, 0, 10, 10);
  const b = box(20, 0, 10, 10);
  const placement = createPlacement({
    paths: [a, b],
    layerId: first.id,
    pathLayers: { [b.id]: second.id },
  });

  const scene = addPlacement(addLayer(addLayer(createScene({ paper }), first), second), placement);
  const groups = scenePathsByLayer(scene);

  assert.deepEqual(groups.map((g) => g.layer.name), ['First', 'Second']);
  assert.equal(groups[0].paths.length, 1);
  assert.equal(groups[1].paths.length, 1);
});

test('a hidden layer is not plotted at all', () => {
  const shown = createLayer({ name: 'Shown' });
  const hidden = createLayer({ name: 'Hidden', visible: false });

  const a = box(0, 0, 10, 10);
  const b = box(20, 0, 10, 10);
  const placement = createPlacement({
    paths: [a, b],
    layerId: shown.id,
    pathLayers: { [b.id]: hidden.id },
  });

  const scene = addPlacement(addLayer(addLayer(createScene({ paper }), shown), hidden), placement);

  assert.equal(scenePaths(scene).length, 1, 'hiding a layer means not drawing it');
});

test('hatch lines inherit the placement layer', () => {
  const layer = createLayer({ name: 'Fill' });
  const placement = createPlacement({
    paths: [box(0, 0, 40, 40)],
    layerId: layer.id,
    hatch: { enabled: true, spacingMm: 5, angleDeg: 0 },
  });

  const scene = addPlacement(addLayer(createScene({ paper }), layer), placement);
  const groups = scenePathsByLayer(scene);

  assert.equal(groups.length, 1);
  assert.ok(groups[0].paths.length > 5, 'outline and fill together');
});
