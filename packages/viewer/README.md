# @cirrobio/spatial-viewer

The WebGL spatial and embedding canvases from [Spatial Data Studio](../../README.md),
plus the checkpoint reader that feeds them, as a library. Spatial Data Studio renders
its canvas from this package; a Cirro dashboard tile can import the same components
instead of embedding the whole app in an iframe. **One source of truth for the canvas.**

## What's in it

- `SpatialCanvas` / `EmbeddingCanvas` — the deck.gl canvases, with their layers,
  legends, minimap, cell selection (lasso plus the circle/ellipse/square/rectangle
  tools of `selectionShapes`) and shape-annotation editing.
- `CanvasHostProvider` — the contract a host implements to drive them (see below).
- `DataSourceProvider` + `openCheckpoint` — the read surface the canvases render
  through, and the `.zarr.zip` reader that implements it over HTTP Range with zarrita
  and no backend at all. `openCheckpoint` also returns the file's `app_state`, its field
  inventory, and its `figures` index (which plots it carries a rendered figure for);
  `DataSource.getPlotFigure(plotId, format)` reads one as a blob, so a host can show the
  saved SVG/PDF/PNG figures without a backend.
- The display model (`DisplaySpec`, `DisplayEncoding`, `SessionFields`, `ImageInfo`, …)
  and `SPATIAL_ENCODING_DEFAULTS` / `EMBEDDING_ENCODING_DEFAULTS` — the fallbacks the
  canvases apply for absent encoding fields, so a host authoring a display agrees with
  what the canvas will actually render.

## Using it

```tsx
import {
  CanvasHostProvider, DataSourceProvider, SpatialCanvas, openCheckpoint,
} from '@cirrobio/spatial-viewer';

const { source, appState } = await openCheckpoint(url);

<DataSourceProvider source={source}>
  <CanvasHostProvider host={host}>
    <SpatialCanvas
      display={display}
      sessionId={id}
      canvasMode={null}
      annotationTarget={null}
      followDisplayViewport
    />
  </CanvasHostProvider>
</DataSourceProvider>
```

`CanvasHost` is the only seam between the canvases and whoever is hosting them: the
field inventory, the data versions, the theme, the edit gate, and `onDisplayChange` —
the host decides what persisting a display edit means. Cell selection, shape
annotations and snapshot export are optional groups; omit one and the canvas turns
that feature off, affordances included, rather than offering a control that does
nothing.

### No stylesheet

The package ships no CSS. The in-canvas overlays (legends, hints, minimap, loading
cues) carry their own inline styles, which read the host's theme tokens
(`--color-surface`, `--color-text`, …, as space-separated RGB channels) when they are
defined and fall back to a dark palette when they are not.

An in-canvas settings panel is *not* included — it is host UI. Both canvases take an
optional `controls` slot that receives the canvas-internal state a panel needs
(channels, the live camera, the resolved legend); pass nothing for a bare canvas.

## Peer dependencies — you must dedupe

`@deck.gl/*`, `@luma.gl/*` and `@math.gl/*` are peers, never dependencies. deck.gl
registers layers on a module-level registry and checks `instanceof` across package
boundaries, so a second copy of any of them silently breaks picking and layer updates.
Viv (`@vivjs/*`) pulls its own copies, so a consumer must force a single one — this
repo does it with Vite's `resolve.dedupe`:

```js
resolve: {
  dedupe: ['@deck.gl/core', '@luma.gl/core', '@luma.gl/engine', '@luma.gl/webgl', '@math.gl/core'],
}
```

`apache-arrow` is a peer, and `>=17` rather than the `>=13` it used to be, because
`usePolygonBbox` builds Arrow objects and hands them to the host's
`GeoArrowPolygonLayer`: the two must be the *same* copy, and `@geoarrow/deck.gl-layers`
imports `Duration`, which arrow added after 13. A host on 13 therefore cannot serve this
package — it fails at bundle time on that export, or silently hands geoarrow objects from
a copy it does not share. Do not "fix" that by moving `apache-arrow` to `dependencies`:
a nested copy puts a different Arrow on each side of exactly the call this range exists
to protect. The host has to supply one copy `>=17`, deduped with `@geoarrow/*`.

The package is **not** `"type": "module"`: apache-arrow 13 has no `types` export
condition, so a CJS-typed package resolves its `Arrow.dom.d.ts` while an ESM one does
not — which is what lets a consumer still type-checking against an older arrow resolve
these declarations at all. Do not add `"type": "module"`.

## Releasing

Nothing is published yet, and `package.json` deliberately declares no `license` —
neither this repo nor `frontend/package.json` declares one, so picking a license for
the extracted package is a decision for a human, not a default to invent. Set it
before publishing.

To make this consumable outside the repo, a human has to either:

- **Publish to npm** — `npm publish -w @cirrobio/spatial-viewer` under the `@cirrobio`
  scope (`--access public` if the scope is public), after bumping `version`. Consumers
  then take a normal semver range.
- **Or reference it from git**, the way `Cirro-portal` references `Cirro-components`: a
  dependency on `github:CirroBio/squidpy-viewer#<ref>` with the package under
  `packages/viewer`. That needs `dist/` to be committed or a `prepare` script that
  builds it on install, since git installs run no publish pipeline.

Either way `npm run build` (Vite library mode + `tsc --emitDeclarationOnly`) is what
produces `dist/`, and the app is built from the same sources by the repo root's
`npm run build`.
