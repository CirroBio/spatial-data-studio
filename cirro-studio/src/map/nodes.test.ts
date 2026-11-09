import { describe, expect, it } from 'vitest';
import { buildLibrary } from '../app/library';
import { creditOf } from '../cirro/cirro-publication';
import { itemKey, type DatasetRecord, type StoreItem, type VersionItem } from '../data/model';
import { datasetRef } from '../stack/cirroRef';
import { labelLines, stageNodes, userTags } from './nodes';

describe('labelLines', () => {
  it('keeps the words that tell two names apart', () => {
    expect(labelLines('Visium CytAssist mouse brain', 13, 3)).toEqual(['Visium', 'CytAssist', 'mouse brain']);
    expect(labelLines('Visium CytAssist human colon', 13, 3)).toEqual(['Visium', 'CytAssist', 'human colon']);
  });
  it('cuts what is left after the last line', () => {
    expect(labelLines('Xenium human lung (raw counts)', 11, 2)).toEqual(['Xenium', 'human lung…']);
    expect(labelLines('a b c d e f', 3, 2)).toEqual(['a b', 'c…']);
  });
  it('cuts a word too long for its line and carries on', () => {
    expect(labelLines('Supercalifragilistic run', 10, 2)).toEqual(['Supercali…', 'run']);
  });
  it('leaves a name that fits', () => {
    expect(labelLines('Xenium human pancreas', 22, 3)).toEqual(['Xenium human pancreas']);
  });
});

describe('userTags', () => {
  const record = (tags: DatasetRecord['tags']): DatasetRecord => ({
    id: 'd', name: 'd', description: '', processId: '', processName: '', status: 'COMPLETED', createdAt: '', createdBy: '',
    tags, folders: [], sourceIds: [], share: null,
  });

  it('leaves out the app\'s own tags, as it writes them now and as it once did, folders and lineage', () => {
    expect(userTags(record([
      { key: '', value: 'spatial-data-studio' },
      { key: 'cirro-app', value: 'spatial-data-studio' },
      { key: 'spatial-data-studio.kind', value: 'version' },
      { key: '', value: 'folder://lung/2026' },
      { key: '', value: 'lineage.from: cirro::p:dataset:d' },
      { key: '', value: 'tumor' },
      { key: 'site', value: 'Seattle' },
    ]))).toEqual(['tumor', 'site: Seattle']);
  });

  it('leaves out credit tags when they make a credit, which needs a source or a license', () => {
    const credited = record([
      { key: '', value: 'credit.source: Xenium Human Lung' },
      { key: '', value: 'credit.license: CC BY 4.0' },
      { key: '', value: 'tumor' },
    ]);
    const credit = creditOf(credited.tags) ?? undefined;
    expect(credit).toEqual({ source: 'Xenium Human Lung', license: 'CC BY 4.0' });
    expect(userTags({ ...credited, credit })).toEqual(['tumor']);
    const uncredited = record([{ key: '', value: 'credit.by: 10x Genomics' }]);
    expect(creditOf(uncredited.tags)).toBeNull();
    expect(userTags(uncredited)).toEqual(['credit.by: 10x Genomics']);
  });
});

describe('stageNodes', () => {
  const dataset = (id: string, name: string): DatasetRecord => ({
    id, name, description: '', processId: 'custom_dataset', processName: 'Files', status: 'COMPLETED', createdAt: '', createdBy: '',
    tags: [], folders: [], sourceIds: [], share: null,
  });

  it('says which store a figure draws, not the title of the version it was kept in', () => {
    const store: StoreItem = {
      kind: 'store', key: itemKey('s', 'lung.sdata.zarr.zip'), datasetId: 's', path: 'lung.sdata.zarr.zip', label: 'lung.sdata.zarr.zip',
      size: 1, isFolder: false, checkpoint: true,
    };
    const ref = datasetRef('s', 'lung.sdata.zarr.zip');
    const version: VersionItem = {
      kind: 'version', key: itemKey('v', 'layer.json'), datasetId: 'v', path: 'layer.json', label: 'Example figures', size: 1,
      parent: ref, base: ref, depth: 1, title: 'Example figures', message: '', createdAt: '', createdBy: '',
      changes: [{ op: 'set-figure', table: 'table', id: 'fig_1', title: 'Clusters' }],
    };
    const byId = new Map([['s', dataset('s', 'Xenium human lung')], ['v', dataset('v', 'Xenium human lung · Example figures')]]);
    const [figure] = stageNodes(buildLibrary({ items: [store, version], byId }), { byId }).figures;
    expect(figure.facts.find((f) => f.key === 'in')?.text).toBe('in “Xenium human lung”');
  });

  it('leaves out a figure a later version removed', () => {
    const ref = datasetRef('s', 'lung.sdata.zarr.zip');
    const version = (id: string, depth: number, changes: VersionItem['changes']): VersionItem => ({
      kind: 'version', key: itemKey(id, 'layer.json'), datasetId: id, path: 'layer.json', label: id, size: 1,
      parent: depth === 1 ? ref : datasetRef('v1', 'layer.json'), base: ref, depth, title: id, message: '', createdAt: `2026-11-0${depth}`, createdBy: '',
      changes,
    });
    const library = buildLibrary({
      items: [
        version('v1', 1, [{ op: 'set-figure', table: 'table', id: 'fig_1', title: 'Clusters' }, { op: 'set-figure', table: 'table', id: 'fig_2', title: 'Niches' }]),
        version('v2', 2, [{ op: 'delete-figure', table: 'table', id: 'fig_1', title: 'Clusters' }]),
      ],
      byId: new Map(),
    });
    expect(library.figures.map((f) => f.title)).toEqual(['Niches']);
  });
});
