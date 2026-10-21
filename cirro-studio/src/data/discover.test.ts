import { describe, expect, it } from 'vitest';
import { datasetContents, findRuns, findStores, storeLabel } from './discover';
import { itemsOf, foldersOf, type DatasetRecord } from './model';
import { rowsOf, scansOf, type ScanRecord } from './scan';

const files = (...paths: string[]) => paths.map((path) => ({ path, size: 10 }));

describe('findRuns', () => {
  it('finds each Xenium output folder and its metrics file', () => {
    const runs = findRuns(files(
      'run1/output-XETG_Region_1/experiment.xenium',
      'run1/output-XETG_Region_1/cell_feature_matrix.h5',
      'run1/output-XETG_Region_1/metrics_summary.csv',
      'run1/output-XETG_Region_2/experiment.xenium',
      'run1/output-XETG_Region_2/cell_feature_matrix/barcodes.tsv.gz',
      'run1/README.txt',
    ));
    expect(runs.map((r) => [r.name, r.type.id, r.metricsPath])).toEqual([
      ['output-XETG_Region_1', 'xenium', 'run1/output-XETG_Region_1/metrics_summary.csv'],
      ['output-XETG_Region_2', 'xenium', null],
    ]);
  });

  it('prefers the more specific type and does not descend into a classified folder', () => {
    // Visium HD carries a Visium-shaped matrix inside binned_outputs; it must read as HD.
    const runs = findRuns(files(
      'hd/binned_outputs/square_008um/spatial/scalefactors_json.json',
      'hd/binned_outputs/square_008um/filtered_feature_bc_matrix.h5',
      'hd/binned_outputs/square_008um/spatial/tissue_positions.parquet',
      'hd/feature_slice.h5',
    ));
    expect(runs.map((r) => [r.path, r.type.id])).toEqual([['hd', 'visium_hd']]);
  });

  it('recognises a dataset that is one run, at its top level', () => {
    const runs = findRuns(files('spatial/scalefactors_json.json', 'spatial/tissue_positions_list.csv', 'filtered_feature_bc_matrix.h5'));
    expect(runs.map((r) => [r.path, r.type.id])).toEqual([['', 'visium']]);
  });

  it('treats glob characters literally except * and ?', () => {
    expect(findRuns(files('x/experimentXxenium', 'x/cell_feature_matrix.h5'))).toEqual([]);
  });
});

describe('findStores', () => {
  it('lists checkpoints and SpatialData zips but not Xenium archives', () => {
    const stores = findStores(files(
      'results/Pancreas/results-07b1a290f7f2.sdata.zarr.zip',
      'sopa/sample.zarr.zip',
      'raw/cells.zarr.zip',
      'raw/transcripts.zarr.zip',
    ));
    expect(stores.map((s) => [s.path, s.kind])).toEqual([
      ['results/Pancreas/results-07b1a290f7f2.sdata.zarr.zip', 'checkpoint'],
      ['sopa/sample.zarr.zip', 'spatialdata'],
    ]);
  });

  it('finds the outermost zarr folder with cells or an image, and skips other zarr', () => {
    const stores = findStores(files(
      'out.zarr/zarr.json',
      'out.zarr/tables/table/zarr.json',
      'out.zarr/tables/table/obsm/spatial/zarr.json',
      'image-only.zarr/zarr.json',
      'image-only.zarr/images/he/zarr.json',
      'ome.zarr/zarr.json',
      'ome.zarr/0/zarr.json',
    ));
    expect(stores.map((s) => [s.path, s.kind, s.isFolder])).toEqual([
      ['image-only.zarr', 'spatialdata', true],
      ['out.zarr', 'spatialdata', true],
    ]);
  });

  it('labels a store by its folder and name without the content hash', () => {
    expect(storeLabel('results/Pancreas/results-07b1a290f7f2.sdata.zarr.zip')).toBe('Pancreas · results');
    expect(storeLabel('sample.zarr')).toBe('sample');
  });
});

describe('datasetContents', () => {
  it('keeps a run\'s images with the run, lists loose images, and recognizes a version', () => {
    const run = datasetContents(files('experiment.xenium', 'cell_feature_matrix.h5', 'morphology.ome.tif', 'extra/slide.svs'));
    expect(run.runs).toHaveLength(1);
    expect(run.images).toEqual([]);
    const images = datasetContents(files('a/slide.ome.tif', 'b/scan.svs'));
    expect(images.images.map((i) => [i.path, i.viewable])).toEqual([['a/slide.ome.tif', true], ['b/scan.svs', false]]);
    const version = datasetContents(files('layer.json', 'overlay/zarr.json'));
    expect(version.version).toBe('layer.json');
    expect(version.stores).toEqual([]);
  });
});

describe('the catalog', () => {
  const dataset: DatasetRecord = {
    id: 'd1', name: 'Run 1', description: '', processId: 'xenium', processName: 'Xenium', status: 'COMPLETED',
    createdAt: '2026-10-01T00:00:00Z', createdBy: 'me', tags: [], folders: [], sourceIds: [], share: null,
  };

  it('reads back from its sheet rows what scanning found', () => {
    const scan: ScanRecord = {
      datasetId: 'd1',
      contents: datasetContents(files('r/experiment.xenium', 'r/cell_feature_matrix.h5', 'out.zarr/zarr.json', 'out.zarr/images/he/zarr.json', 'x.ome.tif')),
      version: null,
      scannedAt: '2026-10-02T00:00:00Z',
    };
    const back = scansOf(rowsOf(scan)).get('d1')!;
    expect(itemsOf(dataset, back)).toEqual(itemsOf(dataset, scan));
    expect(back.contents.totalSize).toBe(scan.contents.totalSize);
  });

  it('counts a dataset whose own row is missing as not scanned', () => {
    const rows = rowsOf({ datasetId: 'd1', contents: datasetContents(files('a.ome.tif')), version: null, scannedAt: '' });
    expect(scansOf(rows.filter((r) => r.kind !== 'dataset')).has('d1')).toBe(false);
  });

  it('reads Cirro folders from folder tags, dropping empty segments', () => {
    expect(foldersOf([{ key: 'Folder', value: 'folder:///RNAseq//Benchmarks/' }, { key: 'x', value: 'y' }])).toEqual(['RNAseq/Benchmarks']);
  });
});
