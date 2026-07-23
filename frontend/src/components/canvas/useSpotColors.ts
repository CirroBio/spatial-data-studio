import { useMemo } from 'react';
import * as arrow from 'apache-arrow';
import type { ScatterPositions } from './useArrowPositions';
import { buildCategoricalPalette, buildNumericColormap } from './colorUtils';

// Above this many distinct levels a categorical coloring is meaningless (the
// palette only has 15 colors) and rendering one legend row per level can hang or
// crash the browser — e.g. an object-dtype obs column of per-cell IDs/barcodes,
// which the backend serves as a categorical. Past the cap we skip the coloring.
export const MAX_CATEGORICAL_LEVELS = 100;

// Normalized coloring input, decoupled from the transport (Arrow over HTTP). Build
// it from an Arrow table with arrowToColorSource.
export type ColorSource =
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
}

export function useSpotColors(
  { colorSource, positions, opacity, isolatedCategory }: Params,
): { colors: Uint8Array | null; colorLegend: ColorLegend | null } {
  // Build color array — respects isolated category by dimming non-matching points
  const colors = useMemo((): Uint8Array | null => {
    if (!colorSource || !positions) return null;
    const n = positions.numRows;
    const result = new Uint8Array(n * 4);
    const alpha = Math.round(opacity * 255);

    if (colorSource.kind === 'categorical') {
      const { codes, categories } = colorSource;
      if (categories.length > MAX_CATEGORICAL_LEVELS) {
        // Failsafe: don't attempt the per-level coloring. Fill a neutral uniform
        // color so the points still render and the layout stays visible.
        for (let i = 0; i < n; i++) {
          result[i * 4] = 128;
          result[i * 4 + 1] = 128;
          result[i * 4 + 2] = 128;
          result[i * 4 + 3] = alpha;
        }
        return result;
      }
      const palette = buildCategoricalPalette(categories);
      const categoryColors: [number, number, number][] = categories.map(
        (cat) => palette.get(cat) ?? [128, 128, 128]
      );

      for (let i = 0; i < n; i++) {
        const code = codes[i];
        const cat = categories[code];
        const [r, g, b] = categoryColors[code] ?? [128, 128, 128];
        const dimmed = isolatedCategory !== null && cat !== isolatedCategory;
        result[i * 4] = r;
        result[i * 4 + 1] = g;
        result[i * 4 + 2] = b;
        result[i * 4 + 3] = dimmed ? 30 : alpha;
      }
    } else {
      const rgba = buildNumericColormap(colorSource.values);
      for (let i = 0; i < n; i++) {
        result[i * 4] = rgba[i * 4];
        result[i * 4 + 1] = rgba[i * 4 + 1];
        result[i * 4 + 2] = rgba[i * 4 + 2];
        result[i * 4 + 3] = rgba[i * 4 + 3] === 0 ? 0 : alpha;
      }
    }
    return result;
  }, [colorSource, positions, opacity, isolatedCategory]);

  // Legend for the current cell coloring: category swatches (categorical) or a
  // colorbar with the value range (numeric). Mirrors the palette/ramp used above.
  const colorLegend = useMemo((): ColorLegend | null => {
    if (!colorSource) return null;
    if (colorSource.kind === 'categorical') {
      const { categories } = colorSource;
      if (categories.length > MAX_CATEGORICAL_LEVELS) {
        return { kind: 'too-many-categories' as const, count: categories.length, limit: MAX_CATEGORICAL_LEVELS };
      }
      const palette = buildCategoricalPalette(categories);
      return {
        kind: 'categorical' as const,
        items: categories.map((c) => ({ label: c, color: palette.get(c) ?? [128, 128, 128] })),
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
  }, [colorSource]);

  return { colors, colorLegend };
}
