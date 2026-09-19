/**
 * The side panels.
 *
 * Rebuilt from state on each render rather than surgically patched. The panel
 * is small, and a rebuild cannot drift out of step with the scene the way
 * incremental updates quietly do.
 */

import { el, clear, numberField, checkboxField, button, card } from './dom.js';
import { marginBox, outsideMargins } from '../core/scene/scene.js';
import { placementBounds, placementLength } from '../core/scene/placement.js';

const mm = (value) => `${Math.round(value * 10) / 10}`;

function paperCard(state, actions) {
  const { paper } = state.scene;

  return card('Paper', [
    el('div', { class: 'field-grid' }, [
      numberField({
        label: 'Width', value: paper.widthMm, min: 1, unit: 'mm',
        onCommit: (v) => actions.setPaper({ widthMm: v }),
      }),
      numberField({
        label: 'Height', value: paper.heightMm, min: 1, unit: 'mm',
        onCommit: (v) => actions.setPaper({ heightMm: v }),
      }),
    ]),
    el('div', { class: 'field-grid field-grid--four' },
      ['top', 'right', 'bottom', 'left'].map((side) =>
        numberField({
          label: side[0].toUpperCase() + side.slice(1),
          value: paper.margins[side], min: 0, unit: 'mm',
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
        label: 'X', value: Math.round(placement.x * 100) / 100, step: 1, unit: 'mm',
        onCommit: (v) => actions.update(placement.id, { x: v }),
      }),
      numberField({
        label: 'Y', value: Math.round(placement.y * 100) / 100, step: 1, unit: 'mm',
        onCommit: (v) => actions.update(placement.id, { y: v }),
      }),
      numberField({
        label: 'Rotation', value: Math.round(placement.rotation * 10) / 10, step: 1, unit: '°',
        onCommit: (v) => actions.update(placement.id, { rotation: v }),
      }),
      numberField({
        label: 'Scale', value: Math.round(placement.scale * 1000) / 1000, step: 0.05, min: 0.01,
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

function viewCard(state, actions) {
  return card('View', [
    el('div', { class: 'stack' }, [
      checkboxField({
        label: 'Snapping', checked: state.settings.snap.enabled,
        onChange: (v) => actions.setSnap({ enabled: v }),
      }),
      checkboxField({
        label: 'Snap to grid', checked: state.settings.snap.grid,
        onChange: (v) => actions.setSnap({ grid: v }),
      }),
      checkboxField({
        label: 'Show grid', checked: state.settings.showGrid,
        onChange: (v) => actions.setSettings({ showGrid: v }),
      }),
    ]),
    numberField({
      label: 'Grid', value: state.settings.snap.gridMm, min: 1, unit: 'mm',
      onCommit: (v) => actions.setSnap({ gridMm: v }),
    }),
    el('div', { class: 'button-row' }, [
      button({ label: 'Fit view', onClick: actions.fitView }),
    ]),
  ]);
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
        label: 'Feed', value: settings.feedRate, min: 1, step: 50, unit: 'mm/min',
        onCommit: (v) => actions.setSettings({ feedRate: v }),
      }),
      numberField({
        label: 'Travel', value: settings.travelFeedRate, min: 1, step: 50, unit: 'mm/min',
        onCommit: (v) => actions.setSettings({ travelFeedRate: v }),
      }),
    ]),

    el('div', { class: 'stack' }, [
      checkboxField({
        label: 'Pen lift installed', checked: settings.penLift,
        onChange: (v) => actions.setSettings({ penLift: v }),
      }),
      !settings.penLift &&
        el('p', { class: 'hint' },
          'Without a pen axis every travel move draws, so the plot is one continuous line.'),
    ]),

    el('dl', { class: 'spec' }, [
      el('dt', { class: 'spec__key' }, 'Total length'),
      el('dd', { class: 'spec__value' }, `${mm(drawn)} mm`),
      el('dt', { class: 'spec__key' }, 'Objects'),
      el('dd', { class: 'spec__value' }, String(state.scene.placements.length)),
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
