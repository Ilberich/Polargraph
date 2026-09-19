import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  load, save, clear, mergeSettings, createMemoryStorage, defaultStorage, STORAGE_KEY,
} from './storage.js';

test('a saved value loads back', () => {
  const storage = createMemoryStorage();
  const value = { paper: { widthMm: 420 }, penLift: false };

  assert.equal(save(value, storage), true);
  assert.deepEqual(load(storage), value);
});

test('an empty store returns the fallback', () => {
  assert.equal(load(createMemoryStorage(), null), null);
  assert.deepEqual(load(createMemoryStorage(), { a: 1 }), { a: 1 });
});

test('corrupt JSON returns the fallback rather than throwing', () => {
  const storage = createMemoryStorage({ [STORAGE_KEY]: '{not json' });
  assert.deepEqual(load(storage, { safe: true }), { safe: true });
});

test('a stored non-object is treated as corrupt', () => {
  // JSON.parse("42") succeeds but is not a session to restore.
  const storage = createMemoryStorage({ [STORAGE_KEY]: '42' });
  assert.equal(load(storage, null), null);
});

test('clearing removes the value', () => {
  const storage = createMemoryStorage();
  save({ a: 1 }, storage);

  assert.equal(clear(storage), true);
  assert.equal(load(storage), null);
});

test('a throwing store fails without taking the app down', () => {
  // localStorage throws outright in some private modes, and can be full.
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { throw new Error('denied'); },
  };

  assert.equal(load(hostile, 'fallback'), 'fallback');
  assert.equal(save({ a: 1 }, hostile), false, 'the caller can tell the user');
  assert.equal(clear(hostile), false);
});

test('defaultStorage falls back to memory when there is no browser', () => {
  const storage = defaultStorage();

  assert.equal(typeof storage.getItem, 'function');
  assert.equal(save({ a: 1 }, storage), true);
});

test('merging fills in missing keys from the defaults', () => {
  const defaults = { feedRate: 1200, penLift: false };
  assert.deepEqual(mergeSettings(defaults, { feedRate: 900 }), { feedRate: 900, penLift: false });
});

test('merging recurses into nested objects', () => {
  const defaults = { paper: { widthMm: 420, heightMm: 594, margins: { top: 20, left: 20 } } };
  const merged = mergeSettings(defaults, { paper: { widthMm: 210, margins: { top: 5 } } });

  assert.deepEqual(merged, {
    paper: { widthMm: 210, heightMm: 594, margins: { top: 5, left: 20 } },
  });
});

test('unknown stored keys are ignored', () => {
  // A session from an older version cannot introduce settings the app has
  // since dropped.
  const merged = mergeSettings({ a: 1 }, { a: 2, removedLastVersion: true });
  assert.deepEqual(merged, { a: 2 });
});

test('merging a missing or malformed session yields the defaults', () => {
  const defaults = { a: 1, b: { c: 2 } };

  assert.deepEqual(mergeSettings(defaults, null), defaults);
  assert.deepEqual(mergeSettings(defaults, 'nonsense'), defaults);
});

test('merging does not mutate the defaults', () => {
  const defaults = { paper: { widthMm: 420 } };
  mergeSettings(defaults, { paper: { widthMm: 1 } });

  assert.equal(defaults.paper.widthMm, 420);
});

test('an array value replaces rather than merging', () => {
  assert.deepEqual(mergeSettings({ tags: ['a'] }, { tags: ['b', 'c'] }), { tags: ['b', 'c'] });
});
