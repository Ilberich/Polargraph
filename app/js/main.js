/**
 * Application entry point.
 *
 * Owns the state and wires the pieces together: scene, viewport, rendering,
 * interaction, panels and persistence. Everything it calls is either pure and
 * tested, or a thin DOM layer.
 *
 * State updates go through `setState`, which schedules a single render on the
 * next frame. A drag fires pointermove far faster than the screen refreshes,
 * and rendering on every event would do the same work several times over.
 */

import { describeEnvironment, plotterUrl } from './core/env.js';
import { importSvg } from './core/svg/import.js';
import { gcodeToPaths } from './core/gcode/parser.js';
import { writeGcode, writeLayeredGcode } from './core/gcode/writer.js';
import { optimize } from './core/gcode/optimize.js';
import { estimateGcode } from './core/gcode/estimate.js';
import { createPath } from './core/geom/path.js';
import {
  createScene, addPlacement, removePlacement, updatePlacement, setPaper,
  reorderPlacement, scenePaths, fitToMargins, centreOnPaper, DEFAULT_PAPER,
  addLayer, updateLayer, removeLayer, reorderLayer, scenePathsByLayer,
} from './core/scene/scene.js';
import { createLayer, assignPaths } from './core/scene/layers.js';
import {
  createPlacement, placementMatrix, fillableShapes, topLevelShapes,
} from './core/scene/placement.js';
import {
  segmentsWithin, pickPath, pickShape, assignSelection, segmentCount,
} from './core/scene/select.js';
import { invert, apply } from './core/geom/matrix.js';
import { createViewport, fitToCanvas, screenToPaperDistance } from './core/view/viewport.js';
import { load, save, mergeSettings, defaultStorage } from './core/storage.js';
import { render } from './ui/render.js';
import { attachInteraction } from './ui/interaction.js';
import { renderPanels, describePaper, NEW_LAYER } from './ui/panels.js';
import { downloadText, pickFiles, isTextEntry } from './ui/dom.js';

const DEFAULT_SETTINGS = {
  feedRate: 1200,
  travelFeedRate: 3000,
  penLift: false,
  travelZ: 5,
  optimize: true,
  acceleration: 200,
  showGrid: false,
  snap: { enabled: true, grid: false, gridMm: 10, paperEdges: true, paperCentre: true, margins: true, objects: true },
};

/** Brush size in screen pixels, so its reach is what it looks like. */
const DEFAULT_BRUSH_PX = 14;

const storage = defaultStorage();

const state = {
  scene: createScene({ paper: DEFAULT_PAPER }),
  viewport: createViewport(),
  selectedId: null,
  selectedLayerId: null,
  guides: [],
  /** Which pane of the tabbed card is open. The paint and fill tabs are modes. */
  tab: 'objects',
  /**
   * The paint tool.
   *
   * `selection` maps a path id to the indices of its chosen segments, and only
   * holds the stroke in progress: it is applied and emptied when the pointer
   * comes up.
   */
  paint: {
    tool: 'brush',
    radiusPx: DEFAULT_BRUSH_PX,
    erase: false,
    erasing: false,
    selection: new Map(),
    cursor: null,
  },
  /** The fill tool. Which shapes are filled lives on the placement. */
  fill: { erase: false },
  settings: { ...DEFAULT_SETTINGS },
  status: '',
  /**
   * The optimized job and its estimate.
   *
   * Recomputed off the back of a change rather than during render: optimizing
   * is bounded at well under a second but still far too slow to run on every
   * frame of a drag.
   */
  analysis: { state: 'empty', report: null, estimate: null, baseline: null },
};

let analysisTimer = null;

let canvas;
let panelHost;
let statusNode;
let frame = null;

/** Whether the queued frame also needs the panel rebuilt. */
let panelsDirty = false;

function setState(patch) {
  Object.assign(state, patch);
  scheduleRender();
}

/**
 * Queue a frame.
 *
 * `panels: false` redraws only the canvas. Viewport changes — resizing,
 * panning, the mobile keyboard opening — do not change what the panel says,
 * and rebuilding it needlessly is actively harmful (see drawPanels).
 */
