import { useMemo } from 'react';
import * as arrow from 'apache-arrow';

export interface ArrowPositions {
  positions: Float32Array;
  numRows: number;
  bounds: { d0min: number; d0max: number; d1min: number; d1max: number; d2min?: number; d2max?: number };
}

interface AxisIndices {
  xIndex?: number;
  yIndex?: number;
  zIndex?: number;  // omit for a 2D scatter
}

// Reads columns `d${xIndex}`/`d${yIndex}`(/`d${zIndex}`) from an obsm field batch
// (see resolve_field's obsm branch) into a flat, stride-2-or-3 Float32Array of
// positions for a deck.gl binary-attribute layer. Defaults to d0/d1 (spatial coords).
export function useArrowPositions(
  table: arrow.Table | null,
  { xIndex = 0, yIndex = 1, zIndex }: AxisIndices = {},
): ArrowPositions | null {
  return useMemo(() => {
    if (!table) return null;
    const xCol = table.getChild(`d${xIndex}`);
    const yCol = table.getChild(`d${yIndex}`);
    if (!xCol || !yCol) return null;
    const zCol = zIndex !== undefined ? table.getChild(`d${zIndex}`) : null;
    const is3d = zCol !== null;
    const stride = is3d ? 3 : 2;

    const n = table.numRows;
    const positions = new Float32Array(n * stride);
    let d0min = Infinity, d0max = -Infinity;
    let d1min = Infinity, d1max = -Infinity;
    let d2min = Infinity, d2max = -Infinity;

    for (let i = 0; i < n; i++) {
      const x = xCol.get(i) as number;
      const y = yCol.get(i) as number;
      positions[i * stride] = x;
      positions[i * stride + 1] = y;
      if (x < d0min) d0min = x;
      if (x > d0max) d0max = x;
      if (y < d1min) d1min = y;
      if (y > d1max) d1max = y;
      if (is3d) {
        const z = zCol.get(i) as number;
        positions[i * stride + 2] = z;
        if (z < d2min) d2min = z;
        if (z > d2max) d2max = z;
      }
    }

    const bounds = is3d
      ? { d0min, d0max, d1min, d1max, d2min, d2max }
      : { d0min, d0max, d1min, d1max };
    return { positions, numRows: n, bounds };
  }, [table, xIndex, yIndex, zIndex]);
}
