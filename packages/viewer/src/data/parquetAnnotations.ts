// A checkpoint's shape annotations for the serverless viewer, read out of
// `shapes/annotations/shapes.parquet` with no backend. The inverse of
// `backend/app/sessions/shape_annotations.py:_row`, and a row-for-row mirror of
// `backend/app/transport/annotations.py:list_shape_annotations`, which is what the live
// app's `GET /shape-annotations` serves — a change to either side's fallbacks moves both.
//
// The element is a handful of user-drawn shapes, so the file is read whole: no index,
// no viewport pruning. Its `geometry` column is only the Polygon approximation
// ShapesModel requires; the exact shape lives in `params` and is all that is decoded.
import type { FileMetaData } from 'hyparquet';
import { parquetMetadata, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { ShapeAnnotation } from '../schemas/annotations';
import { toArrayBuffer } from './parquetShapes';

type Row = Record<string, unknown>;

/** Every shape in an annotations GeoParquet, in file order (the annotation list's order). */
export async function readShapeAnnotations(bytes: Uint8Array): Promise<ShapeAnnotation[]> {
  const file = toArrayBuffer(bytes);
  const metadata = parquetMetadata(file, { geoparquet: false });
  const columns = parquetSchema(metadata).children
    .map((child) => child.element.name)
    .filter((name) => name !== 'geometry');
  const rows = await parquetReadObjects({ file, metadata, columns, compressors, geoparquet: false });
  const ids = shapeIds(pandasIndexColumns(metadata), rows);
  return rows.map((row, i) => decodeShapeAnnotationRow(row, ids[i]));
}

// pandas' own record of where it put the DataFrame index: a column name — an unnamed
// index such as the shape ids is written as `__index_level_0__` — or a `range` descriptor
// when the index was a RangeIndex and pyarrow stored no column for it.
type PandasIndexColumn = string | { kind: 'range'; start: number; step: number };

function pandasIndexColumns(metadata: FileMetaData): PandasIndexColumn[] {
  const raw = metadata.key_value_metadata?.find((kv) => kv.key === 'pandas')?.value;
  if (typeof raw !== 'string') {
    throw new Error('shapes "annotations" carries no pandas metadata, so its shape ids cannot be found');
  }
  return (JSON.parse(raw) as { index_columns: PandasIndexColumn[] }).index_columns;
}

/** Each row's shape id: the DataFrame index as `str(shape_id)` renders it. */
export function shapeIds(indexColumns: PandasIndexColumn[], rows: Row[]): string[] {
  const index = indexColumns[0];
  if (index === undefined) throw new Error('shapes "annotations" records no index');
  if (typeof index === 'string') return rows.map((row) => String(row[index]));
  return rows.map((_row, i) => String(index.start + i * index.step));
}

/** `transport/annotations.py:_cell`: the value, or `fallback` when the column is absent
 * or the cell is null/NaN — a row written before its column existed reads back NaN. */
function cell(row: Row, column: string, fallback: unknown): unknown {
  const value = row[column];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && Number.isNaN(value)) return fallback;
  return value;
}

// pyarrow writes int64 columns, which hyparquet reads as bigint; Python's float()/int()
// accept either.
const toFloat = (value: unknown): number => Number(value);
const toInt = (value: unknown): number => Math.trunc(Number(value));

/** One parquet row as the `ShapeAnnotation` the live route would have returned for it. */
export function decodeShapeAnnotationRow(row: Row, id: string): ShapeAnnotation {
  // `kind`/`params` are the shape's identity, not its style: no fallback would give a
  // drawable shape, so their absence is an error rather than a default.
  if (typeof row.params !== 'string') throw new Error(`annotation "${id}" has no params`);
  const kind = row.kind;
  const geometry: Row = { kind, ...(JSON.parse(row.params) as Row) };
  if (kind === 'text' && !('rotation' in geometry)) geometry.rotation = 0;
  const shape: Row = {
    id,
    geometry,
    stroke: {
      color: cell(row, 'stroke_color', '#3388ff'),
      width: toFloat(cell(row, 'stroke_width', 2.0)),
      dash: cell(row, 'stroke_dash', 'solid'),
      arrowStart: Boolean(cell(row, 'stroke_arrow_start', false)),
      arrowEnd: Boolean(cell(row, 'stroke_arrow_end', false)),
      arrowSize: toFloat(cell(row, 'stroke_arrow_size', 10.0)),
      z: toInt(cell(row, 'stroke_z', 0)),
    },
  };
  if (kind !== 'line' && kind !== 'text') {
    shape.fill = {
      enabled: Boolean(cell(row, 'fill_enabled', false)),
      color: cell(row, 'fill_color', '#000000'),
      alpha: toFloat(cell(row, 'fill_alpha', 0.0)),
      z: toInt(cell(row, 'fill_z', 0)),
    };
  }
  const label = cell(row, 'label', '');
  if (label) shape.label = label;
  const parsed = ShapeAnnotation.safeParse(shape);
  if (!parsed.success) throw new Error(`annotation "${id}" is malformed: ${parsed.error.message}`);
  return parsed.data;
}
