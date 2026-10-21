// Where the app's datasets come from: a Cirro project, or the example collection that
// needs no account. Everything else in the app works through this interface, so both
// behave alike, saving versions included (examples save into this browser).
import type { AsyncReadable } from '@zarrita/storage';
import type { LayerManifest } from '../stack/manifest';
import type { VersionFile } from '../stack/version';
import type { DatasetRecord } from './model';
import type { ScanRecord } from './scan';

export interface NewVersion {
  name: string;
  description: string;
  files: VersionFile[];
  // The datasets the version is made from (its parent's), for Cirro's lineage.
  sourceIds: string[];
  // What the provenance note says about it.
  note: { what: string; parameters: Record<string, unknown> };
}

export interface Collection {
  readonly kind: 'cirro' | 'examples';
  // The project ID, or 'examples'.
  readonly id: string;
  readonly name: string;
  // Where a saved version goes, as the save dialog says it.
  readonly saveTarget: string;
  // Why the catalog of what each dataset holds is kept in this browser rather than with
  // the project; null when it isn't.
  readonly catalogNote: string | null;

  datasets(signal?: AbortSignal): Promise<DatasetRecord[]>;
  /** Whether a dataset could hold anything the app shows, so is worth scanning. */
  worthScanning(dataset: DatasetRecord): boolean;
  /** What a dataset holds. Cached (a Cirro project keeps its catalog in a sheet), so a
   * dataset is listed at most once. */
  scan(dataset: DatasetRecord, signal?: AbortSignal): Promise<ScanRecord>;
  /** A saved version's manifest (`layer.json`). */
  manifest(datasetId: string, path: string): Promise<LayerManifest>;
  /** The dataset a stack refers to by ID, wherever it is visible from here; null if nowhere. */
  resolveDataset(datasetId: string): Promise<DatasetRecord | null>;

  /** A zarrita store over a SpatialData store in a dataset. */
  openStore(datasetId: string, path: string, isFolder: boolean): Promise<Required<AsyncReadable>>;
  /** One file's bytes. */
  readFile(datasetId: string, path: string): Promise<Uint8Array>;
  /** A URL a range-reading library (an OME-TIFF reader) can fetch, and how to renew it. */
  fileUrl(datasetId: string, path: string): Promise<{ url: string; refresh: () => Promise<string> }>;

  /** Write a version as a new dataset; resolves to its ID and any problem with its note. */
  saveVersion(version: NewVersion, onProgress?: (fraction: number) => void): Promise<{ datasetId: string; noteProblem: string | null }>;

  /** The dataset's page in Cirro, when there is one. */
  datasetUrl(datasetId: string): string | null;
  /** Pipelines that take this dataset as input and do `purpose`, each with the page in
   * Cirro that launches it on the dataset (Cirro's own form). */
  pipelines(datasetId: string, purpose: PipelinePurpose): Promise<PipelineLink[]>;
}

// segment: find cells in an image or re-segment a run. encode: turn a run (or a
// segmentation) into a SpatialData store.
export type PipelinePurpose = 'segment' | 'encode';
export interface PipelineLink { id: string; name: string; url: string }
