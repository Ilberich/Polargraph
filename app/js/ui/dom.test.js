import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEditable } from './dom.js';

// Plain objects rather than real elements: the rule is about tag names, so it
// can be checked without a DOM.

test('form fields are editable', () => {
  assert.equal(isEditable({ tagName: 'INPUT' }), true);
  assert.equal(isEditable({ tagName: 'TEXTAREA' }), true);
  assert.equal(isEditable({ tagName: 'SELECT' }), true);
});

test('ordinary elements are not', () => {
  // body is what document.activeElement reports when nothing is focused.
  assert.equal(isEditable({ tagName: 'BODY' }), false);
  assert.equal(isEditable({ tagName: 'DIV' }), false);
  assert.equal(isEditable({ tagName: 'BUTTON' }), false);
});

test('a contenteditable element counts', () => {
  assert.equal(isEditable({ tagName: 'DIV', isContentEditable: true }), true);
});

test('a missing element is not editable', () => {
  // document.activeElement can be null while the document is being replaced.
  assert.equal(isEditable(null), false);
  assert.equal(isEditable(undefined), false);
});
