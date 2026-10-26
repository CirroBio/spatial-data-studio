// A Cirro project as the app's collection: its datasets, what each holds (from the
// project's catalog, listing files only for datasets nobody has scanned), signed reads of
// their files, and new versions uploaded as datasets of their own.
import { EntityType, ProjectAccessType, type Dataset, type DatasetDetail, type Process } from '@cirrobio/api-client';
import { ProjectFileAccessContext, uploadFile } from '@cirrobio/sdk';
import { openZarrStore, type FolderAccess } from '@cirrobio/spatial-viewer';
import { APP_TAG } from '../app/appInfo';
import type { Collection, NewVersion, PipelineLink, PipelinePurpose, UploadStage, UploadType } from '../data/collection';
import { datasetContents, type ListedFile } from '../data/discover';
import { FOLDER_PREFIX, foldersOf, type DatasetRecord } from '../data/model';
import { summarizeVersion, type ScanRecord } from '../data/scan';
import { mapLimit } from '../lib/async';
import { parseManifest } from '../stack/manifest';
import { browserFallback, openCatalog, type CatalogCache } from './catalogSheet';
import { addProvenanceNote, withAppTag } from './provenance';
import { refusedPermission, retryRateLimited, type CirroSession } from './session';

const FILES_PROCESS = 'custom_dataset';
// A store stays open for as long as someone looks at it; its reader re-signs on expiry.
const STORE_URL_MINUTES = 60;
const DATA_DIR = 'data/';
const COMPLETION_WAIT_MS = 60_000;

// Pipelines by what they do, read from their ID and name (IDs differ between tenants).
const PURPOSE: Record<PipelinePurpose, RegExp> = {
  segment: /segment|cellpose|stardist|sopa|proseg|baysor|mcmicro/i,
  encode: /spatial data studio|encode spatial|sopa|space ?ranger/i,
  images: /ome-?tiff|convert image/i,
  runs: /space ?ranger|xenium ?ranger|mcmicro/i,
  spatial: /spatial data studio|encode spatial|sopa|proseg|baysor|cellpose|stardist/i,
};
// Pipelines whose names match a purpose but which build a reference rather than process data.
const REFERENCE_BUILDER = /reference|mkref/i;
// The data types each stage's data is uploaded as, read the same way. Anything can also be
// uploaded as plain files, which is how spatial data is uploaded.
const UPLOAD: Record<Exclude<UploadStage, 'spatial'>, RegExp> = {
  images: /image|ome-?tiff|codex|qptiff/i,
  runs: /xenium|visium|space ?ranger|cosmx|merscope|curio|steinbock|mcmicro/i,
};

// Which datasets could hold anything the app shows, judged by the process that made them
// (IDs differ between tenants, so the rule reads the ID and the name). Raw instrument
// output is often uploaded as plain files, so those are scanned too.
const SPATIAL_PROCESS = /spatial|xenium|visium|cosmx|merscope|sopa|proseg|space ?ranger|segment|cellpose|stardist|mcmicro|codex|ome-?tiff|image|qupath|artist|custom_dataset|\bfiles\b/i;

/** Whether a dataset is worth scanning: made by a spatial or imaging process, or by this
 * app; not another app's saved figure or table, and finished. */
function worthScanning(d: Pick<DatasetRecord, 'processId' | 'processName' | 'tags' | 'status'>): boolean {
  if (d.status !== 'COMPLETED') return false;
  // By value: the app once wrote it as { key: 'cirro-app', value: APP_ID }, which this finds too.
  const ours = d.tags.some((t) => t.value === APP_TAG.value);
  const othersAsset = d.tags.some((t) => t.key === 'asset') && !ours;
  return !othersAsset && (ours || SPATIAL_PROCESS.test(`${d.processId} ${d.processName}`));
}

function record(d: Dataset | DatasetDetail, processes: Map<string, Process>): DatasetRecord {
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? '',
    processId: d.processId,
    processName: processes.get(d.processId)?.name ?? d.processId,
    status: d.status,
    createdAt: new Date(d.createdAt).toISOString(),
    createdBy: d.createdBy,
    tags: d.tags.map((t) => ({ key: t.key ?? '', value: t.value })),
    folders: foldersOf(d.tags),
    sourceIds: d.sourceDatasetIds,
    share: 'share' in d ? d.share?.name ?? null : null,
  };
}

export class CirroCollection implements Collection {
  readonly kind = 'cirro' as const;
  readonly saveTarget: string;

