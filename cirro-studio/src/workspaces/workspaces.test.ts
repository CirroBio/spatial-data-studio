import { describe, expect, it } from 'vitest';
import type { WorkspaceEnvironment } from '@cirrobio/api-client';
import type { Library } from '../app/library';
import type { StoreItem, VersionItem } from '../data/model';
import { datasetRef } from '../stack/cirroRef';
import { DATASETS_VAR, computeFor, mountsFor, workspaceLimit, workspaceName } from './cirro';
import { requestFor } from './request';

describe('mountsFor', () => {
  it('names each folder after its dataset, safe in a path and unique', () => {
    const names: Record<string, string> = { a: 'Xenium lung / section 2', b: 'Xenium lung / section 2', c: '..hidden', d: '???' };
    expect(mountsFor(['a', 'b', 'c', 'd'], (id) => names[id])).toEqual([
      { datasetId: 'a', name: 'Xenium_lung_section_2' },
      { datasetId: 'b', name: 'Xenium_lung_section_2_2' },
      { datasetId: 'c', name: 'hidden' },
      { datasetId: 'd', name: 'd' },
    ]);
  });
});

describe('workspaceName', () => {
  it('names the first item, counts the rest, and keeps to the characters Cirro accepts', () => {
    expect(workspaceName(['Lung: section 2'])).toBe('spatial-data-studio / Lung- section 2');
    expect(workspaceName(['Lung', 'Colon', 'Brain'])).toBe('spatial-data-studio / Lung and 2 more');
    expect(workspaceName(['x'.repeat(300)])).toHaveLength(120);
  });
});

describe('computeFor', () => {
  const env: WorkspaceEnvironment = {
    id: 'cirro-spatial-data-studio', name: 'Cirro/spatial-data-studio', description: '', category: 'Experimental', owner: 'Cirro', versions: [],
    defaultComputeConfig: { containerImageUri: 'studio:v1', cpu: 4, memoryGiB: 16, environmentVariables: { KEEP: '1' } },
  };

  it('scales the default machine and tells the Studio which folder holds which dataset', () => {
    const config = computeFor(env, 2, [{ datasetId: 'a', name: 'Lung' }]);
    expect(config).toMatchObject({ containerImageUri: 'studio:v1', cpu: 8, memoryGiB: 32 });
    expect(config.environmentVariables).toEqual({ KEEP: '1', [DATASETS_VAR]: JSON.stringify({ a: 'Lung' }) });
  });
});

describe('workspaceLimit', () => {
  const apiError = (errorCode: number, message: string) => Object.assign(new Error(message), { errorCode, errors: [] });

  it('reads Cirro\'s per-user limit from its refusal, and nothing else', () => {
    expect(workspaceLimit(apiError(400, 'You have reached your workspace quota for this project (5 out of 5)'))).toEqual({ used: 5, limit: 5 });
    expect(workspaceLimit(apiError(400, 'Invalid compute configuration'))).toBeNull();
    expect(workspaceLimit(apiError(403, 'workspace quota (5 out of 5)'))).toBeNull();
    expect(workspaceLimit(new Error('workspace quota (5 out of 5)'))).toBeNull();
  });
});

describe('requestFor', () => {
  const base: StoreItem = { kind: 'store', key: 'base/lung.zarr', datasetId: 'base', path: 'lung.zarr', label: 'lung', size: 1, isFolder: true, checkpoint: false };
  const version = (id: string, parent: string): VersionItem => ({
    kind: 'version', key: `${id}/`, datasetId: id, path: '', label: id, size: 1, parent, base: datasetRef('base', 'lung.zarr'),
    depth: 1, title: id, message: '', createdAt: '', createdBy: '', changes: [],
  });
  const v1 = version('v1', datasetRef('base', 'lung.zarr'));
  const v2 = version('v2', datasetRef('v1', ''));
  const library: Library = {
    images: [], runs: [], figures: [], links: [], itemByKey: new Map(),
    spatial: [{ key: base.key, baseRef: datasetRef('base', 'lung.zarr'), base, label: 'Lung', versions: [v1, v2], head: v2, size: 3 }],
  };

  it('brings the store and every version beneath a saved version', () => {
    expect(requestFor(v2, 'Lung', library, true)).toEqual({ key: 'v2/', label: 'Lung', datasetIds: ['base', 'v1', 'v2'], unsaved: true });
    expect(requestFor(base, 'Lung', library).datasetIds).toEqual(['base']);
  });
});
