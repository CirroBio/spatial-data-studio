# Cirro Dashboard <-> Spatial Data Studio embed protocol (v1)

Shared contract between:
- squidpy-viewer (Spatial Data Studio, "SDS", the embedded serverless viewer)
- @cirrobio/dashboard (the `spatialdata` dashboard node that hosts it in an iframe)

## Iframe URL

```
<viewerBase>/index.html?checkpoint=<urlencoded checkpoint url>&embed=1
```

- `embed=1` implies serverless/read-only mode (checkpoint mode already forces
  `read_only: true`). Additionally, embed mode:
  - hides the app header and left sidebar entirely (no toggle),
  - hides the checkpoint picker / index landing page,
  - suppresses all display-persistence PUTs (already no-oped in read-only),
  - hides the in-canvas controls (CanvasControls / EmbeddingControls) as well:
    the host's own inspector owns every display setting, so leaving these up
    would be a second, competing control surface over the same state.

  The canvas stays fully interactive (pan, zoom, hover, picking). Camera moves
  are still user edits, so they continue to stream out as `display-changed`.

## Message envelope

Every message is `postMessage`d with `targetOrigin='*'` for v1 (local testing;
the dashboard side validates `event.source === iframe.contentWindow` and
`event.data?.source` below; tighten origins later).

- Viewer -> parent: `{ source: 'sds-embed', version: 1, type, ... }`
- Parent -> viewer: `{ source: 'cirro-dashboard', version: 1, type, ... }`

Both sides ignore messages whose `source`/`version` don't match.

## Display payload type

`DisplayPayload` is exactly the SDS persisted shape (subset of `DisplaySpec`
from `@cirrobio/spatial-viewer`, without `id`/`name`):

```ts
type DisplayPayload =
  | { kind: 'spatial_canvas'; encoding: DisplayEncoding; viewport: Viewport | null }
  | { kind: 'embedding_canvas'; encoding: EmbeddingEncoding; viewport: Viewport | null }
```

`DisplayEncoding`, `EmbeddingEncoding`, `Viewport` are the existing SDS types
(types.ts L131-215). The dashboard mirrors these field-for-field in its node
config (`SpatialDataDisplay` in the dashboard package) — same field names
(snake_case as persisted by SDS), same optionality, same defaults semantics
(missing optional field = SDS default).

## Messages: viewer -> parent

1. `ready` — sent once the checkpoint is open and the first display is mounted:
```ts
{
  source: 'sds-embed', version: 1, type: 'ready',
  inventory: {
    displays: Array<{ id: string; name: string } & DisplayPayload>, // saved displays in app_state order
    obsColumns: Array<{ name: string; kind: 'categorical' | 'numeric' }>,
    images: Array<{ element: string; channelNames: string[]; isRgb: boolean;
                    contrastRange: [number, number][] }>,
    obsmKeys: Array<{ key: string; nComponents: number }>,
  }
}
```
2. `display-changed` — debounced (<=500ms) whenever the ACTIVE display's
   encoding or viewport changes in-iframe (user pans/zooms or uses in-canvas
   controls):
```ts
{ source: 'sds-embed', version: 1, type: 'display-changed', display: DisplayPayload }
```
3. `search-vars-result` — response to `search-vars`:
```ts
{ source: 'sds-embed', version: 1, type: 'search-vars-result', requestId: string, names: string[] }
```
4. `error` — checkpoint failed to open:
```ts
{ source: 'sds-embed', version: 1, type: 'error', message: string }
```

## Messages: parent -> viewer

1. `apply-display` — full replacement of the active display's encoding+viewport
   (viewer applies it to its store exactly as if the user had made the edits;
   `viewport: null` means auto-fit):
```ts
{ source: 'cirro-dashboard', version: 1, type: 'apply-display', display: DisplayPayload }
```
   Applying MUST NOT re-emit `display-changed` (guard against echo loops).
2. `select-display` — switch the active display to one of the saved displays by id:
```ts
{ source: 'cirro-dashboard', version: 1, type: 'select-display', displayId: string }
```
   Viewer responds with a `display-changed` carrying the newly active display's payload.
3. `search-vars` — gene-name search for the inspector's color-by autocomplete:
```ts
{ source: 'cirro-dashboard', version: 1, type: 'search-vars', requestId: string, query: string, limit?: number }
```

### Checkpoint URL refresh

Embed hosts sign checkpoint URLs for a short window (Cirro presigns S3 GETs for
minutes), but a viewing session lasts as long as someone keeps looking, and the
reader issues range GETs the whole time. Rather than guessing a TTL, the viewer
re-signs on demand.

Viewer -> parent:
```ts
{ source: 'sds-embed', version: 1, type: 'refresh-checkpoint-url', requestId: string }
```

Parent -> viewer:
```ts
{ source: 'cirro-dashboard', version: 1, type: 'checkpoint-url',
  requestId: string, url: string | null }   // null = re-signing failed
```

Flow: a range GET answered 401/403 (how S3 reports an expired presign) makes the
reader request a fresh URL, swap it in, and retry that read once. A second
failure propagates as a normal read error, so a genuine permission problem is
not retried forever. Concurrent reads that all expire at the same moment share
one re-sign rather than each asking for their own, and a request that goes
unanswered for 15s rejects.

## Handshake order

1. Parent creates iframe with `embed=1`.
2. Viewer loads checkpoint, mounts first (or saved-active) display, posts `ready`.
3. If the parent's node config already has a `display` payload, it posts
   `apply-display` immediately after `ready`. Otherwise it seeds its config from
   `ready.inventory.displays[0]` (or the active one) and persists that.
4. Thereafter: inspector edits -> `apply-display`; in-iframe edits -> `display-changed`
   -> parent patches node config (persisted with the dashboard).

## Dashboard node contract (implemented in @cirrobio/dashboard)

- Node type id: `'spatialdata'` (NODE_TYPE.spatialdata).
- Config type `SpatialDataConfig`:
```ts
interface SpatialDataConfig {
  datasetId: string;
  datasetName?: string;
  path: string;            // dataset-relative path to the .zarr.zip
  sizeBytes?: number;
  title?: string;
  display?: DisplayPayload & { id?: string };  // persisted display settings
}
```
- New OPTIONAL host capability in SqlHostCapabilities:
```ts
/** Base URL of a deployed Spatial Data Studio serverless viewer build
 *  (directory containing index.html). When absent, spatialdata nodes render
 *  an explanatory placeholder instead of an iframe. */
spatialViewerUrl?: () => Promise<string> | string;
```
- File detection predicate (do NOT widen isTabularFile):
```ts
isSpatialDataFile(path) === /\.zarr\.zip$/i.test(path)   // covers .sdata.zarr.zip
```
