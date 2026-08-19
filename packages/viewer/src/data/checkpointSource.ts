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
import {
  FIGURE_MEDIA_TYPES,
  type FigureFormat, type FigureIndex, type ImageInfo, type ObsField, type ObsmField,
  type SessionFields,
} from '../types';
import { SHAPE_ANNOTATIONS_ELEMENT } from '../lib/shapeAnnotations';
import type { ShapeIndexEntry, ShapeReader } from './parquetShapes';
import type { DataSource, ElementInventory, ImageLoader, LocalCategorical } from './types';

// Highest `viewer/` sidecar layout this build understands. Mirrors
// `persistence.store.VIEWER_SIDECAR_VERSION`; bumped only by a breaking layout change.
const VIEWER_SIDECAR_VERSION = 2;

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
    // 206 is the only status whose body IS the requested span. A 200 means the server
    // (or a proxy in front of it) ignored the Range header and answered with the whole
    // object, which ZipFileStore would then read as the entry at `offset` — every
    // central-directory lookup and chunk decode silently off. getLength() tolerates a
    // 200 because it only needs the total size; a data read cannot.
    if (res.status !== 206) {
      throw new Error(
        `range GET for ${this.url} at ${offset}+${size} was answered ${res.status}, not 206: `
        + 'the server or a proxy in front of it ignored the Range header.');
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
  // Which `obsm` key `coords_transform` belongs to (`transform.world_key`). Absent in a
  // v1 sidecar, which always meant `spatial`.
  world_key?: Record<string, string>;
  // Absent in a checkpoint saved without figures, and in every one written before
  // they were persisted at all.
  figures?: FigureIndex;
  // Polygonal shapes elements that carry a spatial index. Absent in a checkpoint
  // written before the index existed, whose boundaries stay unread (`parquetShapes`).
  shapes?: Record<string, ShapeIndexEntry>;
  // element -> table key -> that element's intrinsic->world affine, which is what places
  // its polygons (`transport.geometry.element_to_world`). Absent in a v1 sidecar; an
  // element the backend could not place is absent from a v2 one.
  shapes_transform?: Record<string, Record<string, number[]>>;
}

type Root = zarr.Location<AsyncReadable>;

// null means the group is genuinely not in the store — the callers read that as
// "this checkpoint predates the feature". Anything else (a 403 on an expired URL, a
// dropped connection, corrupt metadata) propagates: swallowing it would turn a
// transient failure into a confident wrong diagnosis about a healthy file.
async function readGroupAttrs(root: Root, path: string): Promise<Record<string, unknown> | null> {
  try {
    const group = await zarr.open.v3(root.resolve(path), { kind: 'group' });
    return (await group.attrs) as Record<string, unknown>;
  } catch (err) {
    if (zarr.isZarritaError(err, 'NotFoundError')) return null;
    throw err;
  }
}

// Whole numeric array as Float64Array, uniform regardless of the on-disk dtype.
async function readNumeric(root: Root, path: string): Promise<Float64Array> {
  const arr = await zarr.open.v3(root.resolve(path), { kind: 'array' });
  const chunk = await zarr.get(arr);
  return Float64Array.from(chunk.data as ArrayLike<number>, Number);
}

// True for a zarr array holding strings rather than numbers. AnnData writes an
// object-dtype (plain string) obs column as such an ARRAY, while a pandas Categorical
// becomes a group of `codes` + `categories` — so array-ness alone does not mean numeric,
// and reading one of these through readNumeric yields an all-NaN column. The backend
// treats object dtype as categorical too (`arrow._is_categorical`), so this keeps the
// serverless viewer and the live route agreeing on the same column.
function isStringArray(arr: { dtype?: unknown }): boolean {
  const dtype = String(arr.dtype ?? '');
  return dtype.startsWith('v2:U') || dtype.startsWith('v2:S') || dtype.startsWith('v2:O')
    || dtype === 'string' || dtype.startsWith('r*') || /^[<>|]?[USO]\d*$/.test(dtype);
}

