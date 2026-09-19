/** Planar vector helpers. Points are plain `{x, y}` objects. */

export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a, k) {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

/** Z component of the 3D cross product. Sign gives turn direction. */
export function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

export function length(a) {
  return Math.hypot(a.x, a.y);
}

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Unit vector. A zero-length input has no direction, so it returns itself. */
export function normalize(a) {
  const len = length(a);
  return len === 0 ? { x: 0, y: 0 } : { x: a.x / len, y: a.y / len };
}

/**
 * Distance from a point to a line segment.
 *
 * Clamped to the segment rather than the infinite line, so a point beyond an
 * end measures to that end. Used for hit-testing strokes.
 */
export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) return distance(p, a);

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));

  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}
