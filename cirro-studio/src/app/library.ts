// The project as the app presents it: four stages a spatial study moves through, with
// each SpatialData store and the versions saved on it gathered into one spatial dataset.
import type { CatalogItem, DatasetRecord, ImageItem, RunItem, StoreItem, VersionItem } from '../data/model';
import { itemKey } from '../data/model';
import { datasetRef, parseCirroRef } from '../stack/cirroRef';
import type { CatalogState } from './catalog';

export type StageId = 'images' | 'runs' | 'spatial' | 'figures';

export interface Stage {
  id: StageId;
  label: string;
  // CSS custom property holding the stage's tint.
  color: string;
  // What one bubble is, for captions.
  unit: [string, string];
}

export const STAGES: Stage[] = [
  { id: 'images', label: 'Images', color: '--sds-stage-image', unit: ['image', 'images'] },
  { id: 'runs', label: 'Instrument runs', color: '--sds-stage-run', unit: ['run', 'runs'] },
  { id: 'spatial', label: 'Spatial data', color: '--sds-stage-store', unit: ['dataset', 'datasets'] },
  { id: 'figures', label: 'Figures', color: '--sds-stage-figure', unit: ['figure', 'figures'] },
];

export const stageOf = (id: StageId) => STAGES.find((s) => s.id === id)!;

/** A SpatialData store and every version saved on it: what the app calls one spatial
 * dataset. The base can be out of reach (in a project this user can't see), and the
 * versions still group under its reference. */
export interface SpatialEntity {
  key: string;
  baseRef: string;
  base: StoreItem | null;
  label: string;
  versions: VersionItem[];
  // The newest version, which is what opening the dataset shows; null for none.
  head: VersionItem | null;
  size: number;
}

export interface FigureEntry {
  key: string;
  id: string;
  title: string;
  version: VersionItem;
  entityKey: string;
}

export interface Link {
  from: string;
  to: string;
}

export interface Library {
  images: ImageItem[];
  runs: RunItem[];
  spatial: SpatialEntity[];
  figures: FigureEntry[];
  // Made-from links between items of different stages (a run made into a store).
  links: Link[];
  itemByKey: Map<string, CatalogItem>;
}

export const refOfItem = (item: Pick<CatalogItem, 'datasetId' | 'path'>) => datasetRef(item.datasetId, item.path);

function keyOfRef(ref: string): string | null {
  const parsed = parseCirroRef(ref);
  return parsed ? itemKey(parsed.datasetId, parsed.path) : null;
}

export function buildLibrary(state: Pick<CatalogState, 'items' | 'byId'>): Library {
  const images: ImageItem[] = [];
  const runs: RunItem[] = [];
  const stores: StoreItem[] = [];
  const versions: VersionItem[] = [];
  for (const item of state.items) {
    if (item.kind === 'image') images.push(item);
    else if (item.kind === 'run') runs.push(item);
    else if (item.kind === 'store') stores.push(item);
    else versions.push(item);
  }
  const entities = new Map<string, SpatialEntity>();
  // A dataset's only store goes by the dataset's name; several are told apart by their own.
  const storesIn = new Map<string, number>();
  for (const s of stores) storesIn.set(s.datasetId, (storesIn.get(s.datasetId) ?? 0) + 1);
  for (const s of stores) {
    const label = storesIn.get(s.datasetId) === 1 ? state.byId.get(s.datasetId)?.name ?? s.label : s.label;
    entities.set(s.key, { key: s.key, baseRef: refOfItem(s), base: s, label, versions: [], head: null, size: s.size });
  }
  for (const v of versions) {
    const key = keyOfRef(v.base);
    if (!key) continue;
    let entity = entities.get(key);
    if (!entity) {
      const name = parseCirroRef(v.base)?.path.split('/').pop() ?? v.base;
      entity = { key, baseRef: v.base, base: null, label: name, versions: [], head: null, size: 0 };
      entities.set(key, entity);
    }
    entity.versions.push(v);
  }
  for (const e of entities.values()) {
    e.versions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    e.head = e.versions[e.versions.length - 1] ?? null;
    e.size += e.versions.reduce((s, v) => s + v.size, 0);
  }

  const figures: FigureEntry[] = versions.flatMap((v) => {
    const entityKey = keyOfRef(v.base) ?? '';
    return v.changes.flatMap((c) => (c.op === 'set-figure'
      ? [{ key: `${v.key}#${c.id}`, id: c.id, title: c.title, version: v, entityKey }]
      : []));
  });

  const itemByKey = new Map(state.items.map((i) => [i.key, i]));
  // A store's dataset was made from another dataset (Cirro's lineage): link the store to
  // the runs and images in it.
  const byDataset = new Map<string, CatalogItem[]>();
  for (const i of [...images, ...runs]) byDataset.set(i.datasetId, [...(byDataset.get(i.datasetId) ?? []), i]);
  const links: Link[] = [];
  for (const s of stores) {
    for (const source of state.byId.get(s.datasetId)?.sourceIds ?? []) {
      for (const from of byDataset.get(source) ?? []) links.push({ from: from.key, to: s.key });
    }
  }
  return { images, runs, spatial: [...entities.values()], figures, links, itemByKey };
}

/** The versions of an entity as a tree: each version's children, by its reference. */
export function childrenByParent(entity: SpatialEntity): Map<string, VersionItem[]> {
  const children = new Map<string, VersionItem[]>();
  for (const v of entity.versions) children.set(v.parent, [...(children.get(v.parent) ?? []), v]);
  return children;
}

/** The chain of versions from the base up to `version`, base first (as references). */
export function ancestry(entity: SpatialEntity, version: VersionItem | null): string[] {
  const byRef = new Map(entity.versions.map((v) => [refOfItem(v), v]));
  const chain: string[] = [];
  for (let at = version; at; at = byRef.get(at.parent) ?? null) chain.unshift(refOfItem(at));
  return [entity.baseRef, ...chain];
}

export const datasetOf = (state: Pick<CatalogState, 'byId'>, item: CatalogItem): DatasetRecord | undefined => state.byId.get(item.datasetId);
