import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLayer, layerIdFor, assignPaths, groupByLayer, resetLayerIds, LAYER_COLOURS,
} from './layers.js';
import { createPlacement } from './placement.js';
import { createPath } from '../geom/path.js';

const line = (y) => createPath([{ x: 0, y }, { x: 10, y }]);

test('layers get a name and a colour', () => {
  resetLayerIds();
  const first = createLayer();
  const second = createLayer();

  assert.equal(first.name, 'Pen 1');
  assert.equal(second.name, 'Pen 2');
  assert.notEqual(first.color, second.color);
  assert.equal(first.color, LAYER_COLOURS[0]);
});

test('colours repeat once the palette runs out', () => {
  resetLayerIds();
  const layers = Array.from({ length: LAYER_COLOURS.length + 1 }, () => createLayer());
  assert.equal(layers[LAYER_COLOURS.length].color, layers[0].color);
});

test('a path takes its placement default unless overridden', () => {
  const a = line(0);
  const b = line(10);
  const placement = createPlacement({ paths: [a, b], layerId: 'l1' });

  assert.equal(layerIdFor(placement, a), 'l1');
  assert.equal(layerIdFor({ ...placement, pathLayers: { [b.id]: 'l2' } }, b), 'l2');
});

test('assigning to the placement default drops the override', () => {
  // Otherwise "this object is all one pen" stops being expressible.
  const a = line(0);
  const placement = createPlacement({ paths: [a], layerId: 'l1', pathLayers: { [a.id]: 'l2' } });

  assert.deepEqual(assignPaths(placement, [a.id], 'l1'), {});
});

test('assigning to nothing clears the override', () => {
  const a = line(0);
  const placement = createPlacement({ paths: [a], pathLayers: { [a.id]: 'l2' } });

  assert.deepEqual(assignPaths(placement, [a.id], null), {});
});

test('assignment does not mutate the placement', () => {
  const a = line(0);
  const placement = createPlacement({ paths: [a] });

  assignPaths(placement, [a.id], 'l2');
  assert.deepEqual(placement.pathLayers, {});
});

test('grouping follows layer order, not path order', () => {
  // Layer order is the order pens are swapped in, so it has to win.
  const layers = [createLayer({ name: 'A' }), createLayer({ name: 'B' })];
  const entries = [
    { path: line(0), layerId: layers[1].id },
    { path: line(1), layerId: layers[0].id },
    { path: line(2), layerId: layers[1].id },
  ];

  const groups = groupByLayer(layers, entries);

  assert.deepEqual(groups.map((g) => g.layer.name), ['A', 'B']);
  assert.equal(groups[0].paths.length, 1);
  assert.equal(groups[1].paths.length, 2);
});

test('empty layers are dropped', () => {
  const layers = [createLayer({ name: 'A' }), createLayer({ name: 'Unused' })];
  const groups = groupByLayer(layers, [{ path: line(0), layerId: layers[0].id }]);

  assert.equal(groups.length, 1);
});

test('unassigned paths are drawn first, not lost', () => {
  const layers = [createLayer({ name: 'A' })];
  const groups = groupByLayer(layers, [
    { path: line(0), layerId: layers[0].id },
    { path: line(1), layerId: null },
  ]);

  assert.equal(groups[0].layer, null);
  assert.equal(groups.length, 2);
});

test('a path pointing at a deleted layer is still plotted', () => {
  // Losing strokes because their pen was removed would be far worse than
  // plotting them with whatever is already in the holder.
  const layers = [createLayer({ name: 'A' })];
  const groups = groupByLayer(layers, [{ path: line(0), layerId: 'gone' }]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].layer, null);
  assert.equal(groups[0].paths.length, 1);
});

test('grouping nothing yields nothing', () => {
  assert.deepEqual(groupByLayer([createLayer()], []), []);
});
