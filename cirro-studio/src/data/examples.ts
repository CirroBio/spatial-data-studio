// The example collection, open to anyone: the stores `examples/index.json` lists. That is
// this app's own folder (cirro-studio/examples, served as `examples/`), whose index also
// names the docs site's demo stores where they are published beside the app
// (`../viewer/…`, from docs-site/viewer-data). Versions saved on them stay in this
// browser (browserStore.ts) — the same files a Cirro dataset would hold.
import { openZarrStore } from '@cirrobio/spatial-viewer';
import { APP_TAG } from '../app/appInfo';
import { parseManifest } from '../stack/manifest';
import { getBrowserDataset, listBrowserDatasets, putBrowserDataset } from './browserStore';
import type { Collection, NewVersion, PipelineLink } from './collection';
import { datasetContents, storeName } from './discover';
import type { DatasetRecord } from './model';
import { summarizeVersion, type ScanRecord } from './scan';

interface ExampleIndex {
  title?: string;
  checkpoints: { path: string; label?: string; description?: string }[];
}

export const EXAMPLES_ID = 'examples';
const EXAMPLE_PREFIX = 'example-';
const EXAMPLE_FOLDER = 'Examples';
const BROWSER_FOLDER = 'Saved in this browser';

const examplesUrl = (path: string) => new URL(`examples/${path}`, document.baseURI).toString();

// The total size of a static file, from the Content-Range of a one-byte read: what
// the zip reader asks for first anyway, and what both Pages and the dev server answer.
async function sizeOf(url: string): Promise<number> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}.`);
  await res.arrayBuffer();
  return Number(res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length') ?? 0);
}

export class ExampleCollection implements Collection {
  readonly kind = 'examples' as const;
  readonly id = EXAMPLES_ID;
  readonly name = 'Public data';
  readonly saveTarget = 'this browser (log in to Cirro to save to a project)';
  readonly catalogNote = null;

  private index: Promise<ExampleIndex> | null = null;
  private readonly scans = new Map<string, Promise<ScanRecord>>();

  private examples(): Promise<ExampleIndex> {
    this.index ??= fetch(examplesUrl('index.json')).then(async (res) => {
      if (!res.ok) throw new Error(`The example index answered HTTP ${res.status}.`);
      return (await res.json()) as ExampleIndex;
    });
    return this.index;
  }

  async datasets(): Promise<DatasetRecord[]> {
    const index = await this.examples();
    const examples = index.checkpoints.map((c): DatasetRecord => ({
      id: `${EXAMPLE_PREFIX}${storeName(c.path)}`,
      name: c.label ?? storeName(c.path),
      description: c.description ?? '',
      processId: 'example',
      processName: 'Example store (Spatial Data Studio)',
      status: 'COMPLETED',
      createdAt: '',
      createdBy: '',
      tags: [],
      folders: [EXAMPLE_FOLDER],
      sourceIds: [],
      share: null,
    }));
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
    return [...examples, ...saved];
  }

  worthScanning(): boolean {
    return true;
  }

  scan(dataset: DatasetRecord): Promise<ScanRecord> {
    let pending = this.scans.get(dataset.id);
    if (!pending) {
      pending = (async () => {
        const example = await this.examplePath(dataset.id);
        const contents = example
          ? datasetContents([{ path: example, size: await sizeOf(examplesUrl(example)) }])
          : datasetContents((await this.browserDataset(dataset.id)).files.map((f) => ({ path: f.name, size: f.bytes.length })));
        const version = contents.version ? summarizeVersion(await this.manifest(dataset.id, contents.version)) : null;
        return { datasetId: dataset.id, contents, version, scannedAt: new Date().toISOString() };
      })();
      this.scans.set(dataset.id, pending);
      pending.catch(() => this.scans.delete(dataset.id));
    }
    return pending;
  }

  private async examplePath(datasetId: string): Promise<string | null> {
    if (!datasetId.startsWith(EXAMPLE_PREFIX)) return null;
    const index = await this.examples();
    return index.checkpoints.find((c) => `${EXAMPLE_PREFIX}${storeName(c.path)}` === datasetId)?.path ?? null;
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
    if (isFolder || !(await this.examplePath(datasetId))) throw new Error(`No example store at ${datasetId}/${path}.`);
    return openZarrStore(examplesUrl(path));
  }

  async readFile(datasetId: string, path: string): Promise<Uint8Array> {
    if (await this.examplePath(datasetId)) {
      const res = await fetch(examplesUrl(path));
      if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}.`);
      return new Uint8Array(await res.arrayBuffer());
    }
    const file = (await this.browserDataset(datasetId)).files.find((f) => f.name === path);
    if (!file) throw new Error(`Dataset ${datasetId} has no file ${path}.`);
    return file.bytes;
  }

  async fileUrl(_datasetId: string, path: string) {
    const url = examplesUrl(path);
    return { url, refresh: async () => url };
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
}
