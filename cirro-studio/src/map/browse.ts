// An open stage read as a tree of its Cirro folders: what each folder holds and weighs, the
// rows shown for the folders that are open (or every item, as a flat list), each item's
// facts in words, the facts every item shares (said once, above the tree) and the kinds of
// fact that split them (offered as filters).
import type { StageNode } from './nodes';

/** A fact about an item in words. Facts of one `key` are of a kind: shared by every item, it
 * is said once; splitting them, it can filter the stage. `group` is what a filter on it is
 * called when that differs from the text ("made into a store" for "made into 2 stores");
 * `all`, how it is said of every item when "all <text>" wouldn't read ("none with versions yet"). */
export interface Fact { key: string; text: string; group?: string; all?: string }
/** A shared fact as the line above the tree says it. */
export const saidOfAll = (f: Fact) => f.all ?? `all ${f.text}`;
export const groupOf = (f: Fact) => f.group ?? f.text;
export const filterId = (f: Pick<Fact, 'key'> & { text: string }) => `${f.key}:${f.text}`;
// The kinds of fact a stage can be filtered by; the rest only describe.
const FILTERABLE = new Set(['format', 'platform', 'progress', 'kind', 'versions', 'source', 'browser', 'credit']);

export interface TreeFolder {
  kind: 'folder';
  // `folder:` and its path ("Human/Lung"), apart from any item's key.
  id: string;
  name: string;
  children: TreeNode[];
  items: number;
  bytes: number;
  // Every size inside, for the folder's ticks on the ruler.
  sizes: number[];
  newest: string;
}
export interface TreeItem { kind: 'item'; id: string; node: StageNode }
export type TreeNode = TreeFolder | TreeItem;

const FOLDER = 'folder:';
export const folderId = (path: string) => `${FOLDER}${path}`;
const folder = (path: string): TreeFolder => ({
  kind: 'folder', id: folderId(path), name: path.slice(path.lastIndexOf('/') + 1), children: [], items: 0, bytes: 0, sizes: [], newest: '',
});

/** The folders from the items' first Cirro folder; items in none sit at the top, after the folders. */
export function buildTree(nodes: StageNode[]): TreeFolder {
  const root = folder('');
  const byPath = new Map([['', root]]);
  const at = (path: string): TreeFolder => {
    const known = byPath.get(path);
    if (known) return known;
    const f = folder(path);
    byPath.set(path, f);
    at(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '').children.push(f);
    return f;
  };
  for (const n of nodes) at(n.folders[0] ?? '').children.push({ kind: 'item', id: n.key, node: n });
  const total = (f: TreeFolder) => {
    for (const c of f.children) {
      if (c.kind === 'folder') {
        total(c);
        f.items += c.items;
        f.bytes += c.bytes;
        f.sizes.push(...c.sizes);
        if (c.newest > f.newest) f.newest = c.newest;
      } else {
        f.items++;
        f.bytes += c.node.size;
        if (c.node.size) f.sizes.push(c.node.size);
        if (c.node.date > f.newest) f.newest = c.node.date;
      }
    }
  };
  total(root);
  return root;
}

export type SortKey = 'name' | 'size' | 'newest';
export const SORT_KEYS: SortKey[] = ['name', 'size', 'newest'];
const nameOf = (n: TreeNode) => (n.kind === 'folder' ? n.name : n.node.label);
const weight = (n: TreeNode) => (n.kind === 'folder' ? n.bytes : n.node.size);
const time = (n: TreeNode) => (n.kind === 'folder' ? n.newest : n.node.date);
const COMPARE: Record<SortKey, (a: TreeNode, b: TreeNode) => number> = {
  name: (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }),
  size: (a, b) => weight(b) - weight(a) || COMPARE.name(a, b),
  newest: (a, b) => time(b).localeCompare(time(a)) || COMPARE.name(a, b),
};
// Folders before items, each in the chosen order.
const ordered = (nodes: TreeNode[], sort: SortKey) =>
  [...nodes].sort((a, b) => (a.kind === b.kind ? COMPARE[sort](a, b) : a.kind === 'folder' ? -1 : 1));

/** A row of the treegrid, with what aria-level, aria-posinset and aria-setsize need. */
export interface Row { node: TreeNode; level: number; pos: number; of: number; open: boolean; parent: string | null }
export type Keep = ((n: StageNode) => boolean) | null;

/** The rows shown: an open folder shows what it holds. `keep` narrows the items (search,
 * filters); a folder left with none goes, and one with any shows open while it narrows. */
export function visibleRows(root: TreeFolder, open: Set<string>, sort: SortKey, keep: Keep): Row[] {
  const rows: Row[] = [];
  const kept = new Map<TreeNode, boolean>();
  const keeps = (n: TreeNode): boolean => {
    if (!kept.has(n)) kept.set(n, n.kind === 'item' ? !keep || keep(n.node) : n.children.map(keeps).some(Boolean));
    return kept.get(n)!;
  };
  const walk = (f: TreeFolder, level: number) => {
    const shown = ordered(f.children, sort).filter(keeps);
    shown.forEach((n, i) => {
      const isOpen = n.kind === 'folder' && (open.has(n.id) || keep !== null);
      rows.push({ node: n, level, pos: i + 1, of: shown.length, open: isOpen, parent: f === root ? null : f.id });
      if (n.kind === 'folder' && isOpen) walk(n, level + 1);
    });
  };
  walk(root, 1);
  return rows;
}

