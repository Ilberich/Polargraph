import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGcode, gcodeToPaths, measureGcode, stripComments, parseWords,
} from './parser.js';

const moves = (src) => parseGcode(src).filter((r) => r.type === 'move');

test('both comment forms are stripped', () => {
  assert.equal(stripComments('G1 X10 ; go right').trim(), 'G1 X10');
  assert.equal(stripComments('G1 (inline) X10').replace(/\s+/g, ' ').trim(), 'G1 X10');
});

test('words parse, case-insensitively', () => {
  assert.deepEqual(parseWords('G1 X10.5 Y-3 F1200'), { G: 1, X: 10.5, Y: -3, F: 1200 });
  assert.deepEqual(parseWords('g1 x1'), { G: 1, X: 1 });
});

test('a move records both endpoints', () => {
  const [move] = moves('G90\nG1 X10 Y20');

  assert.deepEqual(move.from, { x: 0, y: 0, z: 0 });
  assert.deepEqual(move.to, { x: 10, y: 20, z: 0 });
});

test('unstated axes carry over', () => {
  const [, second] = moves('G1 X10 Y20\nG1 X30');
  assert.deepEqual(second.to, { x: 30, y: 20, z: 0 });
});

test('G0 is rapid and G1 is not', () => {
  const [rapid, draw] = moves('G0 X1\nG1 X2');

  assert.equal(rapid.rapid, true);
  assert.equal(draw.rapid, false);
});

test('feed rate is modal', () => {
  const [first, second] = moves('G1 X1 F900\nG1 X2');

  assert.equal(first.feed, 900);
  assert.equal(second.feed, 900);
});

test('relative mode accumulates, and absolute mode resumes', () => {
  const recorded = moves('G90\nG1 X10\nG91\nG1 X5\nG90\nG1 X1');

  assert.equal(recorded[0].to.x, 10);
  assert.equal(recorded[1].to.x, 15);
  assert.equal(recorded[2].to.x, 1);
});

test('a move to the current position is not a move', () => {
  // Keeping it would put zero-length segments in the preview and the estimate.
  assert.equal(moves('G1 X10\nG1 X10').length, 1);
});

test('pause, home and end are recorded', () => {
  const types = parseGcode('M0\nG28\nM30').map((r) => r.type);
  assert.deepEqual(types, ['pause', 'home', 'end']);
});

test('M2 ends the program like M30', () => {
  assert.deepEqual(parseGcode('M2').map((r) => r.type), ['end']);
});

test('records carry their source line for the scrubber', () => {
  const [move] = moves('; header\nG90\nG1 X5');
  assert.equal(move.line, 3);
});

test('unknown commands are skipped, not rejected', () => {
  // Files from other tools carry codes this machine has no use for.
  const recorded = moves('G21\nM3 S255\nG1 X10\nT1');
  assert.equal(recorded.length, 1);
});

test('blank input parses to nothing', () => {
  assert.deepEqual(parseGcode(''), []);
  assert.deepEqual(parseGcode(null), []);
});

test('rapids start strokes and controlled moves extend them', () => {
  const paths = gcodeToPaths('G0 X0 Y0\nG1 X10 Y0\nG1 X10 Y10\nG0 X50 Y50\nG1 X60 Y50');

  assert.equal(paths.length, 2);
  assert.equal(paths[0].points.length, 3);
  assert.equal(paths[1].points.length, 2);
});

test('a pause breaks a stroke', () => {
  const paths = gcodeToPaths('G0 X0 Y0\nG1 X10 Y0\nM0\nG1 X20 Y0');
  assert.equal(paths.length, 2);
});

test('a single-point stroke is dropped', () => {
  assert.deepEqual(gcodeToPaths('G0 X5 Y5\nG0 X9 Y9'), []);
});

test('measure separates drawn from travelled distance', () => {
  const { draw, travel, total } = measureGcode('G0 X10 Y0\nG1 X10 Y20');

  assert.equal(travel, 10);
  assert.equal(draw, 20);
  assert.equal(total, 30);
});

test('a Z-only move covers no distance across the paper', () => {
  assert.equal(measureGcode('G1 Z-5').total, 0);
});
