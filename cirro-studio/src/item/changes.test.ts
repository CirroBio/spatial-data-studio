import { describe, expect, it } from 'vitest';
import type { Change } from '../stack/manifest';
import { suggestTitle } from './changes';

const groups = (column: string): Change => ({ op: 'set-obs', table: 't', column, kind: 'categorical', note: 'Leiden, resolution 1' });
const result = (note: string): Change => ({ op: 'set-uns', table: 't', path: ['spatial_data_studio', 'results', note], note });

describe('suggestTitle', () => {
  it('names a version for the results it holds', () => {
    expect(suggestTitle([groups('leiden'), result('Clusters in leiden')])).toBe('Clusters in leiden');
    expect(suggestTitle([groups('leiden'), result('Clusters in leiden'), result('Marker genes of leiden')]))
      .toBe('Clusters in leiden and 1 more');
  });

  it('names one without results for its first change', () => {
    expect(suggestTitle([groups('labels')])).toBe('Groups labels');
    expect(suggestTitle([groups('labels'), groups('niche')])).toBe('Groups labels and 1 more');
  });

  it('names one that only removes for what it removes', () => {
    expect(suggestTitle([{ op: 'delete-obs', table: 't', column: 'x' }])).toBe('Removed x');
    expect(suggestTitle([{ op: 'delete-figure', table: 't', id: 'fig_1', title: 'Clusters' }])).toBe('Removed figure Clusters');
    expect(suggestTitle([
      { op: 'delete-figure', table: 't', id: 'fig_1', title: 'Clusters' },
      { op: 'delete-uns', table: 't', path: ['spatial_data_studio', 'results', 'markers_1'] },
    ])).toBe('Removed figure Clusters and 1 more');
  });
});
