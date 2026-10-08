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
                    contrastRange: [number, number][];     // per channel [min, max] of the data
                    contrastLimits: [number, number][] }>, // per channel default contrast (1.1.0+)
    obsmKeys: Array<{ key: string; nComponents: number }>,
    shapes: string[],  // polygon shape elements the canvas can draw as boundaries (1.1.0+)
  }
}
```
   `contrastLimits` is the contrast a channel shows when the display sets none, so a
   host's contrast control can start where the canvas does. `shapes` lists the boundary
   sets a display's `shapes_layer` may name. Both were added in 1.1.0; a host should treat
   them as optional when it may talk to an older viewer.
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

### Folder stores

A checkpoint URL whose **path** ends in `/` names a `.zarr/` folder rather than a
`.zarr.zip` (1.1.0+). An object store has no single presigned URL for a folder, so in embed
mode the viewer asks the host to sign each object key and to list the folder. Keys and
prefixes are relative to the store root. The folder URL itself is never fetched, so any
URL under the folder with a trailing-slash path works (a presign of the folder key is
convenient).

Viewer -> parent:
```ts
{ source: 'sds-embed', version: 1, type: 'sign-keys', requestId: string, keys: string[] }
{ source: 'sds-embed', version: 1, type: 'list-keys', requestId: string, prefix: string }
```

Parent -> viewer:
```ts
{ source: 'cirro-dashboard', version: 1, type: 'signed-keys',
  requestId: string, urls: string[] | null }   // same order as keys; null = failed
{ source: 'cirro-dashboard', version: 1, type: 'listed-keys',
  requestId: string, keys: string[] | null }   // every key under prefix; null = failed
```

The viewer lists the whole folder once (`prefix: ''`) when it opens, and answers a key
absent from that listing as missing without fetching it. That keeps S3's 403-for-a-missing-key
(a presigner without ListBucket) from reading as an expired signature. It batches the
keys requested in one tick into one `sign-keys`, reuses a signature for four minutes, and
re-signs a listed key once if a GET answers 401/403. Requests unanswered for 15s reject.

A folder need not have been saved by this app. The viewer opens any consolidated Zarr v3
SpatialData store and derives the table, image manifests and default displays itself
(`packages/viewer/src/data/plainSpatialData.ts`). A store with images and no tables at all
opens image-only (1.1.2+): `ready` lists its images and no `obsmKeys`, and a display sets
`coords: null`. When the store holds nothing it can show (neither a table nor an image, a
table without `obsm/spatial`, Zarr v2, no consolidated metadata, not zarr at all), it
posts `error` with a message saying which.

## Handshake order

1. Parent creates iframe with `embed=1`.
2. Viewer loads checkpoint, mounts first (or saved-active) display, posts `ready`.
3. If the parent's node config already has a `display` payload, it posts
   `apply-display` immediately after `ready`. Otherwise it seeds its config from
   `ready.inventory.displays[0]` (or the active one) and persists that.
4. Thereafter: inspector edits -> `apply-display`; in-iframe edits -> `display-changed`
   -> parent patches node config (persisted with the dashboard).

## Dashboard node contract (implemented in @cirrobio/dashboard)

The host side lives in Cirro-portal's `packages/dashboard/src/views/spatialdata/`. The
viewer itself is deployed as the Cirro-tools `spatialdata` tool (this repo's release
`viewer-dist.tar.gz`, served unmodified at `/tools/spatialdata/`).

- Node type id: `'spatialdata'` (`NODE_TYPE.spatialData`).
- Config type `SpatialDataConfig`:
```ts
interface SpatialDataConfig {
  title: string;
  datasetId: string;
  datasetName: string;
  path: string;            // dataset-relative path to the .zarr.zip or .zarr folder
  display?: DisplayPayload & { id?: string };  // persisted display settings
}
```
  A node added from the dashboard's "+ Spatial" picker has no `display` until the viewer
  first opens, and then saves the one it starts on.
- Optional host capability in `SqlHostCapabilities`:
```ts
/** Directory of a deployed Spatial Data Studio viewer (holding index.html). When
 *  absent, or when datasetFileUrl is absent, spatialdata nodes render an explanatory
 *  placeholder instead of an iframe. */
readonly spatialViewerUrl?: string;
```
  The checkpoint URL, and every `refresh-checkpoint-url` answer, is signed through the
  existing `datasetFileUrl(projectId, datasetId, path)` capability.
- File and folder detection (do NOT widen isTabularFile):
```ts
isSpatialDataFile(path) === /\.zarr\.zip$/i.test(path)   // covers .sdata.zarr.zip
isSpatialDataFolder(path) === /\.zarr\/?$/i.test(path)   // any .zarr folder
```
  A `.zarr` folder is offered whether or not it is SpatialData; the viewer's `error` says
  when it is not something it can show. The host signs a folder's objects through
  `datasetFileUrl` and lists them from the dataset's file manifest.
- Persistence: settings-panel edits are always saved to the node. Viewer-side
  `display-changed` events (camera moves, display switches) are saved only while the
  tile's settings panel is open, so exploring a tile that is not locked
  (`lock_view`) leaves its saved framing alone.
