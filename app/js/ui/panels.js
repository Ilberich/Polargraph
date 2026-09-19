/**
 * The side panels.
 *
 * Rebuilt from state on each render rather than surgically patched. The panel
 * is small, and a rebuild cannot drift out of step with the scene the way
 * incremental updates quietly do.
 */

import { el, clear, numberField, checkboxField, button, card } from './dom.js';
import { marginBox, outsideMargins } from '../core/scene/scene.js';
import { placementBounds, placementLength, canHatch } from '../core/scene/placement.js';
import { formatDuration } from '../core/gcode/estimate.js';
import { BUILD } from '../build.js';

const mm = (value) => `${Math.round(value * 10) / 10}`;

function paperCard(state, actions) {
  const { paper } = state.scene;

  return card('Paper', [
    el('div', { class: 'field-grid' }, [
      numberField({
        label: 'Width', value: paper.widthMm, min: 1, unit: 'mm', id: 'paper-width',
        onCommit: (v) => actions.setPaper({ widthMm: v }),
      }),
      numberField({
        label: 'Height', value: paper.heightMm, min: 1, unit: 'mm', id: 'paper-height',
        onCommit: (v) => actions.setPaper({ heightMm: v }),
      }),
    ]),
    el('div', { class: 'field-grid field-grid--four' },
      ['top', 'right', 'bottom', 'left'].map((side) =>
        numberField({
          label: side[0].toUpperCase() + side.slice(1),
          value: paper.margins[side], min: 0, unit: 'mm', id: `paper-margin-${side}`,
          onCommit: (v) => actions.setPaper({ margins: { ...paper.margins, [side]: v } }),
        })
      )
    ),
  ]);
}

function objectsCard(state, actions) {
  const { placements } = state.scene;

  if (placements.length === 0) {
    return card('Objects', el('p', { class: 'empty' }, 'Import an SVG or gcode file to begin.'));
  }

  // Drawn back to front, so the topmost object is listed first.
  const rows = [...placements].reverse().map((placement) =>
    el('div', {
      class: `object ${placement.id === state.selectedId ? 'object--selected' : ''}`.trim(),
      onclick: () => actions.select(placement.id),
    }, [
      el('button', {
        class: 'object__visibility',
        type: 'button',
        title: placement.visible ? 'Hide' : 'Show',
        onclick: (e) => {
          e.stopPropagation();
          actions.update(placement.id, { visible: !placement.visible });
        },
      }, placement.visible ? '●' : '○'),

      el('span', { class: 'object__name', title: placement.name }, placement.name),
      el('span', { class: 'object__kind' }, placement.kind),

      el('button', {
        class: 'object__remove',
        type: 'button',
        title: 'Remove',
        onclick: (e) => {
          e.stopPropagation();
          actions.remove(placement.id);
        },
      }, '×'),
    ])
  );

  return card('Objects', el('div', { class: 'object-list' }, rows));
}

function transformCard(state, actions) {
  const placement = state.scene.placements.find((p) => p.id === state.selectedId);
  if (!placement) return null;

  const bounds = placementBounds(placement);

  return card('Transform', [
    el('div', { class: 'field-grid' }, [
      numberField({
        label: 'X', value: Math.round(placement.x * 100) / 100, step: 1, unit: 'mm', id: 'transform-x',
        onCommit: (v) => actions.update(placement.id, { x: v }),
      }),
      numberField({
        label: 'Y', value: Math.round(placement.y * 100) / 100, step: 1, unit: 'mm', id: 'transform-y',
        onCommit: (v) => actions.update(placement.id, { y: v }),
      }),
      numberField({
        label: 'Rotation', value: Math.round(placement.rotation * 10) / 10, step: 1, unit: '°', id: 'transform-rotation',
        onCommit: (v) => actions.update(placement.id, { rotation: v }),
      }),
      numberField({
        label: 'Scale', value: Math.round(placement.scale * 1000) / 1000, step: 0.05, min: 0.01, id: 'transform-scale',
        onCommit: (v) => actions.update(placement.id, { scale: v }),
      }),
    ]),

    el('dl', { class: 'spec' }, [
      el('dt', { class: 'spec__key' }, 'Size'),
      el('dd', { class: 'spec__value' }, `${mm(bounds.width)} × ${mm(bounds.height)} mm`),
      el('dt', { class: 'spec__key' }, 'Length'),
      el('dd', { class: 'spec__value' }, `${mm(placementLength(placement))} mm`),
    ]),

    el('div', { class: 'button-row' }, [
      button({ label: 'Fit to margins', onClick: () => actions.fit(placement.id) }),
      button({ label: 'Centre', onClick: () => actions.centre(placement.id) }),
    ]),
    el('div', { class: 'button-row' }, [
      button({ label: 'Bring forward', onClick: () => actions.reorder(placement.id, 1) }),
      button({ label: 'Send back', onClick: () => actions.reorder(placement.id, -1) }),
    ]),
  ]);
}

