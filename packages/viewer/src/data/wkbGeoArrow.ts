// WKB polygons -> a GeoArrow Arrow table, the exact schema the live
// `/shapes/{element}/geoarrow` route emits (`transport/geometry.py:polygons_geoarrow`):
// a `geometry` column carrying `geoarrow.polygon` / `geoarrow.multipolygon` extension
// metadata plus an int32 `cell_index`, so `usePolygonBbox` and its
// `GeoArrowPolygonLayer` consume the checkpoint reader's output unchanged.
//
// Decoding straight from WKB into the flat Arrow buffers, rather than by way of the
// GeoJSON objects hyparquet will happily produce for a geometry column, keeps a
// viewport's worth of boundaries down to a few typed arrays instead of a few hundred
// thousand two-element JS arrays.
import {
  Data, DataType, Field, Float64, Int32, List, RecordBatch, Schema, Struct, Table,
  makeData,
} from 'apache-arrow';

// WKB geometry type codes (OGC 06-103r4 §8). Only the polygon kinds appear here:
// `is_polygonal` gates which elements the writer indexes at all.
const WKB_POLYGON = 3;
const WKB_MULTIPOLYGON = 6;
// WKB carries dimensionality by adding 1000 (Z), 2000 (M) or 3000 (ZM) to the code.
const WKB_DIM_STRIDE = 1000;

/** Flat coordinate buffers in GeoArrow's nesting order. `polygonOffsets` is absent for
 * a polygon column and present for a multipolygon one — that extra level of nesting is
 * the only structural difference between the two. */
export interface PolygonBuffers {
  xy: Float64Array;            // interleaved x,y
  ringOffsets: Int32Array;     // into xy, in vertices
  partOffsets: Int32Array;     // into ringOffsets
  polygonOffsets?: Int32Array; // into partOffsets (multipolygon only)
}

/**
 * Decode WKB polygon/multipolygon blobs into flat GeoArrow buffers.
 *
 * One pass: the total vertex and ring counts aren't known up front, so the coordinate
 * buffer grows geometrically and is trimmed once at the end — cheaper than a counting
 * pre-pass over every blob.
 *
 * `multi` fixes the nesting level. It comes from the element's declared geometry types,
 * not from the blobs, because a column may legitimately mix Polygon and MultiPolygon
 * rows while the Arrow type has to be decided once for the column. A Polygon row in a
 * multipolygon column becomes a one-part multipolygon.
 */
export function decodeWkbPolygons(blobs: Uint8Array[], multi: boolean): PolygonBuffers {
  let xy = new Float64Array(4096);
  let used = 0;
  const ringOffsets: number[] = [0];
  const partOffsets: number[] = [0];
  const polygonOffsets: number[] = [0];

  for (const blob of blobs) {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    let at = 0;
    // Byte order is per-geometry, and in a multipolygon each member repeats its own
    // order flag and type code, so both are re-read at every nesting level.
    let little = true;

    const u32 = (): number => {
      const value = view.getUint32(at, little);
      at += 4;
      return value;
    };
    /** Consume a geometry header, returning `[base type, ordinates per vertex]`. */
    const header = (): [number, number] => {
      little = view.getUint8(at++) === 1;
      const code = u32();
      const band = Math.floor(code / WKB_DIM_STRIDE);
      return [code % WKB_DIM_STRIDE, band === 0 ? 2 : band === 3 ? 4 : 3];
    };
    /** Read one polygon's rings, appending to `xy`/`ringOffsets`. Z/M ordinates are
     * skipped rather than assumed absent, so a store carrying 3-D boundaries reads
     * without its coordinates shifting. */
    const readRings = (dims: number): void => {
      const rings = u32();
      for (let r = 0; r < rings; r++) {
        const points = u32();
        if (used + points * 2 > xy.length) {
          const grown = new Float64Array(Math.max(xy.length * 2, used + points * 2));
          grown.set(xy.subarray(0, used));
          xy = grown;
        }
        for (let p = 0; p < points; p++) {
          xy[used++] = view.getFloat64(at, little);
          xy[used++] = view.getFloat64(at + 8, little);
          at += 8 * dims;
        }
        ringOffsets.push(used / 2);
      }
    };

    const [code, dims] = header();
    if (code === WKB_POLYGON) {
      readRings(dims);
      partOffsets.push(ringOffsets.length - 1);
    } else if (code === WKB_MULTIPOLYGON) {
      // A polygon column has no nesting level to put a second part in, so one row would
      // silently become several and the geometry column would end up longer than
      // `cell_index`. Refuse: the element's declared `geometry_types` disagrees with its
      // contents, which is a broken index, not something to paper over.
      if (!multi) {
        throw new Error(
          'shapes element declares Polygon geometry but holds a MultiPolygon; its ' +
          'spatial index is stale — re-save the checkpoint');
      }
      const members = u32();
      for (let m = 0; m < members; m++) {
        const [memberCode, memberDims] = header();
        if (memberCode !== WKB_POLYGON) {
          throw new Error(`multipolygon member is not a polygon (wkb type ${memberCode})`);
        }
        readRings(memberDims);
        partOffsets.push(ringOffsets.length - 1);
      }
    } else {
      throw new Error(`unsupported wkb geometry type ${code}; expected polygon or multipolygon`);
    }
    polygonOffsets.push(partOffsets.length - 1);
  }

  return {
    xy: xy.slice(0, used),
    ringOffsets: Int32Array.from(ringOffsets),
    partOffsets: Int32Array.from(partOffsets),
    ...(multi ? { polygonOffsets: Int32Array.from(polygonOffsets) } : {}),
  };
}

