import { describe, expect, it } from 'vitest';
import { creditOf } from '../cirro/cirro-publication';
import type { DatasetRecord } from '../data/model';
import { labelLines, userTags } from './nodes';

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
