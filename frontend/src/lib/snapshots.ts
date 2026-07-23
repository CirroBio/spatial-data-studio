// A saved snapshot as returned by GET /api/snapshots. `url` is the endpoint that
// opens it as a read-only, in-app session pinned to the saved view
// (POST /api/snapshots/{name}/open) — see api.ts::openSnapshot.
export type Snapshot = {
  name: string;
  url: string;
  label: string;
  created: string;  // ISO timestamp
  kind: 'spatial' | 'embedding';
  checkpoint_name: string;
};

// Format the ISO `created` timestamp for display; empty string if unparseable.
export function formatCreated(created: string): string {
  const d = new Date(created);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
