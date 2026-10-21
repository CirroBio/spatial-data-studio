// Opening an item as a stack: follow a version's `parent` references down to its base
// store, then read the base with every saved version over it, bottom to top.
import type { AsyncReadable } from '@zarrita/storage';
import type { Collection } from '../data/collection';
import { datasetRef, requireCirroRef } from './cirroRef';
import { CachedStore, SavedLayer } from './layeredStore';
import { LAYER_MANIFEST, type LayerManifest } from './manifest';

export interface StackLevel {
  datasetId: string;
  // Relative to the dataset's data directory: the base store, or a version's layer.json.
  path: string;
  // Null for the base store.
  manifest: LayerManifest | null;
}

export interface StackTop {
  datasetId: string;
  path: string;
  kind: 'store' | 'version';
}

// A stack this deep is a reference loop, or something no person would build by hand.
const MAX_DEPTH = 500;

// A store's path names its container: `.zarr.zip` is a zip, anything else a folder.
export const isZipStore = (path: string) => /\.zip$/i.test(path);

/** The levels of the stack whose top is `top`, base first. */
export async function resolveChain(collection: Collection, top: StackTop): Promise<StackLevel[]> {
  if (top.kind === 'store') return [{ datasetId: top.datasetId, path: top.path, manifest: null }];
  const levels: StackLevel[] = [];
  const seen = new Set<string>();
  let at = { datasetId: top.datasetId, path: top.path };
  for (;;) {
    const ref = datasetRef(at.datasetId, at.path);
    if (seen.has(ref)) throw new Error(`The versions under ${ref} refer back to themselves.`);
    if (seen.size >= MAX_DEPTH) throw new Error(`The stack goes on past ${MAX_DEPTH} versions, to ${ref}.`);
    seen.add(ref);
    const manifest = await collection.manifest(at.datasetId, at.path);
    levels.unshift({ ...at, manifest });
    const parent = requireCirroRef(manifest.parent);
    at = { datasetId: parent.datasetId, path: parent.path };
    if (!parent.path.endsWith(LAYER_MANIFEST)) {
      levels.unshift({ ...at, manifest: null });
      return levels;
    }
  }
}

/** Where a version's overlay object is, relative to its dataset's data directory. */
export function overlayPath(level: StackLevel, key: string): string {
  const dir = level.path.includes('/') ? level.path.slice(0, level.path.lastIndexOf('/') + 1) : '';
  return `${dir}${level.manifest!.overlay}/${key}`;
}

/** The store at the bottom of a stack, with what it answers kept in memory. */
export async function openBase(collection: Collection, base: StackLevel): Promise<Required<AsyncReadable>> {
  return new CachedStore(await collection.openStore(base.datasetId, base.path, !isZipStore(base.path)));
}

/** The saved versions of a stack as layers, bottom to top. */
export function savedLayers(collection: Collection, levels: StackLevel[]): SavedLayer[] {
  return levels.slice(1).map((level) => new SavedLayer(
    level.manifest!.files.map((f) => f.key),
    level.manifest!.deleted,
    (key) => collection.readFile(level.datasetId, overlayPath(level, key)),
  ));
}

/** The reference a version saved on top of `levels` names as its parent. */
export function topRef(levels: StackLevel[]): string {
  const top = levels[levels.length - 1];
  return datasetRef(top.datasetId, top.path);
}

export const baseRef = (levels: StackLevel[]) => datasetRef(levels[0].datasetId, levels[0].path);
