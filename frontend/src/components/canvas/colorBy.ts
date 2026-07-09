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
  const [slot, key = ''] = (path ?? '').split(/:(.*)/s);
  if (slot === 'X') return { slot: 'X', column: '', layer: '', gene: key };
  if (slot === 'layers') {
    const [layer, gene = ''] = key.split(/\/(.*)/s);
    return { slot: 'layers', column: '', layer, gene };
  }
  return { slot: 'obs', column: key, layer: '', gene: '' };
}

// Human label for legends: the obs column, or the gene (annotated with its layer).
export function colorByLabel(path: string | null | undefined): string {
  const c = parseColorBy(path);
  if (c.slot === 'obs') return c.column;
  if (c.slot === 'layers') return c.gene ? `${c.gene} (${c.layer})` : '';
  return c.gene;
}
