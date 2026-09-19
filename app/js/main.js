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
import { writeGcode } from './core/gcode/writer.js';
import { optimize } from './core/gcode/optimize.js';
import { estimateGcode } from './core/gcode/estimate.js';
import { createPath } from './core/geom/path.js';
import {
  createScene, addPlacement, removePlacement, updatePlacement, setPaper,
  reorderPlacement, scenePaths, fitToMargins, centreOnPaper, DEFAULT_PAPER,
} from './core/scene/scene.js';
import { createPlacement } from './core/scene/placement.js';
import { createViewport, fitToCanvas } from './core/view/viewport.js';
import { load, save, mergeSettings, defaultStorage } from './core/storage.js';
import { render } from './ui/render.js';
import { attachInteraction } from './ui/interaction.js';
import { renderPanels, describePaper } from './ui/panels.js';
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

const storage = defaultStorage();

const state = {
  scene: createScene({ paper: DEFAULT_PAPER }),
  viewport: createViewport(),
  selectedId: null,
  guides: [],
  settings: { ...DEFAULT_SETTINGS },
  status: '',
  /**
   * The optimized job and its estimate.
   *
   * Recomputed off the back of a change rather than during render: optimizing
   * is bounded at well under a second but still far too slow to run on every
   * frame of a drag.
   */
  analysis: { state: 'empty', report: null, estimate: null },
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
function buildJob() {
  const paths = scenePaths(state.scene);
  if (paths.length === 0) return null;

  const { paths: ordered, report } = state.settings.optimize
    ? optimize(paths)
    : { paths, report: null };

  const gcode = writeGcode(ordered, {
    penLift: state.settings.penLift,
    feedRate: state.settings.feedRate,
    travelFeedRate: state.settings.travelFeedRate,
    travelZ: state.settings.travelZ,
  });

  return { gcode, report, pathCount: ordered.length };
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
    setState({ analysis: { state: 'empty', report: null, estimate: null } });
    return;
  }

  setState({ analysis: { ...state.analysis, state: 'pending' } });

  analysisTimer = setTimeout(() => {
    analysisTimer = null;

    const job = buildJob();
    if (!job) {
      setState({ analysis: { state: 'empty', report: null, estimate: null } });
      return;
    }

    setState({
      analysis: {
        state: 'ready',
        report: job.report,
        estimate: estimateGcode(job.gcode, {
          acceleration: state.settings.acceleration,
          maxSpeedMmMin: Math.max(state.settings.feedRate, state.settings.travelFeedRate),
        }),
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

// ----------------------------------------------------------------- actions --

const actions = {
  select: (id) => setState({ selectedId: id }),

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
  commit: () => {},
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
