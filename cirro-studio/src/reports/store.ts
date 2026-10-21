// An analysis kept with the data, as a report: one or more tables in the table's `uns`
// (`uns["spatial_data_studio"]["results"][<id>][<name>]`, AnnData dataframes, the main
// one named `table`) beside what made it (`…["meta"]`, a JSON string), so Python reads
// both as pandas and JSON. Every run of an analysis task is kept this way, in the draft,
// and its report draws from what is kept, so it reads the same whenever it is opened.
import type { AsyncReadable } from '@zarrita/storage';
import * as zarr from 'zarrita';
import type { GeneTest } from '../analysis/rankGenes';
import { APP_ID, APP_VERSION } from '../app/appInfo';
import { childNames, newId, readString } from '../figures/spec';
import type { DataFrameColumn } from '../stack/editor';
import { RESULTS, UNS_ROOT } from '../stack/manifest';
import { applyEdit } from '../workbench/workbench';

// The analyses with a report, by the task that runs them.
export type ReportKind = 'markers' | 'compare' | 'moran' | 'neighborhoods' | 'niches' | 'clusters';

export interface ResultMeta {
  kind: ReportKind;
  // What the report is called, in the views menu and its own header.
  title: string;
  method: string;
  about: string;
  parameters: Record<string, unknown>;
  // What the report needs beyond its tables (group sizes, how a group was chosen…), as
  // the run saw it.
  summary: Record<string, unknown>;
}

export interface KeptMeta extends ResultMeta {
  created_at: string;
  created_by: string;
  app: { id: string; version: string };
}

export interface KeptResult {
  id: string;
  // Under `uns`, the result's group.
  path: string[];
  meta: KeptMeta;
}

export interface DataFrame {
  index: string[];
  columns: Record<string, ArrayLike<number> | string[]>;
}

// The column each statistic of a kept gene test (a comparison, or markers) is stored
// under; reports and volcano figures read them back by these names.
export const GENE_TEST_COLUMN = {
  score: 'score',
  logfc: 'logfoldchange',
  pval: 'pval',
  padj: 'pval_adj',
  meanA: 'mean_group',
  meanB: 'mean_reference',
  fracA: 'fraction_group',
  fracB: 'fraction_reference',
} as const satisfies Partial<Record<keyof GeneTest, string>>;

/** The statistics of gene tests as dataframe columns, one row per test. */
export function geneTestColumns(tests: GeneTest[]): Record<string, Float64Array> {
  const fields = Object.keys(GENE_TEST_COLUMN) as (keyof typeof GENE_TEST_COLUMN)[];
  return Object.fromEntries(fields.map((f) => [GENE_TEST_COLUMN[f], Float64Array.from(tests, (t) => t[f])]));
}

/** Gene tests back from a kept table, one per row. */
export function geneTestsOf(df: DataFrame, genes: string[] = df.index): GeneTest[] {
  const col = (name: string) => {
    const c = df.columns[name];
    if (!c || Array.isArray(c)) throw new Error(`The result has no numeric column “${name}”.`);
    return c as ArrayLike<number>;
  };
  const [score, logfc, pval, padj, meanA, meanB, fracA, fracB] = [
    GENE_TEST_COLUMN.score, GENE_TEST_COLUMN.logfc, GENE_TEST_COLUMN.pval, GENE_TEST_COLUMN.padj,
    GENE_TEST_COLUMN.meanA, GENE_TEST_COLUMN.meanB, GENE_TEST_COLUMN.fracA, GENE_TEST_COLUMN.fracB,
  ].map(col);
  return genes.map((gene, i) => ({
    gene, score: score[i], logfc: logfc[i], pval: pval[i], padj: padj[i], meanA: meanA[i], meanB: meanB[i], fracA: fracA[i], fracB: fracB[i],
  }));
}

export interface KeptTable { index: string[]; columns: Record<string, DataFrameColumn> }

// Names the store refuses for a dataframe column, and the one its index is kept under.
const UNSTORABLE = new Set(['', '.', '..', '_index']);

