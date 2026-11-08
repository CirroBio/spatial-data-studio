import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Executor, type Process } from '@cirrobio/api-client';
import type { NewVersion } from '../data/collection';
import { CirroCollection } from './cirroCollection';
import type { CirroSession } from './session';

// This browser's saved versions, in memory: the tests have no IndexedDB.
const savedInBrowser: { projectId: string; name: string }[] = [];
vi.mock('../data/browserStore', () => ({
  listBrowserDatasets: async () => [],
  saveInBrowser: async (projectId: string, v: { name: string }) => {
    savedInBrowser.push({ projectId, name: v.name });
    return `saved-${savedInBrowser.length}`;
  },
  browserRecord: () => null,
  browserFile: async () => new Uint8Array(),
  browserListing: async () => [],
}));
beforeEach(() => {
  savedInBrowser.length = 0;
});

const PROJECT = 'project-1';

// Named after processes in a real Cirro, where the IDs differ between tenants.
function process(id: string, name: string, more: Partial<Process> = {}): Process {
  return {
    id, name, description: `${name}.`, dataType: '', executor: Executor.Nextflow, childProcessIds: [], parentProcessIds: [],
    linkedProjectIds: [], isTenantWide: true, allowMultipleSources: false, usesSampleSheet: false, requiresInternet: false,
    executionModes: [], isArchived: false, tags: [], ...more,
  };
}

const PROCESSES = [
  process('process-convert-vsi-1-0', 'Convert Image to OME-TIFF'),
  process('process-hutch-spaceranger-count-1-0', 'Analyze Visium Spatial Transcriptomics'),
  process('process-hutch-spaceranger-mkref-1-0', 'Build SpaceRanger Reference'),
  process('xeniumranger-resegment-1-0', 'Resegment Cells (Xenium Ranger)'),
  process('proseg-resegment-1-0', 'Resegment Cells (Proseg)'),
  process('process-cirro-spatial-data-studio-1-0', 'Analyze Spatial Data (Spatial Data Studio)'),
  process('process-nf-core-sopa-1-0-1', 'Spatial Omics Analysis (nf-core/sopa)'),
  process('process-cirro-cellpose-1_0', 'Segment Cells (Cellpose)', { isArchived: true }),
  process('their-stardist', 'Segment Cells (StarDist)', { isTenantWide: false, linkedProjectIds: ['another-project'] }),
  process('our-stardist', 'Segment Cells (StarDist)', { isTenantWide: false, linkedProjectIds: [PROJECT] }),
  process('xenium', 'Spatial Transcriptomics (Xenium)', { executor: Executor.Ingest, fileRequirementsMessage: 'An experiment.xenium file.' }),
  process('cosmx', 'CosMx Single-Cell Imaging', { executor: Executor.Ingest }),
  process('codex_raw', 'CODEX Images (raw)', { executor: Executor.Ingest }),
  process('images', 'Images', { executor: Executor.Ingest }),
  process('custom_dataset', 'Files', { executor: Executor.Ingest }),
  process('paired_dnaseq', 'Paired DNAseq (FASTQ)', { executor: Executor.Ingest }),
];

const session = {
  tenant: { id: 'dev', name: 'Cirro (dev)', url: 'https://dev.cirro.bio' },
  data: { processes: { getProcesses: async () => PROCESSES } },
} as unknown as CirroSession;

const collection = () => new CirroCollection(session, PROJECT, 'Project', 'write');

describe('CirroCollection, adding data', () => {
  it('lists the pipelines that make each stage, launched from the project', async () => {
    const names = async (stage: 'images' | 'runs' | 'spatial') => (await collection().pipelines(null, stage)).map((p) => p.id);
    expect(await names('images')).toEqual(['process-convert-vsi-1-0']);
    // A reference builder matches by name but makes no data.
    expect(await names('runs')).toEqual(['process-hutch-spaceranger-count-1-0', 'xeniumranger-resegment-1-0']);
    // The archived pipeline and the one linked to another project are left out.
    expect(await names('spatial')).toEqual([
      'process-cirro-spatial-data-studio-1-0', 'proseg-resegment-1-0', 'our-stardist', 'process-nf-core-sopa-1-0-1',
    ]);
    const [convert] = await collection().pipelines(null, 'images');
    expect(convert).toEqual({
      id: 'process-convert-vsi-1-0', name: 'Convert Image to OME-TIFF', description: 'Convert Image to OME-TIFF.',
      url: 'https://dev.cirro.bio/project/project-1/pipeline/process-convert-vsi-1-0',
    });
  });

  it('offers each stage its own data types first, then Files', async () => {
    expect(await collection().uploadTypes('runs')).toEqual([
      { id: 'cosmx', name: 'CosMx Single-Cell Imaging', requirements: null },
      { id: 'xenium', name: 'Spatial Transcriptomics (Xenium)', requirements: 'An experiment.xenium file.' },
      { id: 'custom_dataset', name: 'Files', requirements: null },
    ]);
    // The general type comes before the specific ones.
    expect((await collection().uploadTypes('images')).map((t) => t.id)).toEqual(['images', 'codex_raw', 'custom_dataset']);
    expect((await collection().uploadTypes('spatial')).map((t) => t.id)).toEqual(['custom_dataset']);
  });
});

describe('CirroCollection, a project the user can only read', () => {
  const version: NewVersion = { name: 'v', description: '', files: [], sourceIds: [], note: { what: '', parameters: {} } };
  const refusing = (upload: () => Promise<never>) => new CirroCollection({
    ...session, data: { ...session.data, datasets: { uploadDataset: upload } },
  } as unknown as CirroSession, PROJECT, 'Project', 'write');

  it('saves versions in this browser', async () => {
    const readOnly = new CirroCollection(session, PROJECT, 'Project', 'read');
    expect(readOnly.saveTarget).toBe('this browser');
    expect(await readOnly.saveVersion(version)).toEqual({ datasetId: 'saved-1', notice: null });
    expect(savedInBrowser).toEqual([{ projectId: PROJECT, name: 'v' }]);
  });

  it('learns it from a refused save, and saves in this browser instead', async () => {
    const c = refusing(async () => {
      throw Object.assign(new Error('Not allowed to CREATE_DATASET on project project-1'), { errorCode: 403, errors: [] });
    });
    const { notice } = await c.saveVersion(version);
    expect(notice).toMatch(/saved in this browser/);
    expect(c.access).toBe('read');
    expect(c.saveTarget).toBe('this browser');
  });

  it('passes on any other failure', async () => {
    const c = refusing(async () => {
      throw Object.assign(new Error('Service unavailable'), { errorCode: 503, errors: [] });
    });
    await expect(c.saveVersion(version)).rejects.toThrow('Service unavailable');
    expect(c.access).toBe('write');
  });
});