/**
 * Hatch fill for the selected object.
 *
 * Only offered when there is something closed to fill — an open path has no
 * inside, and a control that silently does nothing is worse than one that is
 * not there.
 */
function fillCard(state, actions) {
  const placement = state.scene.placements.find((p) => p.id === state.selectedId);
  if (!placement) return null;

  if (!canHatch(placement)) {
    return card('Fill', el('p', { class: 'empty' },
      'This object has no closed shapes, so there is nothing to fill.'));
  }

  const { hatch } = placement;
  const update = (changes) =>
    actions.update(placement.id, { hatch: { ...hatch, ...changes } });

  return card('Fill', [
    el('div', { class: 'stack' }, [
      checkboxField({
        label: 'Hatch fill', checked: hatch.enabled, id: 'fill-enabled',
        onChange: (v) => update({ enabled: v }),
      }),
      hatch.enabled && checkboxField({
        label: 'Crosshatch', checked: hatch.cross, id: 'fill-cross',
        onChange: (v) => update({ cross: v }),
      }),
      // Two overlapping shapes can either knock a hole in each other or merge
      // into one solid region. Both are wanted often enough that guessing is
      // worse than asking — a ring needs its middle left open, two overlapping
      // blobs usually do not.
      hatch.enabled && checkboxField({
        label: 'Overlaps make holes', checked: hatch.rule === 'evenodd',
        id: 'fill-holes',
        onChange: (v) => update({ rule: v ? 'evenodd' : 'nonzero' }),
      }),
    ]),

    hatch.enabled && el('div', { class: 'field-grid' }, [
      numberField({
        label: 'Spacing', value: hatch.spacingMm, min: 0.1, step: 0.5, unit: 'mm',
        id: 'fill-spacing',
        onCommit: (v) => update({ spacingMm: v }),
      }),
      numberField({
        label: 'Angle', value: hatch.angleDeg, step: 5, unit: '°',
        id: 'fill-angle',
        onCommit: (v) => update({ angleDeg: v }),
      }),
    ]),

  ]);
}

function viewCard(state, actions) {
  return card('View', [
    el('div', { class: 'stack' }, [
      checkboxField({
        label: 'Snapping', checked: state.settings.snap.enabled, id: 'view-snap',
        onChange: (v) => actions.setSnap({ enabled: v }),
      }),
      checkboxField({
        label: 'Snap to grid', checked: state.settings.snap.grid, id: 'view-snap-grid',
        onChange: (v) => actions.setSnap({ grid: v }),
      }),
      checkboxField({
        label: 'Show grid', checked: state.settings.showGrid, id: 'view-show-grid',
        onChange: (v) => actions.setSettings({ showGrid: v }),
      }),
    ]),
    numberField({
      label: 'Grid', value: state.settings.snap.gridMm, min: 1, unit: 'mm', id: 'view-grid-mm',
      onCommit: (v) => actions.setSnap({ gridMm: v }),
    }),
    el('div', { class: 'button-row' }, [
      button({ label: 'Fit view', onClick: actions.fitView }),
    ]),

    // So a stale cache can be told apart from a bug that was never fixed.
    el('dl', { class: 'spec' }, [
      el('dt', { class: 'spec__key' }, 'Build'),
      el('dd', { class: 'spec__value' }, BUILD),
    ]),
  ]);
}

/**
 * The estimate rows.
 *
 * Optimization runs on a debounce, so these can legitimately be a moment
 * behind. Saying so is better than showing a stale number as though it were
 * current.
 */
