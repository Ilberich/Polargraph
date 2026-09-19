/**
 * Canvas rendering.
 *
 * Geometry is drawn in each placement's own coordinates with the viewport and
 * placement matrices pushed onto the canvas transform, rather than by
 * transforming every point in JavaScript first. A drawing can run to tens of
 * thousands of points and is redrawn on every frame of a drag; letting the
 * canvas do the arithmetic is the difference between a smooth drag and a
 * stuttering one.
 *
 * Colours are read from the CSS custom properties rather than duplicated here,
 * so the theme stays defined in exactly one place.
 */

import { placementMatrix, placementBounds, placementPaths } from '../core/scene/placement.js';
import { marginBox } from '../core/scene/scene.js';
import { layerIdFor } from '../core/scene/layers.js';
import { segmentCount, runsOf } from '../core/scene/select.js';
import { toScreen } from '../core/view/viewport.js';

/** Screen size of a selection handle, in CSS pixels. */
export const HANDLE_SIZE = 10;

/** How far above the selection the rotation handle sits, in CSS pixels. */
export const ROTATE_HANDLE_OFFSET = 28;

function readTheme(element) {
  const style = getComputedStyle(element);
  const get = (name, fallback) => style.getPropertyValue(name).trim() || fallback;

  return {
    stage: get('--surface-sunken', '#131518'),
    paper: get('--surface', '#1e2125'),
    border: get('--border', '#32373d'),
    borderStrong: get('--border-strong', '#434a52'),
    ink: get('--text', '#e4e7ea'),
    faint: get('--text-faint', '#6b747c'),
    accent: get('--accent', '#4db6a4'),
    warn: get('--warn', '#d9a85c'),
  };
}

/**
 * Size the backing store to the element and the device pixel ratio.
 *
 * Without this, everything is soft on a high-density display. Returns the size
 * in CSS pixels, which is the space all the interaction maths works in.
 */
export function resizeCanvas(canvas) {
  const ratio = globalThis.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));

  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }

  return { width, height, ratio };
}

function drawPaper(ctx, scene, viewport, theme) {
  const { widthMm, heightMm } = scene.paper;
  const origin = toScreen(viewport, { x: 0, y: 0 });
  const width = widthMm * viewport.scale;
  const height = heightMm * viewport.scale;

  ctx.fillStyle = theme.paper;
  ctx.fillRect(origin.x, origin.y, width, height);

  ctx.strokeStyle = theme.borderStrong;
  ctx.lineWidth = 1;
  ctx.strokeRect(origin.x + 0.5, origin.y + 0.5, width, height);
}

function drawGrid(ctx, scene, viewport, theme, gridMm) {
  if (!(gridMm > 0)) return;

  // Below a couple of pixels apart the grid is just noise on the paper.
  const spacing = gridMm * viewport.scale;
  if (spacing < 6) return;

  const { widthMm, heightMm } = scene.paper;
  const origin = toScreen(viewport, { x: 0, y: 0 });

  ctx.save();
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();

  for (let x = 0; x <= widthMm + 1e-6; x += gridMm) {
    const sx = Math.round(origin.x + x * viewport.scale) + 0.5;
    ctx.moveTo(sx, origin.y);
    ctx.lineTo(sx, origin.y + heightMm * viewport.scale);
  }

  for (let y = 0; y <= heightMm + 1e-6; y += gridMm) {
    const sy = Math.round(origin.y + y * viewport.scale) + 0.5;
    ctx.moveTo(origin.x, sy);
    ctx.lineTo(origin.x + widthMm * viewport.scale, sy);
  }

  ctx.stroke();
  ctx.restore();
}

function drawMargins(ctx, scene, viewport, theme) {
  const box = marginBox(scene.paper);
  if (box.width <= 0 || box.height <= 0) return;

  const topLeft = toScreen(viewport, { x: box.minX, y: box.minY });

  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(
    topLeft.x + 0.5,
    topLeft.y + 0.5,
    box.width * viewport.scale,
    box.height * viewport.scale
  );
  ctx.restore();
}

