/**
 * The side panels.
 *
 * Rebuilt from state on each render rather than surgically patched. The panel
 * is small, and a rebuild cannot drift out of step with the scene the way
 * incremental updates quietly do.
 */

import { el, clear, numberField, checkboxField, button, card, tabbedCard } from './dom.js';
import { marginBox, outsideMargins } from '../core/scene/scene.js';
import {
  placementBounds, placementLength, canHatch, topLevelShapes,
} from '../core/scene/placement.js';
import { formatDuration } from '../core/gcode/estimate.js';
import { el as element } from './dom.js';
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

function objectsPane(state, actions) {
  const { placements } = state.scene;

  if (placements.length === 0) {
    return el('p', { class: 'empty' }, 'Import an SVG or gcode file to begin.');
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
      }, placement.visible ? '\u25cf' : '\u25cb'),

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
      }, '\u00d7'),
    ])
  );

  return el('div', { class: 'object-list' }, rows);
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

    layerRow(state, actions, placement),

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
 * Layers: which pen draws what, in the order they will be swapped.
 *
 * Order is the point of this list, not decoration — it is the sequence the
 * machine will stop for. Colour is the ink that will be in the holder, shown
 * so the canvas can be read at a glance.
 *
 * The selected layer is also where paint and fill put what they touch, so
 * choosing one here is the same act as choosing one on those tabs.
 */
function layersPane(state, actions) {
  const { layers } = state.scene;

  const rows = layers.map((layer, index) => {
    const swatch = el('input', {
      class: 'layer__colour',
      type: 'color',
      value: layer.color,
      title: 'Layer colour',
      id: `layer-colour-${layer.id}`,
      onchange: (e) => actions.updateLayer(layer.id, { color: e.target.value }),
      onclick: (e) => e.stopPropagation(),
    });

    const name = el('input', {
      class: 'layer__name',
      type: 'text',
      value: layer.name,
      id: `layer-name-${layer.id}`,
      onchange: (e) => actions.updateLayer(layer.id, { name: e.target.value.trim() || layer.name }),
      onclick: (e) => e.stopPropagation(),
    });

    return el('div', {
      class: `layer ${layer.id === state.selectedLayerId ? 'layer--selected' : ''}`.trim(),
      onclick: () => actions.selectLayer(layer.id),
    }, [
      el('span', { class: 'layer__order', title: `Layer ${index + 1} of ${layers.length}` },
        String(index + 1)),
      swatch,
      name,
      el('button', {
        class: 'object__visibility',
        type: 'button',
        title: layer.visible ? 'Hide' : 'Show',
        onclick: (e) => {
          e.stopPropagation();
          actions.updateLayer(layer.id, { visible: !layer.visible });
        },
      }, layer.visible ? '\u25cf' : '\u25cb'),
      el('button', {
        class: 'object__remove',
        type: 'button',
        title: 'Remove layer',
        onclick: (e) => {
          e.stopPropagation();
          actions.removeLayer(layer.id);
        },
      }, '\u00d7'),
    ]);
  });

  const selected = layers.find((l) => l.id === state.selectedLayerId);

  return [
    layers.length === 0
      ? el('p', { class: 'empty' },
        'One pen for everything. Add a layer to plot in more than one colour.')
      : el('div', { class: 'object-list' }, rows),

    el('div', { class: 'button-row' }, [
      button({ label: 'Add layer', onClick: actions.addLayer }),
      selected && button({
        label: 'Move up',
        onClick: () => actions.reorderLayer(selected.id, -1),
      }),
      selected && button({
        label: 'Move down',
        onClick: () => actions.reorderLayer(selected.id, 1),
      }),
    ].filter(Boolean)),
  ];
}

/** Which layer draws the selected object, unless a stroke says otherwise. */
function layerRow(state, actions, placement) {
  const { layers } = state.scene;
  if (layers.length === 0) return null;

  const select = el('select', {
    class: 'field__input',
    id: 'transform-layer',
    onchange: (e) =>
      actions.assignPlacementToLayer(placement.id, e.target.value || null),
  }, [
    element('option', { value: '', selected: placement.layerId == null }, 'Unassigned'),
    ...layers.map((layer) =>
      element('option', { value: layer.id, selected: placement.layerId === layer.id }, layer.name)),
  ]);

  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label' }, 'Layer'),
    el('span', { class: 'field__control' }, [select]),
  ]);
}

/** Sentinel for "put it on a layer that does not exist yet". */
export const NEW_LAYER = '__new__';

/**
 * Where paint and fill put what they touch.
 *
 * The same choice the layers list makes, offered again next to the tools that
 * use it — a mode whose destination is only visible on another tab is a mode
 * that paints in the wrong colour.
 */
function layerChooser(state, actions, id) {
  const { layers } = state.scene;

  const select = el('select', {
    class: 'field__input',
    id,
    onchange: (e) => actions.chooseLayer(e.target.value),
  }, [
    element('option', { value: '', selected: state.selectedLayerId == null },
      'This object\u2019s layer'),
    ...layers.map((layer) =>
      element('option', { value: layer.id, selected: state.selectedLayerId === layer.id },
        layer.name)),
    element('option', { value: NEW_LAYER }, 'New layer\u2026'),
  ]);

  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label' }, 'Onto'),
    el('span', { class: 'field__control' }, [select]),
  ]);
}

/**
 * Painting: putting part of an object onto another layer.
 *
 * The tab is the mode. Moving, scaling and rotating on the canvas are locked
 * while it is open, because choosing part of a stroke accurately is impossible
 * if the same gesture might drag the object instead.
 */
