import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MM_PER_REV,
  STEPS_PER_REV,
  MM_PER_STEP,
  STEPS_PER_MM,
  mmToSteps,
  stepsToMm,
} from './machine.js';

test('drivetrain constants match the documented machine', () => {
  assert.equal(MM_PER_REV, 40, 'GT2 2mm pitch x 20 teeth');
  assert.equal(STEPS_PER_REV, 3200, '200 full steps x 16 microsteps');
  assert.equal(MM_PER_STEP, 0.0125, '40mm / 3200 steps');
  assert.equal(STEPS_PER_MM, 80);
});

test('one revolution of belt round-trips exactly', () => {
  assert.equal(mmToSteps(MM_PER_REV), STEPS_PER_REV);
  assert.equal(stepsToMm(STEPS_PER_REV), MM_PER_REV);
});

test('mmToSteps rounds to the nearest whole step', () => {
  assert.equal(mmToSteps(0.0125), 1, 'exactly one step');
  assert.equal(mmToSteps(0.018), 1, 'rounds down from 1.44 steps');
  assert.equal(mmToSteps(0.02), 2, 'rounds up from 1.6 steps');
  assert.equal(mmToSteps(0), 0);
});

test('conversions carry sign for reverse travel', () => {
  assert.equal(mmToSteps(-40), -3200);
  assert.equal(stepsToMm(-3200), -40);
});

test('stepsToMm is exact at scale, with no float drift', () => {
  // 0.0125 is a negative power of two times 100, so this stays exact.
  assert.equal(stepsToMm(80000), 1000);
});
