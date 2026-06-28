# squidpy-viewer frontend

React/TypeScript SPA for the squidpy-viewer spatial omics analysis tool.

## Stack

- Vite 5 + React 18 + TypeScript 5 (strict)
- Tailwind CSS 3
- deck.gl 9 (`OrthographicView` for 2D world-coordinate spatial data)
- apache-arrow 18 (Arrow IPC field data decoding)
- Radix UI (dialog, dropdown-menu, tabs, tooltip)
- react-hook-form
- zustand (global state)

## Development

```sh
npm install
npm run dev      # serves on http://localhost:5173, proxies /api -> http://127.0.0.1:8000
```

The backend must be running at `http://127.0.0.1:8000`. Vite proxies all `/api`
requests there, including the `/api/events` SSE stream (buffering disabled via
`x-accel-buffering: no`).

## Build

```sh
npm run build    # tsc -b && vite build -> dist/
npm run preview  # serve the production build
```

## Layout

- `src/api.ts` — fetch wrappers and Arrow IPC field fetching
- `src/types.ts` — domain types mirroring the backend API contract
- `src/store/sessionStore.ts` — global zustand store
- `src/hooks/useSSE.ts` — single multiplexed EventSource connection
- `src/hooks/useSession.ts` — active session loading
- `src/hooks/useArrowField.ts` — Arrow field fetching, cached by `sessionId:fieldPath:version`
- `src/components/canvas/SpatialCanvas.tsx` — deck.gl spatial canvas (tissue image + spots)
- `src/components/forms/FunctionForm.tsx` — schema-driven function parameter form

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
