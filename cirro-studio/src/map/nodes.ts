// The items of each stage: one per image, run, spatial dataset or figure, with what drawing
// them as bubbles and listing them as rows needs, their lineage and their facts in words.
import { hierarchy, pack, type HierarchyCircularNode } from 'd3-hierarchy';
import { APP_TAG } from '../app/appInfo';
import type { CatalogState } from '../app/catalog';
import type { Library, StageId } from '../app/library';
import type { DatasetRecord, ImageItem, RunItem } from '../data/model';
import { FOLDER_PREFIX } from '../data/model';
import type { Fact } from './browse';

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
  // The dataset it is in (for a spatial dataset, its store's), when this project lists it.
  dataset: DatasetRecord | null;
  // Other items' keys: what it was made from, and what was made from it.
  from: string[];
  into: string[];
  facts: Fact[];
}

/** Tags a person gave the dataset: not the app's own bookkeeping, not folders. */
export function userTags(d: DatasetRecord | undefined): string[] {
  return (d?.tags ?? [])
    // Versions saved before tags became plain values also carry keyed `spatial-data-studio.*` ones.
    .filter((t) => t.value !== APP_TAG.value && !t.key.startsWith(`${APP_TAG.value}.`) && !t.value.startsWith(FOLDER_PREFIX))
    .map((t) => (t.key ? `${t.key}: ${t.value}` : t.value));
}

const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;
// A file's extension as people name the format: ".ndpi" is NDPI.
const extension = (path: string) => path.slice(path.lastIndexOf('.') + 1).toUpperCase();
// The kind of id a version saved in this browser carries (data/examples.ts).
const BROWSER_VERSION = 'browser-version';

type Bare = Omit<StageNode, 'from' | 'into' | 'facts'>;

export function stageNodes(library: Library, catalog: Pick<CatalogState, 'byId'>): Record<StageId, StageNode[]> {
  const ds = (id: string) => catalog.byId.get(id);
  const common = (datasetId: string) => {
    const d = ds(datasetId);
    return { datasetName: d?.name ?? datasetId, date: d?.createdAt ?? '', folders: d?.folders ?? [], tags: userTags(d), dataset: d ?? null };
  };
  const bare: Record<StageId, Bare[]> = {
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

  // Lineage both ways: a run or image made into a store (Cirro's), a store into its figures.
  const from = new Map<string, string[]>();
  const into = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    into.set(a, [...(into.get(a) ?? []), b]);
    from.set(b, [...(from.get(b) ?? []), a]);
  };
  for (const l of library.links) link(l.from, l.to);
  for (const f of library.figures) link(f.entityKey, f.key);
  const stageOfKey = new Map(Object.values(bare).flat().map((n) => [n.key, n.stage]));
  const lineage = (key: string, side: Map<string, string[]>) => (side.get(key) ?? []).filter((k) => stageOfKey.has(k));
  const intoStage = (key: string, stage: StageId) => lineage(key, into).filter((k) => stageOfKey.get(k) === stage).length;

  const facts = (n: Bare): Fact[] => {
    const out: Fact[] = [];
    if (n.stage === 'images') {
      const image = library.itemByKey.get(n.key) as ImageItem;
      out.push(image.viewable ? { key: 'format', text: 'OME-TIFF' } : { key: 'format', text: `${extension(image.path)}, which a browser can't draw`, group: 'not drawn here' });
    }
    if (n.stage === 'runs') out.push({ key: 'platform', text: (library.itemByKey.get(n.key) as RunItem).runLabel });
    if (n.stage === 'images' || n.stage === 'runs') {
      const stores = intoStage(n.key, 'spatial');
      out.push(stores
        ? { key: 'progress', text: `made into ${count(stores, ['store', 'stores'])}`, group: 'made into spatial data' }
        : { key: 'progress', text: 'not made into spatial data yet', all: 'none made into spatial data yet' });
    }
    if (n.stage === 'spatial') {
      const entity = library.spatial.find((e) => e.key === n.key)!;
      out.push(!entity.base ? { key: 'kind', text: 'store not in this project', all: 'no store in this project' }
        : entity.base.checkpoint ? { key: 'kind', text: 'checkpoint', all: 'all checkpoints' }
          : { key: 'kind', text: 'SpatialData store', all: 'all SpatialData stores' });
      out.push(n.versions
        ? { key: 'versions', text: count(n.versions, ['version', 'versions']), group: 'has versions', all: 'all with versions' }
        : { key: 'versions', text: 'no versions yet', all: 'none with versions yet' });
      const sources = lineage(n.key, from);
      const runs = sources.filter((k) => stageOfKey.get(k) === 'runs').length;
      if (sources.length) {
        const text = runs ? `from ${runs === 1 ? 'a run' : `${runs} runs`}` : `from ${sources.length === 1 ? 'an image' : `${sources.length} images`}`;
        out.push({ key: 'source', text, group: runs ? 'from a run' : 'from an image' });
      }
      const figures = intoStage(n.key, 'figures');
      if (figures) out.push({ key: 'figures', text: count(figures, ['figure', 'figures']) });
      if (entity.versions.some((v) => ds(v.datasetId)?.processId === BROWSER_VERSION)) out.push({ key: 'browser', text: 'versions in this browser' });
    }
    if (n.stage === 'figures') out.push({ key: 'in', text: `in “${n.datasetName}”` });
    if (n.dataset?.credit) out.push({ key: 'credit', text: `${n.dataset.credit.by} · ${n.dataset.credit.license}`, group: n.dataset.credit.by });
    // An item that isn't the whole of its dataset says which dataset it is in.
    if (n.stage !== 'spatial' && n.stage !== 'figures' && n.dataset && n.dataset.name !== n.label) out.push({ key: 'dataset', text: `in ${n.dataset.name}` });
    if (n.tags.length) out.push({ key: 'tags', text: n.tags.join(' · '), all: `all tagged ${n.tags.join(' · ')}` });
    return out;
  };

  const finish = (list: Bare[]): StageNode[] => list.map((n) => ({ ...n, from: lineage(n.key, from), into: lineage(n.key, into), facts: facts(n) }));
  return { images: finish(bare.images), runs: finish(bare.runs), spatial: finish(bare.spatial), figures: finish(bare.figures) };
}

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

function folderTree(nodes: StageNode[]): Tree {
  const root: Tree = { name: '', path: '', children: [] };
  for (const n of nodes) insert(root, n.folders[0] ? n.folders[0].split('/') : [], n);
  return root;
}

type PackedNode = HierarchyCircularNode<Tree>;

// The gap between folders' circles: 4 px in a cluster of 240 px or more, less in a smaller
// one, so a minimap's padding doesn't take the room its bubbles need.
const gapFor = (d: number) => Math.min(4, d / 60);

/** Packed circles, areas by bytes. Small items keep a floor so a figure is still a dot
 * beside a 5 GB store. */
function packTree(tree: Tree, d: number, floor: number): PackedNode {
  const root = hierarchy(tree)
    .sum((t) => (t.node ? Math.max(t.node.size, floor) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const gap = gapFor(d);
  return pack<Tree>().size([d, d]).padding((t) => (t.depth === 0 ? 2 * gap : gap))(root);
}

/** A stage's bubbles packed by folder into a circle `d` across, positioned from its
 * top-left corner: a column of the overview, or a stage's minimap in the rail. */
export function packCluster(nodes: StageNode[], d: number, floor: number): { node: StageNode; x: number; y: number; r: number }[] {
  return packTree(folderTree(nodes), d, floor).leaves()
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