function scheduleRender({ panels = true } = {}) {
  if (panels) panelsDirty = true;
  if (frame !== null) return;

  frame = requestAnimationFrame(() => {
    frame = null;

    const withPanels = panelsDirty;
    panelsDirty = false;

    drawCanvas();
    if (withPanels) drawPanels();
    statusNode.textContent = state.status || describePaper(state.scene.paper);
  });
}

function drawCanvas() {
  render(canvas, {
    scene: state.scene,
    viewport: state.viewport,
    selectedId: state.selectedId,
    guides: state.guides,
    gridMm: state.settings.showGrid ? state.settings.snap.gridMm : 0,
    tool: activeTool() ? state.selectedId : null,
    paint: activeTool() === 'paint' ? state.paint : null,
  });
}

/**
 * Rebuild the panel, unless the user is typing into it.
 *
 * The panel is rebuilt wholesale rather than patched, which replaces its DOM
 * and destroys whatever holds focus. On a phone that closes the soft keyboard
 * the instant it opens — because the keyboard opening resizes the viewport,
 * which used to schedule a render, which rebuilt the panel out from under the
 * field being tapped.
 *
 * So a rebuild is deferred while a text field inside the panel has focus, and
 * runs when focus leaves. Values in the panel are only stale during an edit the
 * user is about to commit anyway.
 *
 * Only text entry defers. A checkbox keeps focus after being clicked, so
 * counting it here would defer the rebuild indefinitely and the click would
 * appear to do nothing at all.
 */
function drawPanels() {
  if (panelHost.contains(document.activeElement) && isTextEntry(document.activeElement)) {
    panelsDirty = true;
    return;
  }

  // A rebuild replaces the control the user was on, which for a keyboard user
  // means being thrown back to the start of the tab order every time they
  // toggle something. Controls carry stable ids so the same one can be picked
  // up again afterwards.
  const focusedId =
    panelHost.contains(document.activeElement) ? document.activeElement.id : null;

  renderPanels(panelHost, state, actions);

  if (focusedId) document.getElementById(focusedId)?.focus();
}

/**
 * Turn the scene into the gcode that would actually be plotted.
 *
 * One function so the panel's figures and the exported file can never disagree
 * about what optimization did.
 */
function buildJob({ withBaseline = false } = {}) {
  const groups = scenePathsByLayer(state.scene);
  const pathCount = groups.reduce((sum, g) => sum + g.paths.length, 0);
  if (pathCount === 0) return null;

  const options = {
    penLift: state.settings.penLift,
    feedRate: state.settings.feedRate,
    travelFeedRate: state.settings.travelFeedRate,
    travelZ: state.settings.travelZ,
  };

  // Optimized within each layer, never across one. Reordering strokes into a
  // different pen's section would mean drawing them in the wrong colour.
  let report = null;

  const optimized = groups.map((group) => {
    if (!state.settings.optimize) return group;

    const result = optimize(group.paths);
    report = report
      ? {
          before: report.before + result.report.before,
          after: report.after + result.report.after,
          saved: report.saved + result.report.saved,
          pathsBefore: report.pathsBefore + result.report.pathsBefore,
          pathsAfter: report.pathsAfter + result.report.pathsAfter,
        }
      : result.report;

    return { ...group, paths: result.paths };
  });

  // The same job unoptimized, for the time comparison.
  const baseline = withBaseline && report ? writeLayeredGcode(groups, options) : null;

  return {
    gcode: writeLayeredGcode(optimized, options),
    baseline,
    report,
    pathCount,
    layerCount: groups.length,
  };
}

/**
 * Recompute the estimate a short while after the last change.
 *
 * Debounced because a drag fires changes continuously and optimizing each
 * intermediate position would be wasted work the user never sees.
 */
