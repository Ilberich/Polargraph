import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importSvg } from './import.js';
import { boundsOf, pathLength } from '../geom/path.js';

const close = (a, b, tol = 0.01) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b} within ${tol}`);

test('a document with no svg element reports it', () => {
  const result = importSvg('<html></html>');

  assert.deepEqual(result.paths, []);
  assert.match(result.warnings[0], /No <svg>/);
});

test('user units convert to millimetres at 96 dpi', () => {
  // 96 user units is one inch, so the line is 25.4 mm long.
  const { paths } = importSvg(
    '<svg width="96" height="96"><line x1="0" y1="0" x2="96" y2="0"/></svg>'
  );

  close(pathLength(paths[0]), 25.4);
});

test('a physical width lands at that physical size', () => {
  const { paths, widthMm, heightMm } = importSvg(
    '<svg width="100mm" height="50mm" viewBox="0 0 100 50">' +
      '<rect x="0" y="0" width="100" height="50"/></svg>'
  );

  close(widthMm, 100);
  close(heightMm, 50);

  const b = boundsOf(paths);
  close(b.width, 100);
  close(b.height, 50);
});

test('viewBox scaling reaches the geometry', () => {
  // 100mm wide viewport over a 0..10 viewBox: everything scales ten times.
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 10 10">' +
      '<rect x="0" y="0" width="5" height="5"/></svg>'
  );

  const b = boundsOf(paths);
  close(b.width, 50);
  close(b.height, 50);
});

test('size falls back to the viewBox when width and height are missing', () => {
  const { widthMm } = importSvg('<svg viewBox="0 0 96 96"><rect width="10" height="10"/></svg>');
  close(widthMm, 25.4);
});

test('a percentage width falls back to the viewBox rather than resolving to nothing', () => {
  const { widthMm } = importSvg('<svg width="100%" height="100%" viewBox="0 0 96 48"><rect width="1" height="1"/></svg>');

  close(widthMm, 25.4);
});

test('nested transforms accumulate', () => {
  const { paths } = importSvg(
    '<svg width="96" height="96">' +
      '<g transform="translate(48 0)"><g transform="translate(0 48)">' +
      '<line x1="0" y1="0" x2="0" y2="0"/>' +
      '<rect x="0" y="0" width="48" height="48"/>' +
      '</g></g></svg>'
  );

  const b = boundsOf(paths);
  close(b.minX, 12.7, 0.01);
  close(b.minY, 12.7, 0.01);
});

test('a child transform applies before its parent', () => {
  // scale then translate: the rect ends at x=10+5*2=20 user units.
  const { paths } = importSvg(
    '<svg width="96" height="96"><g transform="translate(10 0)">' +
      '<rect transform="scale(2)" x="0" y="0" width="5" height="5"/></g></svg>'
  );

  const b = boundsOf(paths);
  close(b.minX, (10 * 25.4) / 96);
  close(b.maxX, (20 * 25.4) / 96);
});

test('definitions and hidden elements are not drawn', () => {
  const { paths } = importSvg(
    '<svg width="96" height="96">' +
      '<defs><rect width="10" height="10"/></defs>' +
      '<clipPath><circle r="5"/></clipPath>' +
      '<rect width="10" height="10" display="none"/>' +
      '<rect width="10" height="10" style="fill:red;display:none"/>' +
      '<title>not geometry</title>' +
      '</svg>'
  );

  assert.deepEqual(paths, []);
});

test('unsupported constructs warn but do not fail the import', () => {
  const { paths, warnings } = importSvg(
    '<svg width="96" height="96">' +
      '<text x="0" y="0">hello</text>' +
      '<use href="#a"/>' +
      '<rect width="10" height="10"/>' +
      '</svg>'
  );

  assert.equal(paths.length, 1, 'the drawable shape still imports');
  assert.ok(warnings.some((w) => /Text/.test(w)));
  assert.ok(warnings.some((w) => /<use>/.test(w)));
});

test('warnings do not repeat per element', () => {
  const { warnings } = importSvg(
    '<svg width="96" height="96"><text>a</text><text>b</text><text>c</text></svg>'
  );

  assert.equal(warnings.filter((w) => /Text/.test(w)).length, 1);
});

test('all basic shapes import', () => {
  const { paths } = importSvg(
    '<svg width="200" height="200">' +
      '<rect width="10" height="10"/>' +
      '<circle cx="50" cy="50" r="10"/>' +
      '<ellipse cx="80" cy="50" rx="10" ry="5"/>' +
      '<line x1="0" y1="100" x2="10" y2="100"/>' +
      '<polyline points="0,120 10,120"/>' +
      '<polygon points="0,140 10,140 10,150"/>' +
      '<path d="M0 160 L10 160"/>' +
      '</svg>'
  );

  assert.equal(paths.length, 7);
});

test('flattening tolerance is honoured in millimetres, not source units', () => {
  // The same circle, once at source scale and once scaled up tenfold by a
  // viewBox. Tolerance is a paper measurement, so the larger drawing needs
  // more points to stay within it.
  const small = importSvg(
    '<svg width="25.4mm" height="25.4mm" viewBox="0 0 96 96"><circle cx="48" cy="48" r="40"/></svg>'
  );
  const large = importSvg(
    '<svg width="254mm" height="254mm" viewBox="0 0 96 96"><circle cx="48" cy="48" r="40"/></svg>'
  );

  assert.ok(
    large.paths[0].points.length > small.paths[0].points.length,
    `expected more points on the larger drawing: ${large.paths[0].points.length} vs ${small.paths[0].points.length}`
  );
});

test('imported points carry z, defaulting to zero', () => {
  const { paths } = importSvg('<svg width="96" height="96"><line x1="0" y1="0" x2="1" y2="1"/></svg>');
  assert.equal(paths[0].points[0].z, 0);
});

test('namespaced documents import', () => {
  const { paths } = importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
      '<svg:rect xmlns:svg="http://www.w3.org/2000/svg" width="10" height="10"/></svg>'
  );

  assert.equal(paths.length, 1);
});

test('a real-world export with declaration, doctype and comments imports', () => {
  const { paths } = importSvg(`<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
    <svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
      <!-- a comment -->
      <g id="layer1" transform="translate(10,10)">
        <path d="M 0,0 C 10,0 20,10 20,20 S 30,40 40,40 Z" id="p1"/>
      </g>
    </svg>`);

  assert.equal(paths.length, 1);
  assert.equal(paths[0].meta.id, 'p1');
  assert.equal(paths[0].closed, true);
});

// ----------------------------------------------- closed-ness and filling --

test('a path that returns to its start is closed without Z', () => {
  // Plenty of tools emit the closing point instead of the command.
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<path d="M10 10 L90 10 L90 90 L10 90 L10 10"/></svg>'
  );

  assert.equal(paths[0].closed, true);
  assert.equal(paths[0].points.length, 4, 'the repeated start point is dropped');
});

test('a polyline whose ends meet is closed', () => {
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<polyline points="10,10 90,10 90,90 10,90 10,10" fill="none"/></svg>'
  );

  assert.equal(paths[0].closed, true);
});

test('a genuinely open path stays open', () => {
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<path d="M10 10 L90 50 L20 90" fill="none"/></svg>'
  );

  assert.equal(paths[0].closed, false);
});

test('an unfilled shape is marked unfilled', () => {
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<path d="M10 10 L90 50 L20 90" fill="none"/></svg>'
  );

  assert.equal(paths[0].meta.filled, false);
});

test('a shape with no fill attribute is filled, as SVG says', () => {
  // SVG's initial fill is black, so silence means filled. A filled shape has
  // an inside even when its outline is not explicitly closed.
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<path d="M10 10 L90 50 L20 90"/></svg>'
  );

  assert.equal(paths[0].meta.filled, true);
});

test('fill is inherited from an ancestor group', () => {
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<g fill="none"><g><path d="M10 10 L90 50 L20 90"/></g></g></svg>'
  );

  assert.equal(paths[0].meta.filled, false);
});

test('a child overrides an inherited fill', () => {
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<g fill="none"><path d="M10 10 L90 50 L20 90" fill="red"/></g></svg>'
  );

  assert.equal(paths[0].meta.filled, true);
});

test('a fill in a style attribute beats the presentation attribute', () => {
  const { paths } = importSvg(
    '<svg width="100mm" height="100mm" viewBox="0 0 100 100">' +
      '<path d="M10 10 L90 50 L20 90" fill="red" style="fill:none"/></svg>'
  );

  assert.equal(paths[0].meta.filled, false);
});
