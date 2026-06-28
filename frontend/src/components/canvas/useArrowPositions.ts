import { useMemo } from 'react';
import * as arrow from 'apache-arrow';

export interface ArrowPositions {
  positions: Float32Array;
  numRows: number;
  bounds: { d0min: number; d0max: number; d1min: number; d1max: number };
}

export function useArrowPositions(table: arrow.Table | null): ArrowPositions | null {
  return useMemo(() => {
    if (!table) return null;
    const d0Col = table.getChild('d0');
    const d1Col = table.getChild('d1');
    if (!d0Col || !d1Col) return null;

    const n = table.numRows;
    const positions = new Float32Array(n * 2);
    let d0min = Infinity, d0max = -Infinity;
    let d1min = Infinity, d1max = -Infinity;

    for (let i = 0; i < n; i++) {
      const x = d0Col.get(i) as number;
      const y = d1Col.get(i) as number;
      positions[i * 2] = x;
      positions[i * 2 + 1] = y;
      if (x < d0min) d0min = x;
      if (x > d0max) d0max = x;
      if (y < d1min) d1min = y;
      if (y > d1max) d1max = y;
    }

    return { positions, numRows: n, bounds: { d0min, d0max, d1min, d1max } };
  }, [table]);
}
