// A saved figure is a spec, not a picture: what to draw and how, stored in the table's
// `uns` (`uns["spatial_data_studio"]["figures"][<id>]`, a JSON string) of the version it
// was saved in. Opening the version redraws it from the data it sits on; export draws it
// to SVG, PNG or PDF on demand. A Python reader gets it with
// `json.loads(adata.uns["spatial_data_studio"]["figures"][id])`.
import type { AsyncReadable } from '@zarrita/storage';
import * as zarr from 'zarrita';
import type { DisplaySpec } from '@cirrobio/spatial-viewer';
import { FIGURES, UNS_ROOT } from '../stack/manifest';
import { applyEdit } from '../workbench/workbench';

export const FIGURE_FORMAT = 'spatial-data-studio.figure';

export type ChartSpec =
  | { type: 'volcano'; result: string; labels: number; padj: number; logfc: number }
  | { type: 'heatmap'; result: string };

export interface FigureSpec {
  format: typeof FIGURE_FORMAT;
  version: 1;
  id: string;
  title: string;
  caption: string;
  created_at: string;
  created_by: string;
  // A canvas view (exact display: colors, channels, camera) or a chart over a result.
  view: { kind: 'canvas'; display: DisplaySpec } | { kind: 'chart'; chart: ChartSpec };
  // The physical size it was laid out for, in mm.
  width_mm: number;
}

/** The children of `prefix` in the consolidated index, as names. */
export async function childNames(store: Required<AsyncReadable>, prefix: string): Promise<string[]> {
  const bytes = await store.get('/zarr.json');
  if (!bytes) return [];
  const root = JSON.parse(new TextDecoder().decode(bytes)) as { consolidated_metadata?: { metadata: Record<string, unknown> } };
  const keys = Object.keys(root.consolidated_metadata?.metadata ?? {});
  return keys.filter((k) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes('/')).map((k) => k.slice(prefix.length + 1));
}

/** A string kept in the store (a scalar zarr array). */
export async function readString(store: Required<AsyncReadable>, path: string): Promise<string> {
  const location = zarr.root(store).resolve(path);
  const arr = await zarr.open.v3(location, { kind: 'array' });
  return String(await zarr.get(arr));
}

export async function readFigures(store: Required<AsyncReadable>, table: string): Promise<FigureSpec[]> {
  const prefix = `tables/${table}/uns/${UNS_ROOT}/${FIGURES}`;
  const ids = await childNames(store, prefix);
  const specs = await Promise.all(ids.map(async (id) => {
    const parsed = JSON.parse(await readString(store, `${prefix}/${id}`)) as FigureSpec;
    return parsed.format === FIGURE_FORMAT ? parsed : null;
  }));
  return specs.filter((s): s is FigureSpec => s !== null).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** A short, path-safe id, unique enough for one dataset's figures and results. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Stage a figure in the draft, in the table's `uns`, and record it as a change. */
export async function keepFigure(
  wbKey: string, table: string, figure: Omit<FigureSpec, 'format' | 'version' | 'id' | 'created_at'>,
): Promise<FigureSpec> {
  const spec: FigureSpec = { format: FIGURE_FORMAT, version: 1, id: newId('fig'), created_at: new Date().toISOString(), ...figure };
  await applyEdit(wbKey, async (e) => {
    await e.setUns(table, [UNS_ROOT, FIGURES, spec.id], { kind: 'string', value: JSON.stringify(spec) });
    return { op: 'set-figure', table, id: spec.id, title: spec.title };
  });
  return spec;
}
