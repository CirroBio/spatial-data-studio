// DataSource backed by a `.zarr.zip` checkpoint read directly over HTTP Range with
// zarrita — no backend (DESIGN §14). The zip is `ZIP_STORED`, so a zarr chunk is a
// contiguous byte span the reader can fetch on its own; `ZipFileStore` pulls the
// central directory once and range-reads entries after that.
//
// Field data is materialized into the *same* Arrow schemas the live
// `/data/{field_path}` route emits (`transport/arrow.py:resolve_field`), so
// `useArrowPositions` and `arrowToColorSource` consume either source unchanged.
import { loadOmeZarrFromStore } from '@vivjs/loaders';
import { Schema, Table, makeTable } from 'apache-arrow';
import type { AbsolutePath, AsyncReadable, RangeQuery } from '@zarrita/storage';
import ZipFileStore from '@zarrita/storage/zip';
import * as zarr from 'zarrita';
import type { ImageInfo, ObsField, ObsmField, SessionFields } from '../types';
import type { DataSource, ImageLoader, LocalCategorical } from './types';

// Highest `viewer/` sidecar layout this build understands. Mirrors
// `persistence.store.VIEWER_SIDECAR_VERSION`; bumped only by a breaking layout change.
const VIEWER_SIDECAR_VERSION = 1;

/**
 * Resolves a currently-valid URL for the checkpoint. A host that hands out
 * short-lived presigned URLs (Cirro signs for minutes; a session lasts as long as
 * someone keeps looking) supplies this so the reader can re-sign instead of
 * failing once the URL it opened with expires.
 */
export type CheckpointUrlRefresher = () => Promise<string>;

// What S3 answers a presigned URL with once it has expired (`AccessDenied` /
// `ExpiredToken`). A genuine permission failure looks the same, so the reader
// re-signs at most once per expiry and surfaces a second failure as-is.
const EXPIRED_URL_STATUSES = new Set([401, 403]);

// Range-GET reader for ZipFileStore. Unlike zarrita's built-in HTTPRangeReader it
// never issues a HEAD: Cirro serves checkpoints as method-specific presigned S3 GET
// URLs, which reject HEAD with 403 (SignatureDoesNotMatch), so getLength()'s HEAD
// would abort the open before a single chunk was read. The total comes from the
// `Content-Range` of a one-byte GET instead.
class RangeGetReader {
  private length?: number;
  private url: string;
  private refreshing: Promise<string> | null = null;

  constructor(url: string, private readonly refreshUrl?: CheckpointUrlRefresher) {
    this.url = url;
  }

  /**
   * Re-sign once per expiry, not once per failed read: an expired URL fails every
   * in-flight tile request at the same moment, and each one must retry against the
   * same replacement rather than asking the host for its own.
   */
  private async refresh(refreshUrl: CheckpointUrlRefresher, staleUrl: string): Promise<void> {
    // Another read's refresh already replaced the URL this attempt used.
    if (this.url !== staleUrl) return;
    if (!this.refreshing) {
      this.refreshing = refreshUrl().then(
        (url) => { this.url = url; this.refreshing = null; return url; },
        (err: unknown) => { this.refreshing = null; throw err; },
      );
    }
    await this.refreshing;
  }

  private async fetchRange(range: string): Promise<Response> {
    const attemptUrl = this.url;
    const res = await fetch(attemptUrl, { headers: { Range: range } });
    if (res.ok || !this.refreshUrl || !EXPIRED_URL_STATUSES.has(res.status)) return res;
    await this.refresh(this.refreshUrl, attemptUrl);
    return fetch(this.url, { headers: { Range: range } });
  }

  async getLength(): Promise<number> {
    if (this.length === undefined) {
      const res = await this.fetchRange('bytes=0-0');
      if (!res.ok) throw new Error(`length probe failed for ${this.url}: ${res.status} ${res.statusText}`);
      const contentRange = res.headers.get('content-range'); // "bytes 0-0/<total>"
      const total = contentRange?.split('/')[1];
      const length = total ? Number(total) : Number(res.headers.get('content-length'));
      if (!Number.isFinite(length)) throw new Error(`could not determine length of ${this.url}`);
      this.length = length;
    }
    return this.length;
  }

