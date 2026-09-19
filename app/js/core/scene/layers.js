/**
 * Layers: which pen draws what.
 *
 * A layer is a pen. Everything assigned to it is plotted together, then the
 * machine returns home and pauses so the pen can be swapped, then the next
 * layer runs. That ordering is the whole point — a multi-colour drawing
 * plotted in arbitrary order would need a pen change per stroke.
 *
 * Membership is held here, against stable path ids, rather than on the paths
 * themselves. Paths get reordered, reversed and merged by the optimizer, and a
 * layer assignment has to survive all of that.
 */

let nextLayerId = 1;

/** Reset layer id allocation. Tests only. */
export function resetLayerIds() {
  nextLayerId = 1;
}

/**
 * Default colours for new layers.
 *
 * These stand for real ink, not a data palette — they are what the user will
 * put in the holder — so they are plain recognisable pen colours, light enough
 * to read on the dark canvas.
 */
export const LAYER_COLOURS = [
  '#e4e7ea', // black pen, drawn light so it shows on a dark ground
  '#d9736a',
  '#6aa9d9',
  '#7fc98b',
  '#d9a85c',
  '#b98fd0',
];

export function createLayer({
  name = null, color = null, visible = true, z = null, zEnd = null,
} = {}) {
  const index = nextLayerId - 1;

  return {
    id: `l${nextLayerId++}`,
    name: name ?? `Layer ${nextLayerId - 1}`,
    color: color ?? LAYER_COLOURS[index % LAYER_COLOURS.length],
    visible,
    /**
     * How deep this pen draws, and what to finish at.
     *
     * `null` takes the job's own depth. `zEnd` set makes every stroke on the
     * layer ramp along its length — see scene/depth.js.
     */
    z,
    zEnd,
  };
}

/**
 * The layer a path belongs to, falling back to its placement's default.
 *
 * A hatch line carries its own layer, set when the shape was filled. It is not
 * the shape's: filling a blue outline with red hatching is the ordinary case,
 * not an odd one, and the hatch is not in the paths a per-path override could
 * be held against — it is generated from them.
 */
export function layerIdFor(placement, path) {
  const fillLayerId = path.meta?.fillLayerId;
  if (fillLayerId !== undefined) return fillLayerId ?? placement.layerId ?? null;

  return placement.pathLayers?.[path.id] ?? placement.layerId ?? null;
}

/**
 * Assign paths to a layer.
 *
 * Returns a new overrides map. Assigning to the placement's own default layer
 * removes the override rather than storing a redundant one, so the map stays
 * small and "this placement is all one pen" remains expressible.
 */
export function assignPaths(placement, pathIds, layerId) {
  const overrides = { ...(placement.pathLayers ?? {}) };

  for (const id of pathIds) {
    if (layerId === placement.layerId || layerId == null) delete overrides[id];
    else overrides[id] = layerId;
  }

  return overrides;
}

/**
 * Group paths into layers, in plot order.
 *
 * Layers are returned in their own order, and empty ones are dropped — a pen
 * swap for a layer with nothing in it would stop the machine for no reason.
 *
 * Anything belonging to no layer, or to one that has been deleted, is grouped
 * under `null` and drawn first. Losing strokes because their layer went away
 * would be much worse than plotting them with whatever pen is already in.
 */
export function groupByLayer(layers, entries) {
  const groups = new Map();

  for (const { path, layerId } of entries) {
    const key = layers.some((l) => l.id === layerId) ? layerId : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(path);
  }

  const ordered = [];

  if (groups.has(null)) {
    ordered.push({ layer: null, paths: groups.get(null) });
  }

  for (const layer of layers) {
    const paths = groups.get(layer.id);
    if (paths && paths.length > 0) ordered.push({ layer, paths });
  }

  return ordered;
}
