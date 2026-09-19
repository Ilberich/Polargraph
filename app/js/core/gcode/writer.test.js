import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeGcode, formatNumber } from './writer.js';
import { createPath } from '../geom/path.js';
import { parseGcode } from './parser.js';

const square = createPath(
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
  { closed: true }
);

const bodyOf = (gcode) =>
  gcode.split('\n').filter((l) => l && !l.startsWith(';'));

test('numbers are trimmed, not padded', () => {
  assert.equal(formatNumber(10), '10');
  assert.equal(formatNumber(10.5), '10.5');
  assert.equal(formatNumber(10.123456), '10.123');
  assert.equal(formatNumber(1 / 3, 4), '0.3333');
});

test('negative zero is normalised', () => {
  // Valid JavaScript, but it reads as a mistake in a file a human opens.
  assert.equal(formatNumber(-0), '0');
  assert.equal(formatNumber(-0.0001), '0');
});

test('output starts absolute and ends with home then end-of-program', () => {
  const lines = bodyOf(writeGcode([square]));

  assert.equal(lines[0], 'G90');
  assert.equal(lines[lines.length - 2], 'G28');
  assert.equal(lines[lines.length - 1], 'M30');
});

test('home can be suppressed', () => {
  assert.ok(!writeGcode([square], { endWithHome: false }).includes('G28'));
});

test('a stroke travels with G0 then draws with G1', () => {
  const lines = bodyOf(writeGcode([square]));

  assert.match(lines[1], /^G0 X0 Y0/);
  assert.ok(lines.slice(2, -2).every((l) => l.startsWith('G1')));
});

test('a closed path returns to its start', () => {
  const draws = bodyOf(writeGcode([square])).filter((l) => l.startsWith('G1'));

  // Four sides: three corners plus the closing move back to the first point.
  assert.equal(draws.length, 4);

  // Check the position rather than the text: X is modal and already 0 on the
  // closing move, so only Y appears on that line.
  const parsed = parseGcode(writeGcode([square]));
  const last = parsed.filter((r) => r.type === 'move').pop();

  assert.deepEqual(last.to, { x: 0, y: 0, z: 0 });
});

test('an open path does not close itself', () => {
  const open = createPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  const draws = bodyOf(writeGcode([open])).filter((l) => l.startsWith('G1'));

  assert.equal(draws.length, 2);
});

test('only changed axes are written', () => {
  // A horizontal move must not restate Y.
  const path = createPath([{ x: 0, y: 5 }, { x: 10, y: 5 }]);
  const draw = bodyOf(writeGcode(path ? [path] : [])).find((l) => l.startsWith('G1'));

  assert.match(draw, /X10/);
  assert.ok(!draw.includes('Y'), `Y should be modal: ${draw}`);
});

test('feed rate is written once until it changes', () => {
  const gcode = writeGcode([square], { feedRate: 900, travelFeedRate: 3000 });
  const feeds = gcode.match(/F\d+/g);

  assert.deepEqual(feeds, ['F3000', 'F900'], 'travel then draw, each stated once');
});

test('degenerate paths are skipped', () => {
  const gcode = writeGcode([createPath([{ x: 1, y: 1 }]), createPath([])]);
  assert.equal(bodyOf(gcode).filter((l) => l.startsWith('G')).length, 2, 'G90 and G28 only');
});

test('per-vertex Z is emitted', () => {
  const ramp = createPath([
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: -1 },
    { x: 20, y: 0, z: -2 },
  ]);
  const gcode = writeGcode([ramp]);

  assert.ok(gcode.includes('Z-1'));
  assert.ok(gcode.includes('Z-2'));
});

test('without a pen axis nothing lifts between strokes', () => {
  // v1 hardware: travel moves mark the paper, and the file says so. Z is still
  // stated once to establish a known depth, but there is no raise/lower
  // choreography around travels.
  const gcode = writeGcode([square, square], { penLift: false });
  const lines = bodyOf(gcode);

  assert.match(gcode, /pen lift: no/);
  assert.equal(lines.filter((l) => /Z/.test(l)).length, 1);
  assert.ok(!lines.some((l) => /^G0 Z/.test(l)), 'nothing lifts');
});

test('a stroke starting where the last ended emits no travel', () => {
  // A bare `G0 F3000` would be a move that moves nothing.
  const lines = bodyOf(writeGcode([square, square]));

  assert.ok(!lines.some((l) => /^G0(\s+F\S+)?$/.test(l)), lines.join('\n'));
});

test('a discarded line does not advance the modal feed state', () => {
  // The second square needs no travel, so its G0 is dropped. If the writer had
  // already recorded the travel feed, the following G1 would omit F and the
  // machine would draw at the travel rate.
  const gcode = writeGcode([square, square], { feedRate: 900, travelFeedRate: 3000 });
  const moves = parseGcode(gcode).filter((r) => r.type === 'move');

  for (const move of moves.filter((m) => !m.rapid)) {
    assert.equal(move.feed, 900, 'every drawn move must run at the drawing feed');
  }
});

test('with a pen axis the pen raises before travel and lowers to draw', () => {
  const path = createPath([{ x: 0, y: 0, z: -2 }, { x: 10, y: 0, z: -2 }]);
  const lines = bodyOf(writeGcode([path], { penLift: true, travelZ: 5 }));

  assert.match(lines[1], /^G0 Z5/, 'raise first');
  assert.match(lines[2], /^G0 X0 Y0/, 'travel raised');
  assert.ok(!lines[2].includes('Z'), 'the travel must not carry the stroke depth');
  assert.match(lines[3], /^G1 Z-2/, 'lower onto the paper');
  assert.match(lines[lines.length - 3], /^G0 Z5/, 'raise at the end of the job');
});

test('an empty job still produces a valid program', () => {
  assert.deepEqual(bodyOf(writeGcode([])), ['G90', 'G28', 'M30']);
});

test('the header can be turned off', () => {
  assert.ok(!writeGcode([square], { header: false }).startsWith(';'));
});