/** Trace one batch of paths in the placement's own coordinate system. */
function traceBatch(ctx, paths) {
  ctx.beginPath();

  for (const path of paths) {
    const [first, ...rest] = path.points;
    if (!first) continue;

    ctx.moveTo(first.x, first.y);
    for (const point of rest) ctx.lineTo(point.x, point.y);
    if (path.closed) ctx.closePath();
  }
}

/**
 * Group a placement's paths by the colour they will be drawn in.
 *
 * Batching by colour keeps this to one stroke call per pen rather than one per
 * path, which matters when a hatch fill runs to thousands of lines.
 */
function batchByColour(placement, layers, fallback) {
  const batches = new Map();

  for (const path of placementPaths(placement)) {
    const layerId = layerIdFor(placement, path);
    const layer = layers.find((l) => l.id === layerId);

    // A hidden layer is not drawn, matching what would be plotted.
    if (layer && !layer.visible) continue;

    const colour = layer?.color ?? fallback;
    if (!batches.has(colour)) batches.set(colour, []);
    batches.get(colour).push(path);
  }

  return batches;
}

function drawPlacement(ctx, placement, viewport, theme, selected, layers) {
  if (!placement.visible) return;

  const m = placementMatrix(placement);

  ctx.save();
  ctx.translate(viewport.x, viewport.y);
  ctx.scale(viewport.scale, viewport.scale);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);

  // A constant hairline, so lines stay visible at any zoom and the drawing
  // reads the same whatever is in the pen holder.
  const totalScale = viewport.scale * Math.abs(placement.scale || 1);
  ctx.lineWidth = (selected ? 1.5 : 1.1) / (totalScale || 1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const [colour, paths] of batchByColour(placement, layers, theme.ink)) {
    // Selection has to stay legible, so it overrides the pen colour rather
    // than sitting alongside it — there is no second channel to show it in.
    ctx.strokeStyle = selected ? theme.accent : colour;
    traceBatch(ctx, paths);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * The painted selection, drawn over the geometry it covers.
 *
 * Drawn as runs rather than segment by segment so a brushed stretch reads as
 * one continuous mark, and heavier than the drawing itself so it is legible
 * against whatever pen colour is underneath.
 */
function drawPaintSelection(ctx, placement, viewport, theme, selection) {
  const m = placementMatrix(placement);
  const totalScale = viewport.scale * Math.abs(placement.scale || 1);

  ctx.save();
  ctx.translate(viewport.x, viewport.y);
  ctx.scale(viewport.scale, viewport.scale);
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 3.5 / (totalScale || 1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();

  for (const path of placement.paths) {
    const chosen = selection.get(path.id);
    if (!chosen || chosen.size === 0) continue;

    for (const run of runsOf([...chosen], segmentCount(path), path.closed)) {
      const points = path.points;
      ctx.moveTo(points[run[0]].x, points[run[0]].y);

      for (const i of run) {
        const end = points[(i + 1) % points.length];
        ctx.lineTo(end.x, end.y);
      }
    }
  }

  ctx.stroke();
  ctx.restore();
}

/** The brush, shown at its true size so its reach is never a guess. */
function drawBrush(ctx, cursor, radiusPx, theme) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cursor.x, cursor.y, radiusPx, 0, Math.PI * 2);
  ctx.strokeStyle = theme.ink;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

/** Screen positions of the scale handles, clockwise from the top left. */
export function handlePositions(placement, viewport) {
  const b = placementBounds(placement);

  const corners = [
    { x: b.minX, y: b.minY, corner: 'nw' },
    { x: b.maxX, y: b.minY, corner: 'ne' },
    { x: b.maxX, y: b.maxY, corner: 'se' },
    { x: b.minX, y: b.maxY, corner: 'sw' },
  ];

  return corners.map((c) => ({ ...toScreen(viewport, c), corner: c.corner }));
}

/** Screen position of the rotation handle, above the selection. */
export function rotateHandlePosition(placement, viewport) {
  const b = placementBounds(placement);
  const top = toScreen(viewport, { x: (b.minX + b.maxX) / 2, y: b.minY });

  return { x: top.x, y: top.y - ROTATE_HANDLE_OFFSET };
}

function drawSelection(ctx, placement, viewport, theme) {
  const b = placementBounds(placement);
  const topLeft = toScreen(viewport, { x: b.minX, y: b.minY });
  const width = b.width * viewport.scale;
  const height = b.height * viewport.scale;

  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, width, height);
  ctx.setLineDash([]);

  const rotateAt = rotateHandlePosition(placement, viewport);
  ctx.beginPath();
  ctx.moveTo(topLeft.x + width / 2, topLeft.y);
  ctx.lineTo(rotateAt.x, rotateAt.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(rotateAt.x, rotateAt.y, HANDLE_SIZE / 2, 0, Math.PI * 2);
  ctx.fillStyle = theme.accent;
  ctx.fill();

  for (const handle of handlePositions(placement, viewport)) {
    ctx.fillStyle = theme.accent;
    ctx.fillRect(
      handle.x - HANDLE_SIZE / 2,
      handle.y - HANDLE_SIZE / 2,
      HANDLE_SIZE,
      HANDLE_SIZE
    );
    ctx.strokeStyle = theme.stage;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      handle.x - HANDLE_SIZE / 2,
      handle.y - HANDLE_SIZE / 2,
      HANDLE_SIZE,
      HANDLE_SIZE
    );
  }

  ctx.restore();
}

