# Spatial Data Studio frontend

React/TypeScript SPA for the Spatial Data Studio spatial omics analysis tool.

The WebGL canvas itself is not here: it lives in
[`packages/viewer`](../packages/viewer/README.md) (`@cirrobio/spatial-viewer`), a
workspace sibling this app depends on, so a Cirro dashboard can render the same
canvas natively. What stays here is the app around it — the store, the REST layer,
the panels, and the Tailwind-styled in-canvas control panels the app passes into the
canvas' `controls` slot.

## Stack

- Vite 6 + React 19 + TypeScript 5 (strict)
- Tailwind CSS 3
- deck.gl 9 (`OrthographicView` for 2D world-coordinate spatial/embedding scatter;
  `OrbitView` + `PointCloudLayer` for the 3D embeddings mode)
- apache-arrow 18 (Arrow IPC field data decoding)
- Radix UI (dialog, dropdown-menu, tabs, tooltip)
- react-hook-form
- zustand (global state)

## Development

```sh
npm install      # run it at the repo root: one npm workspace covers this app and packages/viewer
npm run dev      # serves on http://localhost:5173, proxies /api -> http://127.0.0.1:8000
```

Vite resolves `@cirrobio/spatial-viewer` to `packages/viewer/src` (an alias in
`vite.config.ts`, mirrored by `paths` in `tsconfig.app.json`), so canvas edits hot-
reload and typechecking needs no build of the library first.

The backend must be running at `http://127.0.0.1:8000`. Vite proxies all `/api`
requests there, including the `/api/events` SSE stream (buffering disabled via
`x-accel-buffering: no`).

## Build

```sh
npm run build    # from the repo root: builds packages/viewer, then tsc -b && vite build -> frontend/dist/
npm run preview  # serve the production build
```

## Layout

- `src/api.ts` — fetch wrappers and Arrow IPC field fetching
- `src/types.ts` — the app's own domain types (registry, sessions, jobs, SSE); the
  display model the canvas renders from comes from `@cirrobio/spatial-viewer`
- `src/store/sessionStore.ts` — global zustand store
- `src/hooks/useSSE.ts` — single multiplexed EventSource connection
- `src/hooks/useSession.ts` — active session loading
- `src/hooks/usePresence.ts` — viewer heartbeat + the lock-state / edit-gate selectors
- `src/lib/presence.ts` — this browser's id + display name, and what the session lock means for it
- `src/data/apiSource.ts` — the live-session `DataSource` the canvas reads through
- `src/components/StudioCanvasHost.tsx` — the app's implementation of the library's
  `CanvasHost` contract, built from the store; the only place the store and the canvas meet
- `src/components/canvas/StudioSpatialCanvas.tsx` /
  `StudioEmbeddingCanvas.tsx` — the library canvas with the app's control panel in its
  `controls` slot; the panels themselves (`CanvasControls`, `EmbeddingControls`,
  `ColorBySelect`, `CanvasSettingsShell`, `RangeField`, `DualRangeField`) are the only
  canvas files left in this app, and they are here because they are Tailwind-styled
- `src/hooks/useDisplayPersistence.ts` — optimistic store write + debounced display PUT
- `src/components/forms/FunctionForm.tsx` — schema-driven function parameter form

## Theming

The app follows Cirro's visual identity. Colors are declared once as CSS custom
properties in `src/index.css` — `--color-bg/surface/border/text/muted/accent/
on-accent/accent-lo/success/warn/danger`, each as space-separated RGB channels so
Tailwind's `/<alpha>` modifiers keep working — and exposed as Tailwind color names in
`tailwind.config.js`. Components only ever use those names (`bg-surface`,
`text-accent`, …), never a literal color, so a palette change is a one-file edit.

Both themes derive from the Cirro palette in `@cirrobio/ui`'s `theme/theme.ts`
(`Cirro-components` repo): light is that palette as the portal uses it; dark recasts it
onto the brand's deep navy with the logo's bright teal as the accent, since a viewer for
microscopy imagery wants a dark surround. Dark is the default; the theme is persisted in
`localStorage` and applied as `data-theme` on `<html>` (`store/sessionStore.ts`).
`--color-on-accent` is the foreground for anything filled with a brand color, which is
what keeps a solid accent button legible in both.

Two colors are *not* theme tokens and must not be swapped for brand colors:
`CATEGORY_COLORS` and the viridis ramp in the canvas library's `canvas/colorUtils.ts`
encode data, not chrome, and `CHANNEL_COLORS` mirrors the backend's channel defaults.
The library's in-canvas overlays carry inline styles rather than Tailwind classes (it
ships no stylesheet), but they read these same `--color-*` tokens, so they follow the
app theme here and fall back to the dark palette in a host that defines none.
`PLOT_BACKGROUNDS` there tracks `--color-bg` per theme and is mirrored in `backend/app/snapshots.py` so an
exported figure matches the canvas it came from.

Typography is Geist / Geist Mono (`@fontsource-variable/*`, self-hosted so the Docker
image renders branded offline). `components/CirroMark.tsx` draws the Cirro mark, static
in the header and as the counter-rotating loader on the startup splash;
`public/favicon.svg` holds the same geometry for the browser tab.

## Rendering approach

The spatial canvas uses a deck.gl `OrthographicView` because the data lives in 2D
world coordinates (microns), not a geographic projection. Cell/spot centroids are
fetched as Arrow IPC (`/api/sessions/{id}/data/obsm:spatial`), decoded into a single
interleaved `Float32Array` of `[x0,y0,x1,y1,...]`, and bound to a `ScatterplotLayer`
as a binary attribute via `data.attributes` (not per-row accessor functions):

```ts
new ScatterplotLayer({
  data: { length: n, attributes: {
    getPosition: { value: positions, size: 2 },
    getFillColor: { value: colors, size: 4, normalized: true },
  }},
  radiusUnits: 'pixels',
});
```

Colors are precomputed on the CPU into a `Uint8Array`: categorical obs fields use a
palette keyed by category value (stable across recompute), numeric fields and
`X:<gene>` use a viridis lookup. The tissue image is drawn as a `BitmapLayer` placed
at the image element's world `bounds` (from `/image/{element}/info`), sharing the
same coordinate space as the spots so they register exactly.