function estimateRows(state) {
  const { state: status, report, estimate, baseline } = state.analysis;

  if (status === 'empty') return [];

  if (status !== 'ready' || !estimate) {
    return [
      el('dt', { class: 'spec__key' }, 'Time'),
      el('dd', { class: 'spec__value spec__value--pending' }, 'calculating'),
    ];
  }

  const rows = [
    el('dt', { class: 'spec__key' }, 'Est. time'),
    el('dd', { class: 'spec__value' }, formatDuration(estimate.totalSeconds)),
    el('dt', { class: 'spec__key' }, 'Drawing'),
    el('dd', { class: 'spec__value' }, formatDuration(estimate.drawSeconds)),
    el('dt', { class: 'spec__key' }, 'Travel'),
    el('dd', { class: 'spec__value' }, formatDuration(estimate.travelSeconds)),
  ];

  // How much sooner the plot finishes: drawing and travel together, against
  // the same job in import order.
  if (baseline && baseline.totalSeconds - estimate.totalSeconds > 1) {
    const savedSeconds = baseline.totalSeconds - estimate.totalSeconds;
    const percent = Math.round((savedSeconds / baseline.totalSeconds) * 100);

    rows.push(
      el('dt', { class: 'spec__key' }, 'Time saved'),
      el('dd', { class: 'spec__value spec__value--good' },
        `${formatDuration(savedSeconds)} (${percent}%)`)
    );
  }

  if (report && report.saved > 0.5) {
    const percent = Math.round((report.saved / report.before) * 100);

    rows.push(
      el('dt', { class: 'spec__key' }, 'Travel cut'),
      el('dd', { class: 'spec__value spec__value--good' },
        `${mm(report.saved)} mm (${percent}%)`)
    );
  }

  if (report && report.pathsAfter < report.pathsBefore) {
    rows.push(
      el('dt', { class: 'spec__key' }, 'Paths merged'),
      el('dd', { class: 'spec__value' },
        `${report.pathsBefore} → ${report.pathsAfter}`)
    );
  }

  return rows;
}

function outputCard(state, actions) {
  const { settings } = state;
  const strays = outsideMargins(state.scene);
  const drawn = state.scene.placements
    .filter((p) => p.visible)
    .reduce((sum, p) => sum + placementLength(p), 0);

  return card('Output', [
    el('div', { class: 'field-grid' }, [
      numberField({
        label: 'Feed', value: settings.feedRate, min: 1, step: 50, unit: 'mm/min', id: 'output-feed',
        onCommit: (v) => actions.setSettings({ feedRate: v }),
      }),
      numberField({
        label: 'Travel', value: settings.travelFeedRate, min: 1, step: 50, unit: 'mm/min', id: 'output-travel-feed',
        onCommit: (v) => actions.setSettings({ travelFeedRate: v }),
      }),
      numberField({
        label: 'Acceleration', value: settings.acceleration, min: 1, step: 25, unit: 'mm/s²', id: 'output-acceleration',
        onCommit: (v) => actions.setSettings({ acceleration: v }),
      }),
    ]),

    el('div', { class: 'stack' }, [
      checkboxField({
        label: 'Pen lift installed', checked: settings.penLift, id: 'output-pen-lift',
        onChange: (v) => actions.setSettings({ penLift: v }),
      }),
      !settings.penLift &&
        el('p', { class: 'hint' },
          'Without a pen axis every travel move draws, so the plot is one continuous line.'),
    ]),

    el('div', { class: 'stack' }, [
      checkboxField({
        label: 'Optimize paths', checked: settings.optimize, id: 'output-optimize',
        onChange: (v) => actions.setSettings({ optimize: v }),
      }),
      settings.optimize && !settings.penLift &&
        el('p', { class: 'hint' },
          'Ordering strokes to cut travel matters most without a pen lift, ' +
          'since every travel move draws.'),
    ]),

    el('dl', { class: 'spec' }, [
      el('dt', { class: 'spec__key' }, 'Total length'),
      el('dd', { class: 'spec__value' }, `${mm(drawn)} mm`),
      el('dt', { class: 'spec__key' }, 'Objects'),
      el('dd', { class: 'spec__value' }, String(state.scene.placements.length)),
      ...estimateRows(state),
    ]),

    strays.length > 0 &&
      el('div', { class: 'notice notice--warn' }, [
        el('strong', { class: 'notice__title' },
          `${strays.length} object${strays.length > 1 ? 's' : ''} outside the margins`),
        el('span', {},
          'The plotter will follow these off the paper. Fit or move them before plotting.'),
      ]),

    el('div', { class: 'button-row' }, [
      button({
        label: 'Export gcode',
        variant: 'button--primary',
        onClick: actions.exportGcode,
      }),
    ]),
  ]);
}

/** Rebuild the panel into `container`. */
export function renderPanels(container, state, actions) {
  clear(container);

  const cards = [
    objectsCard(state, actions),
    transformCard(state, actions),
    fillCard(state, actions),
    paperCard(state, actions),
    viewCard(state, actions),
    outputCard(state, actions),
  ].filter(Boolean);

  container.append(...cards);
}

/** Paper size in millimetres, for the status readout. */
export function describePaper(paper) {
  const box = marginBox(paper);
  return `${mm(paper.widthMm)} × ${mm(paper.heightMm)} mm · drawable ${mm(box.width)} × ${mm(box.height)}`;
}
