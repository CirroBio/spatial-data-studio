// A zarr store for a SpatialData `.zarr/` FOLDER on object storage that is readable only
// through per-object presigned URLs (Cirro's S3 buckets). A folder has no single URL to
// sign, so the host signs keys on request and lists what the folder holds.
//
// The listing is what makes missing keys cheap and unambiguous: zarr probes for nodes
// that may not exist, and a presigned GET for an absent S3 key answers 403 — the same
// status as an expired signature — unless the signer may list the bucket. Answering
// "absent" from the listing means a 403 can only ever mean "re-sign".
import type { AbsolutePath, AsyncReadable, RangeQuery } from '@zarrita/storage';

/** What the host provides to read a folder store. Keys and prefixes are relative to the
 *  store root (no leading slash). */
export interface FolderAccess {
  /** Presigned GET URLs for `keys`, in the same order. */
  signKeys(keys: readonly string[]): Promise<readonly string[]>;
  /** Every object key under `prefix`; `''` lists the whole store. */
  listKeys(prefix: string): Promise<readonly string[]>;
}

// Signatures are reused for less than the shortest lifetime a Cirro host issues (five
// minutes), so a cached URL never goes stale mid-request.
const SIGNED_URL_TTL_MS = 4 * 60 * 1000;
const EXPIRED_URL_STATUSES = new Set([401, 403]);

function rangeHeader(range: RangeQuery): string {
  return 'suffixLength' in range
    ? `bytes=-${range.suffixLength}`
    : `bytes=${range.offset}-${range.offset + range.length - 1}`;
}

export class HostSignedFolderStore implements Required<AsyncReadable> {
  private readonly signed = new Map<string, { url: string; at: number }>();
  // Keys waiting for the next batch signature, with the callers waiting on each.
  private pending = new Map<string, Array<{ resolve: (url: string) => void; reject: (err: unknown) => void }>>();
  private flushScheduled = false;

  private constructor(private readonly access: FolderAccess, private readonly keys: ReadonlySet<string>) {}

  /** Lists the folder once, then serves reads from it. */
  static async open(access: FolderAccess): Promise<HostSignedFolderStore> {
    return new HostSignedFolderStore(access, new Set(await access.listKeys('')));
  }

  /** The folder's keys, for callers that need to enumerate (e.g. parquet part files). */
  listing(): ReadonlySet<string> {
    return this.keys;
  }

  async get(key: AbsolutePath): Promise<Uint8Array | undefined> {
    return this.fetchKey(key.slice(1), undefined);
  }

  async getRange(key: AbsolutePath, range: RangeQuery): Promise<Uint8Array | undefined> {
    return this.fetchKey(key.slice(1), rangeHeader(range));
  }

  private async fetchKey(key: string, range: string | undefined): Promise<Uint8Array | undefined> {
    if (!this.keys.has(key)) return undefined;
    const init = range ? { headers: { Range: range } } : undefined;
    let res = await fetch(await this.sign(key), init);
    if (EXPIRED_URL_STATUSES.has(res.status)) {
      // The key exists (it is listed), so this is an expired signature: re-sign once.
      this.signed.delete(key);
      res = await fetch(await this.sign(key), init);
    }
    if (!res.ok) throw new Error(`GET ${key} failed: ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private sign(key: string): Promise<string> {
    const cached = this.signed.get(key);
    if (cached && Date.now() - cached.at < SIGNED_URL_TTL_MS) return Promise.resolve(cached.url);
    return new Promise((resolve, reject) => {
      const waiters = this.pending.get(key) ?? [];
      waiters.push({ resolve, reject });
      this.pending.set(key, waiters);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        // One round trip for every key requested in the same tick: opening an image
        // level asks for dozens of chunks at once.
        queueMicrotask(() => this.flush());
      }
    });
  }

  private flush(): void {
    this.flushScheduled = false;
    const batch = this.pending;
    this.pending = new Map();
    const keys = [...batch.keys()];
    this.access.signKeys(keys).then(
      (urls) => {
        const at = Date.now();
        keys.forEach((key, i) => {
          const url = urls[i];
          const waiters = batch.get(key) ?? [];
          if (!url) {
            waiters.forEach((w) => w.reject(new Error(`the host could not sign ${key}`)));
            return;
          }
          this.signed.set(key, { url, at });
          waiters.forEach((w) => w.resolve(url));
        });
      },
      (err: unknown) => batch.forEach((waiters) => waiters.forEach((w) => w.reject(err))),
    );
  }
}
