// Range-queried cell boundaries for the serverless viewer: reads the viewport's
// polygons out of a checkpoint's `shapes/<element>/shapes.parquet` over HTTP Range,
// with no backend, and returns the same GeoArrow table the live
// `/shapes/{element}/geoarrow` route serves.
//
// The write side (`persistence.store._index_shapes`) Hilbert-sorts the rows and adds a
// GeoParquet 1.1 `covering` bbox column in small row groups; this reader is the half
// that makes that pay. The sequence per viewport, in order of increasing cost:
//
//  1. Reject on the element's `bounds` from the sidecar — no request at all.
//  2. Parse the footer, sized exactly from the sidecar's `footer_bytes` — one request,
//     cached for the element's lifetime, so later viewports skip it.
//  3. Prune row groups by intersecting the viewport against each one's `covering`
//     statistics. Free: the statistics are already in the footer.
//  4. Read only the `bbox` column of the surviving row groups (~10% of the file's
//     bytes) and test each row exactly. This is what makes the `limit` cheap: a
//     zoomed-out viewport is rejected here, before a byte of geometry moves.
//  5. Read `geometry` for the surviving row groups only, and decode just the hit rows.
//
// A file that resists pruning degrades on its own rather than through a separate code
// path: if nothing prunes, every row group survives step 3 and steps 4-5 read the file
// whole — the right answer for the small elements where that happens, and bounded by
// `MAX_QUERY_DOWNLOAD_BYTES` either way.
import type { AsyncBuffer, ColumnData, FileMetaData, RowGroup } from 'hyparquet';
import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import type { AbsolutePath, AsyncReadable } from '@zarrita/storage';
import type { Table } from 'apache-arrow';
import { decodeWkbPolygons, polygonTable } from './wkbGeoArrow';

/** One entry of the viewer sidecar's `shapes` map — `store._index_shapes`' report.
 * Schema: `backend/app/schemas/checkpoint/viewer_sidecar.schema.json#/$defs/shape_index`. */
export interface ShapeIndexEntry {
  geometry_types: string[];
  num_rows: number;
  row_groups: number;
  file_bytes: number;
  footer_bytes: number;
  bounds: [number, number, number, number];
  selectivity: number;
}

// Ceiling on the bytes one viewport query may transfer. The `limit` check in step 4
// normally binds long before this; it is here so a pathological file (one row group
// holding the whole slide, an element that resisted the sort) cannot turn a pan into a
// multi-hundred-megabyte download. Hitting it yields an empty table, which the boundary
// layer already renders as "not shown", the same as being over `limit`.
const MAX_QUERY_DOWNLOAD_BYTES = 32 * 1024 * 1024;

// Column chunks separated by less than this are fetched as one request. RTT dominates
// an HTTP range read, so fetching some slack beats a second round trip — doubly so here,
// since `ZipFileStore.getRange` reads a 30-byte local header before every range it
// serves, making each avoided request two avoided requests.
//
// The value sits in the gap between the two chunk spacings the writer produces (measured
// on a 428k-cell element, 4096-row row groups): the four `bbox` leaves of one row group
// are contiguous, consecutive row groups' `geometry` chunks are ~71 KiB apart (the
// non-geometry columns in between), and consecutive `bbox` blocks are ~478 KiB apart (a
// whole geometry chunk). So this merges the first two and never the third — bridging
// geometry to join two bbox reads is exactly the waste the bbox-first pass exists to
// avoid. It generalizes: the geometry gap is the small columns of one row group, while
// the bbox gap is a geometry chunk, which row-group sizing keeps large.
const COALESCE_GAP_BYTES = 128 * 1024;

// Slack over the sidecar's `footer_bytes` for the one-shot footer fetch, covering the
// 8-byte length+magic trailer and any page-index growth since the report was written.
// Sized so a footer read is a single request even if the file was rewritten.
const FOOTER_SLACK_BYTES = 16 * 1024;

/** Why a query returned nothing, for the console when boundaries don't appear. */
export type ShapeQueryOutcome =
  | 'ok'              // geometry returned
  | 'outside-bounds'  // viewport misses the element entirely
  | 'pruned-empty'    // no row group intersects
  | 'over-limit'      // more cells in view than the caller will draw
  | 'over-budget';    // surviving row groups exceed MAX_QUERY_DOWNLOAD_BYTES

