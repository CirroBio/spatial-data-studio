// Reading Cirro datasets: their records, their file listings and their files. The same
// calls serve a Cirro tenant (files signed for the signed-in user) and a publication
// (cirro-publication.ts: files at public URLs), so a project and Public Data read alike.
import type { Dataset, DatasetDetail, Process } from '@cirrobio/api-client';
import { openZarrStore, type FolderAccess } from '@cirrobio/spatial-viewer';
import type { ListedFile } from '../data/discover';
import type { DatasetRecord } from '../data/model';
import { creditOf, datasetFileUrl, folderPaths, type DataSource } from './cirro-publication';
import { retryRateLimited } from './session';

// A store stays open for as long as someone looks at it; its reader re-signs on expiry.
const STORE_URL_MINUTES = 60;
const DATA_DIR = 'data/';

export function datasetRecord(d: Dataset | DatasetDetail, processes: Map<string, Process>): DatasetRecord {
  return {
    id: d.id,
    name: d.name,
    description: d.description ?? '',
    processId: d.processId,
    processName: processes.get(d.processId)?.name ?? d.processId,
    status: d.status,
    createdAt: new Date(d.createdAt).toISOString(),
    // A publication leaves out who made a dataset.
    createdBy: d.createdBy ?? '',
    tags: d.tags.map((t) => ({ key: t.key ?? '', value: t.value })),
    folders: folderPaths(d.tags),
    sourceIds: d.sourceDatasetIds,
    share: 'share' in d ? d.share?.name ?? null : null,
    credit: creditOf(d.tags) ?? undefined,
  };
}

/** Datasets' details, listings and files through one data source, each fetched once. */
export class DatasetReader {
  private readonly details = new Map<string, Promise<DatasetDetail>>();
  private readonly listings = new Map<string, Promise<{ domain: string; files: ListedFile[] }>>();

  constructor(private readonly source: DataSource) {}

  /** Every dataset in a project, paged through its listing. */
  async list(projectId: string, processes: Map<string, Process>): Promise<DatasetRecord[]> {
    const all: DatasetRecord[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.source.dataService.datasets.getDatasets({ projectId, limit: 1000, nextToken });
      all.push(...page.data.map((d) => datasetRecord(d, processes)));
      nextToken = page.nextToken || undefined;
    } while (nextToken);
    return all;
  }

  detail(projectId: string, datasetId: string): Promise<DatasetDetail> {
    let pending = this.details.get(datasetId);
    if (!pending) {
      pending = this.source.dataService.datasets.getDataset({ projectId, datasetId });
      this.details.set(datasetId, pending);
      pending.catch(() => this.details.delete(datasetId));
    }
    return pending;
  }

  /** Keep a detail already fetched elsewhere. */
  remember(detail: DatasetDetail): void {
    this.details.set(detail.id, Promise.resolve(detail));
  }

  /** Every file in the dataset's data directory, paged through the manifest. */
  listing(projectId: string, datasetId: string): Promise<{ domain: string; files: ListedFile[] }> {
    let pending = this.listings.get(datasetId);
    if (!pending) {
      pending = (async () => {
        const files: ListedFile[] = [];
        let domain = '';
        for (let offset = 0; ;) {
          const page = await this.source.dataService.datasets.getDatasetManifest({ projectId, datasetId, fileOffset: offset });
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

  private sign(projectId: string, datasetId: string, path: string, minutes = 5): Promise<string> {
    return retryRateLimited(() => datasetFileUrl(this.source, projectId, datasetId, path, { timeoutMinutes: minutes }));
  }

  async openStore(projectId: string, datasetId: string, path: string, isFolder: boolean) {
    if (!isFolder) {
      const sign = () => this.sign(projectId, datasetId, path, STORE_URL_MINUTES);
      return openZarrStore(await sign(), sign);
    }
    const { files } = await this.listing(projectId, datasetId);
    const prefix = `${path}/`;
    const keys = files.filter((f) => f.path.startsWith(prefix)).map((f) => f.path.slice(prefix.length));
    const folder: FolderAccess = {
      signKeys: (wanted) => Promise.all(wanted.map((k) => this.sign(projectId, datasetId, `${prefix}${k}`, STORE_URL_MINUTES))),
      listKeys: async (under) => keys.filter((k) => k.startsWith(under)),
    };
    // The folder URL only names the store for the reader's caches; it is never fetched.
    return openZarrStore(`https://cirro-dataset.invalid/${datasetId}/${encodeURI(path)}/`, undefined, folder);
  }

  async readFile(projectId: string, datasetId: string, path: string): Promise<Uint8Array> {
    const res = await fetch(await this.sign(projectId, datasetId, path));
    if (!res.ok) throw new Error(`Reading ${path} from Cirro failed: HTTP ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async fileUrl(projectId: string, datasetId: string, path: string) {
    const refresh = () => this.sign(projectId, datasetId, path, STORE_URL_MINUTES);
    return { url: await refresh(), refresh };
  }
}
