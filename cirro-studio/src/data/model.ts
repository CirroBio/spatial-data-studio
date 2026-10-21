// The app's model of a project: the datasets in it, and the items found inside them.
// An item is what the app shows and opens: an image, an instrument run, a SpatialData
// store, or a saved version of one. A dataset may hold several items (a sopa run writes
// a store and images; a Spatial Data Studio run writes a full and a low-res store per
// sample), and most datasets in a project hold none.
import type { Change } from '../stack/manifest';
import type { ScanRecord } from './scan';

export interface DatasetRecord {
  id: string;
  name: string;
  description: string;
  processId: string;
  processName: string;
  status: string;
  createdAt: string;
  createdBy: string;
  tags: { key: string; value: string }[];
  // Cirro's folders (`folder://a/b` tags), as paths.
  folders: string[];
  // The datasets this one was made from (Cirro's lineage).
  sourceIds: string[];
  // Set when the dataset reached the project through a share.
  share: string | null;
}

export type ItemKind = 'image' | 'run' | 'store' | 'version';

interface ItemBase {
  // `<datasetId>/<path>`, unique within a collection.
  key: string;
  datasetId: string;
  // Relative to the dataset's data directory.
  path: string;
  label: string;
  size: number;
}

export interface ImageItem extends ItemBase {
  kind: 'image';
  viewable: boolean;
}

export interface RunItem extends ItemBase {
  kind: 'run';
  runType: string;
  runLabel: string;
  metricsPath: string | null;
}

export interface StoreItem extends ItemBase {
  kind: 'store';
  isFolder: boolean;
  checkpoint: boolean;
}

export interface VersionItem extends ItemBase {
  kind: 'version';
  parent: string;
  base: string;
  depth: number;
  title: string;
  message: string;
  createdAt: string;
  createdBy: string;
  changes: Change[];
}

export type CatalogItem = ImageItem | RunItem | StoreItem | VersionItem;

export const itemKey = (datasetId: string, path: string) => `${datasetId}/${path}`;

/** The items in a dataset, from what scanning found in its files. */
export function itemsOf(dataset: DatasetRecord, scan: ScanRecord): CatalogItem[] {
  const { contents, version } = scan;
  if (contents.version && version) {
    return [{
      kind: 'version', key: itemKey(dataset.id, contents.version), datasetId: dataset.id, path: contents.version,
      label: version.title, size: contents.totalSize,
      parent: version.parent, base: version.base, depth: version.depth, title: version.title, message: version.message,
      createdAt: version.created_at, createdBy: version.created_by, changes: version.changes,
    }];
  }
  return [
    ...contents.stores.map((s): StoreItem => ({
      kind: 'store', key: itemKey(dataset.id, s.path), datasetId: dataset.id, path: s.path,
      label: s.label, size: s.size, isFolder: s.isFolder, checkpoint: s.kind === 'checkpoint',
    })),
    ...contents.runs.map((r): RunItem => ({
      kind: 'run', key: itemKey(dataset.id, r.path), datasetId: dataset.id, path: r.path,
      label: r.name || dataset.name, size: r.size, runType: r.type.id, runLabel: r.type.label, metricsPath: r.metricsPath,
    })),
    ...contents.images.map((i): ImageItem => ({
      kind: 'image', key: itemKey(dataset.id, i.path), datasetId: dataset.id, path: i.path,
      label: i.label, size: i.size, viewable: i.viewable,
    })),
  ];
}

export const FOLDER_PREFIX = 'folder://';

/** Cirro's folders, from the `Folder: folder://a/b` tags its datasets page writes, as
 * paths with empty segments dropped (`folder:///a//b/` is `a/b`). */
export function foldersOf(tags: { key?: string | null; value: string }[]): string[] {
  return tags.flatMap((t) => (t.value.startsWith(FOLDER_PREFIX)
    ? [t.value.slice(FOLDER_PREFIX.length).split('/').filter(Boolean).join('/')].filter(Boolean)
    : []));
}