function scheduleAnalysis() {
  if (analysisTimer !== null) clearTimeout(analysisTimer);

  if (state.scene.placements.length === 0) {
    setState({ analysis: { state: 'empty', report: null, estimate: null, baseline: null } });
    return;
  }

  setState({ analysis: { ...state.analysis, state: 'pending' } });

  analysisTimer = setTimeout(() => {
    analysisTimer = null;

    const job = buildJob({ withBaseline: true });
    if (!job) {
      setState({ analysis: { state: 'empty', report: null, estimate: null, baseline: null } });
      return;
    }

    const settings = {
      acceleration: state.settings.acceleration,
      maxSpeedMmMin: Math.max(state.settings.feedRate, state.settings.travelFeedRate),
    };

    setState({
      analysis: {
        state: 'ready',
        report: job.report,
        estimate: estimateGcode(job.gcode, settings),
        baseline: job.baseline ? estimateGcode(job.baseline, settings) : null,
      },
    });
  }, 250);
}

/** Persist the parts of the session worth restoring. */
function persist() {
  save(
    {
      settings: state.settings,
      paper: state.scene.paper,
    },
    storage
  );
}

function restore() {
  const stored = load(storage, null);
  if (!stored) return;

  state.settings = mergeSettings(DEFAULT_SETTINGS, stored.settings);
  if (stored.paper) {
    state.scene = setPaper(state.scene, mergeSettings(DEFAULT_PAPER, stored.paper));
  }
}

function fitView() {
  const rect = canvas.getBoundingClientRect();
  setState({
    viewport: fitToCanvas(
      state.scene.paper,
      { width: rect.width, height: rect.height },
      48
    ),
  });
}

function setStatus(message) {
  setState({ status: message });
}


// ----------------------------------------------------------- canvas tools --

/** Click tolerance for taking a whole stroke or a shape, in screen pixels. */
const PICK_PIXELS = 8;

/**
 * The canvas tool the open tab puts in the user's hand, if any.
 *
 * The tab *is* the mode. Both tools work on the selected object and lock
 * moving, scaling and rotating while they are open — choosing part of a stroke
 * accurately is impossible if the same gesture might drag the object instead.
 */
function activeTool() {
  if (!state.selectedId) return null;
  return state.tab === 'paint' || state.tab === 'fill' ? state.tab : null;
}

function toolPlacement() {
  if (!activeTool()) return null;
  return state.scene.placements.find((p) => p.id === state.selectedId) ?? null;
}

/** A paper point in the placement's own coordinates. */
function toLocal(placement, paper) {
  return apply(invert(placementMatrix(placement)), paper);
}

/** Screen pixels as a distance in the placement's own coordinates. */
function toLocalDistance(placement, pixels) {
  return screenToPaperDistance(state.viewport, pixels) / (Math.abs(placement.scale) || 1);
}

const allSegments = (path) => Array.from({ length: segmentCount(path) }, (_, i) => i);

/** Add segments of one path to the selection. Returns whether anything changed. */
function addSegments(selection, path, indices) {
  const before = selection.get(path.id);
  const next = new Set(before ?? []);

  for (const i of indices) next.add(i);
  if (next.size === (before?.size ?? 0)) return false;

  selection.set(path.id, next);
  return true;
}

/**
 * Paint at a point on the paper.
 *
 * Builds up the stroke only. Where it lands is decided when the pointer comes
 * up — see commitPaint — because assigning splits paths and rebuilds the
 * object's path list, which is far too much work to do on every pointermove.
 */
function paintAt(paper, altHeld) {
  const placement = toolPlacement();
  if (!placement) return;

  // Alt is the desktop shortcut; the toggle is how a tablet gets there.
  const erasing = altHeld || state.paint.erase;
  const local = toLocal(placement, paper);
  const selection = new Map(state.paint.selection);
  let changed = false;

  if (state.paint.tool === 'whole') {
    const path = pickPath(placement.paths, local, toLocalDistance(placement, PICK_PIXELS));
    if (path) changed = addSegments(selection, path, allSegments(path));
  } else {
    const radius = toLocalDistance(placement, state.paint.radiusPx);

    for (const path of placement.paths) {
      const hits = segmentsWithin(path, local, radius);
      if (hits.length > 0) changed = addSegments(selection, path, hits) || changed;
    }
  }

  state.paint = { ...state.paint, selection, erasing };
  if (changed) scheduleRender({ panels: false });
}

