import { useMemo } from 'react';
import * as arrow from 'apache-arrow';
import type { ArrowPositions } from './useArrowPositions';
import { buildCategoricalPalette, buildNumericColormap } from './colorUtils';

export type ColorLegend =
  | { kind: 'categorical'; items: { label: string; color: [number, number, number] }[] }
  | { kind: 'numeric'; min: number; max: number };

interface Params {
  colorTable: arrow.Table | null;
  positions: ArrowPositions | null;
  opacity: number;
  isolatedCategory: string | null;
}

export function useSpotColors(
  { colorTable, positions, opacity, isolatedCategory }: Params,
): { colors: Uint8Array | null; colorLegend: ColorLegend | null } {
  // Build color array — respects isolated category by dimming non-matching points
  const colors = useMemo((): Uint8Array | null => {
    if (!colorTable || !positions) return null;
    const n = positions.numRows;
    const result = new Uint8Array(n * 4);

    const schemaMetadata = colorTable.schema.metadata;
    const kind = schemaMetadata?.get('kind');

    if (kind === 'categorical') {
      const codeCol = colorTable.getChild('code');
      const catJson = schemaMetadata?.get('categories');
      if (!codeCol || !catJson) return null;

      const categories: string[] = JSON.parse(catJson) as string[];
      const palette = buildCategoricalPalette(categories);
      const categoryColors: [number, number, number][] = categories.map(
        (cat) => palette.get(cat) ?? [128, 128, 128]
      );

      for (let i = 0; i < n; i++) {
        const code = codeCol.get(i) as number;
        const cat = categories[code];
        const [r, g, b] = categoryColors[code] ?? [128, 128, 128];
        const dimmed = isolatedCategory !== null && cat !== isolatedCategory;
        result[i * 4] = r;
        result[i * 4 + 1] = g;
        result[i * 4 + 2] = b;
        result[i * 4 + 3] = dimmed ? 30 : Math.round(opacity * 255);
      }
    } else {
      const valueCol = colorTable.getChild('value');
      if (!valueCol) return null;
      const values = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        values[i] = valueCol.get(i) as number;
      }
      const rgba = buildNumericColormap(values);
      for (let i = 0; i < n; i++) {
        result[i * 4] = rgba[i * 4];
        result[i * 4 + 1] = rgba[i * 4 + 1];
        result[i * 4 + 2] = rgba[i * 4 + 2];
        result[i * 4 + 3] = Math.round(opacity * 255);
      }
    }
    return result;
  }, [colorTable, positions, opacity, isolatedCategory]);

  // Legend for the current cell coloring: category swatches (categorical) or a
  // colorbar with the value range (numeric). Mirrors the palette/ramp used above.
  const colorLegend = useMemo((): ColorLegend | null => {
    if (!colorTable) return null;
    const meta = colorTable.schema.metadata;
    if (meta?.get('kind') === 'categorical') {
      const catJson = meta?.get('categories');
      if (!catJson) return null;
      const categories = JSON.parse(catJson) as string[];
      const palette = buildCategoricalPalette(categories);
      return {
        kind: 'categorical' as const,
        items: categories.map((c) => ({ label: c, color: palette.get(c) ?? [128, 128, 128] })),
      };
    }
    const valueCol = colorTable.getChild('value');
    if (!valueCol) return null;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < colorTable.numRows; i++) {
      const v = valueCol.get(i) as number;
      if (!Number.isNaN(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) return null;
    return { kind: 'numeric' as const, min, max };
  }, [colorTable]);

  return { colors, colorLegend };
}
