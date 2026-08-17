// The two pieces of the boundary reader that fail *silently* when they're wrong:
// row-group pruning (a false negative drops cells with no error anywhere) and WKB
// decoding (a mis-parsed offset yields plausible-looking garbage). Both are checked
// against an independent brute-force implementation rather than against themselves.
import { describe, expect, it } from 'vitest';
import {
  type Bbox, asFiniteBox, intersects, invertAffine6, selectRowRuns, transformBboxAabb,
} from './parquetShapes';
import { decodeWkbPolygons, polygonTable } from './wkbGeoArrow';

// Deterministic PRNG so a failure is reproducible from the seed alone.
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('selectRowRuns', () => {
  // The reference: every row group whose box overlaps the window, no merging, no
  // pruning cleverness — written the obvious way so it can disagree with the real one.
  function bruteForce(groups: { rows: number; box: Bbox | null }[], window: Bbox): number[] {
    const [wx0, wy0, wx1, wy1] = window;
    const rows: number[] = [];
    let at = 0;
    groups.forEach((group) => {
      const start = at;
      at += group.rows;
      const overlaps = group.box === null || !(
        group.box[2] < wx0 || group.box[0] > wx1 || group.box[3] < wy0 || group.box[1] > wy1);
      if (overlaps) for (let r = start; r < at; r++) rows.push(r);
    });
    return rows;
  }

  function rowsOf(runs: { start: number; end: number }[]): number[] {
    return runs.flatMap((run) => {
      const out: number[] = [];
      for (let r = run.start; r < run.end; r++) out.push(r);
      return out;
    });
  }

  it('selects exactly the intersecting row groups, over random boxes', () => {
    const random = rng(20260817);
    for (let trial = 0; trial < 400; trial++) {
      const groups = Array.from({ length: 1 + Math.floor(random() * 12) }, () => {
        const x = random() * 100;
        const y = random() * 100;
        return {
          rows: 1 + Math.floor(random() * 5),
          box: [x, y, x + random() * 30, y + random() * 30] as Bbox,
        };
      });
      const qx = random() * 100;
      const qy = random() * 100;
      const window: Bbox = [qx, qy, qx + random() * 40, qy + random() * 40];
      expect(rowsOf(selectRowRuns(groups, window))).toEqual(bruteForce(groups, window));
    }
  });

  it('merges adjacent survivors into one run', () => {
    const box: Bbox = [0, 0, 1, 1];
    const far: Bbox = [50, 50, 51, 51];
    const runs = selectRowRuns(
      [{ rows: 10, box }, { rows: 10, box }, { rows: 10, box: far }, { rows: 10, box }],
      [0, 0, 2, 2],
    );
    expect(runs).toEqual([{ start: 0, end: 20 }, { start: 30, end: 40 }]);
  });

  it('keeps a row group whose statistics are missing', () => {
    // "Don't know" has to mean "read it": a writer that emitted no min/max must not
    // cause those cells to vanish.
    const runs = selectRowRuns(
      [{ rows: 4, box: [50, 50, 60, 60] }, { rows: 4, box: null }], [0, 0, 1, 1]);
    expect(runs).toEqual([{ start: 4, end: 8 }]);
  });

  it('counts a shared edge as an intersection', () => {
    // Touching counts: a polygon exactly on the seam belongs to both viewports, and
    // over-inclusion is the safe direction.
    expect(intersects([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true);
    expect(intersects([0, 0, 1, 1], [1.001, 1, 2, 2])).toBe(false);
  });

  it('drops a row whose bbox is absent, which is how an empty geometry is written', () => {
    // geopandas writes *null* covering members for an empty or missing geometry, not
    // NaN. Nulls cannot be left to the comparison: `0 <= null` coerces to `0 <= 0` and
    // is true, so the row would read as a hit near the origin and then hand the decoder
    // a null blob. asFiniteBox is what rejects it.
    expect(asFiniteBox({ xmin: null, ymin: null, xmax: null, ymax: null })).toBeNull();
    expect(asFiniteBox(null)).toBeNull();
    expect(asFiniteBox({ xmin: 0, ymin: 0, xmax: NaN, ymax: 1 })).toBeNull();
    expect(asFiniteBox({ xmin: 1, ymin: 2, xmax: 3, ymax: 4 })).toEqual([1, 2, 3, 4]);
    // The coercion this guards against, spelled out: without the guard a null box
    // intersects any window touching the origin.
    expect(intersects([0, 0, 10, 10], [null, null, null, null] as unknown as number[]))
      .toBe(true);
  });
});

describe('transformBboxAabb', () => {
  it('bounds a rotated box by all four corners, not two', () => {
    // 90-degree rotation: transforming only (x0,y0) and (x1,y1) would give an inverted,
    // wrong box. [a,b,c,d,e,f] with x' = a*x + b*y + c.
    const rotate90 = [0, -1, 0, 1, 0, 0];
    expect(transformBboxAabb([0, 0, 2, 4], rotate90)).toEqual([-4, 0, 0, 2]);
  });

  it('round-trips a window through an affine and its inverse', () => {
    const affine = [2, 0.5, 10, -0.25, 3, -5];
    const box: Bbox = [1, 2, 7, 11];
    const back = transformBboxAabb(transformBboxAabb(box, affine), invertAffine6(affine));
    // The AABB of a rotated AABB only grows, so the round trip must *contain* the
    // original — that containment is what makes the pruning conservative.
    expect(back[0]).toBeLessThanOrEqual(box[0] + 1e-9);
    expect(back[1]).toBeLessThanOrEqual(box[1] + 1e-9);
    expect(back[2]).toBeGreaterThanOrEqual(box[2] - 1e-9);
    expect(back[3]).toBeGreaterThanOrEqual(box[3] - 1e-9);
  });

  it('refuses a degenerate transform instead of producing silent NaNs', () => {
    expect(() => invertAffine6([0, 0, 0, 0, 0, 0])).toThrow(/not invertible/);
  });
});

type Ring = number[][];      // [[x, y], ...], optionally with Z/M ordinates appended
type Polygon = Ring[];       // exterior ring first, then interior rings

interface WkbOptions {
  little?: boolean;
  dims?: number;  // > 2 pads each vertex with Z/M ordinates the decoder must skip
}

/** WKB writer, so the decoder is tested against an encoder written independently of it
 * rather than against its own inverse. */
class WkbWriter {
  private readonly bytes: number[] = [];

  constructor(private readonly little: boolean, private readonly dims: number) {}

  private u32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value, this.little);
    for (let i = 0; i < 4; i++) this.bytes.push(view.getUint8(i));
  }

  private f64(value: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, this.little);
    for (let i = 0; i < 8; i++) this.bytes.push(view.getUint8(i));
  }

  header(baseType: number): void {
    this.bytes.push(this.little ? 1 : 0);
    this.u32(baseType + (this.dims === 2 ? 0 : this.dims === 4 ? 3000 : 1000));
  }

  count(n: number): void {
    this.u32(n);
  }

  polygon(rings: Polygon): void {
    this.header(3);
    this.u32(rings.length);
    for (const ring of rings) {
      this.u32(ring.length);
      for (const vertex of ring) {
        this.f64(vertex[0]);
        this.f64(vertex[1]);
        for (let d = 2; d < this.dims; d++) this.f64(vertex[d] ?? 0);
      }
    }
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

function encodePolygon(rings: Polygon, opts: WkbOptions = {}): Uint8Array {
  const writer = new WkbWriter(opts.little ?? true, opts.dims ?? 2);
  writer.polygon(rings);
  return writer.done();
}

function encodeMultiPolygon(polygons: Polygon[], opts: WkbOptions = {}): Uint8Array {
  const writer = new WkbWriter(opts.little ?? true, opts.dims ?? 2);
  writer.header(6);
  writer.count(polygons.length);
  for (const rings of polygons) writer.polygon(rings);
  return writer.done();
}

const SQUARE: Polygon = [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]];
const SQUARE_WITH_HOLE: Polygon = [
  [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
  [[3, 3], [6, 3], [6, 6], [3, 6], [3, 3]],
];

describe('decodeWkbPolygons', () => {
  it('decodes a single-ring polygon', () => {
    const { xy, ringOffsets, partOffsets } = decodeWkbPolygons([encodePolygon(SQUARE)], false);
    expect(Array.from(xy)).toEqual([0, 0, 4, 0, 4, 4, 0, 4, 0, 0]);
    expect(Array.from(ringOffsets)).toEqual([0, 5]);
    expect(Array.from(partOffsets)).toEqual([0, 1]);
  });

  it('decodes an interior ring as a second ring of the same part', () => {
    const { ringOffsets, partOffsets } = decodeWkbPolygons([encodePolygon(SQUARE_WITH_HOLE)], false);
    expect(Array.from(ringOffsets)).toEqual([0, 5, 10]);
    // Both rings belong to one polygon, so there is one part boundary, not two.
    expect(Array.from(partOffsets)).toEqual([0, 2]);
  });

  it('reads big-endian geometry', () => {
    const little = decodeWkbPolygons([encodePolygon(SQUARE_WITH_HOLE, { little: true })], false);
    const big = decodeWkbPolygons([encodePolygon(SQUARE_WITH_HOLE, { little: false })], false);
    expect(Array.from(big.xy)).toEqual(Array.from(little.xy));
    expect(Array.from(big.ringOffsets)).toEqual(Array.from(little.ringOffsets));
  });

  it('skips Z and M ordinates without shifting x/y', () => {
    for (const dims of [3, 4]) {
      const { xy } = decodeWkbPolygons([encodePolygon(SQUARE, { dims })], false);
      expect(Array.from(xy)).toEqual([0, 0, 4, 0, 4, 4, 0, 4, 0, 0]);
    }
  });

  it('decodes a multipolygon, with each member carrying its own byte order', () => {
    const blob = encodeMultiPolygon([SQUARE, SQUARE_WITH_HOLE]);
    const { ringOffsets, partOffsets, polygonOffsets } = decodeWkbPolygons([blob], true);
    expect(Array.from(ringOffsets)).toEqual([0, 5, 10, 15]);
    expect(Array.from(partOffsets)).toEqual([0, 1, 3]);
    // One row, holding two parts.
    expect(Array.from(polygonOffsets!)).toEqual([0, 2]);
  });

  it('keeps rows aligned across many blobs of differing vertex counts', () => {
    const random = rng(7);
    const rows: Polygon[] = Array.from({ length: 50 }, () => {
      const n = 3 + Math.floor(random() * 20);
      const ring = Array.from({ length: n }, (_, i) => [i, i * 2]);
      return [[...ring, ring[0]]];
    });
    const { ringOffsets, partOffsets, xy } = decodeWkbPolygons(
      rows.map((rings) => encodePolygon(rings)), false);
    expect(partOffsets.length).toBe(rows.length + 1);
    // Each row's offsets must land exactly on its own vertex count.
    let vertices = 0;
    rows.forEach((row, i) => {
      vertices += row[0].length;
      expect(ringOffsets[partOffsets[i + 1]]).toBe(vertices);
    });
    expect(xy.length).toBe(vertices * 2);
  });

  it('rejects a non-polygon geometry rather than mis-reading it', () => {
    const point = new Uint8Array([1, 1, 0, 0, 0, ...new Array(16).fill(0)]);
    expect(() => decodeWkbPolygons([point], false)).toThrow(/unsupported wkb geometry type 1/);
  });

  it('refuses a MultiPolygon row in a column declared Polygon-only', () => {
    // A stale index (an element re-indexed from a GeoDataFrame that no longer matches
    // the file) can claim Polygon-only for a file holding MultiPolygons. There is no
    // nesting level to put the second part in, so one row would silently become two and
    // the geometry column would outrun `cell_index` — Arrow then fails with an opaque
    // schema error far from the cause. Fail here, with the remedy.
    const blob = encodeMultiPolygon([SQUARE, SQUARE_WITH_HOLE]);
    expect(() => decodeWkbPolygons([blob], false)).toThrow(/re-save the checkpoint/);
  });
});

describe('polygonTable', () => {
  it('builds the schema the GeoArrow layer dispatches on', () => {
    const buffers = decodeWkbPolygons([encodePolygon(SQUARE_WITH_HOLE), encodePolygon(SQUARE)], false);
    const table = polygonTable(buffers, Int32Array.from([3, 9]), false);
    expect(table.numRows).toBe(2);
    expect(table.schema.fields.map((f) => f.name)).toEqual(['geometry', 'cell_index']);
    // `GeoArrowPolygonLayer` finds its geometry column by this metadata key alone.
    expect(table.schema.fields[0].metadata.get('ARROW:extension:name')).toBe('geoarrow.polygon');
    // Separated x/y coordinates, matching what `geoarrow.pyarrow.as_geoarrow` emits on
    // the live route: list<rings: list<vertices: struct<x, y>>>.
    expect(table.schema.fields[0].type.toString()).toContain('Struct');
    expect(Array.from(table.getChild('cell_index')!.toArray())).toEqual([3, 9]);
  });

  it('round-trips coordinates through the Arrow accessors', () => {
    const table = polygonTable(
      decodeWkbPolygons([encodePolygon(SQUARE)], false), Int32Array.from([0]), false);
    // One polygon, one ring, five vertices — read back the way deck.gl's picking does.
    const rings = table.getChild('geometry')!.get(0) as { length: number };
    expect(rings.length).toBe(1);
  });

  it('is empty, not malformed, for an empty result', () => {
    const table = polygonTable(decodeWkbPolygons([], false), new Int32Array(0), false);
    expect(table.numRows).toBe(0);
    // `usePolygonBbox` reads numRows === 0 as "nothing to draw", so this path has to
    // produce a valid table rather than throw.
    expect(table.schema.fields[0].metadata.get('ARROW:extension:name')).toBe('geoarrow.polygon');
  });
});
