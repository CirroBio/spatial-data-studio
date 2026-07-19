import type { SnapshotConfig } from '../types';

// A saved snapshot as returned by GET /api/snapshots. `url` serves the JSON
// SnapshotConfig; `checkpoint_name` is the immutable .zarr.zip it reads from.
export type Snapshot = {
  name: string;
  url: string;
  label: string;
  created: string;  // ISO timestamp
  kind: 'spatial' | 'embedding';
  checkpoint_name: string;
};

// Fetch a snapshot's JSON config. Plain fetch (not the /api client) so the same
// SnapshotViewer works both in the app (served /snapshots/*.sview.json) and in the
// standalone bundle (relative snapshots/*.sview.json).
export async function fetchSnapshotConfig(url: string): Promise<SnapshotConfig> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`snapshot config ${url}: ${res.status}`);
  return res.json() as Promise<SnapshotConfig>;
}

// Format the ISO `created` timestamp for display; empty string if unparseable.
export function formatCreated(created: string): string {
  const d = new Date(created);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
