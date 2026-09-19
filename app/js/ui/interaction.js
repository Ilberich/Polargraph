/**
 * Pointer interaction on the canvas.
 *
 * A small explicit state machine. Drag gestures are the place where implicit
 * state — a scatter of booleans across handlers — turns into objects that jump,
 * stick to the cursor after release, or resize when they should move.
 *
 * All the arithmetic lives in core/scene/manipulate.js; this file decides which
 * gesture is happening and feeds it paper coordinates.
 */

import { toPaper, pan, zoomAt, screenToPaperDistance } from '../core/view/viewport.js';
import { pickAt } from '../core/scene/scene.js';
import { placementBounds } from '../core/scene/placement.js';
import { scaleFromHandle, rotationTowards, moveBy } from '../core/scene/manipulate.js';
import { snapPosition } from '../core/scene/snap.js';
import { handlePositions, rotateHandlePosition, HANDLE_SIZE } from './render.js';

/** Snap radius in screen pixels, converted to paper units at the current zoom. */
const SNAP_PIXELS = 8;

/** Movement below this is a click, not a drag. */
const CLICK_SLOP = 3;

/** How far the pointer must travel before a fill drag tries another shape. */
const FILL_STEP = 6;

function canvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** Which handle, if any, is under a screen point. */
function handleAt(placement, viewport, point) {
  const reach = HANDLE_SIZE;

  const rotate = rotateHandlePosition(placement, viewport);
  if (Math.hypot(point.x - rotate.x, point.y - rotate.y) <= reach) {
    return { kind: 'rotate' };
  }

  for (const handle of handlePositions(placement, viewport)) {
    if (Math.abs(point.x - handle.x) <= reach / 2 && Math.abs(point.y - handle.y) <= reach / 2) {
      return { kind: 'scale', corner: handle.corner };
    }
  }

  return null;
}

/**
 * Attach interaction to a canvas.
 *
 * `host` supplies the current state and receives changes, so this module owns
 * no application state of its own — only the gesture in progress.
 */