/**
 * Wrap decoded buffers plus `cellIndex` as the Arrow table the boundary layer expects.
 *
 * GeoArrow geometry is plain nested Arrow lists — `List<List<FixedSizeList<2, f64>>>`
 * for a polygon, one `List` deeper for a multipolygon — identified by an
 * `ARROW:extension:name` key in the field's metadata. `GeoArrowPolygonLayer` dispatches
 * on that key, so it belongs on the geometry field and nowhere else.
 */
export function polygonTable(
  buffers: PolygonBuffers, cellIndex: Int32Array, multi: boolean,
): Table {
  const { xy, ringOffsets, partOffsets, polygonOffsets } = buffers;
  const vertices = xy.length / 2;
  // GeoArrow's interleaved layout is a struct of two f64 children, so the interleaved
  // buffer is split once here rather than per access.
  const coords = makeData({
    type: new Struct([
      new Field('x', new Float64(), false), new Field('y', new Float64(), false),
    ]),
    length: vertices,
    children: [
      makeData({ type: new Float64(), length: vertices, data: deinterleave(xy, 0) }),
      makeData({ type: new Float64(), length: vertices, data: deinterleave(xy, 1) }),
    ],
  });

  let geometryData = nest('vertices', coords, ringOffsets);
  geometryData = nest('rings', geometryData, partOffsets);
  if (multi) {
    if (!polygonOffsets) throw new Error('multipolygon table needs polygonOffsets');
    geometryData = nest('polygons', geometryData, polygonOffsets);
  }

  const geometry = new Field('geometry', geometryData.type, true, new Map([
    ['ARROW:extension:name', multi ? 'geoarrow.multipolygon' : 'geoarrow.polygon'],
    ['ARROW:extension:metadata', '{}'],
  ]));
  const index = new Field('cell_index', new Int32(), false);
  const indexData = makeData({
    type: index.type, length: cellIndex.length, data: cellIndex,
  });

  const schema = new Schema([geometry, index]);
  // One record batch: `usePolygonBbox` builds its fill-color attribute per batch, and a
  // viewport is one fetch, so there is nothing to split.
  const batch = new RecordBatch(schema, makeData({
    type: new Struct(schema.fields),
    length: cellIndex.length,
    children: [geometryData, indexData],
  }));
  return new Table(schema, batch);
}

function deinterleave(xy: Float64Array, offset: number): Float64Array {
  const out = new Float64Array(xy.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = xy[i * 2 + offset];
  return out;
}

function nest(name: string, child: Data, offsets: Int32Array): Data<List> {
  const field = new Field(name, child.type as DataType, false);
  return makeData({
    type: new List(field), length: offsets.length - 1, valueOffsets: offsets, child,
  });
}
