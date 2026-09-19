/**
 * How long a job will take.
 *
 * Dividing total length by feed rate is wrong by a wide margin on real
 * drawings. A plotter spends most of a flattened curve accelerating and
 * braking: at 1200 mm/min and 200 mm/s², a 0.5 mm segment never gets near its
 * commanded speed. Curves are made of thousands of such segments, so the naive
 * figure can be optimistic by a factor of several.
 *
 * This models each move as a trapezoid — accelerate, cruise, decelerate —
 * carrying the junction speed between consecutive moves so a straight run is
 * not braked to a stop at every vertex.
 */

import { parseGcode } from './parser.js';

export const DEFAULTS = {
  /** mm/s². */
  acceleration: 200,
  /** Speed the machine may carry through a corner without slowing, mm/s. */
  jerk: 5,
  /** Ceiling on commanded feed, mm/min. */
  maxSpeedMmMin: 6000,
  /** Seconds added per pause for the user to swap a pen. */
  pauseSeconds: 20,
};

/**
 * Time for one move, given entry and exit speeds.
 *
 * The move accelerates from `entrySpeed` toward `peak`, then decelerates to
 * `exitSpeed`. If the distance is too short to reach `peak`, the profile is a
 * triangle instead and the achievable peak is solved for directly.
 */
export function moveDuration(distance, entrySpeed, exitSpeed, peak, acceleration) {
  if (distance <= 0) return 0;
  if (acceleration <= 0) return peak > 0 ? distance / peak : 0;

  // Distance needed to accelerate up to the peak and back down again.
  const accelDistance = (peak * peak - entrySpeed * entrySpeed) / (2 * acceleration);
  const decelDistance = (peak * peak - exitSpeed * exitSpeed) / (2 * acceleration);

  if (accelDistance + decelDistance <= distance) {
    const cruise = distance - accelDistance - decelDistance;

    return (
      (peak - entrySpeed) / acceleration +
      cruise / peak +
      (peak - exitSpeed) / acceleration
    );
  }

  // Too short to cruise: find the speed actually reached at the crossover.
  const reachable = Math.sqrt(
    (2 * acceleration * distance + entrySpeed * entrySpeed + exitSpeed * exitSpeed) / 2
  );
  const top = Math.max(reachable, Math.max(entrySpeed, exitSpeed));

  return (top - entrySpeed) / acceleration + (top - exitSpeed) / acceleration;
}

/** The speed a corner can be taken at, from how sharply the path turns. */
function junctionSpeed(previous, next, jerk, limit) {
  if (!previous || !next) return 0;

  const lengthA = Math.hypot(previous.x, previous.y);
  const lengthB = Math.hypot(next.x, next.y);
  if (lengthA === 0 || lengthB === 0) return 0;

  const cosine =
    (previous.x * next.x + previous.y * next.y) / (lengthA * lengthB);

  // Straight on: no reason to slow at all. Doubling back: full stop.
  const clamped = Math.max(-1, Math.min(1, cosine));
  if (clamped <= -0.999) return 0;

  // Scale between a full stop at a reversal and the limit when dead straight,
  // with `jerk` as the speed a right-angle corner may be taken at.
  const straightness = (clamped + 1) / 2;
  return Math.min(limit, jerk + (limit - jerk) * straightness ** 3);
}

/**
 * Estimate a job from parsed gcode.
 *
 * Returns seconds of drawing, travelling and pausing, plus the distances the
 * app already shows, so the panel can present one consistent picture.
 */
export function estimateGcode(source, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const records = parseGcode(source);

  const accel = settings.acceleration;
  const limit = settings.maxSpeedMmMin / 60;

  const moves = [];

  for (const record of records) {
    if (record.type !== 'move') continue;

    const dx = record.to.x - record.from.x;
    const dy = record.to.y - record.from.y;
    const distance = Math.hypot(dx, dy);

    // A pen-height change moves no distance across the paper; it still takes
    // time on a machine with a servo, but not time this model can know.
    if (distance === 0) continue;

    const commanded = record.feed > 0 ? record.feed / 60 : limit;

    moves.push({
      distance,
      direction: { x: dx / distance, y: dy / distance },
      speed: Math.min(commanded, limit),
      rapid: record.rapid,
    });
  }

  let drawSeconds = 0;
  let travelSeconds = 0;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const previous = moves[i - 1];
    const next = moves[i + 1];

    // The junction speed is capped by both moves' commanded speeds.
    const entrySpeed = previous
      ? Math.min(junctionSpeed(previous.direction, move.direction, settings.jerk, limit),
                 previous.speed, move.speed)
      : 0;

    const exitSpeed = next
      ? Math.min(junctionSpeed(move.direction, next.direction, settings.jerk, limit),
                 next.speed, move.speed)
      : 0;

    const seconds = moveDuration(move.distance, entrySpeed, exitSpeed, move.speed, accel);

    if (move.rapid) travelSeconds += seconds;
    else drawSeconds += seconds;
  }

  const pauses = records.filter((r) => r.type === 'pause').length;
  const pauseSeconds = pauses * settings.pauseSeconds;

  return {
    drawSeconds,
    travelSeconds,
    pauseSeconds,
    pauses,
    totalSeconds: drawSeconds + travelSeconds + pauseSeconds,
    moves: moves.length,
  };
}

/** Human-readable duration: "1h 12m", "4m 30s", "45s". */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';

  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
