/**
 * The SVG `transform` attribute.
 *
 * The functions in a transform list combine as a matrix product in written
 * order, which means the LAST one applies to a point first: under
 * `translate(10,0) scale(2)` a point is scaled and then translated.
 *
 * That is the reverse of what `compose` does, so the list is folded with
 * `multiply` in written order instead.
 */

import {
  IDENTITY, multiply, translation, scaling, rotation, skewX, skewY,
} from '../geom/matrix.js';

const FUNCTION = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

function numbers(text) {
  return text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** Build the matrix for one transform function, or null if unrecognised. */
function transformFunction(name, args) {
  switch (name) {
    case 'translate':
      return translation(args[0] ?? 0, args[1] ?? 0);

    case 'scale':
      // A single argument scales both axes.
      return scaling(args[0] ?? 1, args[1] ?? args[0] ?? 1);

    case 'rotate':
      return rotation(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);

    case 'skewX':
      return skewX(args[0] ?? 0);

    case 'skewY':
      return skewY(args[0] ?? 0);

    case 'matrix':
      return args.length === 6 ? args : null;

    default:
      return null;
  }
}

/**
 * Parse a transform attribute into a single matrix.
 *
 * An unrecognised or malformed function is skipped rather than failing the
 * import — dropping one transform distorts a shape, but throwing loses the
 * whole drawing.
 */
export function parseTransform(value) {
  if (!value) return IDENTITY;

  const matrices = [];
  FUNCTION.lastIndex = 0;

  let match;
  while ((match = FUNCTION.exec(value)) !== null) {
    const matrix = transformFunction(match[1], numbers(match[2]));
    if (matrix) matrices.push(matrix);
  }

  return matrices.reduce((acc, m) => multiply(acc, m), IDENTITY);
}