/**
 * Put the painted stroke on a layer.
 *
 * The selected layer is the destination, so painting with a layer chosen puts
 * strokes on it directly — there is no separate step to confirm, because
 * nothing about the gcode needs one. Erasing sends them back to the object's
 * own layer.
 */
function commitPaint() {
  const placement = toolPlacement();
  if (!placement || state.paint.selection.size === 0) return;

  const layerId = state.paint.erasing ? null : state.selectedLayerId;
  const { paths, pathLayers } = assignSelection(placement, state.paint.selection, layerId);

  setState({
    scene: updatePlacement(state.scene, placement.id, { paths, pathLayers }),
    paint: { ...state.paint, selection: new Map() },
  });

  scheduleAnalysis();
}

function setBrushAt(cursor) {
  if (!state.paint || (!cursor && !state.paint.cursor)) return;

  state.paint = { ...state.paint, cursor };
  scheduleRender({ panels: false });
}

/**
 * Fill the shape under a point.
 *
 * Clicking inside a shape is how a fill tool is used, so that is what decides
 * which shape — the outline nearest the click is only the fallback for a click
 * that landed inside nothing.
 */
function fillAt(paper, altHeld) {
  const placement = toolPlacement();
  if (!placement) return;

  const erasing = altHeld || state.fill.erase;
  const local = toLocal(placement, paper);
  const shape = pickShape(
    fillableShapes(placement),
    local,
    toLocalDistance(placement, PICK_PIXELS)
  );

  if (!shape) return;

  const fills = { ...(placement.fills ?? {}) };
  const wanted = state.selectedLayerId ?? null;

  if (erasing) {
    if (!(shape.id in fills)) return;
    delete fills[shape.id];
  } else {
    if (shape.id in fills && fills[shape.id] === wanted) return;
    fills[shape.id] = wanted;
  }

  setState({ scene: updatePlacement(state.scene, placement.id, { fills }) });
  scheduleAnalysis();
}

// ----------------------------------------------------------------- actions --

