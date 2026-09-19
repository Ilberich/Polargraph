import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateGcode, moveDuration, formatDuration, DEFAULTS } from './estimate.js';

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b} within ${tol}`);

// ------------------------------------------------------- the motion model --

test('a long move reaches its commanded speed', () => {
  // 0 -> 20 mm/s at 200 mm/s^2 takes 0.1s and covers 1mm at each end.
  // The remaining 98mm cruises at 20mm/s = 4.9s. Total 5.1s.
  close(moveDuration(100, 0, 0, 20, 200), 5.1, 1e-9);
});

test('a short move never reaches its commanded speed', () => {
  // The whole 1mm is spent accelerating and braking, so it takes longer than
  // distance/speed would suggest.
  const naive = 1 / 20;
  assert.ok(moveDuration(1, 0, 0, 20, 200) > naive * 2);
});

test('carrying speed through a junction is faster than stopping', () => {
  const stopping = moveDuration(10, 0, 0, 20, 200);
  const carrying = moveDuration(10, 20, 20, 20, 200);

  assert.ok(carrying < stopping);
});

test('a zero-length move takes no time', () => {
  assert.equal(moveDuration(0, 0, 0, 20, 200), 0);
});

test('without acceleration the model degrades to distance over speed', () => {
  close(moveDuration(100, 0, 0, 20, 0), 5);
});

// ----------------------------------------------------------- whole jobs --

test('a job with no moves takes no time', () => {
  const e = estimateGcode('G90\nM30');

  assert.equal(e.totalSeconds, 0);
  assert.equal(e.moves, 0);
});

test('drawing and travelling are counted separately', () => {
  const e = estimateGcode('G0 X100 Y0 F3000\nG1 X100 Y100 F1200');

  assert.ok(e.travelSeconds > 0);
  assert.ok(e.drawSeconds > 0);
  close(e.totalSeconds, e.drawSeconds + e.travelSeconds, 1e-9);
});

test('a rapid is quicker than the same distance drawn', () => {
  const rapid = estimateGcode('G0 X100 F3000');
  const drawn = estimateGcode('G1 X100 F1200');

  assert.ok(rapid.totalSeconds < drawn.totalSeconds);
});

test('the estimate exceeds the naive length-over-feed figure', () => {
  // A flattened curve: many short segments, each one acceleration-limited.
  // This gap is the whole reason the model exists.
  const lines = ['G90'];
  for (let i = 1; i <= 400; i++) lines.push(`G1 X${(i * 0.5).toFixed(2)} F1200`);

  const estimate = estimateGcode(lines.join('\n'));
  const naive = 200 / (1200 / 60); // 200mm at 20mm/s = 10s

  assert.ok(
    estimate.totalSeconds > naive,
    `estimate ${estimate.totalSeconds.toFixed(1)}s should exceed naive ${naive}s`
  );
});

test('a straight run is not braked at every vertex', () => {
  // The same distance, once as one move and once split into many collinear
  // ones. Junction speeds should keep these close; stopping at each vertex
  // would make the split version far slower.
  const single = estimateGcode('G1 X200 F1200');

  const split = ['G90'];
  for (let i = 1; i <= 100; i++) split.push(`G1 X${i * 2} F1200`);
  const many = estimateGcode(split.join('\n'));

  assert.ok(
    many.totalSeconds < single.totalSeconds * 1.6,
    `split ${many.totalSeconds.toFixed(2)}s vs single ${single.totalSeconds.toFixed(2)}s`
  );
});

test('doubling back costs more than carrying straight on', () => {
  const straight = estimateGcode('G1 X50 F1200\nG1 X100 F1200');
  const reversal = estimateGcode('G1 X50 F1200\nG1 X0 F1200');

  assert.ok(reversal.totalSeconds > straight.totalSeconds);
});

test('a higher feed rate takes less time', () => {
  const slow = estimateGcode('G1 X200 F600');
  const fast = estimateGcode('G1 X200 F2400');

  assert.ok(fast.totalSeconds < slow.totalSeconds);
});

test('feed is capped by the machine maximum', () => {
  const asked = estimateGcode('G1 X200 F99999', { maxSpeedMmMin: 1200 });
  const capped = estimateGcode('G1 X200 F1200', { maxSpeedMmMin: 1200 });

  close(asked.totalSeconds, capped.totalSeconds, 1e-9);
});

test('higher acceleration takes less time', () => {
  const sluggish = estimateGcode('G1 X100 F3000', { acceleration: 50 });
  const brisk = estimateGcode('G1 X100 F3000', { acceleration: 800 });

  assert.ok(brisk.totalSeconds < sluggish.totalSeconds);
});

test('pauses add pen-swap time and are counted', () => {
  const e = estimateGcode('G1 X10 F1200\nM0\nG1 X20 F1200', { pauseSeconds: 30 });

  assert.equal(e.pauses, 1);
  close(e.pauseSeconds, 30);
  assert.ok(e.totalSeconds > 30);
});

test('a Z-only move contributes no travel time', () => {
  // It takes time on a machine with a servo, but not time this model knows.
  assert.equal(estimateGcode('G1 Z-5 F300').moves, 0);
});

test('the default settings produce a plausible figure', () => {
  // A 1m line at the default 1200 mm/min should land near a minute.
  const e = estimateGcode('G1 X1000 F1200', DEFAULTS);
  assert.ok(e.totalSeconds > 48 && e.totalSeconds < 60, `${e.totalSeconds}s`);
});

// ------------------------------------------------------------ formatting --

test('durations format readably', () => {
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(270), '4m 30s');
  assert.equal(formatDuration(4320), '1h 12m');
});

test('a zero or nonsense duration formats safely', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(NaN), '0s');
});
