// A draft turned into the files of a saved version: `layer.json` plus each object the
// draft holds, under `overlay/` at its store key.
import { APP_ID, APP_VERSION } from '../app/appInfo';
import type { MemoryLayer } from './layeredStore';
import {
  LAYER_FORMAT, LAYER_FORMAT_VERSION, LAYER_MANIFEST, OVERLAY_DIR, type Change, type LayerManifest,
} from './manifest';
import { encodeJson } from './zarrWrite';

export interface VersionInfo {
  parent: string;
  base: string;
  depth: number;
  title: string;
  message: string;
  createdBy: string;
  changes: Change[];
}

export interface VersionFile {
  // Relative to the dataset's data directory.
  name: string;
  bytes: Uint8Array;
}

export function versionFiles(draft: MemoryLayer, info: VersionInfo): { manifest: LayerManifest; files: VersionFile[] } {
  const keys = [...draft.objects.keys()].sort();
  const manifest: LayerManifest = {
    format: LAYER_FORMAT,
    format_version: LAYER_FORMAT_VERSION,
    parent: info.parent,
    base: info.base,
    depth: info.depth,
    title: info.title,
    message: info.message,
    created_at: new Date().toISOString(),
    created_by: info.createdBy,
    app: { id: APP_ID, version: APP_VERSION },
    overlay: OVERLAY_DIR,
    files: keys.map((key) => ({ key, size: draft.objects.get(key)!.length })),
    deleted: [...draft.deleted].sort(),
    changes: info.changes,
  };
  return {
    manifest,
    files: [
      { name: LAYER_MANIFEST, bytes: encodeJson(manifest) },
      ...keys.map((key) => ({ name: `${OVERLAY_DIR}/${key}`, bytes: draft.objects.get(key)! })),
    ],
  };
}
