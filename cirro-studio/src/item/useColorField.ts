import { useMemo } from 'react';
import { arrowToColorSource, buildColorLegend, rgbToHex, useArrowField } from '@cirrobio/spatial-viewer';

export type ColorKey =
  | { kind: 'categorical'; field: string; items: { label: string; color: string; count: number }[] }
  | { kind: 'too-many-categories'; field: string; count: number; limit: number }
  | { kind: 'numeric'; field: string; min: number; max: number };

/** The legend a canvas draws for `field` (the same palette, overrides and category
 * cap), with how many cells each category holds. A numeric field with no values has
 * none. */
export function useColorKey(field: string | null, version: number, overrides?: Record<string, string>): { key: ColorKey | null; loading: boolean; error: string | null } {
  const { table, loading, error } = useArrowField(field, version);
  const key = useMemo((): ColorKey | null => {
    const source = arrowToColorSource(table);
    if (!source || !field) return null;
    const legend = buildColorLegend(source, overrides);
    if (legend?.kind !== 'categorical') return legend && { ...legend, field };
    const counts = new Array<number>(legend.items.length).fill(0);
    // Only narrows the type: a categorical legend comes only from categorical codes.
    if (source.kind === 'categorical') for (const c of source.codes) if (c >= 0) counts[c] += 1;
    return {
      kind: 'categorical', field,
      items: legend.items.map((item, i) => ({ label: item.label, color: rgbToHex(item.color), count: counts[i] })),
    };
  }, [table, field, overrides]);
  // The read starts in an effect, so a first render has neither a table nor a request yet.
  return { key, loading: loading || (field !== null && !table && !error), error };
}
