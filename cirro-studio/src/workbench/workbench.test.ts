import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AsyncReadable } from '@zarrita/storage';
import ZipFileStore from '@zarrita/storage/zip';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PublicProject } from '../data/publicProject';
import { FIGURE_FORMAT, keepFigure, readFigures, removeFigure, type FigureSpec } from '../figures/spec';
import { StackEditor } from '../stack/editor';
import { LayeredStore, MemoryLayer } from '../stack/layeredStore';
import { FIGURES, UNS_ROOT } from '../stack/manifest';
import { applyEdit, storeOf, useWorkbench, type Workbench } from './workbench';

// The draft is kept in IndexedDB, which the test DOM doesn't have.
vi.mock('../data/idb', () => {
  const kept = new Map<string, unknown>();
  return {
    kvGet: async (_store: string, key: string) => kept.get(key),
    kvPut: async (_store: string, key: string, value: unknown) => {
      kept.set(key, value);
    },
    kvDelete: async (_store: string, key: string) => {
      kept.delete(key);
    },
  };
});

const DEMO = resolve(__dirname, '../../../docs-site/viewer-data/visium-human-colon.sdata.zarr.zip');
const OPEN_TIMEOUT_MS = 30_000;

class DemoCollection extends PublicProject {
  override async openStore(): Promise<Required<AsyncReadable>> {
    return ZipFileStore.fromBlob(new Blob([readFileSync(DEMO)]));
  }
}

const SAVED_FIGURE: FigureSpec = {
  format: FIGURE_FORMAT, version: 1, id: 'fig_saved', title: 'Saved figure', caption: '', created_at: '', created_by: '',
  view: { kind: 'chart', chart: { type: 'heatmap', result: 'spatial_data_studio/results/r/table' } }, width_mm: 89,
};

// The demo with a figure beneath the draft, as a saved version would hold one.
class FigureBeneathCollection extends DemoCollection {
  override async openStore() {
    const zip = await super.openStore();
    const layer = new MemoryLayer();
    await new StackEditor(new LayeredStore(zip, [layer]), layer)
      .setUns('table', [UNS_ROOT, FIGURES, SAVED_FIGURE.id], { kind: 'string', value: JSON.stringify(SAVED_FIGURE) });
    return new LayeredStore(zip, [layer]);
  }
}

// Opened through its hook, as the page opens it; `seen.wb` follows its state.
async function openDemo(datasetId: string, Collection = DemoCollection) {
  const seen: { wb: Workbench | null } = { wb: null };
  const top = { datasetId, path: 'demo.zarr.zip', kind: 'store' as const };
  const collection = new Collection({ kind: 'publication', url: 'https://example.invalid/published/demo', id: 'demo', name: 'Demo', description: '' });
  function Probe() {
    seen.wb = useWorkbench(collection, top);
    return null;
  }
  createRoot(document.createElement('div')).render(createElement(Probe));
  await vi.waitFor(() => expect(seen.wb?.status).toBe('ready'), { timeout: OPEN_TIMEOUT_MS });
  return seen;
}

async function setNumeric(editor: StackEditor, column: string) {
  const n = (await editor.node('tables/table/obs/_index'))!.shape as number[];
  return editor.setObs('table', column, { kind: 'numeric', values: new Float32Array(n[0]) });
}

describe('workbench draft changes', () => {
  it('records deleting a column the store has, even after the draft replaced it', async () => {
    const seen = await openDemo('replace-then-delete');
    const { key, revision } = seen.wb!;
    await applyEdit(key, (e) => setNumeric(e, 'leiden'));
    await applyEdit(key, (e) => e.deleteObs('table', 'leiden'));
    await vi.waitFor(() => expect(seen.wb?.revision).toBe(revision + 2));
    expect(seen.wb!.changes).toEqual([{ op: 'delete-obs', table: 'table', column: 'leiden' }]);
    expect(seen.wb!.dataVersions['obs:leiden']).toBe(2);
  }, OPEN_TIMEOUT_MS);

  it('records nothing for a column the draft added and then deleted', async () => {
    const seen = await openDemo('add-then-delete');
    const { key, revision } = seen.wb!;
    await applyEdit(key, (e) => setNumeric(e, 'sds_added'));
    await applyEdit(key, (e) => e.deleteObs('table', 'sds_added'));
    await vi.waitFor(() => expect(seen.wb?.revision).toBe(revision + 2));
    expect(seen.wb!.changes).toEqual([]);
  }, OPEN_TIMEOUT_MS);
});

describe('removing a kept figure', () => {
  const keep = (key: string, title: string) => keepFigure(key, 'table', {
    title, caption: '', created_by: '', width_mm: 89,
    view: { kind: 'chart', chart: { type: 'heatmap', result: 'spatial_data_studio/results/r/table' } },
  });

  it('takes one kept in the draft back out, and the draft with nothing else goes with it', async () => {
    const seen = await openDemo('keep-then-remove');
    const { key } = seen.wb!;
    const figure = await keep(key, 'Clusters');
    expect(seen.wb!.changes).toEqual([{ op: 'set-figure', table: 'table', id: figure.id, title: 'Clusters' }]);
    await removeFigure(key, 'table', figure);
    expect(seen.wb!.changes).toEqual([]);
    expect(seen.wb!.draftBytes).toBe(0);
    expect(await readFigures(storeOf(key), 'table')).toEqual([]);
  }, OPEN_TIMEOUT_MS);

  it('takes out one of two alike, leaving the other', async () => {
    const seen = await openDemo('keep-twice-remove-one');
    const { key } = seen.wb!;
    const first = await keep(key, 'Clusters');
    const second = await keep(key, 'Clusters');
    await removeFigure(key, 'table', first);
    expect(seen.wb!.changes).toEqual([{ op: 'set-figure', table: 'table', id: second.id, title: 'Clusters' }]);
    expect((await readFigures(storeOf(key), 'table')).map((f) => f.id)).toEqual([second.id]);
  }, OPEN_TIMEOUT_MS);

  it('records removing one a saved version holds', async () => {
    const seen = await openDemo('remove-saved-figure', FigureBeneathCollection);
    const { key } = seen.wb!;
    expect((await readFigures(storeOf(key), 'table')).map((f) => f.id)).toEqual([SAVED_FIGURE.id]);
    await removeFigure(key, 'table', SAVED_FIGURE);
    expect(seen.wb!.changes).toEqual([{ op: 'delete-figure', table: 'table', id: SAVED_FIGURE.id, title: SAVED_FIGURE.title }]);
    expect(await readFigures(storeOf(key), 'table')).toEqual([]);
  }, OPEN_TIMEOUT_MS);
});
