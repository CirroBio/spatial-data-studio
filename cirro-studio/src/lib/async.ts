/** Maps over items with at most `limit` calls in flight; stops starting new ones once
 * `signal` aborts. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