export interface ShapeQueryReport {
  element: string;
  outcome: ShapeQueryOutcome;
  rowGroupsTotal: number;
  rowGroupsKept: number;
  candidateRows: number;     // rows in the surviving row groups
  hitRows: number;           // rows whose own bbox intersects the viewport
  projectedBytes: number;    // compressed geometry bytes the surviving row groups hold
  // Column bytes fetched for this query, which `over-limit` keeps small. Excludes the
  // footer, which is read once per element and then cached for every later viewport.
  transferredBytes: number;
}

export type Bbox = [number, number, number, number];

/**
 * A byte-range view of one zip entry, plus the span cache that keeps hyparquet's
 * many small reads from becoming many HTTP requests.
 *
 * `byteLength` comes from the sidecar rather than from the zip's central directory:
 * `ZipFileStore` doesn't expose per-entry sizes, and the report already carries the
 * number.
 */
class EntryBuffer implements AsyncBuffer {
  // Spans held in memory for hyparquet to slice out of. Replaced wholesale by each
  // `prefetch`, so at most one column read's worth is retained at a time.
  private spans: { start: number; end: number; bytes: Uint8Array }[] = [];

  constructor(
    private readonly store: Required<AsyncReadable>,
    private readonly key: AbsolutePath,
    readonly byteLength: number,
  ) {}

