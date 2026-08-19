import { useMemo } from 'react';
import * as arrow from 'apache-arrow';
import type { ScatterPositions } from './useArrowPositions';
import { buildCategoricalPalette, buildNumericColormap, hexToRgb } from './colorUtils';

// Above this many distinct levels a categorical coloring is meaningless (the
// palette only has 15 colors) and rendering one legend row per level can hang or
// crash the browser — e.g. an object-dtype obs column of per-cell IDs/barcodes,
// which the backend serves as a categorical. Past the cap we skip the coloring.
const MAX_CATEGORICAL_LEVELS = 100;

// Normalized coloring input, decoupled from the transport (Arrow over HTTP). Build
// it from an Arrow table with arrowToColorSource.
type ColorSource =
  | { kind: 'categorical'; codes: Int32Array; categories: string[] }
  | { kind: 'numeric'; values: Float32Array };

export type ColorLegend =
  | { kind: 'categorical'; items: { label: string; color: [number, number, number] }[] }
  | { kind: 'too-many-categories'; count: number; limit: number }
  | { kind: 'numeric'; min: number; max: number };

// Adapt a color-by Arrow field (schema metadata 'kind'/'categories' + a 'code' or
// 'value' column) into a ColorSource. Used at the two live call sites.
export function arrowToColorSource(table: arrow.Table | null): ColorSource | null {
  if (!table) return null;
  const meta = table.schema.metadata;
  const n = table.numRows;
  if (meta?.get('kind') === 'categorical') {
    const codeCol = table.getChild('code');
    const catJson = meta.get('categories');
    if (!codeCol || !catJson) return null;
    const categories = JSON.parse(catJson) as string[];
    const codes = new Int32Array(n);
    for (let i = 0; i < n; i++) codes[i] = codeCol.get(i) as number;
    return { kind: 'categorical', codes, categories };
  }
  const valueCol = table.getChild('value');
  if (!valueCol) return null;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = valueCol.get(i);
    values[i] = v == null ? NaN : Number(v);
  }
  return { kind: 'numeric', values };
}

interface Params {
  colorSource: ColorSource | null;
  positions: ScatterPositions | null;
  opacity: number;
  isolatedCategory: string | null;
  // Rows to draw fully transparent (the serverless viewer's hide-cells mask). Unlike
  // an isolated category, which dims to a visible 30, these vanish.
  hiddenCells?: ReadonlySet<number> | null;
  // Per-category `#rrggbb` overrides for the current categorical field; a level
  // absent here falls back to the default palette. Undefined for numeric fields.
  categoryColors?: Record<string, string>;
}

// Resolve each category's effective RGB: a user override if present, else the
// default palette color. Shared by the color buffer and the legend so both agree.
function resolveCategoryColors(
  categories: string[],
  overrides: Record<string, string> | undefined,
): [number, number, number][] {
  const palette = buildCategoricalPalette(categories);
  return categories.map((cat) => {
    const override = overrides?.[cat];
    return override ? hexToRgb(override) : palette.get(cat) ?? [128, 128, 128];
  });
}

export function useSpotColors(
  { colorSource, positions, opacity, isolatedCategory, categoryColors, hiddenCells }: Params,
): { colors: Uint8Array | null; colorLegend: ColorLegend | null } {
  // Build color array — respects isolated category by dimming non-matching points
  const colors = useMemo((): Uint8Array | null => {
    if (!positions) return null;
    const n = positions.numRows;
    const result = new Uint8Array(n * 4);
    const alpha = Math.round(opacity * 255);
    const alphaAt = (i: number) => (hiddenCells?.has(i) ? 0 : alpha);

    if (!colorSource) {
      // `color_by: null` is a reachable display state — no categorical obs column to
      // pick at session start, or a save that dropped X — and the figure renderer draws
      // those cells grey. Both canvases gate the whole points layer on this buffer, so
      // returning null for a missing coloring would blank a checkpoint that exports fine.
      for (let i = 0; i < n; i++) {
        result[i * 4] = 128;
        result[i * 4 + 1] = 128;
        result[i * 4 + 2] = 128;
        result[i * 4 + 3] = alphaAt(i);
      }
      return result;
    }

    if (colorSource.kind === 'categorical') {
      const { codes, categories } = colorSource;
      if (categories.length > MAX_CATEGORICAL_LEVELS) {
        // Failsafe: don't attempt the per-level coloring. Fill a neutral uniform
        // color so the points still render and the layout stays visible.
        for (let i = 0; i < n; i++) {
          result[i * 4] = 128;
          result[i * 4 + 1] = 128;
          result[i * 4 + 2] = 128;
          result[i * 4 + 3] = alphaAt(i);
        }
        return result;
      }
      const resolved = resolveCategoryColors(categories, categoryColors);

      for (let i = 0; i < n; i++) {
        const code = codes[i];
        const cat = categories[code];
        const [r, g, b] = resolved[code] ?? [128, 128, 128];
        const dimmed = isolatedCategory !== null && cat !== isolatedCategory;
        result[i * 4] = r;
        result[i * 4 + 1] = g;
        result[i * 4 + 2] = b;
        result[i * 4 + 3] = hiddenCells?.has(i) ? 0 : dimmed ? 30 : alpha;
      }
    } else {
      const rgba = buildNumericColormap(colorSource.values);
      for (let i = 0; i < n; i++) {
        result[i * 4] = rgba[i * 4];
        result[i * 4 + 1] = rgba[i * 4 + 1];
        result[i * 4 + 2] = rgba[i * 4 + 2];
        result[i * 4 + 3] = rgba[i * 4 + 3] === 0 ? 0 : alphaAt(i);
      }
    }
    return result;
  }, [colorSource, positions, opacity, isolatedCategory, categoryColors, hiddenCells]);

  // Legend for the current cell coloring: category swatches (categorical) or a
  // colorbar with the value range (numeric). Mirrors the palette/ramp used above.
  const colorLegend = useMemo((): ColorLegend | null => {
    if (!colorSource) return null;
    if (colorSource.kind === 'categorical') {
      const { categories } = colorSource;
      if (categories.length > MAX_CATEGORICAL_LEVELS) {
        return { kind: 'too-many-categories' as const, count: categories.length, limit: MAX_CATEGORICAL_LEVELS };
      }
      const resolved = resolveCategoryColors(categories, categoryColors);
      return {
        kind: 'categorical' as const,
        items: categories.map((c, i) => ({ label: c, color: resolved[i] })),
      };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const v of colorSource.values) {
      if (!Number.isNaN(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) return null;
    return { kind: 'numeric' as const, min, max };
  }, [colorSource, categoryColors]);

  return { colors, colorLegend };
}
