import { describe, expect, it } from 'vitest';
import { IndexSource, parseIndex } from './indexFolder';

const INDEX_URL = 'https://data.example.org/lab/index.json';

const index = {
  title: 'Lab sections',
  description: 'Sections from our lab',
  checkpoints: [
    { path: 'raw/lung.sdata.zarr.zip' },
    {
      id: 'lung-clustered',
      path: 'analyzed/lung.sdata.zarr.zip',
      label: 'Lung, clustered',
      description: 'With Leiden clusters',
      folder: '/Xenium/Lung/',
      from: ['raw/lung.sdata.zarr.zip'],
      tags: ['tumor', 'site: Seattle', 3],
      date: '2026-10-01',
      size: 1234,
      credit: { source: 'Xenium Human Lung', license: 'CC BY 4.0', extra: 'ignored' },
    },
    { path: 'https://other.example.org/x.sdata.zarr.zip', from: ['lung-clustered', 'elsewhere'], credit: { by: 'Someone' } },
    { label: 'no path, so not a checkpoint' },
  ],
};

describe('parseIndex', () => {
  const parsed = parseIndex(index, INDEX_URL);
  const [raw, clustered, remote] = parsed.datasets;

  it('reads the folder\'s name and description', () => {
    expect(parsed.name).toBe('Lab sections');
    expect(parsed.description).toBe('Sections from our lab');
    expect(parsed.datasets).toHaveLength(3);
  });

  it('makes each checkpoint a dataset of one file, named by its label or its file', () => {
    expect(raw.record).toMatchObject({ id: 'raw-lung.sdata.zarr.zip', name: 'lung', description: '', folders: [], status: 'COMPLETED' });
    expect(raw).toMatchObject({ url: 'https://data.example.org/lab/raw/lung.sdata.zarr.zip', file: 'lung.sdata.zarr.zip', size: null });
    expect(clustered.record).toMatchObject({ id: 'lung-clustered', name: 'Lung, clustered', description: 'With Leiden clusters' });
    // A bare date stays that day wherever it is read.
    expect(new Date(clustered.record.createdAt).getDate()).toBe(1);
    expect(remote.url).toBe('https://other.example.org/x.sdata.zarr.zip');
  });

  it('files, tags and sizes a checkpoint as its entry says', () => {
    expect(clustered.record.folders).toEqual(['Xenium/Lung']);
    expect(clustered.record.tags).toEqual([{ key: '', value: 'tumor' }, { key: '', value: 'site: Seattle' }]);
    expect(clustered.size).toBe(1234);
  });

  it('links lineage by id or by path', () => {
    expect(clustered.record.sourceIds).toEqual(['raw-lung.sdata.zarr.zip']);
    expect(remote.record.sourceIds).toEqual(['lung-clustered', 'elsewhere']);
  });

  it('keeps a credit only when it names a source or a license, as the shim does', () => {
    expect(clustered.record.credit).toEqual({ source: 'Xenium Human Lung', license: 'CC BY 4.0' });
    expect(remote.record.credit).toBeUndefined();
  });

  it('makes an id safe for version references, and still links lineage by it as written', () => {
    const { datasets } = parseIndex({
      checkpoints: [{ path: 'a.zip', id: 'GSE1:lung/raw' }, { path: 'b.zip', from: ['GSE1:lung/raw'] }],
    }, INDEX_URL);
    expect(datasets.map((d) => d.record.id)).toEqual(['GSE1-lung-raw', 'b.zip']);
    expect(datasets[1].record.sourceIds).toEqual(['GSE1-lung-raw']);
  });

  it('leaves out an entry the browser could not fetch, rather than the whole folder', () => {
    const { datasets } = parseIndex({
      checkpoints: [{ path: 'http://other.example.org/x.zip' }, { path: 'data:text/plain,x' }, { path: 'http://' }, { path: 'ok.zip' }],
    }, INDEX_URL);
    expect(datasets.map((d) => d.url)).toEqual(['https://data.example.org/lab/ok.zip']);
    expect(parseIndex({ checkpoints: [{ path: 'x.zip' }] }, 'http://localhost:8790/index.json').datasets[0].url).toBe('http://localhost:8790/x.zip');
  });

  it('refuses a file that is not an index, or two checkpoints with one id', () => {
    expect(() => parseIndex({ title: 'x' }, INDEX_URL)).toThrow('no "checkpoints" list');
    expect(() => parseIndex(null, INDEX_URL)).toThrow('no "checkpoints" list');
    expect(() => parseIndex({ checkpoints: [{ path: 'a.zip', id: 'x' }, { path: 'b.zip', id: 'x' }] }, INDEX_URL)).toThrow('two checkpoints as "x"');
  });
});

describe('IndexSource', () => {
  const source = new IndexSource(parseIndex(index, INDEX_URL));

  it('lists each dataset as its one file', async () => {
    expect((await source.datasets()).map((d) => d.id)).toEqual(['raw-lung.sdata.zarr.zip', 'lung-clustered', 'https-other.example.org-x.sdata.zarr.zip']);
    expect(await source.listing('lung-clustered')).toEqual([{ path: 'lung.sdata.zarr.zip', size: 1234 }]);
  });

  it('reads a file from its own address', async () => {
    const { url } = await source.fileUrl('lung-clustered');
    expect(url).toBe('https://data.example.org/lab/analyzed/lung.sdata.zarr.zip');
    await expect(source.fileUrl('nope')).rejects.toThrow('no checkpoint "nope"');
  });
});
