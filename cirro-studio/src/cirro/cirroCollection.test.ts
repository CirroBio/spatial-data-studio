import { describe, expect, it } from 'vitest';
import { Executor, type Process } from '@cirrobio/api-client';
import { CirroCollection } from './cirroCollection';
import type { CirroSession } from './session';

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

const collection = () => new CirroCollection(session, PROJECT, 'Project');

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
