// What scanning a dataset found, in the form the project's catalog keeps it: one record
// per dataset, and one row per item when the catalog is a Cirro sheet (so the sheet is
// readable on its own, in Cirro's Data Studio or SQL).
import type { LayerManifest } from '../stack/manifest';
import { RUN_TYPES, type DatasetContents } from './discover';

// A saved version's manifest without its object list: what the catalog needs to place it.
export type VersionSummary = Omit<LayerManifest, 'files' | 'deleted' | 'format' | 'format_version' | 'overlay'>;

export interface ScanRecord {
  datasetId: string;
  contents: DatasetContents;
  version: VersionSummary | null;
  scannedAt: string;
}

export function summarizeVersion(manifest: LayerManifest): VersionSummary {
  const { files: _files, deleted: _deleted, format: _format, format_version: _version, overlay: _overlay, ...summary } = manifest;
  return summary;
}

export type RowKind = 'dataset' | 'store' | 'run' | 'image' | 'version';
export const ROW_KINDS: RowKind[] = ['dataset', 'store', 'run', 'image', 'version'];

export interface CatalogRow {
  item: string;
  kind: RowKind;
  dataset_id: string;
  path: string;
  label: string;
  size_bytes: number;
  format: string;
  details: string;
  scanned_at: string;
}

const extension = (path: string) => /\.(ome\.tiff?|zarr\.zip|[^./]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';

export function rowsOf(scan: ScanRecord): CatalogRow[] {
  const { datasetId: id, contents: c, scannedAt } = scan;
  const row = (kind: RowKind, path: string, label: string, size: number, format: string, details: unknown): CatalogRow => ({
    item: `${kind}:${id}/${path}`, kind, dataset_id: id, path, label, size_bytes: size, format,
    details: JSON.stringify(details), scanned_at: scannedAt,
  });
  return [
    row('dataset', '', '', c.totalSize, '', { fileCount: c.fileCount }),
    ...c.stores.map((s) => row('store', s.path, s.label, s.size, s.isFolder ? 'zarr' : 'zarr.zip', { kind: s.kind })),
    ...c.runs.map((r) => row('run', r.path, r.name, r.size, r.type.id, { metricsPath: r.metricsPath })),
    ...c.images.map((i) => row('image', i.path, i.label, i.size, extension(i.path), { viewable: i.viewable })),
    ...(c.version && scan.version ? [row('version', c.version, scan.version.title, c.totalSize, 'layer', scan.version)] : []),
  ];
}

/** Scan records back from catalog rows, by dataset; a dataset without its `dataset` row
 * was written partially and counts as not scanned. */
export function scansOf(rows: CatalogRow[]): Map<string, ScanRecord> {
  const byDataset = new Map<string, CatalogRow[]>();
  for (const r of rows) byDataset.set(r.dataset_id, [...(byDataset.get(r.dataset_id) ?? []), r]);
  const scans = new Map<string, ScanRecord>();
  for (const [datasetId, list] of byDataset) {
    const head = list.find((r) => r.kind === 'dataset');
    if (!head) continue;
    const details = (r: CatalogRow) => JSON.parse(r.details || '{}');
    const versionRow = list.find((r) => r.kind === 'version');
    const contents: DatasetContents = {
      totalSize: Number(head.size_bytes) || 0,
      fileCount: details(head).fileCount ?? 0,
      stores: list.filter((r) => r.kind === 'store').map((r) => ({
        path: r.path, label: r.label, size: Number(r.size_bytes) || 0, isFolder: r.format === 'zarr', kind: details(r).kind,
      })),
      runs: list.filter((r) => r.kind === 'run').flatMap((r) => {
        const type = RUN_TYPES.find((t) => t.id === r.format);
        return type ? [{ path: r.path, name: r.label, type, metricsPath: details(r).metricsPath ?? null, size: Number(r.size_bytes) || 0 }] : [];
      }),
      images: list.filter((r) => r.kind === 'image').map((r) => ({
        path: r.path, label: r.label, size: Number(r.size_bytes) || 0, viewable: Boolean(details(r).viewable),
      })),
      version: versionRow?.path ?? null,
    };
    scans.set(datasetId, { datasetId, contents, version: versionRow ? details(versionRow) : null, scannedAt: head.scanned_at });
  }
  return scans;
}
