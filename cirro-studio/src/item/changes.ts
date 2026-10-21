import type { Change } from '../stack/manifest';

/** A change in the words the history and the save dialog show; `withNote` adds how it
 * was made, where the change carries that. */
export function describeChange(c: Change, withNote = true): string {
  const note = (n?: string) => (withNote && n ? ` (${n})` : '');
  switch (c.op) {
    case 'set-obs': return `${c.kind === 'categorical' ? 'Groups' : 'Values'} “${c.column}”${note(c.note)}`;
    case 'delete-obs': return `Removed “${c.column}”`;
    case 'set-obsm': return `Embedding “${c.key}”${note(c.note)}`;
    // A result's note is what it is ("Neighborhood enrichment of leiden"); its key is an id.
    case 'set-uns': return `Result “${c.note ?? c.path[c.path.length - 1]}”`;
    case 'delete-uns': return `Removed result “${c.path[c.path.length - 1]}”`;
    case 'set-figure': return `Figure “${c.title}”`;
    case 'delete-figure': return `Removed figure “${c.title}”`;
  }
}

export const isRemoval = (c: Change) => c.op.startsWith('delete-');

/** A default title for a version from what it changes. */
export function suggestTitle(changes: Change[]): string {
  const added = changes.filter((c) => !isRemoval(c));
  if (!added.length) return 'Removed results';
  const first = describeChange(added[0], false).replace(/[“”]/g, '');
  return added.length === 1 ? first : `${first} and ${added.length - 1} more`;
}
