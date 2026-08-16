// The read surface the canvas needs, independent of where the data lives.
//
// Two implementations: `apiSource` talks to a live session over the HTTP API;
// `checkpointSource` reads a `.zarr.zip` checkpoint directly over HTTP Range with
// zarrita and no backend at all (DESIGN §14). Everything downstream of this
// interface — palettes, point styling, channel shaders, legends, the minimap —
// already works off plain typed arrays and is shared unchanged.
//
// Only the *render* path is here. Writes (compute, subsetting, region assignment,
// figure export, display persistence) stay on `api.ts` and are gated by `canEdit`,
// which is false for a checkpoint.
import type { Table } from 'apache-arrow';
import type { ImageInfo } from '../types';

// Viv's multiscale pyramid handle: `loadOmeZarr(...).data`, a PixelSource per level.
export type ImageLoader = Awaited<ReturnType<typeof import('@vivjs/loaders')['loadOmeZarr']>>['data'];

// A categorical column built in the browser (lasso labelling in the serverless
// viewer), in the same shape `arrowToColorSource` produces from a fetched one.
export interface LocalCategorical {
  categories: string[];
  codes: Int32Array;
}

// Everything a SpatialData object holds, as the `/elements` route reports it: the
// boundary overlay picks its polygonal shape sets out of this, and the data
// inspector pages the tables.
export interface ElementInventory {
  tables: { name: string; n_obs: number; n_vars: number; active: boolean }[];
  shapes: { name: string; count: number; geometry: string[]; columns: string[] }[];
  points: { name: string; columns: string[] }[];
  images: { name: string }[];
  labels: { name: string }[];
}

export interface DataSource {
  readonly kind: 'live' | 'checkpoint';
  // Stable identity for cache keys. The session id, or the checkpoint's URL.
  readonly id: string;

  // Arrow table for a `<element>:<key>` field path, in the schema
  // `transport/arrow.py:resolve_field` emits: `obsm:` -> d0/d1(/d2) float32;
  // categorical `obs:` -> an int32 `code` column with `kind`/`categories` schema
  // metadata; everything else -> a single `value` column.
  getFieldData(fieldPath: string): Promise<Table>;

  getImageInfo(element: string): Promise<ImageInfo>;

  // Open the element's multiscale pyramid for Viv. The source owns store
  // construction so the caller never builds a URL or a zarr store itself.
  openImageLoader(element: string): Promise<ImageLoader>;

  // Viewport-clipped boundary polygons as GeoArrow (geometry + int32 cell_index) in
  // the coords world space. Empty table when the bbox holds more than `limit` cells.
  // Optional: a source that can't supply boundaries leaves the Cells layer on its
  // points-only path, the same fallback as a display with no shapes element.
  getShapesGeoArrow?(
    element: string, bbox: [number, number, number, number], limit?: number,
  ): Promise<Table>;

  // Optional for the same reason — the boundary overlay is what looks up which
  // shape sets are polygonal.
  getElements?(): Promise<ElementInventory>;

  // URL of a server-composited thumbnail for the minimap inset, or null when the
  // source can't produce one — the inset then draws the cell scatter, the same
  // fallback it uses when the image layer is off.
  imageThumbnailUrl(element: string, channels: string | undefined, maxPx: number): string | null;

  searchVarNames(query: string, limit?: number): Promise<string[]>;

  // Install a browser-only column that `getFieldData` serves for `fieldPath`,
  // shadowing anything of that name in the store. Present only on a checkpoint: a
  // live session labels cells by writing a real obs column through the backend, so
  // labels there survive, feed compute, and are shared with other viewers.
  setLocalColumn?(fieldPath: string, column: LocalCategorical): void;
}
