export type Snapshot = { name: string; url: string };

// Snapshot files are named `YYYY-MM-DDTHH-MM-SS_<slug>.html` (the time uses '-'
// separators). Split into a readable timestamp + slug label; fall back to the raw
// name when it doesn't match.
export function describe(name: string): { when: string; label: string } {
  const stamp = name.slice(0, 19);
  const iso = `${stamp.slice(0, 10)}T${stamp.slice(11).replace(/-/g, ':')}`;
  const d = new Date(iso);
  if (name[10] === 'T' && name[19] === '_' && !Number.isNaN(d.getTime())) {
    const slug = name.slice(20, -5);
    return {
      when: d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      label: slug || name,
    };
  }
  return { when: '', label: name };
}
