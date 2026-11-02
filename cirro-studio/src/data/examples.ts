// Public data, open to anyone: the Cirro datasets `publicDatasets.json` lists, read from
// their Cirro publications (static copies in a public bucket, written by cirro-publish)
// with the same calls a project uses. Versions saved on them stay in this browser
// (browserStore.ts) — the same files a Cirro dataset would hold.
import type { Process } from '@cirrobio/api-client';
import { APP_TAG } from '../app/appInfo';
import type { DatasetReader } from '../cirro/datasetReader';
import { parseManifest } from '../stack/manifest';
import { getBrowserDataset, listBrowserDatasets, putBrowserDataset } from './browserStore';
import type { Collection, NewVersion, PipelineLink, UploadType } from './collection';
import { datasetContents } from './discover';
import type { DatasetRecord } from './model';
import publicDatasets from './publicDatasets.json';
import { summarizeVersion, type ScanRecord } from './scan';

// A whole dataset (`cirro::<project>:dataset:<dataset>`) and the publication that holds it
// (Cirro-publish-data-objects, SPEC.md "Dataset URIs").
interface PublicDataset { baseUrl: string; uri: string }
const PUBLIC_DATASETS: PublicDataset[] = publicDatasets;

interface Published { reader: DatasetReader; projectId: string; processes: Promise<Map<string, Process>> }

export const EXAMPLES_ID = 'examples';
const BROWSER_FOLDER = 'Saved in this browser';

export class ExampleCollection implements Collection {
  readonly kind = 'examples' as const;
  readonly id = EXAMPLES_ID;
  readonly name = 'Public data';
  readonly saveTarget = 'this browser (log in to Cirro to save to a project)';
  readonly catalogNote = null;

  private published: Promise<Map<string, Published>> | null = null;
  private readonly scans = new Map<string, Promise<ScanRecord>>();

  // The Cirro client loads only when public data is first read.
  private publishedDatasets(): Promise<Map<string, Published>> {
    this.published ??= (async () => {
      const [{ createPublicationDataSource, parseDatasetUri }, { DatasetReader }] = await Promise.all([
        import('../cirro/cirro-publication'), import('../cirro/datasetReader'),
      ]);
      const sources = new Map<string, Omit<Published, 'projectId'>>();
      const byId = new Map<string, Published>();
      for (const { baseUrl, uri } of PUBLIC_DATASETS) {
        let source = sources.get(baseUrl);
        if (!source) {
          const publication = createPublicationDataSource({ baseUrl });
          const processes = publication.dataService.processes.getProcesses({}).then((list) => new Map(list.map((p) => [p.id, p])));
          source = { reader: new DatasetReader(publication), processes };
          sources.set(baseUrl, source);
        }
        const { projectId, datasetId } = parseDatasetUri(uri);
        byId.set(datasetId, { ...source, projectId });
      }
      return byId;
    })();
    return this.published;
  }

  async datasets(): Promise<DatasetRecord[]> {
    const { datasetRecord } = await import('../cirro/datasetReader');
    const published = await Promise.all([...(await this.publishedDatasets())].map(
      async ([datasetId, { reader, projectId, processes }]) => datasetRecord(await reader.detail(projectId, datasetId), await processes),
    ));
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
    return [...published, ...saved];
  }

  worthScanning(): boolean {
    return true;
  }

  scan(dataset: DatasetRecord): Promise<ScanRecord> {
    let pending = this.scans.get(dataset.id);
    if (!pending) {
      pending = (async () => {
        const published = (await this.publishedDatasets()).get(dataset.id);
        const files = published
          ? (await published.reader.listing(published.projectId, dataset.id)).files
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

  private async publishedDataset(datasetId: string): Promise<Published> {
    const published = (await this.publishedDatasets()).get(datasetId);
    if (!published) throw new Error(`Dataset ${datasetId} is not public data.`);
    return published;
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
    const { reader, projectId } = await this.publishedDataset(datasetId);
    return reader.openStore(projectId, datasetId, path, isFolder);
  }

  async readFile(datasetId: string, path: string): Promise<Uint8Array> {
    const published = (await this.publishedDatasets()).get(datasetId);
    if (published) return published.reader.readFile(published.projectId, datasetId, path);
    const file = (await this.browserDataset(datasetId)).files.find((f) => f.name === path);
    if (!file) throw new Error(`Dataset ${datasetId} has no file ${path}.`);
    return file.bytes;
  }

  async fileUrl(datasetId: string, path: string) {
    const { reader, projectId } = await this.publishedDataset(datasetId);
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
