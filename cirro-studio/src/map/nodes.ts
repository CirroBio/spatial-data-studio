// The bubbles of each stage: one per image, run, spatial dataset or figure, with what
// grouping and labelling them needs.
import { hierarchy, pack, type HierarchyCircularNode } from 'd3-hierarchy';
import { APP_TAG } from '../app/appInfo';
import type { CatalogState } from '../app/catalog';
import type { Library, StageId } from '../app/library';
import type { DatasetRecord } from '../data/model';
import { FOLDER_PREFIX } from '../data/model';

export interface StageNode {
  key: string;
  stage: StageId;
  label: string;
  // The dataset it is in, for the second line of a card.
  datasetName: string;
  size: number;
  date: string;
  folders: string[];
  tags: string[];
  // How many saved versions a spatial dataset has: drawn as rings.
  versions: number;
  // What opening it goes to.
  target: { datasetId: string; path: string; lens?: string };
}

/** Tags a person gave the dataset: not the app's own bookkeeping, not folders. */
export function userTags(d: DatasetRecord | undefined): string[] {
  return (d?.tags ?? [])
    .filter((t) => !(t.key === APP_TAG.key) && !t.key.startsWith(`${APP_TAG.value}.`) && !t.value.startsWith(FOLDER_PREFIX))
    .map((t) => (t.key ? `${t.key}: ${t.value}` : t.value));
}

export function stageNodes(library: Library, catalog: Pick<CatalogState, 'byId'>): Record<StageId, StageNode[]> {
  const ds = (id: string) => catalog.byId.get(id);
  const common = (datasetId: string) => {
    const d = ds(datasetId);
    return { datasetName: d?.name ?? datasetId, date: d?.createdAt ?? '', folders: d?.folders ?? [], tags: userTags(d) };
  };
  return {
    images: library.images.map((i) => ({
      key: i.key, stage: 'images', label: i.label, size: i.size, versions: 0,
      target: { datasetId: i.datasetId, path: i.path }, ...common(i.datasetId),
    })),
    runs: library.runs.map((r) => ({
      key: r.key, stage: 'runs', label: r.label, size: r.size, versions: 0,
      target: { datasetId: r.datasetId, path: r.path }, ...common(r.datasetId),
    })),
    spatial: library.spatial.map((e) => {
      // A dataset opens on its newest version; with none, on the store itself.
      const top = e.head ?? e.base;
      const at = e.base ?? e.head!;
      return {
        key: e.key, stage: 'spatial', label: e.label, size: e.size, versions: e.versions.length,
        target: { datasetId: top!.datasetId, path: top!.path }, ...common(at.datasetId),
        datasetName: ds(at.datasetId)?.name ?? (e.base ? e.base.datasetId : 'not in this project'),
      };
    }),
    figures: library.figures.map((f) => ({
      key: f.key, stage: 'figures', label: f.title, size: 0, versions: 0,
      target: { datasetId: f.version.datasetId, path: f.version.path, lens: `figure:${f.id}` },
      ...common(f.version.datasetId),
      datasetName: f.version.title,
      date: f.version.createdAt,
    })),
  };
}

export type Grouping = 'folders' | 'tags' | 'time';

interface Tree {
  name: string;
  path: string;
  children?: Tree[];
  node?: StageNode;
}

function insert(root: Tree, path: string[], node: StageNode) {
  let at = root;
  for (let i = 0; i < path.length; i++) {
    const p = path.slice(0, i + 1).join('/');
    let child = at.children!.find((c) => !c.node && c.path === p);
    if (!child) {
      child = { name: path[i], path: p, children: [] };
      at.children!.push(child);
    }
    at = child;
  }
  at.children!.push({ name: node.label, path: `${at.path}#${node.key}`, node });
}

const MONTH = (iso: string) => (iso ? iso.slice(0, 7) : 'Undated');

export function groupTree(nodes: StageNode[], grouping: Grouping): Tree {
  const root: Tree = { name: '', path: '', children: [] };
  for (const n of nodes) {
    const groups = grouping === 'folders' ? (n.folders[0] ? n.folders[0].split('/') : [])
      : grouping === 'tags' ? (n.tags.length ? [n.tags.slice().sort().join(' · ')] : ['No tags'])
        : [MONTH(n.date)];
    insert(root, groups, n);
  }
  return root;
}

export type PackedNode = HierarchyCircularNode<Tree>;

/** Packed circles, areas by bytes. Small items keep a floor so a figure is still a dot
 * beside a 5 GB store. */
export function packTree(tree: Tree, width: number, height: number, floor: number): PackedNode {
  const root = hierarchy(tree)
    .sum((d) => (d.node ? Math.max(d.node.size, floor) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return pack<Tree>().size([width, height]).padding((d) => (d.depth === 0 ? 8 : 4))(root);
}

/** A stage's bubbles packed by folder into a circle `d` across, positioned from its
 * top-left corner: a column of the overview, or a stage's place in the rail. */
export function packCluster(nodes: StageNode[], d: number, floor: number): { node: StageNode; x: number; y: number; r: number }[] {
  return packTree(groupTree(nodes, 'folders'), d, d, floor).leaves()
    .filter((l) => l.data.node)
    .map((l) => ({ node: l.data.node!, x: l.x, y: l.y, r: l.r }));
}

/** A bubble's name in up to `maxLines` lines of `perLine` characters, wrapped at words;
 * a word too long for its line, or what is left after the last line, is cut short. */
export function labelLines(label: string, perLine: number, maxLines: number): string[] {
  const words = label.split(' ');
  const lines: string[] = [];
  while (words.length && lines.length < maxLines) {
    let line = '';
    while (words.length && `${line} ${words[0]}`.trim().length <= perLine) line = `${line} ${words.shift()}`.trim();
    if (!line) line = words.shift()!;
    if (lines.length === maxLines - 1 && words.length) line = `${line} ${words.splice(0).join(' ')}`;
    lines.push(line.length > perLine ? `${line.slice(0, perLine - 1).trimEnd()}…` : line);
  }
  return lines;
}