  /** Fetch the given spans concurrently so the reads that follow hit memory. Returns the
   * bytes transferred, which is what the query reports as its download cost. */
  async prefetch(spans: { start: number; end: number }[]): Promise<number> {
    const clamped = spans
      .map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(this.byteLength, end) }))
      .filter((span) => span.end > span.start);
    this.spans = await Promise.all(clamped.map(async (span) => ({
      ...span, bytes: await this.read(span.start, span.end),
    })));
    return clamped.reduce((sum, span) => sum + (span.end - span.start), 0);
  }

  async slice(start: number, end?: number): Promise<ArrayBuffer> {
    // A negative start is a suffix range (hyparquet's footer probe).
    const from = start < 0 ? Math.max(0, this.byteLength + start) : start;
    const to = end === undefined ? this.byteLength : end;
    const cached = this.spans.find((span) => span.start <= from && span.end >= to);
    if (cached) {
      const offset = from - cached.start;
      return toArrayBuffer(cached.bytes.subarray(offset, offset + (to - from)));
    }
    return toArrayBuffer(await this.read(from, to));
  }

  private async read(start: number, end: number): Promise<Uint8Array> {
    const bytes = await this.store.getRange(this.key, { offset: start, length: end - start });
    if (!bytes) throw new Error(`checkpoint has no entry ${this.key}`);
    return bytes;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Boundary reader over a checkpoint's indexed shape parquets. */
export interface ShapeReader {
  /**
   * The viewport's boundaries as a GeoArrow table (`geometry` + int32 `cell_index`) in
   * world space. `bbox` is `[minx, miny, maxx, maxy]`, also world space.
   *
   * The table has 0 rows whenever nothing should be drawn — outside the element, nothing
   * in view, or more in view than `limit` allows. That is the same all-or-nothing
   * contract the live route has, and what `usePolygonBbox` reads as "leave the points
   * showing"; `report` says which case it was.
   */
  query(element: string, bbox: Bbox, limit?: number): Promise<{
    table: Table; report: ShapeQueryReport;
  }>;
}

/**
 * `store` must be the raw `ZipFileStore`, not the consolidated-metadata wrapper: the
 * parquet is a plain zip entry, not a zarr node.
 *
 * `affines` is per element — the sidecar's `shapes_transform[element][table]`, which the
 * backend derived with `transport/geometry.py:element_to_world` for the same table this
 * reader gathers colors for. Each boundary element is placed by its OWN transform: on
 * Xenium `cell_boundaries` declares a 4.7x micron->pixel scale the derivation divides
 * back out, and where a table annotates several regions there is no table-wide points
 * affine to borrow in the first place. `index` and `affines` must agree on their keys;
 * the caller drops any element it has no placement for rather than drawing it somewhere
 * unverifiable.
 */
export function createShapeReader(
  store: Required<AsyncReadable>,
  index: Record<string, ShapeIndexEntry>,
  affines: Record<string, number[]>,
  readCellIndex: (element: string, start: number, stop: number) => Promise<Int32Array>,
): ShapeReader {
  const footers = new Map<string, Promise<FileMetaData>>();
  const inverses = new Map<string, number[]>();

  // The world->intrinsic direction, cached: it is inverted once per element, not once
  // per viewport.
  function inverseOf(element: string): number[] {
    let inverse = inverses.get(element);
    if (!inverse) {
      inverse = invertAffine6(affines[element]);
      inverses.set(element, inverse);
    }
    return inverse;
  }

  function buffer(element: string): EntryBuffer {
    return new EntryBuffer(
      store, `/shapes/${element}/shapes.parquet` as AbsolutePath, index[element].file_bytes);
  }

  function footer(element: string, file: EntryBuffer): Promise<FileMetaData> {
    const cached = footers.get(element);
    if (cached) return cached;
    // Sized from the report, so this is one request of a few KiB rather than
    // hyparquet's 512 KiB speculative default — which on a small element would be a
    // third of the whole file.
    const pending = parquetMetadataAsync(file, {
      initialFetchSize: index[element].footer_bytes + FOOTER_SLACK_BYTES,
      geoparquet: false,
    }).catch((err: unknown) => {
      footers.delete(element);
      throw err;
    });
    footers.set(element, pending);
    return pending;
  }

  return {
    async query(
      element: string, bbox: Bbox, limit?: number,
    ): Promise<{ table: Table; report: ShapeQueryReport }> {
      const entry = index[element];
      if (!entry) throw new Error(`checkpoint has no spatial index for shapes "${element}"`);
      if (!affines[element]) {
        throw new Error(
          `checkpoint carries no placement for shapes "${element}", so its boundaries `
          + 'cannot be drawn in the coordinate space the cells are in.');
      }
      const multi = entry.geometry_types.includes('MultiPolygon');
      const empty = (outcome: ShapeQueryOutcome, rest: Partial<ShapeQueryReport> = {}) => ({
        table: polygonTable(decodeWkbPolygons([], multi), new Int32Array(0), multi),
        report: {
          element, outcome, rowGroupsTotal: entry.row_groups, rowGroupsKept: 0,
          candidateRows: 0, hitRows: 0, projectedBytes: 0, transferredBytes: 0, ...rest,
        },
      });

      // The covering statistics are in the element's intrinsic space, so the query
      // window goes the other way: all four corners through the inverse affine, then
      // their AABB, because the affine may rotate.
      const window = transformBboxAabb(bbox, inverseOf(element));
      if (!intersects(window, entry.bounds)) return empty('outside-bounds');

      const file = buffer(element);
      const metadata = await footer(element, file);
      const groups = metadata.row_groups.map((group) => ({
        rows: Number(group.num_rows),
        box: coveringBox(metadata, group),
      }));

      const kept = selectRowRuns(groups, window);
      if (kept.length === 0) return empty('pruned-empty');

      const candidateRows = kept.reduce((sum, run) => sum + (run.end - run.start), 0);
      const projectedBytes = projectedColumnBytes(metadata, kept, 'geometry');
      const partial = { rowGroupsKept: keptGroupCount(groups, kept), candidateRows, projectedBytes };
      if (projectedBytes > MAX_QUERY_DOWNLOAD_BYTES) return empty('over-budget', partial);

      // Step 4: the covering column for the surviving runs, ~4 doubles a row against the
      // geometry's hundreds of bytes. Exact per-row test, matching the live route's
      // `sindex.intersection` (also a bbox test, so both sources return the same set).
      const boxes = await readColumn<Record<string, number | null> | null>(
        file, metadata, kept, 'bbox');
      const hits: number[] = [];
      for (let i = 0; i < boxes.values.length; i++) {
        // An empty or missing geometry has a *null* bbox, not a NaN one. Nulls must be
        // tested for rather than compared: `-5 <= null` coerces to `-5 <= 0` and is
        // true, so such a row would read as a hit near the origin and then hand
        // `decodeWkbPolygons` a null blob.
        const box = asFiniteBox(boxes.values[i]);
        if (box && intersects(window, box)) hits.push(i);
      }
      if (hits.length === 0) {
        return empty('pruned-empty', { ...partial, transferredBytes: boxes.bytes });
      }
      if (limit !== undefined && hits.length > limit) {
        // The whole point of reading `bbox` first: a zoomed-out viewport costs the
        // covering column and nothing else.
        return empty('over-limit',
                     { ...partial, hitRows: hits.length, transferredBytes: boxes.bytes });
      }

      const blobs = await readColumn<Uint8Array>(file, metadata, kept, 'geometry');
      const buffers = decodeWkbPolygons(hits.map((i) => blobs.values[i]), multi);
      applyAffineXy(buffers.xy, affines[element]);
      const cellIndex = await gatherCellIndex(readCellIndex, element, kept, hits);
      return {
        table: polygonTable(buffers, cellIndex, multi),
        report: {
          element, outcome: 'ok', rowGroupsTotal: entry.row_groups, hitRows: hits.length,
          transferredBytes: boxes.bytes + blobs.bytes, ...partial,
        },
      };
    },
  };
}

/**
 * Row ranges to read: the row groups whose bounding box intersects `window`, with
 * adjacent survivors merged into one run so a contiguous stretch costs one request.
 *
 * A row group with no usable box is kept. Pruning is only ever allowed to be
 * conservative — a false negative here drops cells from the display with no error
 * anywhere, so "don't know" must mean "read it".
 */
export function selectRowRuns(
  groups: { rows: number; box: Bbox | null }[], window: Bbox,
): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let rowStart = 0;
  for (const group of groups) {
    const start = rowStart;
    rowStart += group.rows;
    if (group.box !== null && !intersects(window, group.box)) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === start) last.end = rowStart;
    else runs.push({ start, end: rowStart });
  }
  return runs;
}