  async read(offset: number, size: number): Promise<Uint8Array<ArrayBuffer>> {
    if (size === 0) return new Uint8Array(0);
    const res = await this.fetchRange(`bytes=${offset}-${offset + size - 1}`);
    if (!res.ok) {
      throw new Error(`range GET failed for ${this.url} at ${offset}+${size}: ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

// A store view rooted at `prefix` inside another store. Viv's loader opens the
// multiscale group at the store root, but a checkpoint holds every element in one
// zip, so the image group needs to look like its own store. zarrita keys are
// absolute ("/zarr.json"), so this is a prefix concat.
function subStore(store: Required<AsyncReadable>, prefix: string): Required<AsyncReadable> {
  const at = (key: AbsolutePath): AbsolutePath => `/${prefix}${key}` as AbsolutePath;
  return {
    get: (key: AbsolutePath) => store.get(at(key)),
    getRange: (key: AbsolutePath, range: RangeQuery) => store.getRange(at(key), range),
  };
}

// Written by `persistence.store._write_viewer_sidecar`. Required: a Zarr v3 store has
// no child index, so without it (and the consolidated metadata written alongside it)
// the reader cannot even name the table. `openCheckpoint` rejects a checkpoint that
// predates it rather than presenting an empty session.
interface ViewerSidecar {
  sidecar_version: number;
  table_keys: string[];
  images: Record<string, Record<string, ImageInfo>>;
  coords_transform: Record<string, number[]>;
}

type Root = zarr.Location<AsyncReadable>;

async function readGroupAttrs(root: Root, path: string): Promise<Record<string, unknown> | null> {
  try {
    const group = await zarr.open.v3(root.resolve(path), { kind: 'group' });
    return (await group.attrs) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Whole numeric array as Float64Array, uniform regardless of the on-disk dtype.
async function readNumeric(root: Root, path: string): Promise<Float64Array> {
  const arr = await zarr.open.v3(root.resolve(path), { kind: 'array' });
  const chunk = await zarr.get(arr);
  return Float64Array.from(chunk.data as ArrayLike<number>, Number);
}

async function readStrings(root: Root, path: string): Promise<string[]> {
  const arr = await zarr.open.v3(root.resolve(path), { kind: 'array' });
  const chunk = await zarr.get(arr);
  return globalThis.Array.from(chunk.data as ArrayLike<unknown>, String);
}

// A single slice of a 1-D array — the CSC mirror's per-gene span. zarrita fetches
// only the chunks the slice covers.
async function readSpan(root: Root, path: string, start: number, stop: number): Promise<Float64Array> {
  const arr = await zarr.open.v3(root.resolve(path), { kind: 'array' });
  const chunk = await zarr.get(arr, [zarr.slice(start, stop)]);
  return Float64Array.from(chunk.data as ArrayLike<number>, Number);
}

function withMetadata(table: Table, metadata: Map<string, string>): Table {
  return new Table(new Schema(table.schema.fields, metadata), table.batches);
}

export interface CheckpointHandle {
  source: DataSource;
  // `attrs["app_state"]` from the store root — the displays, compute history and
  // regions the live app gets from `GET /api/sessions/{id}`.
  appState: Record<string, unknown>;
  // What the pickers enumerate, in the shape `GET /api/sessions/{id}` returns.
  fields: SessionFields;
}

/** Open a checkpoint for reading. `source` is a `blob:`/`http(s):` URL, or a File the
 * user picked (which `file://` pages need — range GETs don't work there).
 * `refreshUrl` re-signs an expiring URL mid-session; a File needs none. */
export async function openCheckpoint(
  target: string | File,
  refreshUrl?: CheckpointUrlRefresher,
): Promise<CheckpointHandle> {
  const url = typeof target === 'string' ? target : target.name;
  const rawStore = typeof target === 'string'
    ? new ZipFileStore(new RangeGetReader(target, refreshUrl))
    : ZipFileStore.fromBlob(target);
  // Every open is pinned to v3 (`open.v3`) rather than letting zarrita auto-detect:
// checkpoints are always Zarr v3, and the auto-detect path probes v2 first, which
// costs a 404 per node and leaves the losing probe's rejection unhandled — surfacing
// as `Uncaught (in promise) NotFoundError` in every consumer's console.
// Consolidated metadata turns every later `zarr.open` into a memory lookup and
  // supplies the group listing `deriveFields` needs (Zarr v3 stores carry no child
  // index). It is written alongside the sidecar, which the check below requires.
  const store = await zarr.withMaybeConsolidatedMetadata(rawStore, { format: 'v3' });
  const contents = 'contents' in store ? store.contents() : [];
  const root = zarr.root(store);
  const rootAttrs = (await (await zarr.open.v3(root, { kind: 'group' })).attrs) as Record<string, unknown>;
  const appState = (rootAttrs.app_state ?? {}) as Record<string, unknown>;

  const sidecar = (await readGroupAttrs(root, 'viewer')) as unknown as ViewerSidecar | null;
  // Without the sidecar there is nothing to degrade to: a Zarr v3 store carries no
  // child index, so with neither it nor consolidated metadata the reader cannot even
  // name the table, and the viewer would present an empty session with no explanation.
  // Fail with something the user can act on instead.
  if (!sidecar) {
    throw new Error(
      'This checkpoint was saved before the serverless viewer existed, so it carries none ' +
      'of the metadata the browser needs to read it. Open it in the app and save it again.',
    );
  }
  if (sidecar.sidecar_version > VIEWER_SIDECAR_VERSION) {
    throw new Error(
      `This checkpoint was written for a newer viewer (sidecar v${sidecar.sidecar_version}; ` +
      `this build reads v${VIEWER_SIDECAR_VERSION}).`,
    );
  }
  // Mirrors `Session._default_table_key`: the app has no table picker, it uses the
  // first one.
  const table = sidecar.table_keys[0] ?? '';

  // var_names back a gene's column index and the gene picker; a few thousand short
  // strings, read once.
  let varNames: string[] | null = null;
  const varNamesOnce = async (): Promise<string[]> => {
    if (varNames === null) varNames = await readStrings(root, `tables/${table}/var/_index`);
    return varNames;
  };

  // Columns the user created in this browser session (lasso labels). Checked before
  // the store, so a local column can also shadow one of the same name.
  const localColumns = new Map<string, LocalCategorical>();

  const source: DataSource = {
    kind: 'checkpoint',
    id: url,

    setLocalColumn(fieldPath, column) {
      localColumns.set(fieldPath, column);
    },

    async getFieldData(fieldPath: string): Promise<Table> {
      const local = localColumns.get(fieldPath);
      if (local) {
        return withMetadata(makeTable({ code: local.codes }), new Map([
          ['kind', 'categorical'],
          ['categories', JSON.stringify(local.categories)],
        ]));
      }
      const separator = fieldPath.indexOf(':');
      if (separator < 0) throw new Error(`bad field path: ${fieldPath}`);
      const element = fieldPath.slice(0, separator);
      const key = fieldPath.slice(separator + 1);

      if (element === 'obsm') return readObsm(root, table, key, sidecar.coords_transform[table]);
      if (element === 'obs') return readObs(root, table, key);
      if (element === 'X') {
        return readGene(root, table, 'X', await varNamesOnce(), key);
      }
      if (element === 'layers') {
        const slash = key.indexOf('/');
        if (slash < 0) throw new Error(`layer field needs \`layers:<layer>/<gene>\` form: ${key}`);
        return readGene(root, table, `layers/${key.slice(0, slash)}`,
                        await varNamesOnce(), key.slice(slash + 1));
      }
      throw new Error(`unsupported element for a checkpoint: ${element}`);
    },

    async getImageInfo(element: string): Promise<ImageInfo> {
      const baked = sidecar.images[element]?.[table] ?? sidecar.images[element]?.[''];
      if (!baked) throw new Error(`checkpoint has no manifest for image "${element}"`);
      // `client_compositing` gates the Viv path; the checkpoint reader has no other.
      // The URL fields stay unset — `openImageLoader` owns store construction here.
      return { ...baked, client_compositing: true };
    },

    async openImageLoader(element: string): Promise<ImageLoader> {
      const { data } = await loadOmeZarrFromStore(subStore(store, `images/${element}`));
      return data;
    },

    // getShapesGeoArrow / getElements are deliberately absent: the boundary overlay
    // reads `shapes/<name>/shapes.parquet`, which zarrita cannot decode.

    // No server to composite one, and the minimap already falls back to the cell
    // scatter. Compositing the coarsest level in JS just for an inset isn't worth
    // carrying a second, divergent copy of the channel blend.
    imageThumbnailUrl: () => null,

    async searchVarNames(query: string, limit = 50): Promise<string[]> {
      // Same ranking as `GET /var-names`: prefix hits first, then substring hits.
      const names = await varNamesOnce();
      const needle = query.trim().toLowerCase();
      if (!needle) return names.slice(0, limit);
      const starts = names.filter((n) => n.toLowerCase().startsWith(needle));
      if (starts.length >= limit) return starts.slice(0, limit);
      const contains = names.filter(
        (n) => n.toLowerCase().includes(needle) && !n.toLowerCase().startsWith(needle));
      return starts.concat(contains).slice(0, limit);
    },
  };

  return { source, appState, fields: await deriveFields(root, contents, table, sidecar) };
}

type Contents = { path: string; kind: 'array' | 'group' }[];

/** Immediate children of a group, from the consolidated listing. */
function childrenOf(contents: Contents, group: string): string[] {
  const prefix = `${group}/`;
  return contents
    .map((entry) => entry.path.replace(/^\//, ''))
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map((path) => path.slice(prefix.length));
}

// The inventory the Color By / obsm pickers read, in the shape `GET /api/sessions/{id}`
// returns. Every read here hits consolidated metadata, so this costs no requests.
async function deriveFields(
  root: Root, contents: Contents, table: string, sidecar: ViewerSidecar,
): Promise<SessionFields> {
  const obsAttrs = (await readGroupAttrs(root, `tables/${table}/obs`)) ?? {};
  const indexName = (obsAttrs._index as string) ?? '_index';
  const columnOrder = (obsAttrs['column-order'] as string[]) ?? [];
  // AnnData stores a categorical column as a group (`codes` + `categories`) and a
  // plain one as an array — the same distinction `arrow.field_kind` makes.
  const kindByPath = new Map(contents.map((e) => [e.path.replace(/^\//, ''), e.kind]));
  const obs: ObsField[] = columnOrder
    .filter((name) => name !== indexName)
    .map((name) => ({
      name,
      kind: kindByPath.get(`tables/${table}/obs/${name}`) === 'group' ? 'categorical' : 'numeric',
    }));

  const obsm: ObsmField[] = [];
  for (const name of childrenOf(contents, `tables/${table}/obsm`)) {
    const arr = await zarr.open.v3(root.resolve(`tables/${table}/obsm/${name}`), { kind: 'array' });
    obsm.push({ name, n_components: arr.shape[1] ?? 0 });
  }

  const images = Object.keys(sidecar.images);
  return {
    obs,
    obsm,
    n_obs: await arrayLength(root, `tables/${table}/obs/${indexName}`),
    var_names_count: await arrayLength(root, `tables/${table}/var/_index`),
    obsp: childrenOf(contents, `tables/${table}/obsp`),
    layers: childrenOf(contents, `tables/${table}/layers`),
    images,
    image_dims: images.map((name) => {
      const manifest = sidecar.images[name][table] ?? sidecar.images[name][''];
      return { name, width: manifest.width, height: manifest.height };
    }),
    shapes: childrenOf(contents, 'shapes'),
  };
}

async function arrayLength(root: Root, path: string): Promise<number> {
  try {
    return (await zarr.open.v3(root.resolve(path), { kind: 'array' })).shape[0];
  } catch {
    return 0;
  }
}

// obsm -> d0/d1(/d2) float32, matching `resolve_field`'s obsm branch. The live route
// additionally applies the points->global affine to obsm:spatial; the sidecar bakes
// that affine so the same mapping happens here.
async function readObsm(
  root: Root, table: string, key: string, affine: number[] | undefined,
): Promise<Table> {
  const arr = await zarr.open.v3(root.resolve(`tables/${table}/obsm/${key}`), { kind: 'array' });
  const chunk = await zarr.get(arr);
  const [n, d] = chunk.shape;
  const flat = chunk.data as ArrayLike<number>;
  const columns: Record<string, Float32Array> = {};
  for (let axis = 0; axis < d; axis++) {
    const column = new Float32Array(n);
    for (let i = 0; i < n; i++) column[i] = Number(flat[i * d + axis]);
    columns[`d${axis}`] = column;
  }
  if (key === 'spatial' && affine && !isIdentityAffine(affine)) {
    applyAffineXy(columns.d0, columns.d1, affine);
  }
  return makeTable(columns);
}

function isIdentityAffine([a, b, c, d, e, f]: number[]): boolean {
  return a === 1 && b === 0 && c === 0 && d === 0 && e === 1 && f === 0;
}

// x' = a*x + b*y + c, y' = d*x + e*y + f — `transform.apply_affine6_xy`, in place.
function applyAffineXy(xs: Float32Array, ys: Float32Array, [a, b, c, d, e, f]: number[]): void {
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    xs[i] = a * x + b * y + c;
    ys[i] = d * x + e * y + f;
  }
}

// AnnData writes a categorical obs column as a group of `codes` + `categories`, and a
// plain column as an array. Mirrors `_obs_batch`'s two shapes.
async function readObs(root: Root, table: string, key: string): Promise<Table> {
  const path = `tables/${table}/obs/${key}`;
  const node = await zarr.open.v3(root.resolve(path));
  if (node.kind === 'group') {
    const categories = await readStrings(root, `${path}/categories`);
    const codes = Int32Array.from(await readNumeric(root, `${path}/codes`));
    return withMetadata(makeTable({ code: codes }), new Map([
      ['kind', 'categorical'],
      ['categories', JSON.stringify(categories)],
    ]));
  }
  const values = await readNumeric(root, path);
  return withMetadata(makeTable({ value: values }), new Map([['kind', 'numeric']]));
}

// One gene's column as a dense float32 `value` column, matching `_gene_batch`.
// Prefers the sidecar's gene-major CSC mirror — one gene is then a contiguous span
// of `data`/`indices` covering one or two chunks. Without the mirror (a checkpoint
// saved before it existed) falls back to the on-disk layout: a dense `X` is column-
// sliceable, but a CSR one has to be read whole, which is why the mirror exists.
async function readGene(
  root: Root, table: string, matrix: string, varNames: string[], gene: string,
): Promise<Table> {
  const geneIndex = varNames.indexOf(gene);
  if (geneIndex < 0) throw new Error(`gene not found: ${gene}`);

  if (matrix === 'X') {
    const mirror = await readGeneFromCsc(root, table, geneIndex);
    if (mirror) return makeTable({ value: mirror });
  }
  return makeTable({ value: await readGeneFromMatrix(root, `tables/${table}/${matrix}`, geneIndex) });
}

async function readGeneFromCsc(
  root: Root, table: string, geneIndex: number,
): Promise<Float32Array | null> {
  const base = `viewer/tables/${table}/X_csc`;
  const attrs = await readGroupAttrs(root, base);
  if (!attrs) return null;
  const [nCells] = attrs.shape as [number, number];
  // Two adjacent offsets bound the column; an empty column has start === stop.
  const bounds = await readSpan(root, `${base}/indptr`, geneIndex, geneIndex + 2);
  const [start, stop] = [bounds[0], bounds[1]];
  const column = new Float32Array(nCells);
  if (stop > start) {
    const [values, rows] = await Promise.all([
      readSpan(root, `${base}/data`, start, stop),
      readSpan(root, `${base}/indices`, start, stop),
    ]);
    for (let i = 0; i < values.length; i++) column[rows[i]] = values[i];
  }
  return column;
}

async function readGeneFromMatrix(
  root: Root, path: string, geneIndex: number,
): Promise<Float32Array> {
  const node = await zarr.open.v3(root.resolve(path));
  if (node.kind === 'array') {
    const column = await zarr.get(node, [null, geneIndex]);
    return Float32Array.from(column.data as ArrayLike<number>, Number);
  }
  // AnnData CSR: scan every row's span for this gene. Reads the whole `data`/
  // `indices` pair — tens of megabytes on a real table.
  const [values, columns, offsets] = await Promise.all([
    readNumeric(root, `${path}/data`),
    readNumeric(root, `${path}/indices`),
    readNumeric(root, `${path}/indptr`),
  ]);
  const nCells = offsets.length - 1;
  const column = new Float32Array(nCells);
  for (let cell = 0; cell < nCells; cell++) {
    for (let k = offsets[cell]; k < offsets[cell + 1]; k++) {
      if (columns[k] === geneIndex) {
        column[cell] = values[k];
        break;
      }
    }
  }
  return column;
}
