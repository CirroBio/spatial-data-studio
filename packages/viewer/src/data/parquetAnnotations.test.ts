// The annotations decoder must produce exactly what the live route
// (`transport/annotations.py:list_shape_annotations`) returns for the same row, so these
// cases mirror that function's fallbacks rather than the frontend's own defaults.
import { describe, expect, it } from 'vitest';
import { decodeShapeAnnotationRow, shapeIds } from './parquetAnnotations';

// A row as `shape_annotations._row` writes it, read back by hyparquet: int64 columns
// arrive as bigint.
function fullRow(kind: string, params: object): Record<string, unknown> {
  return {
    kind, params: JSON.stringify(params), label: '',
    stroke_color: '#ff0000', stroke_width: 4, stroke_dash: 'dashed',
    stroke_arrow_start: true, stroke_arrow_end: false, stroke_arrow_size: 12, stroke_z: 3n,
    fill_enabled: true, fill_color: '#00ff00', fill_alpha: 0.5, fill_z: 2n,
  };
}

const LINE = { vertices: [[0, 0], [10, 5]] };
const BOX = { vertices: [[0, 0], [4, 0], [4, 3], [0, 3]] };
const POLYGON = { vertices: [[0, 0], [4, 0], [2, 3]] };
const ELLIPSE = { center: [5, 5], radiusX: 3, radiusY: 2, rotation: 0.25 };
const TEXT = { position: [1, 2], text: 'Hello', fontSize: 14, rotation: 0.5 };

describe('decodeShapeAnnotationRow', () => {
  it('decodes every kind, with fill only on kinds that have an interior', () => {
    const cases = [['line', LINE], ['box', BOX], ['polygon', POLYGON], ['ellipse', ELLIPSE], ['text', TEXT]] as const;
    for (const [kind, params] of cases) {
      const shape = decodeShapeAnnotationRow(fullRow(kind, params), `id-${kind}`);
      expect(shape.id).toBe(`id-${kind}`);
      expect(shape.geometry).toEqual({ kind, ...params });
      expect(shape.stroke).toEqual({
        color: '#ff0000', width: 4, dash: 'dashed', arrowStart: true, arrowEnd: false,
        arrowSize: 12, z: 3,
      });
      if (kind === 'line' || kind === 'text') {
        expect(shape.fill).toBeUndefined();
      } else {
        expect(shape.fill).toEqual({ enabled: true, color: '#00ff00', alpha: 0.5, z: 2 });
      }
    }
  });

  it('falls back to the live route defaults for absent, null and NaN style cells', () => {
    const absent = { kind: 'box', params: JSON.stringify(BOX) };
    const nulls = { ...absent, stroke_color: null, stroke_dash: null, fill_color: null, label: null };
    const nans = {
      ...absent, stroke_width: NaN, stroke_arrow_size: NaN, stroke_z: NaN,
      fill_alpha: NaN, fill_z: NaN,
    };
    for (const row of [absent, nulls, nans]) {
      const shape = decodeShapeAnnotationRow(row, 'a');
      expect(shape.stroke).toEqual({
        color: '#3388ff', width: 2, dash: 'solid', arrowStart: false, arrowEnd: false,
        arrowSize: 10, z: 0,
      });
      expect(shape.fill).toEqual({ enabled: false, color: '#000000', alpha: 0, z: 0 });
      expect(shape).not.toHaveProperty('label');
    }
  });

  it('keeps a non-empty label and drops an empty one', () => {
    expect(decodeShapeAnnotationRow({ ...fullRow('line', LINE), label: 'Tumor' }, 'a').label).toBe('Tumor');
    expect(decodeShapeAnnotationRow(fullRow('line', LINE), 'a')).not.toHaveProperty('label');
  });

  it('gives a text label saved before rotation existed a rotation of 0', () => {
    const { rotation: _, ...unrotated } = TEXT;
    expect(decodeShapeAnnotationRow(fullRow('text', unrotated), 't').geometry).toEqual({ kind: 'text', ...unrotated, rotation: 0 });
  });

  it('refuses a row with no params rather than inventing a shape', () => {
    expect(() => decodeShapeAnnotationRow({ kind: 'box' }, 'x')).toThrow(/"x" has no params/);
  });

  it('refuses a row whose decoded shape fails the schema', () => {
    expect(() => decodeShapeAnnotationRow(fullRow('box', { vertices: [[0, 0]] }), 'bad')).toThrow(/"bad" is malformed/);
    expect(() => decodeShapeAnnotationRow({ ...fullRow('line', LINE), stroke_dash: 'wavy' }, 'bad')).toThrow(/"bad" is malformed/);
  });
});

describe('shapeIds', () => {
  it('reads the index column pandas names, as strings', () => {
    expect(shapeIds(['__index_level_0__'], [{ __index_level_0__: 'a' }, { __index_level_0__: 'b' }])).toEqual(['a', 'b']);
    expect(shapeIds(['id'], [{ id: 7n }])).toEqual(['7']);
  });

  it('numbers rows from a RangeIndex descriptor, which stores no column', () => {
    expect(shapeIds([{ kind: 'range', start: 5, step: 2 }], [{}, {}, {}])).toEqual(['5', '7', '9']);
  });
});
