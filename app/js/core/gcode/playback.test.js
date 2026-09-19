import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gcodeTimeline, estimateGcode } from './estimate.js';
import { entryAt, positionAt, progressAt } from './playback.js';

const SETTINGS = { acceleration: 200, maxSpeedMmMin: 3000 };

/** A straight draw, a travel, another draw. */
const JOB = [
  'G21', 'G90',
  'G0 X0 Y0',
  'G1 X100 Y0 F1200',
  'G0 X100 Y50 F3000',
  'G1 X0 Y50 F1200',
].join('\n');

test('the timeline and the estimate agree, because they are one pass', () => {
  const timeline = gcodeTimeline(JOB, SETTINGS);
  const estimate = estimateGcode(JOB, SETTINGS);

  assert.equal(timeline.totalSeconds, estimate.totalSeconds);
  assert.equal(timeline.entries.filter((e) => e.kind === 'move').length, estimate.moves);
});

test('entries run back to back with no gaps', () => {
  const { entries, totalSeconds } = gcodeTimeline(JOB, SETTINGS);
  let at = 0;

  for (const entry of entries) {
    assert.equal(entry.start, at);
    at += entry.seconds;
  }

  assert.equal(at, totalSeconds);
});

test('the entry in progress is found by time', () => {
  const timeline = gcodeTimeline(JOB, SETTINGS);
  const { entries } = timeline;

  assert.equal(entryAt(timeline, 0), 0);
  assert.equal(entryAt(timeline, entries[1].start + 0.001), 1);
  assert.equal(entryAt(timeline, entries[2].start), 2);
  assert.equal(entryAt(timeline, 1e6), entries.length - 1, 'past the end, the last entry');
});

test('the pen starts where the job starts and ends where it ends', () => {
  const timeline = gcodeTimeline(JOB, SETTINGS);

  const start = positionAt(timeline, 0);
  assert.deepEqual([start.x, start.y], [0, 0]);

  const end = positionAt(timeline, timeline.totalSeconds);
  assert.deepEqual([end.x, end.y], [0, 50]);
});

test('the pen moves along the move it is part way through', () => {
  const timeline = gcodeTimeline(JOB, SETTINGS);
  const first = timeline.entries[0];

  const half = positionAt(timeline, first.start + first.seconds / 2);

  assert.equal(half.state, 'drawing');
  assert.ok(half.x > 0 && half.x < 100, `x was ${half.x}`);
  assert.equal(half.y, 0);
});

test('travel is reported as travel, not drawing', () => {
  const timeline = gcodeTimeline(JOB, SETTINGS);
  const travel = timeline.entries.find((e) => e.rapid);

  assert.equal(positionAt(timeline, travel.start + travel.seconds / 2).state, 'travelling');
});

test('time past the end is clamped rather than extrapolated', () => {
  const timeline = gcodeTimeline(JOB, SETTINGS);
  const end = positionAt(timeline, timeline.totalSeconds);

  assert.deepEqual(positionAt(timeline, 1e9), end);
  assert.deepEqual(positionAt(timeline, -5), positionAt(timeline, 0));
});

test('a pen swap holds the gondola where the last move left it', () => {
  const withPause = ['G0 X0 Y0', 'G1 X100 Y0 F1200', 'M0 ; change pen', 'G1 X100 Y40 F1200'].join('\n');
  const timeline = gcodeTimeline(withPause, SETTINGS);
  const pause = timeline.entries.find((e) => e.kind === 'pause');

  assert.ok(pause, 'the pause is on the timeline');

  const during = positionAt(timeline, pause.start + pause.seconds / 2);
  assert.equal(during.state, 'paused');
  assert.deepEqual([during.x, during.y], [100, 0]);
});

test('a pause stops the machine, so the moves either side start from rest', () => {
  // Treating a pen swap as something speed carries through would have the
  // gondola leaving the pause already up to feed.
  const straight = ['G0 X0 Y0', 'G1 X50 Y0 F1200', 'G1 X100 Y0 F1200'].join('\n');
  const broken = ['G0 X0 Y0', 'G1 X50 Y0 F1200', 'M0', 'G1 X100 Y0 F1200'].join('\n');

  const moving = (source) =>
    gcodeTimeline(source, SETTINGS).entries
      .filter((e) => e.kind === 'move')
      .reduce((sum, e) => sum + e.seconds, 0);

  assert.ok(moving(broken) > moving(straight));
});

test('progress is measured in time, not distance', () => {
  const timeline = gcodeTimeline(JOB, SETTINGS);

  assert.equal(progressAt(timeline, 0), 0);
  assert.equal(progressAt(timeline, timeline.totalSeconds), 1);
  assert.equal(progressAt(timeline, timeline.totalSeconds * 2), 1);
  assert.equal(progressAt({ entries: [], totalSeconds: 0 }, 5), 0);
});

test('an empty job has no position to report', () => {
  assert.equal(positionAt({ entries: [], totalSeconds: 0 }, 0), null);
});
