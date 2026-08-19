// Cell color-by path helpers. A color_by path is `<slot>:<key>`:
//   obs:<column>            an obs column
//   X:<gene>                a gene's expression in X
//   layers:<layer>/<gene>   a gene's value in a named layer
export type ColorBySlot = 'obs' | 'X' | 'layers';

export interface ColorBy {
  slot: ColorBySlot;
  column: string;  // obs column (obs slot only)
  layer: string;   // layer name (layers slot only)
  gene: string;    // gene name (X and layers slots)
}

export function parseColorBy(path: string | null | undefined): ColorBy {
  const raw = path ?? '';
  // No colouring at all — the one legitimately empty path, kept distinct from a path
  // that names something this build cannot read.
  if (!raw) return { slot: 'obs', column: '', layer: '', gene: '' };
  const [slot, key = ''] = raw.split(/:(.*)/s);
  if (slot === 'obs') return { slot: 'obs', column: key, layer: '', gene: '' };
  if (slot === 'X') return { slot: 'X', column: '', layer: '', gene: key };
  if (slot === 'layers') {
    const [layer, gene = ''] = key.split(/\/(.*)/s);
    return { slot: 'layers', column: '', layer, gene };
  }
  // A path naming no known slot (a hand-edited `?view=` link, a display written by a
  // newer build). Falling through to an obs column dropped the slot silently and, for a
  // path with no ':' at all, left an empty column that reads exactly like "not coloured"
  // — so the legend went blank with nothing saying why. Carry the whole path through as
  // the column instead: the legend and the picker then show what is actually set. Not a
  // throw, because these callers run inside render and a bad link would blank the canvas.
  console.warn(`color_by path names no known slot, showing it verbatim: ${raw}`);
  return { slot: 'obs', column: raw, layer: '', gene: '' };
}

// Human label for legends: the obs column, or the gene (annotated with its layer).
export function colorByLabel(path: string | null | undefined): string {
  const c = parseColorBy(path);
  if (c.slot === 'obs') return c.column;
  if (c.slot === 'layers') return c.gene ? `${c.gene} (${c.layer})` : '';
  return c.gene;
}
