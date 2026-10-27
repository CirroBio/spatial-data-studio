import { describe, expect, it } from 'vitest';
import {
  buildTree, filterId, flatRows, folderChain, folderId, initiallyOpen, keepFor, onRuler, ruler, saidOfAll, summarize, visibleRows, type Fact,
} from './browse';
import type { StageNode } from './nodes';

const node = (key: string, folder: string | null, size: number, date: string, facts: Fact[] = [], tags: string[] = []): StageNode => ({
  key, stage: 'runs', label: key, datasetName: key, size, date, folders: folder ? [folder] : [], tags, versions: 0,
  target: { datasetId: key, path: '' }, dataset: null, from: [], into: [], facts,
});

const xenium = (made: number): Fact[] => [
  { key: 'platform', text: '10x Xenium' },
  made ? { key: 'progress', text: `made into ${made} store${made === 1 ? '' : 's'}`, group: 'made into spatial data' } : { key: 'progress', text: 'not made into spatial data yet' },
];
const NODES = [
  node('lung', 'Human/Lung', 2e9, '2026-10-01', xenium(1)),
  node('lung-2', 'Human/Lung', 3e9, '2026-10-05', xenium(0)),
  node('brain', 'Mouse', 5e6, '2026-09-01', xenium(2), ['pilot']),
  node('loose', null, 4e3, '2026-08-01', xenium(0)),
];

describe('the folder tree', () => {
  const root = buildTree(NODES);

  it('holds folders inside folders, with what each weighs, and items in no folder at the top', () => {
    expect(root.children.map((c) => c.id)).toEqual([folderId('Human'), folderId('Mouse'), 'loose']);
    const human = root.children[0];
    expect(human.kind === 'folder' && [human.items, human.bytes, human.newest]).toEqual([2, 5e9, '2026-10-05']);
    expect(root.items).toBe(4);
  });

  it('shows open folders\' rows, folders first, in the chosen order', () => {
    const open = new Set([folderId('Human'), folderId('Human/Lung')]);
    const rows = visibleRows(root, open, 'size', null);
    expect(rows.map((r) => [r.node.id, r.level])).toEqual([
      [folderId('Human'), 1], [folderId('Human/Lung'), 2], ['lung-2', 3], ['lung', 3], [folderId('Mouse'), 1], ['loose', 1],
    ]);
    expect(rows.find((r) => r.node.id === 'lung')?.parent).toBe(folderId('Human/Lung'));
  });

  it('opens the folders on the way to what a search finds, and drops the rest', () => {
    const rows = visibleRows(root, new Set(), 'name', keepFor('brain', new Set()));
    expect(rows.map((r) => r.node.id)).toEqual([folderId('Mouse'), 'brain']);
  });

  it('lists every item flat, newest first', () => {
    expect(flatRows(NODES, 'newest', null).map((r) => r.node.id)).toEqual(['lung-2', 'lung', 'brain', 'loose']);
  });

  it('opens everything in a small stage, and down single folders in a large one', () => {
    expect(initiallyOpen(root)).toEqual(new Set([folderId('Human'), folderId('Human/Lung'), folderId('Mouse')]));
    const many = Array.from({ length: 30 }, (_, i) => node(`n${i}`, i % 2 ? 'Only/A' : 'Only/B', 1, ''));
    expect(initiallyOpen(buildTree(many))).toEqual(new Set([folderId('Only')]));
  });

  it('names the folders on the way to a folder', () => {
    expect(folderChain('Human/Lung')).toEqual([folderId('Human'), folderId('Human/Lung')]);
    expect(folderChain(undefined)).toEqual([]);
  });
});

describe('search and filters', () => {
  it('finds every word typed in names, folders, tags or facts', () => {
    const found = (q: string) => NODES.filter(keepFor(q, new Set())!).map((n) => n.key);
    expect(found('human 2026')).toEqual([]);
    expect(found('lung')).toEqual(['lung', 'lung-2']);
    expect(found('pilot')).toEqual(['brain']);
    expect(found('not made')).toEqual(['lung-2', 'loose']);
  });

  it('keeps an item that has any chosen value of a kind, and every kind chosen', () => {
    const made = filterId({ key: 'progress', text: 'made into spatial data' });
    expect(NODES.filter(keepFor('', new Set([made]))!).map((n) => n.key)).toEqual(['lung', 'brain']);
    expect(NODES.filter(keepFor('lung', new Set([made]))!).map((n) => n.key)).toEqual(['lung']);
    expect(keepFor(' ', new Set())).toBeNull();
  });
});

describe('saying it once', () => {
  it('says what every item states once, and offers the facts that split them as filters', () => {
    const { shared, facets } = summarize(NODES.map((n) => n.facts));
    expect(shared).toEqual([{ key: 'platform', text: '10x Xenium' }]);
    expect(facets).toEqual([{ key: 'progress', values: [{ text: 'made into spatial data', count: 2 }, { text: 'not made into spatial data yet', count: 2 }] }]);
  });

  it('says a group once when every item is of it, in different words', () => {
    const { shared, facets } = summarize([xenium(1), xenium(3)]);
    expect(shared).toContainEqual({ key: 'progress', text: 'made into spatial data' });
    expect(facets).toEqual([]);
  });

  it('says a shared fact in its own words when "all" wouldn\'t read', () => {
    const versions = (n: number): Fact => ({ key: 'versions', text: `${n} versions`, group: 'has versions', all: 'all with versions' });
    const { shared } = summarize([[versions(2)], [versions(5)]]);
    expect(shared.map(saidOfAll)).toEqual(['all with versions']);
    expect(saidOfAll({ key: 'platform', text: '10x Xenium' })).toBe('all 10x Xenium');
  });

  it('never offers a filter for a fact that only describes', () => {
    const { facets } = summarize([[{ key: 'tags', text: 'a' }], [{ key: 'tags', text: 'b' }]]);
    expect(facets).toEqual([]);
  });
});

describe('the size ruler', () => {
  it('spans whole decades around the sizes, marked where its units fall', () => {
    const r = ruler([4e3, 5e6, 3e9])!;
    expect([r.lo, r.hi]).toEqual([3, 10]);
    expect(r.marks.map((m) => m.label)).toEqual(['KB', 'MB', 'GB']);
    expect(onRuler(r, 1e3)).toBe(0);
    expect(onRuler(r, 1e10)).toBe(1);
  });

  it('spans at least two decades, and has nothing to mark with no sizes', () => {
    const r = ruler([2e6, 3e6])!;
    expect(r.hi - r.lo).toBe(2);
    expect(ruler([0])).toBeNull();
  });
});
