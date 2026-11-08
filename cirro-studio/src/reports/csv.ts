// A report's tables as CSV files (RFC 4180), for reading into pandas, R or a spreadsheet.
import type { Column } from '../tasks/parts';

/** A number as it is held (a missing one left empty); text quoted when it holds a comma,
 * a quote or a line break, with its quotes doubled. */
function csvField(v: unknown): string {
  if (typeof v === 'number') return Number.isNaN(v) ? '' : String(v);
  const text = String(v);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Every row, in the order given, under the columns' labels: the values as they are, not
 * as the table formats them. */
export function toCsv<R extends object>(rows: R[], columns: Column<R>[]): string {
  const line = (cells: unknown[]) => `${cells.map(csvField).join(',')}\r\n`;
  return line(columns.map((c) => c.label)) + rows.map((r) => line(columns.map((c) => r[c.key]))).join('');
}

/** A file name for a table called `name`: letters and digits, lowercase, joined by dashes. */
export const csvFileName = (name: string) =>
  `${name.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'table'}.csv`;
