// Longest first, so `.sdata.zarr.zip` wins over `.zarr.zip` and `.zarr`. Mirrors
// `persistence.store.READ_EXTS`, plus `.sdata.zarr`: a SpatialData folder named that
// way is listed by the web app under its stem.
const STORE_EXTENSION = /\.(sdata\.zarr\.zip|sdata\.zarr|zarr\.zip|zarr\.tar\.gz|zarr\.tgz|zarr)$/i;
// The `-<12 lowercase hex>` an auto-named save appends to its stem
// (`persistence.store._HASH_SUFFIX_RE`, docs/CHECKPOINT_FORMAT.md §7).
const CONTENT_HASH = /-[0-9a-f]{12}$/;

/** What a store is called, from its path or address: the last segment without a query,
 * extension or content hash (`results/results-07b1a290f7f2.sdata.zarr.zip?sig` →
 * `results`), the name the backend gives the same file. Empty when there is none, so
 * each caller picks its own fallback. */
export function storeName(pathOrUrl: string): string {
  const segment = pathOrUrl.split('?')[0].replace(/\/+$/, '').split('/').pop() ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch {
    // A `%` that encodes nothing, as a hand-written path can carry: the name as written.
  }
  return name.replace(STORE_EXTENSION, '').replace(CONTENT_HASH, '');
}
