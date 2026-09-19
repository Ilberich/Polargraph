/**
 * 2D affine transforms.
 *
 * Stored as the six values SVG's `matrix(a b c d e f)` uses, in that order:
 *
 *     x' = a*x + c*y + e
 *     y' = b*x + d*y + f
 *
 * Matching SVG's layout means transform attributes parse straight into this
 * representation with no reshuffling, which is one fewer place to invert a
 * convention by accident.
 */

export const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Compose two transforms. The result applies `n` first, then `m` — the same
 * order as the matrix product `m · n`.
 *
 * SVG nests the same way: a child's own transform runs before its parent's, so
 * walking down a tree is `multiply(parent, child)`.
 */
export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Compose left to right: the first argument is applied first. */
export function compose(...matrices) {
  return matrices.reduce((acc, m) => multiply(m, acc), IDENTITY);
}

export function apply(m, p) {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  };
}

export function translation(tx, ty = 0) {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx, sy = sx) {
  return [sx, 0, 0, sy, 0, 0];
}

/** Rotation by `deg` degrees, optionally about a point. */
export function rotation(deg, cx = 0, cy = 0) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rot = [cos, sin, -sin, cos, 0, 0];

  if (cx === 0 && cy === 0) return rot;
  return compose(translation(-cx, -cy), rot, translation(cx, cy));
}

export function skewX(deg) {
  return [1, 0, Math.tan((deg * Math.PI) / 180), 1, 0, 0];
}

export function skewY(deg) {
  return [1, Math.tan((deg * Math.PI) / 180), 0, 1, 0, 0];
}

/** Signed area scale factor. Negative means the transform mirrors. */
export function determinant(m) {
  return m[0] * m[3] - m[1] * m[2];
}

/** Inverse transform, or null when the matrix is singular. */
export function invert(m) {
  const det = determinant(m);
  if (det === 0) return null;

  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/**
 * Mean scale factor applied to lengths.
 *
 * Under a non-uniform transform there is no single answer — a horizontal line
 * and a vertical one scale differently — so this returns the geometric mean of
 * the two axis scales. Curve flattening uses it to keep tolerance meaningful in
 * output units rather than input ones.
 */
export function meanScale(m) {
  return Math.sqrt(Math.abs(determinant(m)));
}