export function attachInteraction(canvas, host) {
  /** null when idle; otherwise the gesture being performed. */
  let gesture = null;

  const paperAt = (event) => toPaper(host.getViewport(), canvasPoint(canvas, event));

  function beginGesture(event) {
    const screen = canvasPoint(canvas, event);
    const paper = toPaper(host.getViewport(), screen);
    const scene = host.getScene();

    // Middle button, or space held, always pans — even over an object.
    if (event.button === 1 || host.isPanModifier(event)) {
      return { type: 'pan', from: screen, viewport: host.getViewport() };
    }

    // A canvas tool locks everything else out. That is the point of it being a
    // mode: a stroke that nudged the object while choosing part of it would
    // make the choice impossible to make accurately.
    const tool = host.getTool();

    if (tool) {
      // Alt takes back rather than adds, the usual convention for a selection.
      const gesture = { type: tool, erase: event.altKey, at: screen };

      if (tool === 'fill') host.fillAt(paper, gesture.erase);
      else host.paintAt(paper, gesture.erase);

      return gesture;
    }

    const selected = host.getSelectedId()
      ? scene.placements.find((p) => p.id === host.getSelectedId())
      : null;

    // Handles are checked before the object itself, or a handle sitting over
    // the shape could never be grabbed.
    if (selected && selected.visible) {
      const handle = handleAt(selected, host.getViewport(), screen);

      if (handle?.kind === 'rotate') {
        return { type: 'rotate', id: selected.id, moved: false };
      }
      if (handle?.kind === 'scale') {
        return { type: 'scale', id: selected.id, corner: handle.corner, moved: false };
      }
    }

    const hit = pickAt(scene, paper, screenToPaperDistance(host.getViewport(), 2));

    if (hit) {
      host.setSelectedId(hit.id);
      return {
        type: 'move',
        id: hit.id,
        origin: { x: hit.x, y: hit.y },
        start: paper,
        startScreen: screen,
        moved: false,
      };
    }

    // Empty paper: deselect, and let the drag pan the view.
    host.setSelectedId(null);
    return { type: 'pan', from: screen, viewport: host.getViewport() };
  }

  function updateGesture(event) {
    const screen = canvasPoint(canvas, event);
    const paper = toPaper(host.getViewport(), screen);

    switch (gesture.type) {
      case 'pan': {
        host.setViewport(
          pan(gesture.viewport, screen.x - gesture.from.x, screen.y - gesture.from.y)
        );
        break;
      }

      case 'move': {
        const moved =
          Math.hypot(screen.x - gesture.startScreen.x, screen.y - gesture.startScreen.y) > CLICK_SLOP;
        if (!moved && !gesture.moved) return;
        gesture.moved = true;

        const proposed = moveBy(gesture.origin, {
          x: paper.x - gesture.start.x,
          y: paper.y - gesture.start.y,
        });

        const placement = host.getScene().placements.find((p) => p.id === gesture.id);
        if (!placement) return;

        const bounds = placementBounds(placement);
        const settings = host.getSnapSettings();

        if (settings.enabled) {
          // A snap radius fixed in paper units would feel sticky when zoomed
          // out and useless when zoomed in.
          const threshold = screenToPaperDistance(host.getViewport(), SNAP_PIXELS);
          const snapped = snapPosition(
            proposed,
            { width: bounds.width, height: bounds.height },
            host.getScene(),
            { ...settings, threshold },
            gesture.id
          );

          host.updatePlacement(gesture.id, { x: snapped.x, y: snapped.y });
          host.setGuides(snapped.guides);
        } else {
          host.updatePlacement(gesture.id, proposed);
          host.setGuides([]);
        }
        break;
      }

      case 'paint': {
        host.paintAt(paper, gesture.erase);
        break;
      }

      case 'fill': {
        // Dragging across shapes fills each in turn, but deciding which shape
        // a point is inside is a test against every outline — far too much to
        // repeat for a pointer that has barely moved.
        if (Math.hypot(screen.x - gesture.at.x, screen.y - gesture.at.y) < FILL_STEP) break;

        gesture.at = screen;
        host.fillAt(paper, gesture.erase);
        break;
      }

      case 'scale': {
        const placement = host.getScene().placements.find((p) => p.id === gesture.id);
        if (!placement) return;

        gesture.moved = true;
        host.updatePlacement(gesture.id, scaleFromHandle(placement, gesture.corner, paper));
        break;
      }

      case 'rotate': {
        const placement = host.getScene().placements.find((p) => p.id === gesture.id);
        if (!placement) return;

        gesture.moved = true;
        // Shift constrains to 15°, the usual convention.
        const step = event.shiftKey ? 15 : 0;
        host.updatePlacement(gesture.id, { rotation: rotationTowards(placement, paper, { step }) });
        break;
      }
    }
  }

  const onPointerDown = (event) => {
    if (event.button !== 0 && event.button !== 1) return;

    // preventDefault below suppresses the focus change a press would normally
    // cause, so a field in the panel would keep focus while the user works on
    // the canvas — and any panel update waiting on that blur would never run.
    // Dropping focus explicitly is what the press would have done anyway.
    if (document.activeElement && document.activeElement !== canvas) {
      document.activeElement.blur?.();
    }

    canvas.setPointerCapture(event.pointerId);
    gesture = beginGesture(event);
    event.preventDefault();
  };

  const onPointerMove = (event) => {
    if (host.getTool() === 'paint') host.setBrushAt(canvasPoint(canvas, event));

    if (!gesture) {
      host.setCursor(hoverCursor(event));
      return;
    }

    updateGesture(event);
    event.preventDefault();
  };

  const onPointerUp = (event) => {
    if (!gesture) return;

    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    gesture = null;
    host.setGuides([]);
    host.commit();
  };

  /** Cursor hint for what a press would do here. */
  function hoverCursor(event) {
    if (host.getTool()) return 'crosshair';

    const screen = canvasPoint(canvas, event);
    const selectedId = host.getSelectedId();
    const selected = selectedId
      ? host.getScene().placements.find((p) => p.id === selectedId)
      : null;

    if (selected?.visible) {
      const handle = handleAt(selected, host.getViewport(), screen);
      if (handle?.kind === 'rotate') return 'grab';
      if (handle?.kind === 'scale') {
        return handle.corner === 'nw' || handle.corner === 'se' ? 'nwse-resize' : 'nesw-resize';
      }
    }

    return pickAt(host.getScene(), toPaper(host.getViewport(), screen)) ? 'move' : 'default';
  }

  const onWheel = (event) => {
    event.preventDefault();

    // Trackpads report fine-grained deltas; the exponential keeps the feel
    // consistent across a mouse wheel's coarse notches and a trackpad's glide.
    const factor = Math.exp(-event.deltaY * 0.0015);
    host.setViewport(zoomAt(host.getViewport(), canvasPoint(canvas, event), factor));
  };

  const onPointerLeave = () => host.setBrushAt(null);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    /** Paper coordinates of an event, for callers that need them. */
    paperAt,
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