const actions = {
  select(id) {
    // A stroke in progress belongs to the object it was started on.
    setState({ selectedId: id, paint: { ...state.paint, selection: new Map() } });
  },

  update(id, changes) {
    setState({ scene: updatePlacement(state.scene, id, changes) });
    scheduleAnalysis();
  },

  remove(id) {
    setState({
      scene: removePlacement(state.scene, id),
      selectedId: state.selectedId === id ? null : state.selectedId,
    });
    scheduleAnalysis();
  },

  reorder(id, delta) {
    setState({ scene: reorderPlacement(state.scene, id, delta) });
  },

  fit(id) {
    setState({ scene: fitToMargins(state.scene, id) });
  },

  centre(id) {
    setState({ scene: centreOnPaper(state.scene, id) });
  },

  setPaper(changes) {
    setState({ scene: setPaper(state.scene, changes) });
    persist();
  },

  setSettings(changes) {
    setState({ settings: { ...state.settings, ...changes } });
    persist();
    scheduleAnalysis();
  },

  setSnap(changes) {
    setState({ settings: { ...state.settings, snap: { ...state.settings.snap, ...changes } } });
    persist();
  },

  fitView,

  addLayer() {
    const layer = createLayer();
    setState({ scene: addLayer(state.scene, layer), selectedLayerId: layer.id });
    scheduleAnalysis();
  },

  updateLayer(id, changes) {
    setState({ scene: updateLayer(state.scene, id, changes) });
    scheduleAnalysis();
  },

  removeLayer(id) {
    setState({
      scene: removeLayer(state.scene, id),
      selectedLayerId: state.selectedLayerId === id ? null : state.selectedLayerId,
    });
    scheduleAnalysis();
  },

  reorderLayer(id, delta) {
    setState({ scene: reorderLayer(state.scene, id, delta) });
    scheduleAnalysis();
  },

  selectLayer(id) {
    setState({ selectedLayerId: id });
  },

  /** Put a whole object onto a pen, clearing any per-path overrides it had. */
  assignPlacementToLayer(placementId, layerId) {
    setState({
      scene: updatePlacement(state.scene, placementId, { layerId, pathLayers: {} }),
    });
    scheduleAnalysis();
  },

  setTab(tab) {
    // A half-drawn stroke means nothing on another tab.
    setState({ tab, paint: { ...state.paint, selection: new Map() } });
  },

  /**
   * Choose the layer paint and fill work onto.
   *
   * The same choice the layers list makes. Picking "new" makes the layer at
   * once rather than on first use, so the next stroke has somewhere to go and
   * the list shows what was chosen.
   */
  chooseLayer(value) {
    if (value === NEW_LAYER) {
      actions.addLayer();
      return;
    }

    setState({ selectedLayerId: value || null });
  },

  setPaintTool(tool) {
    setState({ paint: { ...state.paint, tool, selection: new Map() } });
  },

  setPaintRadius(radiusPx) {
    setState({ paint: { ...state.paint, radiusPx: Math.max(1, radiusPx) } });
  },

  setPaintErase(erase) {
    setState({ paint: { ...state.paint, erase } });
  },

  setFillErase(erase) {
    setState({ fill: { ...state.fill, erase } });
  },

  /** Put the whole object on the chosen layer. */
  paintAll() {
    const placement = toolPlacement();
    if (!placement) return;

    state.paint = {
      ...state.paint,
      erasing: state.paint.erase,
      selection: new Map(
        placement.paths
          .filter((path) => segmentCount(path) > 0)
          .map((path) => [path.id, new Set(allSegments(path))])
      ),
    };

    commitPaint();
  },

  /** Fill every shape, leaving the holes in them open. */
  fillAll() {
    const placement = toolPlacement();
    if (!placement) return;

    const layerId = state.selectedLayerId ?? null;
    const fills = Object.fromEntries(
      topLevelShapes(placement).map((shape) => [shape.id, layerId])
    );

    setState({ scene: updatePlacement(state.scene, placement.id, { fills }) });
    scheduleAnalysis();
  },

  clearFills() {
    const placement = toolPlacement();
    if (!placement) return;

    setState({ scene: updatePlacement(state.scene, placement.id, { fills: {} }) });
    scheduleAnalysis();
  },

  async importSvgFiles() {
    const files = await pickFiles({ accept: '.svg,image/svg+xml' });
    if (files.length === 0) return;

    let scene = state.scene;
    const warnings = [];
    let imported = 0;

    for (const file of files) {
      const result = importSvg(file.text);
      warnings.push(...result.warnings);

      if (result.paths.length === 0) {
        warnings.push(`${file.name} contained no drawable paths.`);
        continue;
      }

      scene = addPlacement(
        scene,
        createPlacement({ name: file.name, kind: 'svg', paths: result.paths })
      );
      imported++;
    }

    setState({ scene });
    scheduleAnalysis();
    setStatus(
      [`Imported ${imported} file${imported === 1 ? '' : 's'}.`, ...new Set(warnings)].join(' ')
    );
  },

  async importGcodeFiles() {
    const files = await pickFiles({ accept: '.gcode,.gco,.nc,.txt' });
    if (files.length === 0) return;

    let scene = state.scene;
    let imported = 0;

    for (const file of files) {
      const paths = gcodeToPaths(file.text).map((p) =>
        createPath(p.points, { closed: p.closed })
      );

      if (paths.length === 0) continue;

      scene = addPlacement(
        scene,
        createPlacement({ name: file.name, kind: 'gcode', paths })
      );
      imported++;
    }

    setState({ scene });
    scheduleAnalysis();
    setStatus(`Imported ${imported} gcode file${imported === 1 ? '' : 's'}.`);
  },

  exportGcode() {
    const job = buildJob();

    if (!job) {
      setStatus('Nothing to export — the paper is empty.');
      return;
    }

    downloadText('polargraph.gcode', job.gcode, 'text/plain');

    const saved = job.report
      ? ` Travel cut by ${Math.round(job.report.saved)}mm.`
      : '';
    setStatus(`Exported ${job.pathCount} path${job.pathCount === 1 ? '' : 's'}.${saved}`);
  },
};