  private processes: Promise<Map<string, Process>> | null = null;
  // Cirro refused the process list: its empty map says nothing about which processes exist.
  private processesRefused = false;
  private listed: Promise<DatasetRecord[]> | null = null;
  private catalog: Promise<CatalogCache> | null = null;
  private cached: Promise<Map<string, ScanRecord>> | null = null;
  // Datasets referenced from other projects, by ID: the project they were found in.
  private readonly elsewhere = new Map<string, string>();
  private readonly details = new Map<string, Promise<DatasetDetail>>();
  private readonly listings = new Map<string, Promise<{ domain: string; files: ListedFile[] }>>();
  private readonly scans = new Map<string, Promise<ScanRecord>>();
  // Scans found this visit, written to the catalog together.
  private unsaved: ScanRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private catalogWhere: CatalogCache['where'] | null = null;

  constructor(private readonly cirro: CirroSession, readonly id: string, readonly name: string) {
    this.saveTarget = `a new dataset in ${name}`;
  }

  get catalogNote(): string | null {
    return this.catalogWhere?.kind === 'browser' ? this.catalogWhere.reason : null;
  }

  worthScanning(d: DatasetRecord): boolean {
    return worthScanning(d);
  }

  private processMap(): Promise<Map<string, Process>> {
    // Pipelines only name datasets and link to what runs next, and VIEW_PROCESS may be
    // granted globally rather than on the project: refused, datasets keep their process ids.
    this.processes ??= this.cirro.data.processes.getProcesses({}).then(
      (list) => new Map(list.map((p) => [p.id, p])),
      (e: unknown) => {
        if (!refusedPermission(e)) throw e;
        this.processesRefused = true;
        return new Map<string, Process>();
      },
    );
    return this.processes;
  }

  datasets(): Promise<DatasetRecord[]> {
    this.listed ??= (async () => {
      const processes = await this.processMap();
      const all: DatasetRecord[] = [];
      let nextToken: string | undefined;
      do {
        const page = await this.cirro.data.datasets.getDatasets({ projectId: this.id, limit: 1000, nextToken });
        all.push(...page.data.map((d) => record(d, processes)));
        nextToken = page.nextToken || undefined;
      } while (nextToken);
      return all;
    })();
    this.listed.catch(() => (this.listed = null));
    return this.listed;
  }

  /** Forget the dataset list, so the next call lists again (after a save). */
  refresh(): void {
    this.listed = null;
  }

  private projectOf(datasetId: string): string {
    return this.elsewhere.get(datasetId) ?? this.id;
  }

  private detail(datasetId: string): Promise<DatasetDetail> {
    let pending = this.details.get(datasetId);
    if (!pending) {
      pending = this.cirro.data.datasets.getDataset({ projectId: this.projectOf(datasetId), datasetId });
      this.details.set(datasetId, pending);
      pending.catch(() => this.details.delete(datasetId));
    }
    return pending;
  }

  /** Every file in the dataset's data directory, paged through the manifest. */
  private listing(datasetId: string): Promise<{ domain: string; files: ListedFile[] }> {
    let pending = this.listings.get(datasetId);
    if (!pending) {
      pending = (async () => {
        const files: ListedFile[] = [];
        let domain = '';
        for (let offset = 0; ;) {
          const page = await this.cirro.data.datasets.getDatasetManifest({ projectId: this.projectOf(datasetId), datasetId, fileOffset: offset });
          domain = (page.domain ?? '').replace(/\/+$/, '');
          const entries = page.files ?? [];
          for (const f of entries) {
            if (f.path?.startsWith(DATA_DIR)) files.push({ path: f.path.slice(DATA_DIR.length), size: f.size ?? 0 });
          }
          offset += entries.length;
          if (!entries.length || offset >= (page.totalFiles ?? 0)) break;
        }
        return { domain, files };
      })();
      this.listings.set(datasetId, pending);
      pending.catch(() => this.listings.delete(datasetId));
    }
    return pending;
  }

  private catalogCache(): Promise<CatalogCache> {
    this.catalog ??= openCatalog(this.cirro, this.id).then((c) => {
      this.catalogWhere = c.where;
      return c;
    });
    return this.catalog;
  }

  private cachedScans(): Promise<Map<string, ScanRecord>> {
    this.cached ??= this.catalogCache().then((c) => c.load()).catch(async (e: unknown) => {
      // A catalog that can't be read is a catalog this visit keeps in the browser.
      const fallback = browserFallback(this.id, e);
      this.catalog = Promise.resolve(fallback);
      this.catalogWhere = fallback.where;
      return fallback.load();
    });
    return this.cached;
  }

