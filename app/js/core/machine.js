/**
 * Machine constants and unit conversions.
 *
 * These describe the physical drivetrain and are the same for every job, unlike
 * the per-job settings the app sends with each plot. See docs/HARDWARE.md.
 */

/** GT2 belt tooth pitch, mm. */
export const GT2_PITCH_MM = 2;

/** Teeth on the drive pulley. */
export const PULLEY_TEETH = 20;

/** DRV8825 microstepping divisor. */
export const MICROSTEPS = 16;

/** Full steps per revolution for a 1.8° NEMA 17. */
export const FULL_STEPS_PER_REV = 200;

/** Belt travel per pulley revolution, mm. 2 × 20 = 40. */
export const MM_PER_REV = GT2_PITCH_MM * PULLEY_TEETH;

/** Microsteps per revolution. 200 × 16 = 3200. */
export const STEPS_PER_REV = FULL_STEPS_PER_REV * MICROSTEPS;

/** Belt travel per microstep, mm. 40 ÷ 3200 = 0.0125. */
export const MM_PER_STEP = MM_PER_REV / STEPS_PER_REV;

/** Microsteps per mm of belt travel. 80. */
export const STEPS_PER_MM = STEPS_PER_REV / MM_PER_REV;

/**
 * Convert belt length in mm to whole microsteps.
 *
 * Rounds to the nearest step, so the result is lossy by up to half a step
 * (0.00625 mm). That is fine for a one-off conversion and wrong for a sequence:
 * a planner stepping through many segments must carry the fractional remainder
 * forward, or the rounding error accumulates into visible drift. Phase 4's
 * planner owns that; this helper deliberately does not hide it.
 */
export function mmToSteps(mm) {
  return Math.round(mm * STEPS_PER_MM);
}

/** Convert whole microsteps to belt length in mm. Exact. */
export function stepsToMm(steps) {
  return steps * MM_PER_STEP;
}