/** Alignment guides, drawn across the whole canvas so the line being met is obvious. */
function drawGuides(ctx, guides, viewport, size, theme) {
  if (!guides || guides.length === 0) return;

  ctx.save();
  ctx.strokeStyle = theme.warn;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 3]);
  ctx.beginPath();

  for (const guide of guides) {
    if (guide.axis === 'x') {
      const x = Math.round(toScreen(viewport, { x: guide.value, y: 0 }).x) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
    } else {
      const y = Math.round(toScreen(viewport, { x: 0, y: guide.value }).y) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
    }
  }

  ctx.stroke();
  ctx.restore();
}

/** Draw the whole scene. */
export function render(canvas, {
  scene, viewport, selectedId = null, guides = [], gridMm = 0, paint = null,
}) {
  const { width, height, ratio } = resizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const theme = readTheme(canvas);

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = theme.stage;
  ctx.fillRect(0, 0, width, height);

  drawPaper(ctx, scene, viewport, theme);
  drawGrid(ctx, scene, viewport, theme, gridMm);
  drawMargins(ctx, scene, viewport, theme);

  // Painting highlights parts of one object, so that object is drawn in its
  // own pen colours rather than as a selection — otherwise the highlight would
  // be accent on accent, and invisible.
  const painted = paint
    ? scene.placements.find((p) => p.id === paint.placementId)
    : null;

  for (const placement of scene.placements) {
    const selected = placement.id === selectedId && placement !== painted;
    drawPlacement(ctx, placement, viewport, theme, selected, scene.layers ?? []);
  }

  if (painted && painted.visible) {
    drawPaintSelection(ctx, painted, viewport, theme, paint.selection);
    if (paint.cursor && paint.tool === 'brush') {
      drawBrush(ctx, paint.cursor, paint.radiusPx, theme);
    }
  }

  // Handles move and resize, which painting locks out, so they are not shown.
  const selected = painted ? null : scene.placements.find((p) => p.id === selectedId);
  if (selected && selected.visible) drawSelection(ctx, selected, viewport, theme);

  drawGuides(ctx, guides, viewport, { width, height }, theme);

  return { width, height };
}
