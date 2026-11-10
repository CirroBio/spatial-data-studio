// A folder of checkpoints listed by its `index.json` (docs/CHECKPOINT_FORMAT.md §8), read
// as a public project: anyone can publish their own data this way on any host that
// serves files to a browser, with no Cirro behind it. Each checkpoint is a dataset of
// one file, named, described, filed and credited by its entry.
import type { AsyncReadable } from '@zarrita/storage';
import { openZarrStore, storeName } from '@cirrobio/spatial-viewer';
import type { ListedFile } from './discover';
import type { DatasetRecord } from './model';
import type { PublicSource } from './publicProject';
import { openedStoreProject } from './publicProjects';

export const INDEX_FILE = 'index.json';

export interface IndexDataset {
  record: DatasetRecord;
  // The file's absolute address and its name, which is the dataset's one path.
  url: string;
  file: string;
  size: number | null;
}

export interface FolderIndex {
  name: string | null;
  description: string;
  datasets: IndexDataset[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (str(x) ? [str(x)!] : [])) : []);
const fileName = (path: string) => path.split('?')[0].split('/').pop() || path;
// An entry without an id is known by its path, made safe to carry in a URL.
const idOfPath = (path: string) => path.replace(/[^A-Za-z0-9._-]+/g, '-');

function fetchable(path: string, indexUrl: string): string | null {
  try {
    const url = new URL(path, indexUrl);
    return url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) ? url.href : null;
  } catch {
    return null;
  }
}

const CREDIT_FIELDS = ['source', 'url', 'by', 'license', 'licenseUrl', 'changes'] as const;

// A bare date is a day where the reader is: read as UTC midnight, it would show as the
// day before anywhere west of Greenwich.
const dateOf = (v: unknown) => {
  const d = str(v);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d ?? '';
};

/** An index.json's checkpoints as datasets; paths resolve against the index's own address. */
export function parseIndex(body: unknown, indexUrl: string): FolderIndex {
  const doc = body as { title?: unknown; description?: unknown; checkpoints?: unknown } | null;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.checkpoints)) {
    throw new Error(`${INDEX_FILE} has no "checkpoints" list.`);
  }
  // An entry the browser can't fetch (not https, or not a URL at all) is left out rather
  // than failing the folder; plain http only for a folder on this machine.
  const entries = doc.checkpoints.flatMap((raw) => {
    const e = raw as Record<string, unknown> | null;
    const path = str(e?.path);
    const url = path && fetchable(path, indexUrl);
    if (!e || !path || !url) return [];
    const named = str(e.id);
    // An id travels in version references (cirro::dataset:<id>/<path>), so it is made
    // safe for them the way a path is; `from` may still name it as written.
    return [{ e, path, url, named, id: idOfPath(named ?? path) }];
  });
  const byRef = new Map<string, string>();
  for (const { path, named, id } of entries) {
    if (byRef.has(id)) throw new Error(`${INDEX_FILE} lists two checkpoints as "${named ?? id}"; give one of them an "id".`);
    byRef.set(id, id);
    byRef.set(path, id);
    if (named) byRef.set(named, id);
  }
  const datasets = entries.map(({ e, path, url, id }): IndexDataset => {
    const credit = Object.fromEntries(CREDIT_FIELDS.flatMap((k) => {
      const v = str((e.credit as Record<string, unknown> | undefined)?.[k]);
      return v ? [[k, v]] : [];
    }));
    const file = fileName(path);
    return {
      url,
      file,
      size: typeof e.size === 'number' && e.size >= 0 ? e.size : null,
      record: {
        id,
        name: str(e.label) ?? storeName(path),
        description: str(e.description) ?? '',
        processId: 'index-json',
        processName: INDEX_FILE,
        status: 'COMPLETED',
        createdAt: dateOf(e.date),
        createdBy: '',
        tags: strings(e.tags).map((value) => ({ key: '', value })),
        folders: str(e.folder) ? [str(e.folder)!.replace(/^\/+|\/+$/g, '')] : [],
        sourceIds: strings(e.from).map((ref) => byRef.get(ref) ?? ref),
        share: null,
        credit: 'source' in credit || 'license' in credit ? credit : undefined,
      },
    };
  });
  return { name: str(doc.title) ?? null, description: str(doc.description) ?? '', datasets };
}

/** A store opened by its address alone, as a folder holding just it. It is named after
 * its file, and said to come from its host. */
export function storeIndex(address: string): FolderIndex {
  const { project, datasetId, path } = openedStoreProject(address);
  return {
    name: project.name,
    description: '',
    datasets: [{
      url: project.url,
      file: path,
      size: null,
      record: {
        id: datasetId,
        name: project.name,
        description: '',
        processId: 'address',
        processName: new URL(project.url).host,
        status: 'COMPLETED',
        createdAt: '',
        createdBy: '',
        tags: [],
        folders: [],
        sourceIds: [],
        share: null,
      },
    }],
  };
}

// Each folder's index, read once per page.
const indexes = new Map<string, Promise<FolderIndex>>();

/** The index at a folder's root. */
export function readIndex(root: string): Promise<FolderIndex> {
  let pending = indexes.get(root);
  if (!pending) {
    pending = (async () => {
      const url = `${root}/${INDEX_FILE}`;
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`No ${INDEX_FILE} at ${root} (HTTP ${res.status}).`);
      return parseIndex(await res.json(), url);
    })();
    indexes.set(root, pending);
    pending.catch(() => indexes.delete(root));
  }
  return pending;
}

// A file's size, when its host says; a listing doesn't need it to open the file. Asked
// with a one-byte GET, as the reader asks it: a presigned URL is signed for GET alone and
// refuses HEAD.
async function sizeOf(url: string): Promise<number> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    // A host that ignores the range sends the whole file; only its headers are wanted.
    void res.body?.cancel();
    if (!res.ok) return 0;
    return Number(res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length')) || 0;
  } catch {
    return 0;
  }
}

/** A folder's checkpoints, read straight from their addresses. */
export class IndexSource implements PublicSource {
  constructor(private readonly index: FolderIndex) {}

  private entry(datasetId: string): IndexDataset {
    const d = this.index.datasets.find((x) => x.record.id === datasetId);
    if (!d) throw new Error(`${INDEX_FILE} lists no checkpoint "${datasetId}".`);
    return d;
  }

  async datasets(): Promise<DatasetRecord[]> {
    return this.index.datasets.map((d) => d.record);
  }

  async listing(datasetId: string): Promise<ListedFile[]> {
    const d = this.entry(datasetId);
    return [{ path: d.file, size: d.size ?? await sizeOf(d.url) }];
  }

  async openStore(datasetId: string): Promise<Required<AsyncReadable>> {
    return openZarrStore(this.entry(datasetId).url);
  }

  async readFile(datasetId: string): Promise<Uint8Array> {
    const { url } = this.entry(datasetId);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Reading ${url} failed: HTTP ${res.status}.`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async fileUrl(datasetId: string) {
    const { url } = this.entry(datasetId);
    return { url, refresh: async () => url };
  }
}
