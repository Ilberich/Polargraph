/**
 * SVG's basic shapes, expressed as path data.
 *
 * Each shape is rewritten as an equivalent `d` string and handed to the path
 * parser rather than flattened directly. Circles and rounded rectangles are
 * arcs, and there is already one tested arc implementation — a second one would
 * be a second place for the same bug.
 */

import { parseLength } from './units.js';

/** Shapes that carry geometry. Anything else is a container or metadata. */
export const SHAPE_TAGS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
]);

function num(attrs, name, options, fallback = 0) {
  const value = parseLength(attrs[name], options);
  return value == null ? fallback : value;
}

/** Parse a `points` list into coordinate pairs, dropping any odd trailing value. */
function parsePoints(value) {
  const numbers = String(value ?? '')
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);

  const points = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i], y: numbers[i + 1] });
  }

  return points;
}

function rectPathData(attrs, options) {
  const x = num(attrs, 'x', options);
  const y = num(attrs, 'y', options);
  const width = num(attrs, 'width', options);
  const height = num(attrs, 'height', options);

  // A rectangle with no extent is not an error, it simply draws nothing.
  if (width <= 0 || height <= 0) return null;

  const rxRaw = parseLength(attrs.rx, options);
  const ryRaw = parseLength(attrs.ry, options);

  // Either radius alone implies the other, per the spec.
  let rx = rxRaw ?? ryRaw ?? 0;
  let ry = ryRaw ?? rxRaw ?? 0;

  // Radii larger than half the side are clamped rather than rejected.
  rx = Math.min(Math.max(rx, 0), width / 2);
  ry = Math.min(Math.max(ry, 0), height / 2);

  if (rx === 0 || ry === 0) {
    return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
  }

  return [
    `M ${x + rx} ${y}`,
    `H ${x + width - rx}`,
    `A ${rx} ${ry} 0 0 1 ${x + width} ${y + ry}`,
    `V ${y + height - ry}`,
    `A ${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height}`,
    `H ${x + rx}`,
    `A ${rx} ${ry} 0 0 1 ${x} ${y + height - ry}`,
    `V ${y + ry}`,
    `A ${rx} ${ry} 0 0 1 ${x + rx} ${y}`,
    'Z',
  ].join(' ');
}

/** An ellipse as two half-turn arcs. One arc cannot express a full turn. */
function ellipsePathData(cx, cy, rx, ry) {
  if (rx <= 0 || ry <= 0) return null;

  return [
    `M ${cx - rx} ${cy}`,
    `A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy}`,
    `A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy}`,
    'Z',
  ].join(' ');
}

/**
 * Path data for a shape element, or null if it has no drawable geometry.
 *
 * `options` is forwarded to length parsing, carrying the percentage basis.
 */
export function shapeToPathData(node, options = {}) {
  const { tag, attrs } = node;

  switch (tag) {
    case 'path':
      return attrs.d ?? null;

    case 'rect':
      return rectPathData(attrs, options);

    case 'circle': {
      const r = num(attrs, 'r', options);
      return ellipsePathData(num(attrs, 'cx', options), num(attrs, 'cy', options), r, r);
    }

    case 'ellipse':
      return ellipsePathData(
        num(attrs, 'cx', options),
        num(attrs, 'cy', options),
        num(attrs, 'rx', options),
        num(attrs, 'ry', options)
      );

    case 'line':
      return `M ${num(attrs, 'x1', options)} ${num(attrs, 'y1', options)} L ${num(attrs, 'x2', options)} ${num(attrs, 'y2', options)}`;

    case 'polyline':
    case 'polygon': {
      const points = parsePoints(attrs.points);
      if (points.length < 2) return null;

      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
      return tag === 'polygon' ? `${d} Z` : d;
    }

    default:
      return null;
  }
}
