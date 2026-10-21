// A SpatialData store read as a stack: a base store (the `.zarr` folder or `.zarr.zip` a
// pipeline wrote) with saved versions on top of it, newest last, and the unsaved draft
// on top of those. Each layer holds only the objects it adds or replaces, plus the
// prefixes it deletes ("whiteouts", as in container image layers). A key is answered by
// the topmost layer that has it; a layer that deletes it hides it from every layer
// below, but not its own objects, so a layer can delete a node and write a new one under
// the same name.
import type { AbsolutePath, AsyncReadable, GetOptions, RangeQuery } from '@zarrita/storage';

export interface Layer {
  /** Whether this layer holds `key` (relative to the store root, no leading slash). */
  has(key: string): boolean;
  /** Whether this layer deletes `key` from the layers below it. */
  hides(key: string): boolean;
  /** The object's bytes; only asked for keys `has` answers true for. */
  read(key: string): Promise<Uint8Array>;
}

/** Deleted nodes are written as prefixes ending in `/`, which hide everything under the node. */
export function hiddenBy(deleted: Iterable<string>, key: string): boolean {
  for (const d of deleted) if (d.endsWith('/') ? key.startsWith(d) : key === d) return true;
  return false;
}

export function sliceRange(bytes: Uint8Array, range: RangeQuery): Uint8Array {
  if ('suffixLength' in range) return bytes.subarray(Math.max(0, bytes.length - range.suffixLength));
  return bytes.subarray(range.offset, range.offset + range.length);
}

export class LayeredStore implements Required<AsyncReadable> {
  /** `layers` run bottom to top. */
  constructor(private readonly base: Required<AsyncReadable>, private readonly layers: readonly Layer[]) {}

  private owner(key: string): Layer | 'base' | null {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (layer.has(key)) return layer;
      if (layer.hides(key)) return null;
    }
    return 'base';
  }

  async get(key: AbsolutePath, opts?: GetOptions): Promise<Uint8Array | undefined> {
    const owner = this.owner(key.slice(1));
    if (owner === null) return undefined;
    if (owner === 'base') return this.base.get(key, opts);
    return owner.read(key.slice(1));
  }

  async getRange(key: AbsolutePath, range: RangeQuery, opts?: GetOptions): Promise<Uint8Array | undefined> {
    const owner = this.owner(key.slice(1));
    if (owner === null) return undefined;
    if (owner === 'base') return this.base.getRange(key, range, opts);
    return sliceRange(await owner.read(key.slice(1)), range);
  }
}

/** The unsaved draft: objects held in memory until they are saved as a version. */
export class MemoryLayer implements Layer {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted = new Set<string>();

  has(key: string): boolean {
    return this.objects.has(key);
  }

  hides(key: string): boolean {
    return hiddenBy(this.deleted, key);
  }

  async read(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`the draft has no object ${key}`);
    return bytes;
  }

  put(objects: Iterable<[string, Uint8Array]>): void {
    for (const [key, bytes] of objects) this.objects.set(key, bytes);
  }

  /** Delete a node: drop what this draft wrote under it and hide what the layers below have. */
  deleteNode(path: string): void {
    const prefix = `${path}/`;
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key);
    this.deleted.add(prefix);
  }

  get isEmpty(): boolean {
    return this.objects.size === 0 && this.deleted.size === 0;
  }

  get bytes(): number {
    let total = 0;
    for (const b of this.objects.values()) total += b.length;
    return total;
  }
}

/** A saved version: the objects its manifest lists, read through `read`. */
export class SavedLayer implements Layer {
  private readonly keys: Set<string>;

  constructor(keys: Iterable<string>, private readonly deleted: readonly string[], readonly read: (key: string) => Promise<Uint8Array>) {
    this.keys = new Set(keys);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  hides(key: string): boolean {
    return hiddenBy(this.deleted, key);
  }
}

// Reopening a stack after each edit re-reads the same metadata and the same small chunks;
// the base is remote, so keep what it answered. Large objects (image tiles, whole
// matrices) go through uncached rather than crowding out the metadata.
export const CACHE_BUDGET_BYTES = 96 * 1024 * 1024;
export const CACHE_MAX_OBJECT_BYTES = 4 * 1024 * 1024;

export class CachedStore implements Required<AsyncReadable> {
  private readonly entries = new Map<string, Promise<Uint8Array | undefined>>();
  private readonly sizes = new Map<string, number>();
  private total = 0;

  constructor(private readonly inner: Required<AsyncReadable>) {}

  private remember(id: string, load: () => Promise<Uint8Array | undefined>): Promise<Uint8Array | undefined> {
    const hit = this.entries.get(id);
    if (hit) {
      // Re-insert: Map order is the eviction order.
      this.entries.delete(id);
      this.entries.set(id, hit);
      return hit;
    }
    const pending = load();
    this.entries.set(id, pending);
    pending.then(
      (bytes) => {
        if (!bytes || bytes.length > CACHE_MAX_OBJECT_BYTES) {
          this.entries.delete(id);
          return;
        }
        this.sizes.set(id, bytes.length);
        this.total += bytes.length;
        for (const old of this.entries.keys()) {
          if (this.total <= CACHE_BUDGET_BYTES) break;
          // A load still pending holds no counted bytes and is never evicted, so each
          // load settles against its own entry.
          const size = this.sizes.get(old);
          if (size === undefined) continue;
          this.total -= size;
          this.sizes.delete(old);
          this.entries.delete(old);
        }
      },
      () => this.entries.delete(id),
    );
    return pending;
  }

  get(key: AbsolutePath, opts?: GetOptions): Promise<Uint8Array | undefined> {
    return this.remember(key, () => this.inner.get(key, opts));
  }

  getRange(key: AbsolutePath, range: RangeQuery, opts?: GetOptions): Promise<Uint8Array | undefined> {
    const id = 'suffixLength' in range ? `${key}#-${range.suffixLength}` : `${key}#${range.offset}+${range.length}`;
    return this.remember(id, () => this.inner.getRange(key, range, opts));
  }
}
