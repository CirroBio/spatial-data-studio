import type * as arrow from 'apache-arrow';
import { useArrowField } from '../../hooks/useArrowField';

// Resolves a display's color_by encoding to its fetched Arrow column, shared by the
// spatial and embedding canvases.
export function useColorField(
  colorBy: string | null | undefined,
  dataVersions: Record<string, number>,
): { colorByPath: string; colorTable: arrow.Table | null; colorLoading: boolean } {
  // '' when the display has no colouring, which reads as falsy everywhere downstream
  // (no field fetch, no colour source, no legend) instead of crashing on null.
  const colorByPath = colorBy ?? '';
  // Gene colorings (`X:<gene>`) can't be versioned per gene — the backend tracks the
  // expression matrix by whole-array identity and bumps the coarse `X:` path — so fold
  // that in, else a normalize/log1p/scale/filter compute leaves the canvas on stale colors.
  const colorVersion = (dataVersions[colorByPath] ?? 0)
    + (colorByPath.startsWith('X:') ? (dataVersions['X:'] ?? 0) : 0);
  const { table: colorTable, loading: colorLoading } = useArrowField(colorByPath, colorVersion);
  return { colorByPath, colorTable, colorLoading };
}
