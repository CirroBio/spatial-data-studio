// `layer.json`: the manifest of one saved version. A version is a dataset holding this
// file and, under `overlay/`, only the store objects the version added or replaced. The
// format is specified in docs/LAYER_FORMAT.md; the Python reader in
// cirro-studio/python/sds_layers.py reads the same file.
import { z } from 'zod';

export const LAYER_FORMAT = 'spatial-data-studio.layer';
export const LAYER_FORMAT_VERSION = 1;
export const LAYER_MANIFEST = 'layer.json';
export const OVERLAY_DIR = 'overlay';

// The app's own objects in a table's `uns`: figures under `uns[UNS_ROOT][FIGURES]`, which
// a `set-figure` or `delete-figure` change names by id, and kept analysis results under
// `uns[UNS_ROOT][RESULTS]`.
export const UNS_ROOT = 'spatial_data_studio';
export const FIGURES = 'figures';
export const RESULTS = 'results';

// What a version changed, in the words the history shows. The objects themselves are the
// record of truth; this is the readable summary of them.
export const Change = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set-obs'), table: z.string(), column: z.string(), kind: z.enum(['categorical', 'numeric']), note: z.string().optional() }),
  z.object({ op: z.literal('delete-obs'), table: z.string(), column: z.string() }),
  z.object({ op: z.literal('set-obsm'), table: z.string(), key: z.string(), note: z.string().optional() }),
  z.object({ op: z.literal('set-uns'), table: z.string(), path: z.array(z.string()), note: z.string().optional() }),
  z.object({ op: z.literal('delete-uns'), table: z.string(), path: z.array(z.string()) }),
  z.object({ op: z.literal('set-figure'), table: z.string(), id: z.string(), title: z.string() }),
  z.object({ op: z.literal('delete-figure'), table: z.string(), id: z.string(), title: z.string() }),
]);
export type Change = z.infer<typeof Change>;

export const LayerManifest = z.object({
  format: z.literal(LAYER_FORMAT),
  format_version: z.literal(LAYER_FORMAT_VERSION),
  // The version this one sits on: a Cirro reference to the base store (a `.zarr` folder
  // or `.zarr.zip` file) or to another version's `layer.json`.
  parent: z.string(),
  // The store at the bottom of the stack, so a reader can name it without walking.
  base: z.string(),
  // 1 for a version directly on the base.
  depth: z.number().int().positive(),
  title: z.string(),
  message: z.string().default(''),
  created_at: z.string(),
  created_by: z.string().default(''),
  app: z.object({ id: z.string(), version: z.string() }),
  // Folder inside this dataset holding the objects, relative to the data directory.
  overlay: z.string(),
  // Every object under `overlay`, as a store key, with its size in bytes.
  files: z.array(z.object({ key: z.string(), size: z.number().int().nonnegative() })),
  // Keys, or node prefixes ending in `/`, that this version deletes from those below.
  deleted: z.array(z.string()),
  changes: z.array(Change),
});
export type LayerManifest = z.infer<typeof LayerManifest>;

export function parseManifest(bytes: Uint8Array): LayerManifest {
  return LayerManifest.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