  scan(dataset: DatasetRecord): Promise<ScanRecord> {
    let pending = this.scans.get(dataset.id);
    if (!pending) {
      pending = (async () => {
        const hit = (await this.cachedScans()).get(dataset.id);
        if (hit) return hit;
        const { files } = await this.listing(dataset.id);
        const contents = datasetContents(files);
        const version = contents.version ? summarizeVersion(await this.manifest(dataset.id, contents.version)) : null;
        const scanned: ScanRecord = { datasetId: dataset.id, contents, version, scannedAt: new Date().toISOString() };
        this.queueSave(scanned);
        return scanned;
      })();
      this.scans.set(dataset.id, pending);
      pending.catch(() => this.scans.delete(dataset.id));
    }
    return pending;
  }

  // Scans arrive one by one while the project opens; the catalog takes them in batches.
  private queueSave(scan: ScanRecord): void {
    this.unsaved.push(scan);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.unsaved;
      this.unsaved = [];
      void this.catalogCache().then((c) => c.save(batch)).catch(async (e: unknown) => {
        const fallback = browserFallback(this.id, e);
        this.catalog = Promise.resolve(fallback);
        this.catalogWhere = fallback.where;
        await fallback.save(batch);
      });
    }, 1500);
  }

  async manifest(datasetId: string, path: string) {
    return parseManifest(await this.readFile(datasetId, path));
  }

  async resolveDataset(datasetId: string): Promise<DatasetRecord | null> {
    const here = (await this.datasets()).find((d) => d.id === datasetId);
    if (here) return here;
    const processes = await this.processMap();
    for (const project of await this.cirro.data.projects.getProjects()) {
      if (project.id === this.id) continue;
      try {
        const detail = await this.cirro.data.datasets.getDataset({ projectId: project.id, datasetId });
        this.elsewhere.set(datasetId, project.id);
        this.details.set(datasetId, Promise.resolve(detail));
        return record(detail, processes);
      } catch {
        // Not in this project (404) or not visible to this user (403): try the next.
      }
    }
    return null;
  }

  private async context(datasetId: string): Promise<ProjectFileAccessContext> {
    // Picks SHARED_DATASET_DOWNLOAD for a dataset shared into the project.
    return ProjectFileAccessContext.datasetDownload({ id: this.projectOf(datasetId) }, await this.detail(datasetId));
  }

  private async sign(datasetId: string, path: string, minutes = 5): Promise<string> {
    const [{ domain }, fileAccessContext] = await Promise.all([this.listing(datasetId), this.context(datasetId)]);
    return retryRateLimited(() => this.cirro.files.getSignedUrlFromProjectFile(
      { url: `${domain}/${DATA_DIR}${path}`, name: path.split('/').pop(), fileAccessContext },
      { timeout: minutes },
    ));
  }

  async openStore(datasetId: string, path: string, isFolder: boolean) {
    if (!isFolder) {
      const sign = () => this.sign(datasetId, path, STORE_URL_MINUTES);
      return openZarrStore(await sign(), sign);
    }
    const { files } = await this.listing(datasetId);
    const prefix = `${path}/`;
    const keys = files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path.slice(prefix.length));
    const folder: FolderAccess = {
      signKeys: (wanted) => Promise.all(wanted.map((k) => this.sign(datasetId, `${prefix}${k}`, STORE_URL_MINUTES))),
      listKeys: async (under) => keys.filter((k) => k.startsWith(under)),
    };
    // The folder URL only names the store for the reader's caches; it is never fetched.
    return openZarrStore(`https://cirro-dataset.invalid/${datasetId}/${encodeURI(path)}/`, undefined, folder);
  }

  async readFile(datasetId: string, path: string): Promise<Uint8Array> {
    const res = await fetch(await this.sign(datasetId, path));
    if (!res.ok) throw new Error(`Reading ${path} from Cirro failed: HTTP ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async fileUrl(datasetId: string, path: string) {
    const refresh = () => this.sign(datasetId, path, STORE_URL_MINUTES);
    return { url: await refresh(), refresh };
  }

  async saveVersion(version: NewVersion, onProgress?: (fraction: number) => void) {
    const processes = await this.processMap();
    if (!this.processesRefused && !processes.has(FILES_PROCESS)) throw new Error(`This Cirro has no "${FILES_PROCESS}" (Files) data type to save versions as.`);
    const parent = version.sourceIds[0];
    const parentRecord = parent ? await this.resolveDataset(parent) : null;
    // A version files itself in its parent's Cirro folders, so they sit together there.
    const folders = (parentRecord?.tags ?? []).filter((t) => t.value.startsWith(FOLDER_PREFIX));
    const created = await this.cirro.data.datasets.uploadDataset({
      projectId: this.id,
      uploadDatasetRequest: {
        name: version.name,
        description: version.description,
        processId: FILES_PROCESS,
        expectedFiles: version.files.map((f) => f.name),
        tags: withAppTag(folders),
      },
    });
    const detail = await this.cirro.data.datasets.getDataset({ projectId: this.id, datasetId: created.id });
    const ctx = new ProjectFileAccessContext({ id: this.id }, detail, { accessType: ProjectAccessType.DatasetUpload, datasetId: created.id });
    const credentials = await retryRateLimited(() => this.cirro.files.getProjectAccessCredentials(ctx));
    const base = created.uploadPath.replace(/\/+$/, '');
    const total = version.files.reduce((s, f) => s + f.bytes.length, 0) || 1;
    let done = 0;
    await mapLimit(version.files, 4, async (f) => {
      const file = new File([f.bytes as BlobPart], f.name.split('/').pop()!);
      await uploadFile({ bucket: created.bucket, path: `${base}/${f.name}`, file, credentials }).done();
      done += f.bytes.length;
      onProgress?.(done / total);
    });
    const noteProblem = await addProvenanceNote(this.cirro, this.id, { type: EntityType.Dataset, id: created.id }, {
      what: version.note.what,
      inputs: parentRecord ? [{ name: parentRecord.name, id: parentRecord.id }] : [],
      parameters: version.note.parameters,
    });
    await this.untilCompleted(created.id);
    this.refresh();
    return { datasetId: created.id, noteProblem };
  }

  // Cirro marks an upload COMPLETED once it has seen every expected file; until then the
  // catalog passes the new version over. Past the wait the version still exists and still
  // opens (opening reads its files directly); it joins the map on a later visit.
  private async untilCompleted(datasetId: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < COMPLETION_WAIT_MS) {
      const { status } = await this.cirro.data.datasets.getDataset({ projectId: this.id, datasetId });
      if (status === 'COMPLETED') return;
      if (status === 'FAILED') throw new Error('Cirro marked the new version\'s dataset as failed after its files were uploaded.');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  datasetUrl(datasetId: string): string {
    return `${this.cirro.tenant.url}/project/${this.projectOf(datasetId)}/dataset/${datasetId}`;
  }

  // A process the project can use: offered to every project, or linked to this one.
  private usable(p: Process): boolean {
    return !p.isArchived && (p.isTenantWide || p.linkedProjectIds.includes(this.id));
  }

  async pipelines(datasetId: string | null, purpose: PipelinePurpose): Promise<PipelineLink[]> {
    const [processes, input] = await Promise.all([this.processMap(), datasetId ? this.detail(datasetId) : null]);
    const launch = datasetId ? `${this.datasetUrl(datasetId)}/pipeline` : `${this.cirro.tenant.url}/project/${this.id}/pipeline`;
    return [...processes.values()]
      .filter((p) => this.usable(p) && p.executor !== 'INGEST' && (!input || p.parentProcessIds.includes(input.processId)))
      .filter((p) => PURPOSE[purpose].test(`${p.id} ${p.name}`) && !REFERENCE_BUILDER.test(p.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ id: p.id, name: p.name, description: p.description, url: `${launch}/${p.id}` }));
  }

  async uploadTypes(stage: UploadStage): Promise<UploadType[]> {
    const processes = await this.processMap();
    const files = processes.get(FILES_PROCESS);
    // Refused the process list, the Files type is still the one every Cirro has.
    if (this.processesRefused) return [{ id: FILES_PROCESS, name: 'Files', requirements: null }];
    const specific = stage === 'spatial' ? [] : [...processes.values()]
      .filter((p) => this.usable(p) && p.executor === 'INGEST' && p.id !== FILES_PROCESS && UPLOAD[stage].test(`${p.id} ${p.name}`))
      // The shortest name first: the most general type (Images before CODEX Images (raw)).
      .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    return [...specific, ...(files ? [files] : [])]
      .map((p) => ({ id: p.id, name: p.name, requirements: p.fileRequirementsMessage || null }));
  }
}
