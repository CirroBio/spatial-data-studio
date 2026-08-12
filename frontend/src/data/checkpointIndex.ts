// `index.json` — the manifest that turns a folder of checkpoints into a browsable
// serverless viewer (DESIGN §14.3).
//
// The deployment is deliberately boilerplate: the built SPA, the `.zarr.zip` files,
// and this one JSON listing them. `index.html` carries nothing deployment-specific,
// so the same build serves any collection.
//
//   {
//     "title": "Mouse brain atlas",            // optional, names the collection
//     "checkpoints": [
//       { "path": "visium_hne.sdata.zarr.zip",
//         "label": "Visium H&E",               // optional, defaults to the file name
//         "description": "Coronal section" }   // optional
//     ]
//   }
//
// `path` is resolved against the index's own URL, so a listing can point at a
// sibling file, a subfolder, or an absolute URL on another host.

export const CHECKPOINT_INDEX_FILE = 'index.json';

export interface CheckpointEntry {
  // As written in the manifest — what goes back into `?checkpoint=`, so the address
  // bar stays as short and portable as the manifest itself.
  path: string;
  url: string;
  label: string;
  description?: string;
}

export interface CheckpointIndex {
  title?: string;
  entries: CheckpointEntry[];
}

const EMPTY: CheckpointIndex = { entries: [] };

function fileName(path: string): string {
  const last = path.split('/').pop() ?? path;
  return decodeURIComponent(last.split('?')[0]) || path;
}

/** Read `index.json` from alongside the page. Returns an empty index when there is
 * none, when it is unreadable, or when it lists nothing usable — its absence is the
 * normal case for a live deployment, not an error. */
export async function fetchCheckpointIndex(): Promise<CheckpointIndex> {
  const indexUrl = new URL(CHECKPOINT_INDEX_FILE, document.baseURI);
  let body: unknown;
  try {
    const res = await fetch(indexUrl.href, { cache: 'no-cache' });
    if (!res.ok) return EMPTY;
    body = await res.json();
  } catch {
    return EMPTY;  // absent, blocked, or not JSON
  }

  const doc = body as { title?: unknown; checkpoints?: unknown };
  if (!Array.isArray(doc?.checkpoints)) return EMPTY;

  const entries: CheckpointEntry[] = [];
  for (const raw of doc.checkpoints) {
    const item = raw as { path?: unknown; label?: unknown; description?: unknown };
    if (typeof item?.path !== 'string' || !item.path) continue;
    entries.push({
      path: item.path,
      url: new URL(item.path, indexUrl).href,
      label: typeof item.label === 'string' && item.label ? item.label : fileName(item.path),
      description: typeof item.description === 'string' ? item.description : undefined,
    });
  }
  return { title: typeof doc.title === 'string' ? doc.title : undefined, entries };
}

/** Open a checkpoint by its manifest path. A full navigation rather than an in-place
 * swap: a checkpoint carries its own displays, fields and locally-made labels, and
 * reloading is the one way to guarantee none of the previous one's state leaks into
 * the next. The bundle is already cached, so this costs a parse, not a download. */
export function openCheckpointPath(path: string): void {
  const url = new URL(window.location.href);
  url.search = `?checkpoint=${encodeURIComponent(path)}`;
  window.location.assign(url.href);
}
