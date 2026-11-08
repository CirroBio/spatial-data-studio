// A public project: a project anyone can read, either a Cirro publication (static copies
// of Cirro datasets, written by cirro-publish, read with the same calls a Cirro project
// uses) or a folder of checkpoints listed by its index.json (indexFolder.ts). Everything
// in it is listed. Versions saved on it stay in this browser (browserStore.ts), filed
// under the project they were made in: the same files a Cirro dataset would hold.
import type { AsyncReadable } from '@zarrita/storage';
import { parseManifest } from '../stack/manifest';
import { browserFile, browserListing, browserRecord, listBrowserDatasets, saveInBrowser, type BrowserDataset } from './browserStore';
import type { Collection, NewVersion, PipelineLink, UploadType } from './collection';
import { datasetContents, type ListedFile } from './discover';
import type { DatasetRecord } from './model';
import { DEFAULT_PUBLIC_PROJECT, type PublicProjectInfo } from './publicProjects';
import { summarizeVersion, type ScanRecord } from './scan';

/** Where a public project's own datasets are read from. */
export interface PublicSource {
  datasets(): Promise<DatasetRecord[]>;
  listing(datasetId: string): Promise<ListedFile[]>;
  openStore(datasetId: string, path: string, isFolder: boolean): Promise<Required<AsyncReadable>>;
  readFile(datasetId: string, path: string): Promise<Uint8Array>;
  fileUrl(datasetId: string, path: string): Promise<{ url: string; refresh: () => Promise<string> }>;
}

interface Publication { source: PublicSource; datasets: DatasetRecord[] }

async function openSource(info: PublicProjectInfo): Promise<PublicSource> {
  if (info.kind === 'index') {
    const { IndexSource, readIndex } = await import('./indexFolder');
    return new IndexSource(await readIndex(info.url));
  }
  const [{ createPublicationDataSource }, { DatasetReader }] = await Promise.all([
    import('../cirro/cirro-publication'), import('../cirro/datasetReader'),
  ]);
  const data = createPublicationDataSource({ baseUrl: info.url });
  const reader = new DatasetReader(data);
  const processes = new Map((await data.dataService.processes.getProcesses({})).map((p) => [p.id, p]));
  return {
    datasets: () => reader.list(info.id, processes),
    listing: async (datasetId) => (await reader.listing(info.id, datasetId)).files,
    openStore: (datasetId, path, isFolder) => reader.openStore(info.id, datasetId, path, isFolder),
    readFile: (datasetId, path) => reader.readFile(info.id, datasetId, path),
    fileUrl: (datasetId, path) => reader.fileUrl(info.id, datasetId, path),
  };
}

export class PublicProject implements Collection {
  readonly kind = 'public' as const;
  readonly access = 'read' as const;
  readonly id: string;
  readonly name: string;
  readonly saveTarget = 'this browser';
  readonly catalogNote = null;

  private loading: Promise<Publication> | null = null;
  private readonly scans = new Map<string, Promise<ScanRecord>>();

  constructor(private readonly info: PublicProjectInfo) {
    this.id = info.id;
    this.name = info.name;
  }

  // The code that reads the project loads only when it is first read.
  private publication(): Promise<Publication> {
    this.loading ??= (async () => {
      const source = await openSource(this.info);
      return { source, datasets: await source.datasets() };
    })();
    this.loading.catch(() => (this.loading = null));
    return this.loading;
  }

  /** The publication, when it holds this dataset; null for a version saved in this browser. */
  private async holding(datasetId: string): Promise<Publication | null> {
    const publication = await this.publication();
    return publication.datasets.some((d) => d.id === datasetId) ? publication : null;
  }

  // Versions saved before public projects were filed by project belong to this app's own.
  private savedHere = (d: BrowserDataset) => (d.projectId ?? (this.info.url === DEFAULT_PUBLIC_PROJECT ? this.id : null)) === this.id;

  async datasets(): Promise<DatasetRecord[]> {
    const { datasets } = await this.publication();
    const saved = (await listBrowserDatasets()).filter(this.savedHere).map(browserRecord);
    return [...datasets, ...saved];
  }

  worthScanning(): boolean {
    return true;
  }

  scan(dataset: DatasetRecord): Promise<ScanRecord> {
    let pending = this.scans.get(dataset.id);
    if (!pending) {
      pending = (async () => {
        const publication = await this.holding(dataset.id);
        const files = publication ? await publication.source.listing(dataset.id) : await browserListing(dataset.id);
        const contents = datasetContents(files);
        const version = contents.version ? summarizeVersion(await this.manifest(dataset.id, contents.version)) : null;
        return { datasetId: dataset.id, contents, version, scannedAt: new Date().toISOString() };
      })();
      this.scans.set(dataset.id, pending);
      pending.catch(() => this.scans.delete(dataset.id));
    }
    return pending;
  }

  private async holdingOrThrow(datasetId: string): Promise<Publication> {
    const publication = await this.holding(datasetId);
    if (!publication) throw new Error(`Dataset ${datasetId} is not in ${this.name}.`);
    return publication;
  }

  async manifest(datasetId: string, path: string) {
    return parseManifest(await this.readFile(datasetId, path));
  }

  async resolveDataset(datasetId: string): Promise<DatasetRecord | null> {
    return (await this.datasets()).find((d) => d.id === datasetId) ?? null;
  }

  async openStore(datasetId: string, path: string, isFolder: boolean) {
    const { source } = await this.holdingOrThrow(datasetId);
    return source.openStore(datasetId, path, isFolder);
  }

  async readFile(datasetId: string, path: string): Promise<Uint8Array> {
    const publication = await this.holding(datasetId);
    return publication ? publication.source.readFile(datasetId, path) : browserFile(datasetId, path);
  }

  async fileUrl(datasetId: string, path: string) {
    const { source } = await this.holdingOrThrow(datasetId);
    return source.fileUrl(datasetId, path);
  }

  async saveVersion(version: NewVersion): Promise<{ datasetId: string; notice: string | null }> {
    return { datasetId: await saveInBrowser(this.id, version), notice: null };
  }

  datasetUrl(): string | null {
    return null;
  }

  async pipelines(): Promise<PipelineLink[]> {
    return [];
  }

  async uploadTypes(): Promise<UploadType[]> {
    return [];
  }
}
