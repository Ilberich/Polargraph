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
import { downloadText, pickFiles } from './ui/dom.js';

const DEFAULT_SETTINGS = {
  feedRate: 1200,
  travelFeedRate: 3000,
  penLift: false,
  travelZ: 5,
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
};

let canvas;
let panelHost;
let statusNode;
let frame = null;

function setState(patch) {
  Object.assign(state, patch);
  scheduleRender();
}

function scheduleRender() {
  if (frame !== null) return;

  frame = requestAnimationFrame(() => {
    frame = null;
    draw();
  });
}

function draw() {
  render(canvas, {
    scene: state.scene,
    viewport: state.viewport,
    selectedId: state.selectedId,
    guides: state.guides,
    gridMm: state.settings.showGrid ? state.settings.snap.gridMm : 0,
  });

  renderPanels(panelHost, state, actions);
  statusNode.textContent = state.status || describePaper(state.scene.paper);
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
  },

  remove(id) {
    setState({
      scene: removePlacement(state.scene, id),
      selectedId: state.selectedId === id ? null : state.selectedId,
    });
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
    setStatus(`Imported ${imported} gcode file${imported === 1 ? '' : 's'}.`);
  },

  exportGcode() {
    const paths = scenePaths(state.scene);

    if (paths.length === 0) {
      setStatus('Nothing to export — the paper is empty.');
      return;
    }

    const gcode = writeGcode(paths, {
      penLift: state.settings.penLift,
      feedRate: state.settings.feedRate,
      travelFeedRate: state.settings.travelFeedRate,
      travelZ: state.settings.travelZ,
    });

    downloadText('polargraph.gcode', gcode, 'text/plain');
    setStatus(`Exported ${paths.length} path${paths.length === 1 ? '' : 's'}.`);
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

  window.addEventListener('resize', scheduleRender);

  fitView();
}

main();