function paintPane(state, actions) {
  const placement = state.scene.placements.find((p) => p.id === state.selectedId);

  if (!placement) {
    return el('p', { class: 'empty' },
      'Select an object to paint part of it onto another layer.');
  }

  const { paint } = state;

  const tool = (value, label, hint) =>
    button({
      label,
      title: hint,
      variant: paint.tool === value ? 'button--primary' : '',
      onClick: () => actions.setPaintTool(value),
    });

  return [
    el('p', { class: 'hint' },
      `Painting ${placement.name}. Dragging on the canvas is locked while this tab is open.`),

    el('div', { class: 'button-row' }, [
      tool('brush', 'Brush', 'Take the part of a stroke you drag across'),
      tool('whole', 'Whole stroke', 'Take a whole stroke at a time'),
    ]),

    paint.tool === 'brush' && numberField({
      label: 'Brush', value: paint.radiusPx, min: 1, step: 2, unit: 'px', id: 'paint-radius',
      onCommit: (v) => actions.setPaintRadius(v),
    }),

    layerChooser(state, actions, 'paint-target'),

    checkboxField({
      label: 'Erase', checked: paint.erase === true, id: 'paint-erase',
      onChange: (v) => actions.setPaintErase(v),
    }),

    el('p', { class: 'hint' },
      'Each stroke lands when you let go. Hold Alt, or turn on Erase, to put ' +
      'strokes back on the object\u2019s own layer.'),

    el('div', { class: 'button-row' }, [
      button({ label: 'Paint all', onClick: actions.paintAll }),
    ]),
  ].filter(Boolean);
}

/**
 * Filling: choosing which shapes get hatched, and in what colour.
 *
 * Which shapes is a per-shape choice — filling everything closed is rarely
 * what a drawing wants. How they are hatched is one setting for the whole
 * object, because spacing and angle are chosen against the pen and the paper,
 * not against a particular shape.
 */
function fillPane(state, actions) {
  const placement = state.scene.placements.find((p) => p.id === state.selectedId);

  if (!placement) {
    return el('p', { class: 'empty' }, 'Select an object to fill shapes in it.');
  }

  if (!canHatch(placement)) {
    return el('p', { class: 'empty' },
      'This object has no closed shapes, so there is nothing to fill.');
  }

  const { hatch } = placement;
  const update = (changes) =>
    actions.update(placement.id, { hatch: { ...hatch, ...changes } });

  const shapes = topLevelShapes(placement).length;
  const filled = Object.keys(placement.fills ?? {}).length;

  return [
    el('p', { class: 'hint' },
      'Click a shape to fill it. Dragging on the canvas is locked while this tab is open.'),

    layerChooser(state, actions, 'fill-target'),

    checkboxField({
      label: 'Erase', checked: state.fill.erase === true, id: 'fill-erase',
      onChange: (v) => actions.setFillErase(v),
    }),

    el('p', { class: 'hint' },
      'Holes are left open. Click inside one to fill it in its own colour, or ' +
      'hold Alt \u2014 or turn on Erase \u2014 to take a fill back.'),

    el('div', { class: 'field-grid' }, [
      numberField({
        label: 'Spacing', value: hatch.spacingMm, min: 0.1, step: 0.5, unit: 'mm',
        id: 'fill-spacing',
        onCommit: (v) => update({ spacingMm: v }),
      }),
      numberField({
        label: 'Angle', value: hatch.angleDeg, step: 5, unit: '\u00b0',
        id: 'fill-angle',
        onCommit: (v) => update({ angleDeg: v }),
      }),
    ]),

    el('div', { class: 'stack' }, [
      checkboxField({
        label: 'Crosshatch', checked: hatch.cross, id: 'fill-cross',
        onChange: (v) => update({ cross: v }),
      }),
      // A shape nested inside a filled one can either be left open or filled
      // over. Even-odd leaves it open, which is what a silhouette with holes
      // wants; nonzero follows the winding direction, which is SVG's own
      // default and keeps overlapping subpaths solid.
      checkboxField({
        label: 'Inner shapes are holes', checked: hatch.rule === 'evenodd',
        id: 'fill-holes',
        onChange: (v) => update({ rule: v ? 'evenodd' : 'nonzero' }),
      }),
    ]),

    el('dl', { class: 'spec' }, [
      el('dt', { class: 'spec__key' }, 'Filled'),
      el('dd', { class: 'spec__value' }, `${filled} of ${shapes} shape${shapes === 1 ? '' : 's'}`),
    ]),

    el('div', { class: 'button-row' }, [
      button({ label: 'Fill all', onClick: actions.fillAll }),
      button({ label: 'Clear fills', onClick: actions.clearFills }),
    ]),
  ];
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

/**
 * The tabbed group at the top of the panel.
 *
 * Objects, layers, paint and fill are all about the thing being worked on, and
 * only one of them is ever being worked on at a time. Stacked, they pushed
 * everything else off the bottom of the panel.
 */
const PANES = [
  { id: 'objects', label: 'Objects', pane: objectsPane },
  { id: 'layers', label: 'Layers', pane: layersPane },
  { id: 'paint', label: 'Paint', pane: paintPane },
  { id: 'fill', label: 'Fill', pane: fillPane },
];

/** Rebuild the panel into `container`. */
export function renderPanels(container, state, actions) {
  clear(container);

  const active = PANES.find((p) => p.id === state.tab) ?? PANES[0];

  const cards = [
    tabbedCard({
      tabs: PANES,
      active: active.id,
      onSelect: actions.setTab,
      body: active.pane(state, actions),
    }),
    transformCard(state, actions),
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
