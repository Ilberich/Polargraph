/**
 * SVG document → paths in millimetres.
 *
 * Ties the SVG layer together: parse the document, resolve the viewport and
 * viewBox, walk the tree accumulating transforms, and flatten every shape into
 * the path model. Everything downstream works in millimetres on paper and never
 * sees an SVG concept again.
 */

import { multiply, meanScale, scaling, IDENTITY } from '../geom/matrix.js';
import { createPath, transformPath, isDegenerate } from '../geom/path.js';
import { parseXml, find } from './xml.js';
import { parseTransform } from './transform.js';
import { pathDataToPolylines } from './pathdata.js';
import { shapeToPathData, SHAPE_TAGS } from './shapes.js';
import {
  parseLength, parseViewBox, viewBoxTransform, userUnitsToMm, MM_PER_INCH,
  USER_UNITS_PER_INCH,
} from './units.js';

/** Default flattening tolerance in millimetres on paper. */
export const DEFAULT_TOLERANCE_MM = 0.05;

/**
 * Elements whose contents are definitions rather than drawing.
 *
 * Their children are only rendered where a `<use>` refers to them. Walking into
 * them would stamp every clip path and gradient shape onto the paper.
 */
const NON_RENDERING = new Set([
  'defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern',
  'title', 'desc', 'metadata', 'style', 'script',
]);

/** Containers whose children are drawn in the parent's coordinate system. */
const CONTAINERS = new Set(['g', 'a', 'switch']);

function isHidden(attrs) {
  if (attrs.display === 'none') return true;

  const style = attrs.style ?? '';
  return /(^|[;\s])display\s*:\s*none/.test(style);
}

/**
 * Work out the drawing's size in user units.
 *
 * Width and height attributes win when they are absolute. A percentage has no
 * basis at the root — it refers to a containing block that does not exist for a
 * standalone file — so the viewBox supplies the size instead. With neither, the
 * caller gets null and can fall back to the geometry's own bounds.
 */
function resolveViewport(attrs, viewBox) {
  const width = parseLength(attrs.width);
  const height = parseLength(attrs.height);

  if (width != null && height != null && width > 0 && height > 0) {
    return { width, height, source: 'attributes' };
  }

  if (viewBox) {
    return { width: viewBox.width, height: viewBox.height, source: 'viewBox' };
  }

  return null;
}

/**
 * Import an SVG document.
 *
 * Returns paths in millimetres, the drawing's size, and any warnings worth
 * showing the user. Unsupported constructs produce a warning and are skipped;
 * an import that drops one unsupported element is far more useful than one that
 * refuses the file.
 */
export function importSvg(source, { toleranceMm = DEFAULT_TOLERANCE_MM } = {}) {
  const warnings = [];
  const document = parseXml(source);
  const svg = find(document, 'svg');

  if (!svg) {
    return { paths: [], widthMm: null, heightMm: null, warnings: ['No <svg> element found.'] };
  }

  const viewBox = parseViewBox(svg.attrs.viewBox);
  const viewport = resolveViewport(svg.attrs, viewBox);

  if (!viewport) {
    warnings.push('No width, height or viewBox; size taken from the geometry.');
  }

  // User units are CSS pixels at 96 dpi; the plotter works in millimetres.
  const mmPerUserUnit = MM_PER_INCH / USER_UNITS_PER_INCH;
  const toMm = scaling(mmPerUserUnit);

  // viewBox maps document coordinates onto the viewport; without one, document
  // coordinates are already user units.
  const rootMatrix =
    viewBox && viewport
      ? multiply(toMm, viewBoxTransform(viewBox, viewport.width, viewport.height, svg.attrs.preserveAspectRatio))
      : toMm;

  const paths = [];

  const walk = (node, parentMatrix) => {
    for (const child of node.children) {
      if (NON_RENDERING.has(child.tag)) continue;
      if (isHidden(child.attrs)) continue;

      // A child's own transform applies before its parent's.
      const matrix = multiply(parentMatrix, parseTransform(child.attrs.transform));

      if (CONTAINERS.has(child.tag)) {
        walk(child, matrix);
        continue;
      }

      if (child.tag === 'use') {
        warnings.push('<use> elements are not resolved yet and were skipped.');
        continue;
      }

      if (child.tag === 'text') {
        warnings.push('Text is not converted to paths; convert it in your editor first.');
        continue;
      }

      if (child.tag === 'svg') {
        // A nested viewport. Treated as a plain group: its own viewBox is not
        // applied, so nested scaling will be wrong. Rare enough to warn about
        // rather than guess at.
        warnings.push('Nested <svg> treated as a group; its viewBox was ignored.');
        walk(child, matrix);
        continue;
      }

      if (!SHAPE_TAGS.has(child.tag)) {
        walk(child, matrix);
        continue;
      }

      const d = shapeToPathData(child, {
        percentBasis: viewport ? Math.max(viewport.width, viewport.height) : null,
      });
      if (!d) continue;

      // Curves are flattened in the shape's own coordinates, so the tolerance
      // has to be carried back through the transform. Without this a shape
      // scaled up tenfold is flattened ten times too coarsely, and one scaled
      // down wastes points nobody can see.
      const scale = meanScale(matrix);
      const localTolerance = scale > 0 ? toleranceMm / scale : toleranceMm;

      for (const sub of pathDataToPolylines(d, localTolerance)) {
        const path = transformPath(
          createPath(sub.points, { closed: sub.closed, meta: { tag: child.tag, id: child.attrs.id } }),
          matrix
        );

        if (!isDegenerate(path)) paths.push(path);
      }
    }
  };

  walk(svg, rootMatrix);

  return {
    paths,
    widthMm: viewport ? userUnitsToMm(viewport.width) : null,
    heightMm: viewport ? userUnitsToMm(viewport.height) : null,
    warnings: [...new Set(warnings)],
  };
}