/** Read one top-level column over the given row runs, flattened in row order. All the
 * bytes are prefetched up front, so the per-run `parquetRead` calls below decompress out
 * of memory and the sequential awaits cost no round trips. */
async function readColumn<T>(
  file: EntryBuffer, metadata: FileMetaData, runs: { start: number; end: number }[],
  column: string,
): Promise<{ values: T[]; bytes: number }> {
  // Every run's chunks in one prefetch, so the whole column read is one concurrent
  // burst of requests rather than a round trip per run.
  const bytes = await file.prefetch(runs.flatMap((run) => coalescedSpans(metadata, run, column)));
  const values: T[] = [];
  for (const run of runs) {
    const chunks: ColumnData[] = [];
    await parquetRead({
      file, metadata, columns: [column], rowStart: run.start, rowEnd: run.end,
      compressors,
      // Raw WKB, not the GeoJSON hyparquet would build for a geometry column, and not
      // UTF-8 — an unannotated BYTE_ARRAY column is decoded as text by default, which
      // would mangle the geometry.
      geoparquet: false,
      utf8: false,
      onChunk: (chunk) => chunks.push(chunk),
    });
    chunks.sort((a, b) => a.rowStart - b.rowStart);
    for (const chunk of chunks) {
      // A chunk may overhang the requested range at either end.
      const from = Math.max(0, run.start - chunk.rowStart);
      const to = Math.min(chunk.columnData.length, run.end - chunk.rowStart);
      for (let i = from; i < to; i++) values.push(chunk.columnData[i] as T);
    }
  }
  return { values, bytes };
}

/** `column`'s chunk byte ranges over a run of row groups, with neighbours closer than
 * `COALESCE_GAP_BYTES` merged into one range. */
function coalescedSpans(
  metadata: FileMetaData, run: { start: number; end: number }, column: string,
): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  forEachChunk(metadata, run, column, (offset, size) => {
    chunks.push({ start: offset, end: offset + size });
  });
  chunks.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && chunk.start - last.end <= COALESCE_GAP_BYTES) {
      last.end = Math.max(last.end, chunk.end);
    } else {
      merged.push({ ...chunk });
    }
  }
  return merged;
}

function projectedColumnBytes(
  metadata: FileMetaData, runs: { start: number; end: number }[], column: string,
): number {
  let total = 0;
  for (const run of runs) forEachChunk(metadata, run, column, (_offset, size) => { total += size; });
  return total;
}

/** Visit the column chunks of every row group overlapping `run`, for the leaf columns
 * under the top-level name `column` (`bbox` has four leaves, `geometry` one). */
function forEachChunk(
  metadata: FileMetaData, run: { start: number; end: number }, column: string,
  visit: (offset: number, size: number) => void,
): void {
  let rowStart = 0;
  for (const group of metadata.row_groups) {
    const rows = Number(group.num_rows);
    const overlaps = rowStart < run.end && rowStart + rows > run.start;
    rowStart += rows;
    if (!overlaps) continue;
    for (const chunk of group.columns) {
      const meta = chunk.meta_data;
      if (!meta || meta.path_in_schema[0] !== column) continue;
      // `dictionary_page_offset` precedes the data pages when a dictionary is written,
      // so it — not `data_page_offset` — is where the chunk's bytes begin.
      const offset = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
      visit(offset, Number(meta.total_compressed_size));
    }
  }
}

function keptGroupCount(
  groups: { rows: number }[], runs: { start: number; end: number }[],
): number {
  let rowStart = 0;
  let count = 0;
  for (const group of groups) {
    const start = rowStart;
    rowStart += group.rows;
    if (runs.some((run) => run.start < rowStart && run.end > start)) count++;
  }
  return count;
}

