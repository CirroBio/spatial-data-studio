// Single-flight fetch dedup, scoped to the client-compositing raster route
// (/api/sessions/{sid}/raster/{element}/...). Viv's vendored zarrita FetchStore
// (@vivjs/loaders -> @zarrita/storage) does a plain `fetch()` per chunk key with no
// caching of its own, and rasters.py packs every channel of a tile into one chunk
// file (chunks=(C, TILE, TILE)) — so an N-channel image's per-channel `getTile`
// calls (useVivImageLayer.ts) all resolve to the SAME chunk URL and, unpatched,
// each issue their own physical fetch of identical bytes. There is no store- or
// fetch-injection hook in loadOmeZarr to fix this cleanly, so this wraps
// `window.fetch` globally but only intercepts GET requests matching the raster
// route — every other fetch in the app (Arrow data, GeoArrow, session state, SSE)
// passes straight through the original implementation, untouched.
const RASTER_PATH_RE = /\/api\/sessions\/[^/]+\/raster\//;

let installed = false;
const inFlight = new Map<string, Promise<Response>>();

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

/** Install the dedup wrapper once (idempotent — safe to call from every render). */
export function installRasterFetchDedup(): void {
  if (installed) return;
  installed = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (requestMethod(input, init) !== 'GET' || !RASTER_PATH_RE.test(url)) {
      return originalFetch(input, init);
    }
    const existing = inFlight.get(url);
    if (existing) return existing.then((res) => res.clone());

    const promise = originalFetch(input, init);
    inFlight.set(url, promise);
    // Never let a rejected fetch wedge the map (next caller must retry, not hang).
    promise.catch(() => {}).finally(() => inFlight.delete(url));
    // Every caller — including this first one — consumes a clone, so the cached
    // Response itself is never read and stays clonable for the next concurrent caller.
    return promise.then((res) => res.clone());
  };
}
