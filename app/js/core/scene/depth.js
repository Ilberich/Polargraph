/**
 * How hard the pen presses, and how that changes along a stroke.
 *
 * Z is a continuous axis rather than up-or-down (AD-2), so depth is a value to
 * author, not a state to toggle. It belongs to the layer: a layer is a pen,
 * and how hard a pen is pressed is a property of that pen rather than of every
 * stroke it happens to draw.
 *
 * A layer may also give a depth to finish at, in which case every stroke on it
 * ramps from one to the other along its own length — a calligraphic stroke
 * that starts light and ends heavy, without having to author each one.
 */

import { withZ, rampZ } from '../geom/path.js';

/** The depth a layer draws at, falling back to the job's own. */
export function layerDepth(layer, defaultZ = 0) {
  const z = layer?.z ?? defaultZ;
  const zEnd = layer?.zEnd;

  return { z, zEnd: zEnd == null || zEnd === z ? null : zEnd };
}

/**
 * Put a depth on a set of strokes.
 *
 * Applied after the optimizer rather than before: it reverses and merges
 * strokes, and a ramp authored beforehand would end up running backwards
 * through half the drawing and meeting itself at every join. Afterwards, each
 * stroke the machine actually draws ramps along its own length.
 */
export function applyDepth(paths, { z, zEnd }) {
  if (zEnd == null) return paths.map((path) => withZ(path, z));
  return paths.map((path) => rampZ(path, z, zEnd));
}
