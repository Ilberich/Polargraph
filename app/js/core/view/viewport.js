/**
 * The mapping between paper millimetres and screen pixels.
 *
 * Kept separate from any canvas so it can be reasoned about and tested on its
 * own — pan and zoom bugs are miserable to chase through rendering code, and
 * they are pure arithmetic.
 *
 * The transform is uniform scale plus translation. No rotation: the paper is
 * always the right way up, and the plotter has no opinion about which way the
 * user tilts their head.
 */

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 40;

/** `scale` is pixels per millimetre; `x`/`y` are the screen position of paper (0,0). */
export function createViewport({ scale = 1, x = 0, y = 0 } = {}) {
  return { scale, x, y };
}

export function toScreen(viewport, point) {
  return {
    x: point.x * viewport.scale + viewport.x,
    y: point.y * viewport.scale + viewport.y,
  };
}

export function toPaper(viewport, point) {
  return {
    x: (point.x - viewport.x) / viewport.scale,
    y: (point.y - viewport.y) / viewport.scale,
  };
}

/** Screen pixels to paper millimetres. Used to keep snap radius constant on screen. */
export function screenToPaperDistance(viewport, pixels) {
  return pixels / viewport.scale;
}

export function pan(viewport, dx, dy) {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

const clampScale = (scale) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

/**
 * Zoom about a fixed screen point.
 *
 * Whatever paper coordinate is under the cursor stays under the cursor, which
 * is the difference between zooming feeling controlled and feeling like the
 * drawing is running away.
 */
export function zoomAt(viewport, screenPoint, factor) {
  const scale = clampScale(viewport.scale * factor);

  // No movement if the clamp swallowed the change.
  if (scale === viewport.scale) return viewport;

  const paperPoint = toPaper(viewport, screenPoint);

  return {
    scale,
    x: screenPoint.x - paperPoint.x * scale,
    y: screenPoint.y - paperPoint.y * scale,
  };
}

export function setScale(viewport, scale, centre) {
  return zoomAt(viewport, centre, clampScale(scale) / viewport.scale);
}

/** Fit a paper size into a canvas, centred, with a pixel margin around it. */
export function fitToCanvas(paper, canvas, padding = 32) {
  const usableWidth = Math.max(1, canvas.width - padding * 2);
  const usableHeight = Math.max(1, canvas.height - padding * 2);

  const scale = clampScale(
    Math.min(usableWidth / paper.widthMm, usableHeight / paper.heightMm)
  );

  return {
    scale,
    x: (canvas.width - paper.widthMm * scale) / 2,
    y: (canvas.height - paper.heightMm * scale) / 2,
  };
}
