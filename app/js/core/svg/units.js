/**
 * SVG lengths, viewBox and the mapping into millimetres.
 *
 * SVG's "user unit" is a pixel at 96 dpi. The plotter thinks in millimetres, so
 * every imported length crosses that boundary exactly once, here, rather than
 * being converted ad hoc at each call site.
 */

import { compose, translation, scaling } from '../geom/matrix.js';

export const USER_UNITS_PER_INCH = 96;
export const MM_PER_INCH = 25.4;

/** Absolute unit suffixes, expressed in user units. */
const UNIT_SCALE = {
  '': 1,
  px: 1,
  pt: USER_UNITS_PER_INCH / 72,
  pc: USER_UNITS_PER_INCH / 6,
  in: USER_UNITS_PER_INCH,
  mm: USER_UNITS_PER_INCH / MM_PER_INCH,
  cm: (USER_UNITS_PER_INCH * 10) / MM_PER_INCH,
  q: USER_UNITS_PER_INCH / MM_PER_INCH / 4,
};

export function userUnitsToMm(units) {
  return (units * MM_PER_INCH) / USER_UNITS_PER_INCH;
}

export function mmToUserUnits(mm) {
  return (mm * USER_UNITS_PER_INCH) / MM_PER_INCH;
}

const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)$/i;

/**
 * Parse a length attribute into user units.
 *
 * Returns null for anything unparseable, so callers can distinguish "absent or
 * malformed" from a genuine zero.
 *
 * `em` and `ex` resolve against `fontSize`; they appear in hand-written SVG and
 * resolving them badly is better than dropping the shape. Percentages need a
 * basis and return null without one.
 */
export function parseLength(value, { percentBasis = null, fontSize = 16 } = {}) {
  if (value == null) return null;

  const match = LENGTH.exec(String(value).trim());
  if (!match) return null;

  const scalar = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  if (unit === '%') {
    return percentBasis == null ? null : (scalar / 100) * percentBasis;
  }
  if (unit === 'em') return scalar * fontSize;
  if (unit === 'ex') return scalar * fontSize * 0.5;

  const scale = UNIT_SCALE[unit];
  return scale === undefined ? null : scalar * scale;
}

/** Parse a length straight to millimetres. */
export function parseLengthMm(value, options) {
  const units = parseLength(value, options);
  return units == null ? null : userUnitsToMm(units);
}

/** Parse `viewBox="minX minY width height"`, or null if malformed. */
export function parseViewBox(value) {
  if (value == null) return null;

  const parts = String(value)
    .trim()
    .split(/[\s,]+/)
    .map(Number);

  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;

  const [minX, minY, width, height] = parts;
  if (width <= 0 || height <= 0) return null;

  return { minX, minY, width, height };
}

/** Parse `preserveAspectRatio`, defaulting as the spec does. */
export function parsePreserveAspectRatio(value) {
  const tokens = String(value ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const align = tokens.find((t) => t === 'none' || t.startsWith('x')) ?? 'xMidYMid';
  const meetOrSlice = tokens.includes('slice') ? 'slice' : 'meet';

  return { align, meetOrSlice };
}

/** Fractional alignment: 0 for Min, 0.5 for Mid, 1 for Max. */
function alignFraction(align, axis) {
  const part = axis === 'x' ? align.slice(1, 4) : align.slice(5, 8);
  if (part === 'Min') return 0;
  if (part === 'Max') return 1;
  return 0.5;
}

/**
 * The transform mapping viewBox coordinates onto a viewport of the given size.
 *
 * This is what makes an imported drawing land at its intended physical size
 * rather than at whatever numbers happen to be in the path data.
 */
export function viewBoxTransform(viewBox, viewportWidth, viewportHeight, preserveAspectRatio) {
  const { align, meetOrSlice } = parsePreserveAspectRatio(preserveAspectRatio);

  let scaleX = viewportWidth / viewBox.width;
  let scaleY = viewportHeight / viewBox.height;

  if (align !== 'none') {
    // "meet" fits the whole viewBox inside the viewport; "slice" fills the
    // viewport and lets the overflow fall outside it.
    const uniform =
      meetOrSlice === 'slice'
        ? Math.max(scaleX, scaleY)
        : Math.min(scaleX, scaleY);

    scaleX = uniform;
    scaleY = uniform;
  }

  const tx = -viewBox.minX * scaleX + (viewportWidth - viewBox.width * scaleX) * alignFraction(align, 'x');
  const ty = -viewBox.minY * scaleY + (viewportHeight - viewBox.height * scaleY) * alignFraction(align, 'y');

  return compose(scaling(scaleX, scaleY), translation(tx, ty));
}
