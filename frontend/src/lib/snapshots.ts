// A saved snapshot figure as returned by GET /api/snapshots. A snapshot is a rendered
// figure (vector PDF and/or raster PNG) of a display, not a re-openable session; the
// deliverables are downloaded, and `metadata` carries the full provenance embedded in
// each file (see backend/app/snapshots.py).
export type SnapshotFormat = 'pdf' | 'png';

export interface SnapshotMetadata {
  label: string;
  created: string;
  dataset?: string;
  kind: 'spatial' | 'embedding';
  formats: SnapshotFormat[];
  output: { width_px: number; height_px: number; dpi: number };
  viewport: { target?: number[]; zoom?: number };
  encoding: Record<string, unknown>;
  render: { rasterized_points?: boolean; image_element?: string | null; cells_in_view?: number };
  recipe: { namespace: string; function: string; params: Record<string, unknown> }[];
}

export type Snapshot = {
  name: string;   // the `<base>.figure.json` sidecar name — the handle for every route
  base: string;
  label: string;
  created: string;  // ISO timestamp
  kind: 'spatial' | 'embedding';
  dataset?: string;
  formats: SnapshotFormat[];
  output: { width_px: number; height_px: number; dpi: number };
  thumbnail_url: string;
  metadata: SnapshotMetadata;
};

// The live framing a canvas hands to the export modal when the user hits Save Snapshot.
export interface SnapshotExportParams {
  sessionId: string;
  displayId: string;
  kind: 'spatial' | 'embedding';
  viewport: { target: number[]; zoom: number };
  canvasSize: { width: number; height: number };  // seeds the default output aspect/size
  label: string;
}

// Format the ISO `created` timestamp for display; empty string if unparseable.
export function formatCreated(created: string): string {
  const d = new Date(created);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