// Codes + levels for a string column, in the order the levels first appear — the shape a
// categorical read returns, so a plain string column colors like a categorical one.
function encodeCategories(values: string[]): { codes: Int32Array; categories: string[] } {
  const categories: string[] = [];
  const indexOf = new Map<string, number>();
  const codes = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let code = indexOf.get(v);
    if (code === undefined) {
      code = categories.length;
      indexOf.set(v, code);
      categories.push(v);
    }
    codes[i] = code;
  }
  return { codes, categories };
}

// A whole uint8 array — a persisted figure, written as one chunk so this is a single
// range read of the zip entry.
async function readBytes(root: Root, path: string): Promise<Uint8Array<ArrayBuffer>> {
  const arr = await zarr.open.v3(root.resolve(path), { kind: 'array' });
  const chunk = await zarr.get(arr);
  // dtype is uint8, so this is the decoded buffer itself — no copy, figures run to
  // megabytes.
  return chunk.data as Uint8Array<ArrayBuffer>;
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
  // Which plots this file carries a rendered figure for, same shape as the live
  // session's `figures`.
  figures: FigureIndex;
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
  // The `obsm` key `coords_transform` was derived for. Resolved by the backend
  // (`transform.world_key`) rather than assumed to be `spatial`: a table spanning several
  // regions keeps region-local coordinates in `spatial` and the stitched ones under
  // another key, and the affine belongs to the stitched one. `spatial` is the right
  // reading of a v1 sidecar, which is what its writer always meant.
  const worldKey = sidecar.world_key?.[table] ?? 'spatial';

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

  // Where each boundary element's polygons go, for the table this session reads.
  // Sidecar v2 onwards: the backend bakes one affine per (element, table) because a
  // shapes element is placed by its OWN transform, not by the table's `coords_transform`
  // (see `transport/geometry.py:element_to_world`).
  //
  // A v1 sidecar carries only `coords_transform`, which places boundaries correctly when
  // it happens to be the boundary element's own transform and puts them somewhere
  // arbitrary when it does not — and nothing in the file says which case it is. The
  // failure is silent and looks like corrupt geometry, so v1 boundaries are withheld
  // instead of guessed at. Everything else in such a checkpoint still opens and renders;
  // the overlay falls back to its points-only path, the same as for a checkpoint written
  // before the shape index existed.
  const shapeAffines: Record<string, number[]> = {};
  for (const [element, byTable] of Object.entries(sidecar.shapes_transform ?? {})) {
    if (byTable[table]) shapeAffines[element] = byTable[table];
  }
  const shapeIndex = sidecar.shapes
    ? Object.fromEntries(Object.entries(sidecar.shapes).filter(([name]) => shapeAffines[name]))
    : {};
  const hasShapes = Object.keys(shapeIndex).length > 0;
  if (!hasShapes && sidecar.shapes && Object.keys(sidecar.shapes).length > 0) {
    console.warn(
      '[shapes] this checkpoint (viewer sidecar v%d) carries no boundary placement for '
      + 'table "%s", so its cell boundaries are not drawn. Open it in the app and save it '
      + 'again to get them back.', sidecar.sidecar_version, table);
  }

  // Boundary reader, code-split: a parquet reader plus a zstd decompressor is ~100 KB
  // gzipped, and most sessions (every live one, and any checkpoint without boundaries)
  // never touch it.
  let shapesOnce: Promise<ShapeReader> | null = null;
  const shapeReader = (): Promise<ShapeReader> => {
    if (!shapesOnce) {
      // Reads the parquet as a plain zip entry, so it takes `rawStore` rather than the
      // consolidated-metadata wrapper.
      shapesOnce = import('./parquetShapes').then(({ createShapeReader }) => createShapeReader(
        rawStore, shapeIndex, shapeAffines,
        async (element, start, stop) => Int32Array.from(
          await readSpan(root, `viewer/shapes/${element}/${table}/cell_index`, start, stop)),
      ));
    }
    return shapesOnce;
  };

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

      if (element === 'obsm') {
        return readObsm(root, table, key, worldKey, sidecar.coords_transform[table]);
      }
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

    // Boundaries come from `shapes/<name>/shapes.parquet` by HTTP Range, pruned to the
    // viewport against its GeoParquet covering index (`parquetShapes`). Both methods
    // stay undefined without an index, which leaves the overlay on its points-only
    // fallback rather than reading every boundary in the sample to draw a screenful.
    ...(hasShapes ? {
      async getShapesGeoArrow(
        element: string, bbox: [number, number, number, number], limit?: number,
      ): Promise<Table> {
        const { table: geometry, report } = await (await shapeReader()).query(element, bbox, limit);
        // The 0-row table the caller reads as "not shown" covers four different
        // reasons; without this the overlay silently failing to appear is unexplainable
        // from the browser.
        if (report.outcome !== 'ok') {
          console.debug('[shapes] %s: %s (%d/%d row groups, %d candidates, %d hits)',
            report.element, report.outcome, report.rowGroupsKept, report.rowGroupsTotal,
            report.candidateRows, report.hitRows);
        }
        return geometry;
      },

      async getElements(): Promise<ElementInventory> {
        // Only what the boundary overlay reads is populated: it picks the polygonal
        // shape sets out of `shapes` and ignores the rest. The data inspector, which
        // uses the other facets, is a live-session panel.
        // The annotations element is withheld from this list only — `getShapesGeoArrow`
        // still serves it, so annotations stay readable; it just never stands in for
        // cell boundaries.
        return {
          tables: [], points: [], labels: [],
          images: Object.keys(sidecar.images).map((name) => ({ name })),
          shapes: Object.entries(shapeIndex)
            .filter(([name]) => name !== SHAPE_ANNOTATIONS_ELEMENT)
            .map(([name, entry]) => ({
              name, count: entry.num_rows, geometry: entry.geometry_types, columns: [],
            })),
        };
      },
    } : {}),

    // No server to composite one, and the minimap already falls back to the cell
    // scatter. Compositing the coarsest level in JS just for an inset isn't worth
    // carrying a second, divergent copy of the channel blend.
    imageThumbnailUrl: () => null,

    async getPlotFigure(plotId: string, format: FigureFormat): Promise<Blob | null> {
      if (!sidecar.figures?.[plotId]?.[format]) return null;
      const bytes = await readBytes(root, `viewer/figures/${plotId}/${format}`);
      return new Blob([bytes], { type: FIGURE_MEDIA_TYPES[format] });
    },

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

  return {
    source, appState, figures: sidecar.figures ?? {},
    fields: await deriveFields(root, contents, table, sidecar),
  };
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
  // AnnData stores a pandas Categorical as a group (`codes` + `categories`); a plain
  // column is an array, whose dtype then decides — a STRING array is categorical too
  // (`arrow._is_categorical` counts object dtype as categorical, and reading one as
  // numeric produces an all-NaN column). Opening each plain column costs no request:
  // its metadata is already in the consolidated tree.
  const kindByPath = new Map(contents.map((e) => [e.path.replace(/^\//, ''), e.kind]));
  const obs: ObsField[] = [];
  for (const name of columnOrder.filter((n) => n !== indexName)) {
    const path = `tables/${table}/obs/${name}`;
    if (kindByPath.get(path) === 'group') {
      obs.push({ name, kind: 'categorical' });
      continue;
    }
    const arr = await zarr.open.v3(root.resolve(path), { kind: 'array' });
    obs.push({ name, kind: isStringArray(arr) ? 'categorical' : 'numeric' });
  }

  const obsm: ObsmField[] = [];
  for (const name of childrenOf(contents, `tables/${table}/obsm`)) {
    const arr = await zarr.open.v3(root.resolve(`tables/${table}/obsm/${name}`), { kind: 'array' });
    // A 1-D obsm array has one component, not zero — `arrow.py` reports 1 for the same
    // element, and 0 made the picker offer an embedding with no axes to choose.
    obsm.push({ name, n_components: arr.shape.length > 1 ? arr.shape[1] : 1 });
  }

  const images = Object.keys(sidecar.images);
  return {
    obs,
    obsm,
    n_obs: await arrayLength(root, `tables/${table}/obs/${indexName}`),
    // A checkpoint saved without X (`store.trim_table`) simply has no `X` node — the
    // backend reports the same absence as `has_x` off the live object.
    has_x: kindByPath.has(`tables/${table}/X`),
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

// 0 only when the array is genuinely not in the store (a table saved without `var`, an
// index the writer omitted). Anything else propagates, for the same reason readGroupAttrs
// re-throws: a 403 or a dropped connection reported as `n_obs: 0` is a confident wrong
// answer about a healthy checkpoint.
async function arrayLength(root: Root, path: string): Promise<number> {
  try {
    return (await zarr.open.v3(root.resolve(path), { kind: 'array' })).shape[0];
  } catch (err) {
    if (zarr.isZarritaError(err, 'NotFoundError')) return 0;
    throw err;
  }
}

// obsm -> d0/d1(/d2) float32, matching `resolve_field`'s obsm branch. The live route
// additionally applies the points->global affine to the world key's coordinates; the
// sidecar bakes both the affine and which key that is, so the same mapping happens here.
async function readObsm(
  root: Root, table: string, key: string, worldKey: string, affine: number[] | undefined,
): Promise<Table> {
  const arr = await zarr.open.v3(root.resolve(`tables/${table}/obsm/${key}`), { kind: 'array' });
  const chunk = await zarr.get(arr);
  // Destructuring a 1-D shape left `d` undefined and the table came back empty; treat such
  // an array as a single d0 column, matching deriveFields' n_components.
  const [n, d = 1] = chunk.shape;
  const flat = chunk.data as ArrayLike<number>;
  const columns: Record<string, Float32Array> = {};
  for (let axis = 0; axis < d; axis++) {
    const column = new Float32Array(n);
    for (let i = 0; i < n; i++) column[i] = Number(flat[i * d + axis]);
    columns[`d${axis}`] = column;
  }
  // A 6-element affine is a map of the xy plane, so it needs both columns; a 1-D
  // world key (the `d = 1` case above) has no d1 to pass and is left as stored rather
  // than dereferencing undefined.
  if (key === worldKey && d >= 2 && affine && !isIdentityAffine(affine)) {
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
  if (isStringArray(node)) {
    const { codes, categories } = encodeCategories(await readStrings(root, path));
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
    const mirrorBase = `viewer/tables/${table}/X_csc`;
    // Absent in a checkpoint saved before the mirror existed, and in one whose `X` is
    // dense — `_write_csc_mirror` writes it only for a sparse `X`.
    const mirrorAttrs = await readGroupAttrs(root, mirrorBase);
    if (mirrorAttrs) {
      return makeTable({ value: await readGeneFromCsc(root, mirrorBase, mirrorAttrs, geneIndex) });
    }
  }
  return makeTable({ value: await readGeneFromMatrix(root, `tables/${table}/${matrix}`, geneIndex) });
}

// One gene's column out of a CSC group: `data`/`indices`/`indptr` plus a `shape` attr
// of [n_obs, n_vars]. The sidecar's `X_csc` mirror and an AnnData `csc_matrix` group
// are the same layout, so both read through here.
async function readGeneFromCsc(
  root: Root, base: string, attrs: Record<string, unknown>, geneIndex: number,
): Promise<Float32Array> {
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
  // AnnData tags every sparse group with the layout it wrote. The two encodings put
  // the gene on opposite axes and index by opposite dimensions, so decoding one as the
  // other yields a column of the wrong length filled with unrelated values and no
  // error — refuse anything this reader cannot name instead.
  const attrs = (await node.attrs) as Record<string, unknown>;
  const encoding = attrs['encoding-type'];
  if (encoding === 'csc_matrix') return readGeneFromCsc(root, path, attrs, geneIndex);
  if (encoding !== 'csr_matrix') {
    throw new Error(
      `cannot read a gene from "${path}": expected a dense array or a csr_matrix/`
      + `csc_matrix group, got encoding-type ${JSON.stringify(encoding ?? null)}.`);
  }
  // CSR: scan every row's span for this gene. Reads the whole `data`/`indices` pair —
  // tens of megabytes on a real table.
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
