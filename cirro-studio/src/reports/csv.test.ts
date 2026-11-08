import { describe, expect, it } from 'vitest';
import type { Column } from '../tasks/parts';
import { csvFileName, toCsv } from './csv';

type Row = { gene: string; padj: number; group: string };
const columns: Column<Row>[] = [
  { key: 'gene', label: 'Gene' },
  { key: 'padj', label: 'Adj. p', format: (v) => v.toPrecision(2) },
  { key: 'group', label: 'In "group", A' },
];

describe('toCsv', () => {
  it('writes a header of the column labels and every row, numbers unformatted', () => {
    const rows: Row[] = [
      { gene: 'EPCAM', padj: 1.2345678901234e-12, group: '3' },
      { gene: 'KRT8', padj: 0.04, group: '10' },
    ];
    expect(toCsv(rows, columns)).toBe('Gene,Adj. p,"In ""group"", A"\r\nEPCAM,1.2345678901234e-12,3\r\nKRT8,0.04,10\r\n');
  });

  it('quotes text with a comma, quote or line break, and leaves a missing number empty', () => {
    const rows: Row[] = [{ gene: 'a,b', padj: NaN, group: 'say "hi"\nthen go' }];
    expect(toCsv(rows, columns).split('\r\n')[1]).toBe('"a,b",,"say ""hi""\nthen go"');
  });

  it('keeps the order of the columns given, not of the rows\' keys', () => {
    const rows = [{ group: 'B', gene: 'X', padj: 0 }];
    expect(toCsv(rows, [columns[2], columns[0]])).toBe('"In ""group"", A",Gene\r\nB,X\r\n');
  });
});

describe('csvFileName', () => {
  it('makes a lowercase, dash-joined name', () => {
    expect(csvFileName('markers leiden')).toBe('markers-leiden.csv');
    expect(csvFileName('compare T cells (CD4+) vs the rest')).toBe('compare-t-cells-cd4-vs-the-rest.csv');
    expect(csvFileName(' / ')).toBe('table.csv');
  });
});
