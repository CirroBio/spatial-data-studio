// @vitest-environment happy-dom  (lib/presence reads localStorage at import)
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTable, Schema, Table } from 'apache-arrow';
import type { DataSource, LocalCategorical } from '@cirrobio/spatial-viewer';

import { useAppStore } from './sessionStore';
import type { RegionSet } from '../types';

// The two members labelling touches, behaving as the checkpoint source does: a local
// column, once installed, shadows the stored one of the same name.
function checkpointLike(stored: Record<string, LocalCategorical>) {
  const local = new Map<string, LocalCategorical>();
  const source = {
    kind: 'checkpoint',
    setLocalColumn: (path: string, column: LocalCategorical) => { local.set(path, column); },
    getFieldData: async (path: string) => {
      const column = local.get(path) ?? stored[path];
      if (!column) throw new Error(`no such column: ${path}`);
      const table = makeTable({ code: column.codes });
      return new Table(new Schema(table.schema.fields, new Map([
        ['kind', 'categorical'],
        ['categories', JSON.stringify(column.categories)],
      ])), table.batches);
    },
  } as unknown as DataSource;
  return { source, local };
}

const tumorSet: RegionSet = {
  id: 'set-1', name: 'tissue', obs_column: 'tissue',
  categories: [
    { label: 'tumor', color: '#ff0000', n_cells: 2 },
    { label: 'stroma', color: '#00ff00', n_cells: 2 },
  ],
};

const openSession = (regions: RegionSet[], obs: string[]) => {
  // Switching sessions is what clears the module-scope local columns between cases.
  useAppStore.getState().setActiveSessionId(null);
  useAppStore.getState().setActiveSessionId('sess');
  useAppStore.setState({
    sessionState: {
      fields: { obs: obs.map((name) => ({ name, kind: 'categorical' })), n_obs: 5 },
      app_state: { regions },
      data_versions: {},
    } as never,
  });
};
const regionSets = () => useAppStore.getState().sessionState?.app_state.regions ?? [];
const label = (source: DataSource, cellIndices: number[], category: string, obsColumn = 'tissue') =>
  useAppStore.getState().applyLocalRegion({
    source, cellIndices, nCells: 5, obsColumn, category, color: '#0000ff',
  });

describe('applyLocalRegion', () => {
  beforeEach(() => openSession([tumorSet], ['tissue']));

  it('keeps the labels a stored region set already carries', async () => {
    const { source, local } = checkpointLike({
      'obs:tissue': { categories: ['tumor', 'stroma'], codes: Int32Array.of(0, 0, 1, 1, -1) },
    });
    await label(source, [1, 2], 'necrosis');

    const column = local.get('obs:tissue');
    // The stored levels keep their positions; the cell with no level joins "unlabelled".
    expect(column?.categories).toEqual(['tumor', 'stroma', 'unlabelled', 'necrosis']);
    expect(Array.from(column?.codes ?? [])).toEqual([0, 3, 3, 1, 2]);
    expect(regionSets()).toEqual([{
      ...tumorSet,
      categories: [
        { label: 'tumor', color: '#ff0000', n_cells: 1 },
        { label: 'necrosis', color: '#0000ff', n_cells: 2 },
        { label: 'stroma', color: '#00ff00', n_cells: 1 },
      ],
    }]);
    expect(useAppStore.getState().sessionState?.data_versions['obs:tissue']).toBe(1);

    // A second label builds on the first rather than re-reading the store.
    await label(source, [0], 'necrosis');
    expect(Array.from(local.get('obs:tissue')?.codes ?? [])).toEqual([3, 3, 3, 1, 2]);
  });

  it('adds no unlabelled level to a stored column with every cell labelled', async () => {
    const { source, local } = checkpointLike({
      'obs:tissue': { categories: ['tumor', 'stroma'], codes: Int32Array.of(0, 0, 1, 1, 1) },
    });
    await label(source, [4], 'tumor');
    expect(local.get('obs:tissue')?.categories).toEqual(['tumor', 'stroma']);
    expect(Array.from(local.get('obs:tissue')?.codes ?? [])).toEqual([0, 0, 1, 1, 0]);
  });

  it('starts a new column with every other cell unlabelled', async () => {
    const { source, local } = checkpointLike({});
    await label(source, [3], 'margin', 'drawn');
    expect(local.get('obs:drawn')?.categories).toEqual(['unlabelled', 'margin']);
    expect(Array.from(local.get('obs:drawn')?.codes ?? [])).toEqual([0, 0, 0, 1, 0]);
    expect(regionSets().map((r) => r.obs_column)).toEqual(['tissue', 'drawn']);
  });
});
