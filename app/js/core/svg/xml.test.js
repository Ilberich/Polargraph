import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseXml, find, descendants, decodeEntities } from './xml.js';

test('parses elements, attributes and nesting', () => {
  const doc = parseXml('<svg width="100"><g id="a"><rect x="1"/></g></svg>');
  const svg = doc.children[0];

  assert.equal(svg.tag, 'svg');
  assert.equal(svg.attrs.width, '100');
  assert.equal(svg.children[0].attrs.id, 'a');
  assert.equal(svg.children[0].children[0].tag, 'rect');
});

test('accepts single or double quoted attributes', () => {
  const doc = parseXml(`<rect x='5' y="6"/>`);
  assert.deepEqual(doc.children[0].attrs, { x: '5', y: '6' });
});

test('an attribute value may contain a greater-than sign', () => {
  // Scanning for the next '>' would truncate the tag here.
  const doc = parseXml('<path d="M0 0 L1 1" data-note="a > b" fill="red"/>');

  assert.equal(doc.children[0].attrs['data-note'], 'a > b');
  assert.equal(doc.children[0].attrs.fill, 'red');
});

test('skips comments, declarations, doctypes and CDATA markers', () => {
  const doc = parseXml(`
    <?xml version="1.0"?>
    <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/svg.dtd">
    <!-- a comment with <tags> inside -->
    <svg><rect/></svg>
  `);

  assert.equal(doc.children.length, 1);
  assert.equal(doc.children[0].tag, 'svg');
});

test('handles a doctype with an internal subset', () => {
  const doc = parseXml('<!DOCTYPE svg [ <!ENTITY x "y"> ]><svg/>');
  assert.equal(doc.children[0].tag, 'svg');
});

test('namespace prefixes are stripped', () => {
  const doc = parseXml('<svg:svg><svg:rect/></svg:svg>');

  assert.equal(doc.children[0].tag, 'svg');
  assert.equal(doc.children[0].children[0].tag, 'rect');
});

test('decodes entities in attribute values', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42;'), 'a & b <c> A B');
  assert.equal(parseXml('<a t="x &amp; y"/>').children[0].attrs.t, 'x & y');
});

test('an unknown entity is left as written', () => {
  assert.equal(decodeEntities('&nope;'), '&nope;');
});

test('self-closing and paired tags nest the same way', () => {
  const doc = parseXml('<g><a/><b></b><c/></g>');
  assert.deepEqual(doc.children[0].children.map((c) => c.tag), ['a', 'b', 'c']);
});

test('a stray closing tag does not derail the parse', () => {
  // Real exports are not always well formed; losing the drawing would be worse.
  const doc = parseXml('<svg></g><rect/></svg>');
  assert.ok(find(doc, 'rect'));
});

test('an unterminated tag terminates the parse', () => {
  const doc = parseXml('<svg><rect x="1"');
  assert.equal(doc.children[0].tag, 'svg');
});

test('find locates a descendant depth first', () => {
  const doc = parseXml('<svg><g><circle/></g></svg>');

  assert.equal(find(doc, 'circle').tag, 'circle');
  assert.equal(find(doc, 'nothing'), null);
});

test('descendants walks the whole tree', () => {
  const doc = parseXml('<svg><g><circle/></g><rect/></svg>');
  const tags = [...descendants(doc)].map((n) => n.tag);

  assert.deepEqual(tags, ['svg', 'g', 'circle', 'rect']);
});

test('attributes without values are tolerated', () => {
  const doc = parseXml('<rect disabled x="1"/>');
  assert.equal(doc.children[0].attrs.x, '1');
});
