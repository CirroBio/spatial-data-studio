// Public data, open to anyone: everything in Spatial Data Studio's own Cirro publication, a
// project of static copies of Cirro datasets in the public bucket, written by cirro-publish.
// Publishing a dataset is what makes it public data. It is read with the same calls a Cirro
// project uses. Versions saved on it stay in this browser (browserStore.ts) — the same files
// a Cirro dataset would hold.
import { APP_TAG } from '../app/appInfo';
import type { DatasetReader } from '../cirro/datasetReader';
import { parseManifest } from '../stack/manifest';
import { getBrowserDataset, listBrowserDatasets, putBrowserDataset } from './browserStore';
import type { Collection, NewVersion, PipelineLink, UploadType } from './collection';
import { datasetContents } from './discover';
import type { DatasetRecord } from './model';
import { summarizeVersion, type ScanRecord } from './scan';

// The publication's root (Cirro-publish-data-objects, SPEC.md "Publication layout").
const PUBLICATION_URL = 'https://cirro-public-resources-20250818192017584600000001.s3.us-west-2.amazonaws.com/published/spatial-data-studio';

interface Publication { reader: DatasetReader; projectId: string; datasets: DatasetRecord[] }

export const EXAMPLES_ID = 'examples';
const BROWSER_FOLDER = 'Saved in this browser';

export class ExampleCollection implements Collection {
  readonly kind = 'examples' as const;
  readonly id = EXAMPLES_ID;
  readonly name = 'Public data';
  readonly saveTarget = 'this browser (log in to Cirro to save to a project)';
  readonly catalogNote = null;

  private loading: Promise<Publication> | null = null;
  private readonly scans = new Map<string, Promise<ScanRecord>>();

  // The Cirro client loads only when public data is first read.
  private publication(): Promise<Publication> {
    this.loading ??= (async () => {
      const [{ createPublicationDataSource }, { DatasetReader }] = await Promise.all([
        import('../cirro/cirro-publication'), import('../cirro/datasetReader'),
      ]);
      const source = createPublicationDataSource({ baseUrl: PUBLICATION_URL });
      const reader = new DatasetReader(source);
      // A publication is one project.
      const [[project], processes] = await Promise.all([
        source.dataService.projects.getProjects(), source.dataService.processes.getProcesses({}),
      ]);
      const datasets = await reader.list(project.id, new Map(processes.map((p) => [p.id, p])));
      return { reader, projectId: project.id, datasets };
    })();
    this.loading.catch(() => (this.loading = null));
    return this.loading;
  }

  /** The publication, when it holds this dataset; null for a version saved in this browser. */
  private async holding(datasetId: string): Promise<Publication | null> {
    const publication = await this.publication();
    return publication.datasets.some((d) => d.id === datasetId) ? publication : null;
  }

  async datasets(): Promise<DatasetRecord[]> {
    const { datasets } = await this.publication();
    const saved = (await listBrowserDatasets()).map((d): DatasetRecord => ({
      id: d.id,
      name: d.name,
      description: d.description,
      processId: 'browser-version',
      processName: 'Version saved in this browser',
      status: 'COMPLETED',
      createdAt: d.createdAt,
      createdBy: 'you',
      tags: [{ key: '', ...APP_TAG }],
      folders: [BROWSER_FOLDER],
      sourceIds: d.sourceIds,
      share: null,
    }));
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
        const files = publication
          ? (await publication.reader.listing(publication.projectId, dataset.id)).files
          : (await this.browserDataset(dataset.id)).files.map((f) => ({ path: f.name, size: f.bytes.length }));
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
    if (!publication) throw new Error(`Dataset ${datasetId} is not public data.`);
    return publication;
  }

  private async browserDataset(datasetId: string) {
    const saved = await getBrowserDataset(datasetId);
    if (!saved) throw new Error(`Dataset ${datasetId} is not in this browser.`);
    return saved;
  }

  async manifest(datasetId: string, path: string) {
    return parseManifest(await this.readFile(datasetId, path));
  }

  async resolveDataset(datasetId: string): Promise<DatasetRecord | null> {
    return (await this.datasets()).find((d) => d.id === datasetId) ?? null;
  }

  async openStore(datasetId: string, path: string, isFolder: boolean) {
    const { reader, projectId } = await this.holdingOrThrow(datasetId);
    return reader.openStore(projectId, datasetId, path, isFolder);
  }

  async readFile(datasetId: string, path: string): Promise<Uint8Array> {
    const publication = await this.holding(datasetId);
    if (publication) return publication.reader.readFile(publication.projectId, datasetId, path);
    const file = (await this.browserDataset(datasetId)).files.find((f) => f.name === path);
    if (!file) throw new Error(`Dataset ${datasetId} has no file ${path}.`);
    return file.bytes;
  }

  async fileUrl(datasetId: string, path: string) {
    const { reader, projectId } = await this.holdingOrThrow(datasetId);
    return reader.fileUrl(projectId, datasetId, path);
  }

  async saveVersion(version: NewVersion): Promise<{ datasetId: string; noteProblem: string | null }> {
    const datasetId = crypto.randomUUID();
    await putBrowserDataset({
      id: datasetId, name: version.name, description: version.description,
      createdAt: new Date().toISOString(), sourceIds: version.sourceIds, files: version.files,
    });
    return { datasetId, noteProblem: null };
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