/** Every item as one list in the chosen order. */
export function flatRows(nodes: StageNode[], sort: SortKey, keep: Keep): Row[] {
  const items = ordered(nodes.filter((n) => !keep || keep(n)).map((node): TreeItem => ({ kind: 'item', id: node.key, node })), sort);
  return items.map((node, i) => ({ node, level: 1, pos: i + 1, of: items.length, open: false, parent: null }));
}

// A stage this small opens with every folder open.
const SMALL_STAGE = 25;
/** The folders open at first: every one in a small stage; otherwise down each chain of
 * single folders, so the first level that branches shows. */
export function initiallyOpen(root: TreeFolder): Set<string> {
  const open = new Set<string>();
  const all = (f: TreeFolder) => f.children.forEach((c) => { if (c.kind === 'folder') { open.add(c.id); all(c); } });
  if (root.items <= SMALL_STAGE) {
    all(root);
    return open;
  }
  for (let f = root; f.children.length === 1 && f.children[0].kind === 'folder';) {
    f = f.children[0];
    open.add(f.id);
  }
  return open;
}

/** The folders from the top down to (and including) a folder path's own. */
export const folderChain = (path: string | undefined): string[] =>
  path ? path.split('/').map((_, i, parts) => folderId(parts.slice(0, i + 1).join('/'))) : [];

/** Search: the words typed, each found somewhere in the item's names, folders, tags or facts. */
export function matches(query: string): Keep {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return (n) => {
    const text = [n.label, n.datasetName, ...n.folders, ...n.tags, ...n.facts.map((f) => f.text)].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  };
}

/** Search, then filters: within a kind of fact any value chosen, across kinds all of them. */
export function keepFor(query: string, filters: Set<string>): Keep {
  const search = matches(query);
  if (!search && !filters.size) return null;
  const byKey = new Map<string, Set<string>>();
  for (const id of filters) {
    const key = id.slice(0, id.indexOf(':'));
    byKey.set(key, (byKey.get(key) ?? new Set()).add(id));
  }
  return (n) => (!search || search(n))
    && [...byKey.values()].every((ids) => n.facts.some((f) => ids.has(filterId({ key: f.key, text: groupOf(f) }))));
}

// ---------- size ----------

/** A stage's sizes on one log ruler of whole decades, from below the smallest to above the
 * largest, so a dot moves only when a size beyond them arrives; marked at KB, MB, GB, TB. */
export interface Ruler { lo: number; hi: number; marks: { at: number; label: string }[] }
const UNITS = ['KB', 'MB', 'GB', 'TB'];
export function ruler(sizes: number[]): Ruler | null {
  const known = sizes.filter((b) => b > 0);
  if (!known.length) return null;
  let lo = Math.floor(Math.log10(Math.min(...known)));
  let hi = Math.ceil(Math.log10(Math.max(...known)));
  // At least two decades, so a stage of near-equal sizes doesn't spread them edge to edge.
  if (hi - lo < 2) {
    lo = hi - 2;
  }
  const marks = UNITS.map((label, i) => ({ at: (3 * (i + 1) - lo) / (hi - lo), label })).filter((m) => m.at >= 0 && m.at <= 1);
  return { lo, hi, marks };
}
export const onRuler = (r: Ruler, bytes: number) => Math.min(1, Math.max(0, (Math.log10(Math.max(bytes, 1)) - r.lo) / (r.hi - r.lo)));

// ---------- say it once ----------

export interface Facet { key: string; values: { text: string; count: number }[] }

/** Facts every item states alike (said once, above the tree), and the kinds of fact whose
 * values split the items into groups worth filtering by, with how many each group has. */
export function summarize(all: Fact[][]): { shared: Fact[]; facets: Facet[] } {
  if (!all.length) return { shared: [], facets: [] };
  const shared: Fact[] = [];
  const facets: Facet[] = [];
  for (const key of new Set(all.flat().map((f) => f.key))) {
    const said = all.map((facts) => facts.find((f) => f.key === key) ?? null);
    const first = said[0];
    // Shared: every item says it, in the same words or of the same group ("10x Xenium").
    if (first && said.every((f) => f?.text === first.text)) {
      shared.push(first);
      continue;
    }
    if (!FILTERABLE.has(key)) continue;
    if (first && said.every((f) => f && groupOf(f) === groupOf(first))) {
      shared.push({ key, text: groupOf(first), all: first.all });
      continue;
    }
    const counts = new Map<string, number>();
    for (const f of said) if (f) counts.set(groupOf(f), (counts.get(groupOf(f)) ?? 0) + 1);
    facets.push({ key, values: [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count) });
  }
  return { shared, facets };
}
