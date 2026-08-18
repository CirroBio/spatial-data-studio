import { ApiError } from './apiError';

// A read endpoint fast-fails with 503 while a job holds the session write lock
// (backend: _read_locked / READ_LOCK_TIMEOUT_S) — most notably during the async
// checkpoint load that runs as a session's first job, which 503s every canvas read
// (coords, colors, image info, raster chunks) until it frees the lock. Retry with
// backoff so state converges once the lock frees, without surfacing a transient
// "busy" error. Non-503 errors propagate immediately. `signal` stops the retry loop
// promptly when the caller aborts (superseded fetch / unmount).
export async function fetchWhenIdle<T>(
  fn: () => Promise<T>,
  { tries = 6, delayMs = 2000, signal }: { tries?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await fn();
    } catch (err) {
      if (attempt < tries && err instanceof ApiError && err.status === 503 && !signal?.aborted) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delayMs);
          // Removed when the timer wins: `once` only fires the listener once, it does not
          // detach it on the non-abort path, so a long-lived signal (one canvas mount
          // spanning many field/image fetches) accumulated one listener per retry.
          function onAbort() {
            clearTimeout(timer);
            reject(new DOMException('aborted', 'AbortError'));
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        continue;
      }
      throw err;
    }
  }
}
