import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTextEntry } from './dom.js';

// Plain objects rather than real elements: the rule is about tag and type, so
// it can be checked without a DOM.

test('text fields are text entry', () => {
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'number' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT' }), true, 'type defaults to text');
  assert.equal(isTextEntry({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
});

test('a checkbox is not text entry', () => {
  // The bug this rule exists to prevent: a checkbox keeps focus after a click,
  // so treating it as editable defers the panel rebuild indefinitely and the
  // user's own click appears to do nothing.
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'radio' }), false);
});

test('controls that commit on click are not text entry', () => {
  for (const type of ['button', 'submit', 'reset', 'file', 'color', 'range']) {
    assert.equal(isTextEntry({ tagName: 'INPUT', type }), false, type);
  }
});

test('a select has no caret, so it is not text entry', () => {
  assert.equal(isTextEntry({ tagName: 'SELECT' }), false);
});

test('ordinary elements are not text entry', () => {
  assert.equal(isTextEntry({ tagName: 'BODY' }), false);
  assert.equal(isTextEntry({ tagName: 'BUTTON' }), false);
});

test('a missing element is not text entry', () => {
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry(undefined), false);
});

test('input type matching ignores case', () => {
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'CHECKBOX' }), false);
});