/** Each label as a name a kept table can use for a row or column: the label itself, or
 * for one the store can't take (with a slash, say) a stand-in with the slash made an
 * underscore, or bracketed, and unlike every other name. */
export function storableNames(labels: string[]): string[] {
  const storable = (g: string) => !/[/\\]/.test(g) && !UNSTORABLE.has(g);
  const taken = new Set(labels.filter(storable));
  return labels.map((g) => {
    if (storable(g)) return g;
    const safe = g.replace(/[/\\]/g, '_');
    const base = UNSTORABLE.has(safe) ? `(${safe || 'blank'})` : safe;
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
    taken.add(name);
    return name;
  });
}

/** Stage a result in the draft, its main table under `table` and any others beside it. */
export async function keepResult(
  wbKey: string, table: string, tables: { table: KeptTable } & Record<string, KeptTable>, meta: ResultMeta, createdBy: string,
): Promise<KeptResult> {
  const id = newId(meta.kind);
  const path = [UNS_ROOT, RESULTS, id];
  const kept: KeptMeta = { ...meta, created_at: new Date().toISOString(), created_by: createdBy, app: { id: APP_ID, version: APP_VERSION } };
  await applyEdit(wbKey, async (e) => {
    for (const [name, t] of Object.entries(tables)) await e.setUns(table, [...path, name], { kind: 'dataframe', index: t.index, columns: t.columns });
    await e.setUns(table, [...path, 'meta'], { kind: 'string', value: JSON.stringify(kept) });
    return { op: 'set-uns', table, path, note: meta.title };
  });
  return { id, path, meta: kept };
}

/** Take a kept result out of the draft (or, saved in a version, out of the next one). */
export function removeResult(wbKey: string, table: string, result: KeptResult): Promise<void> {
  return applyEdit(wbKey, (e) => e.deleteUns(table, result.path));
}

/** Every result kept with the table, oldest first. */
export async function readResults(store: Required<AsyncReadable>, table: string): Promise<KeptResult[]> {
  const prefix = `tables/${table}/uns/${UNS_ROOT}/${RESULTS}`;
  const ids = await childNames(store, prefix);
  const results = await Promise.all(ids.map(async (id): Promise<KeptResult | null> => {
    const names = await childNames(store, `${prefix}/${id}`);
    if (!names.includes('meta')) return null;
    const meta = JSON.parse(await readString(store, `${prefix}/${id}/meta`)) as Partial<KeptMeta>;
    // Kept by a version of the app from before reports, or by something else.
    if (!meta.kind || !meta.title) return null;
    return { id, path: [UNS_ROOT, RESULTS, id], meta: meta as KeptMeta };
  }));
  return results.filter((r): r is KeptResult => r !== null).sort((a, b) => a.meta.created_at.localeCompare(b.meta.created_at));
}

/** The dataframe at `tables/<table>/uns/<path>`. */
export async function readDataFrame(store: Required<AsyncReadable>, table: string, path: string): Promise<DataFrame> {
  const root = zarr.root(store);
  const at = `tables/${table}/uns/${path}`;
  const group = await zarr.open.v3(root.resolve(at), { kind: 'group' });
  const attrs = (await group.attrs) as { 'column-order'?: string[]; _index?: string };
  const read = async (name: string) => {
    const arr = await zarr.open.v3(root.resolve(`${at}/${name}`), { kind: 'array' });
    return (await zarr.get(arr)).data as ArrayLike<number> | ArrayLike<string>;
  };
  const index = Array.from(await read(attrs._index ?? '_index') as ArrayLike<string>, String);
  const columns: DataFrame['columns'] = {};
  for (const name of attrs['column-order'] ?? []) {
    const values = await read(name);
    columns[name] = typeof values[0] === 'string' ? Array.from(values as ArrayLike<string>, String) : values as ArrayLike<number>;
  }
  return { index, columns };
}

/** One of a kept result's tables. */
export const readResultTable = (store: Required<AsyncReadable>, table: string, result: KeptResult, name = 'table') =>
  readDataFrame(store, table, [...result.path, name].join('/'));