// ------------------------------------------------------------ interaction --

let panModifier = false;

const host = {
  getScene: () => state.scene,
  getViewport: () => state.viewport,
  getSelectedId: () => state.selectedId,
  getSnapSettings: () => state.settings.snap,
  setViewport: (viewport) => setState({ viewport }),
  setSelectedId: (selectedId) => setState({ selectedId }),
  setGuides: (guides) => setState({ guides }),
  updatePlacement: (id, changes) => actions.update(id, changes),
  setCursor: (cursor) => {
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  },
  isPanModifier: () => panModifier,
  getTool: activeTool,
  paintAt,
  // A pinch has taken over: the half-drawn stroke was never meant.
  cancelStroke: () => {
    if (state.paint.selection.size === 0) return;
    setState({ paint: { ...state.paint, selection: new Map() } });
  },
  fillAt,
  setBrushAt,
  // A stroke is finished: it lands now, and the panel catches up.
  commit: () => {
    if (activeTool() === 'paint') commitPaint();
  },
};

// ------------------------------------------------------------------- boot --

function renderEnvironment() {
  const env = describeEnvironment(window.location);
  const badge = document.getElementById('mode-badge');
  const label = document.getElementById('mode-label');

  badge.classList.toggle('badge--connected', env.canReachPlotter);
  badge.classList.toggle('badge--standalone', !env.canReachPlotter);
  label.textContent = env.canReachPlotter ? 'Machine control' : 'Standalone';

  badge.title = env.canReachPlotter
    ? 'This page may contact a plotter on your network.'
    : `${env.reason} Your plotter: ${plotterUrl()}`;
}

function main() {
  canvas = document.getElementById('canvas');
  panelHost = document.getElementById('panel');
  statusNode = document.getElementById('status');

  restore();
  renderEnvironment();

  document.getElementById('import-svg').onclick = actions.importSvgFiles;
  document.getElementById('import-gcode').onclick = actions.importGcodeFiles;
  document.getElementById('export-gcode').onclick = actions.exportGcode;

  attachInteraction(canvas, host);

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') panModifier = true;

    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (typing) return;

    if (activeTool()) {
      // The object is being worked on, not edited: removing it out from under
      // the tool would leave nothing to work on.
      if (event.key === 'Escape') actions.setTab('objects');
      return;
    }

    if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
      event.preventDefault();
      actions.remove(state.selectedId);
    }
    if (event.key === 'Escape') actions.select(null);
    if (event.key === 'f') fitView();
  });

  window.addEventListener('keyup', (event) => {
    if (event.code === 'Space') panModifier = false;
  });

  // A resize changes the canvas, never the panel's contents. Rebuilding the
  // panel here is what was dismissing the mobile keyboard.
  window.addEventListener('resize', () => scheduleRender({ panels: false }));
  globalThis.visualViewport?.addEventListener('resize', () => scheduleRender({ panels: false }));

  // Run any rebuild that was deferred while a field was being edited.
  panelHost.addEventListener('focusout', () => {
    if (panelsDirty) scheduleRender();
  });

  // Keep a focused field clear of the soft keyboard.
  //
  // Browsers vary in whether they do this themselves, and the keyboard opens
  // *after* focus — so at focus time the layout it has to account for does not
  // exist yet. Nudging once the keyboard has had time to appear is more
  // reliable than trusting the default, and is a no-op on a desktop where the
  // field is already in view.
  panelHost.addEventListener('focusin', (event) => {
    if (!isTextEntry(event.target)) return;

    setTimeout(() => {
      // The user may have moved on while the keyboard was animating.
      if (document.activeElement !== event.target) return;

      const rect = event.target.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        event.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 300);
  });

  fitView();
  scheduleAnalysis();
}

main();