/** A row group's bounding box from its `covering` column statistics, or null when the
 * file carries none — note the asymmetry: the box needs the *min* of xmin and the *max*
 * of xmax, and getting that backwards drops cells with no error anywhere. */
function coveringBox(metadata: FileMetaData, group: RowGroup): Bbox | null {
  const paths = coveringPaths(metadata);
  if (!paths) return null;
  const bounds: number[] = [];
  for (const [member, path] of paths) {
    const chunk = group.columns.find((c) => c.meta_data?.path_in_schema.join('.') === path);
    const stats = chunk?.meta_data?.statistics;
    // Parquet permits a Statistics object with min/max unset; that must read as absent,
    // not as an empty range.
    const value = member === 'xmin' || member === 'ymin'
      ? stats?.min_value ?? stats?.min
      : stats?.max_value ?? stats?.max;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    bounds.push(value);
  }
  return bounds as Bbox;
}

// [xmin, ymin, xmax, ymax] leaf paths from the `geo` metadata's `covering` key. Read
// from `covering` rather than assumed to be a column called `bbox` — that is the
// convention, but the spec puts the paths here for a reason.
const coveringCache = new WeakMap<FileMetaData, [string, string][] | null>();

function coveringPaths(metadata: FileMetaData): [string, string][] | null {
  if (coveringCache.has(metadata)) return coveringCache.get(metadata) ?? null;
  let paths: [string, string][] | null = null;
  const raw = metadata.key_value_metadata?.find((kv) => kv.key === 'geo')?.value;
  if (typeof raw === 'string') {
    const geo = JSON.parse(raw) as {
      primary_column: string;
      columns: Record<string, { covering?: { bbox: Record<string, string[]> } }>;
    };
    const covering = geo.columns[geo.primary_column]?.covering?.bbox;
    if (covering) {
      paths = (['xmin', 'ymin', 'xmax', 'ymax'] as const)
        .map((member) => [member, covering[member].join('.')] as [string, string]);
    }
  }
  coveringCache.set(metadata, paths);
  return paths;
}

/** `cell_index` for the hit rows, read from the sidecar mirror one run at a time (each
 * run is a contiguous zarr slice covering a whole number of chunks). */
async function gatherCellIndex(
  read: (element: string, start: number, stop: number) => Promise<Int32Array>,
  element: string, runs: { start: number; end: number }[], hits: number[],
): Promise<Int32Array> {
  const spans = await Promise.all(runs.map((run) => read(element, run.start, run.end)));
  const flat = new Int32Array(spans.reduce((sum, span) => sum + span.length, 0));
  let at = 0;
  for (const span of spans) {
    flat.set(span, at);
    at += span.length;
  }
  const out = new Int32Array(hits.length);
  for (let i = 0; i < hits.length; i++) out[i] = flat[hits[i]];
  return out;
}

/** A feature's `covering` bbox as a `Bbox`, or null when any member is absent or
 * non-finite — an empty or missing geometry, which has no extent to intersect. */
export function asFiniteBox(box: Record<string, number | null> | null): Bbox | null {
  if (!box) return null;
  const { xmin, ymin, xmax, ymax } = box;
  return [xmin, ymin, xmax, ymax].every((v) => typeof v === 'number' && Number.isFinite(v))
    ? [xmin as number, ymin as number, xmax as number, ymax as number]
    : null;
}

export function intersects(a: Bbox, b: Bbox | number[]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** All four corners through the affine, then their AABB — the affine may rotate, so
 * transforming only two opposite corners would not bound the result. */
export function transformBboxAabb([x0, y0, x1, y1]: Bbox, [a, b, c, d, e, f]: number[]): Bbox {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(a * x + b * y + c);
    ys.push(d * x + e * y + f);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function invertAffine6([a, b, c, d, e, f]: number[]): number[] {
  const det = a * e - b * d;
  if (det === 0) throw new Error('shapes transform is not invertible');
  return [e / det, -b / det, (b * f - c * e) / det,
          -d / det, a / det, (c * d - a * f) / det];
}

// Intrinsic -> world, in place over the interleaved coordinate buffer.
function applyAffineXy(xy: Float64Array, [a, b, c, d, e, f]: number[]): void {
  if (a === 1 && b === 0 && c === 0 && d === 0 && e === 1 && f === 0) return;
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i];
    const y = xy[i + 1];
    xy[i] = a * x + b * y + c;
    xy[i + 1] = d * x + e * y + f;
  }
}
