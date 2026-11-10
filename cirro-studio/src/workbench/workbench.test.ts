import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AsyncReadable } from '@zarrita/storage';
import ZipFileStore from '@zarrita/storage/zip';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExpressionMatrix } from '@cirrobio/spatial-viewer';
import { describe, expect, it, vi } from 'vitest';
import type { NewVersion } from '../data/collection';
import { PublicProject } from '../data/publicProject';
import { FIGURE_FORMAT, keepFigure, readFigures, removeFigure, type FigureSpec } from '../figures/spec';
import { readResults } from '../reports/store';
import { datasetRef } from '../stack/cirroRef';
import { StackEditor } from '../stack/editor';
import { LayeredStore, MemoryLayer } from '../stack/layeredStore';
import { FIGURES, LAYER_MANIFEST, RESULTS, UNS_ROOT } from '../stack/manifest';
import { versionFiles } from '../stack/version';
import { readMatrix } from '../tasks/data';
import { applyEdit, discardDraft, saveDraft, storeOf, useWorkbench, type Workbench } from './workbench';

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

const UNREADABLE_FIGURE: FigureSpec = { ...SAVED_FIGURE, id: 'fig_unreadable', title: 'Unreadable figure' };
const UNREADABLE_RESULT = 'compare_unreadable';
const CHUNKLESS_BASE = datasetRef('chunkless-base', 'demo.zarr.zip');

// A version on the demo holding a figure and a result, whose collection serves its
// manifest and metadata but answers 403 for every chunk: what the public data's
// publication answered for versions copied without their chunk files.
class ChunklessVersionCollection extends DemoCollection {
  private readonly version = (async () => {
    const draft = new MemoryLayer();
    const editor = new StackEditor(new LayeredStore(ZipFileStore.fromBlob(new Blob([readFileSync(DEMO)])), [draft]), draft);
    const changes = [
      await editor.setUns('table', [UNS_ROOT, FIGURES, UNREADABLE_FIGURE.id], { kind: 'string', value: JSON.stringify(UNREADABLE_FIGURE) }),
      await editor.setUns('table', [UNS_ROOT, RESULTS, UNREADABLE_RESULT, 'meta'], {
        kind: 'string', value: JSON.stringify({ kind: 'compare', title: 'Unreadable result', created_at: '' }),
      }),
    ];
    return versionFiles(draft, { parent: CHUNKLESS_BASE, base: CHUNKLESS_BASE, depth: 1, title: 'Figures', message: '', createdBy: '', changes });
  })();

  override async manifest() {
    return (await this.version).manifest;
  }

  override async readFile(_datasetId: string, path: string): Promise<Uint8Array> {
    const file = (await this.version).files.find((f) => f.name === path);
    if (!file || !path.endsWith('zarr.json')) throw new Error(`Reading ${path} from Cirro failed: HTTP 403.`);
    return file.bytes;
  }
}

// The demo with a save that holds until `release` is called, so a test can act while
// the version is uploading.
function heldSave() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saved: NewVersion[] = [];
  class HeldSaveCollection extends DemoCollection {
    override async saveVersion(version: NewVersion) {
      saved.push(version);
      await held;
      return { datasetId: 'held-save-version', notice: null };
    }
  }
  return { Collection: HeldSaveCollection, saved, release };
}

// Opened through its hook, as the page opens it; `seen.wb` follows its state.
async function openDemo(datasetId: string, Collection = DemoCollection, kind: 'store' | 'version' = 'store') {
  const seen: { wb: Workbench | null } = { wb: null };
  const top = { datasetId, path: kind === 'store' ? 'demo.zarr.zip' : LAYER_MANIFEST, kind };
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

const keep = (key: string, title: string) => keepFigure(key, 'table', {
  title, caption: '', created_by: '', width_mm: 89,
  view: { kind: 'chart', chart: { type: 'heatmap', result: 'spatial_data_studio/results/r/table' } },
});

describe('reading kept figures and reports', () => {
  it('names the ones a version holds but can\'t be read, and still lists one kept in the draft', async () => {
    const seen = await openDemo('chunkless-version', ChunklessVersionCollection, 'version');
    const { key } = seen.wb!;
    const refused = (path: string) => `Reading overlay/tables/table/uns/${UNS_ROOT}/${path}/c from Cirro failed: HTTP 403.`;
    const figureRefused = [{ id: UNREADABLE_FIGURE.id, reason: refused(`${FIGURES}/${UNREADABLE_FIGURE.id}`) }];
    expect(await readFigures(storeOf(key), 'table')).toEqual({ kept: [], unreadable: figureRefused });
    expect(await readResults(storeOf(key), 'table')).toEqual({
      kept: [], unreadable: [{ id: UNREADABLE_RESULT, reason: refused(`${RESULTS}/${UNREADABLE_RESULT}/meta`) }],
    });

    const figure = await keep(key, 'Kept on top');
    expect(await readFigures(storeOf(key), 'table')).toEqual({ kept: [figure], unreadable: figureRefused });
  }, OPEN_TIMEOUT_MS);
});

describe('removing a kept figure', () => {
  it('takes one kept in the draft back out, and the draft with nothing else goes with it', async () => {
    const seen = await openDemo('keep-then-remove');
    const { key } = seen.wb!;
    const figure = await keep(key, 'Clusters');
    expect(seen.wb!.changes).toEqual([{ op: 'set-figure', table: 'table', id: figure.id, title: 'Clusters' }]);
    await removeFigure(key, 'table', figure);
    expect(seen.wb!.changes).toEqual([]);
    expect(seen.wb!.draftBytes).toBe(0);
    expect(await readFigures(storeOf(key), 'table')).toEqual({ kept: [], unreadable: [] });
  }, OPEN_TIMEOUT_MS);

  it('takes out one of two alike, leaving the other', async () => {
    const seen = await openDemo('keep-twice-remove-one');
    const { key } = seen.wb!;
    const first = await keep(key, 'Clusters');
    const second = await keep(key, 'Clusters');
    await removeFigure(key, 'table', first);
    expect(seen.wb!.changes).toEqual([{ op: 'set-figure', table: 'table', id: second.id, title: 'Clusters' }]);
    expect((await readFigures(storeOf(key), 'table')).kept.map((f) => f.id)).toEqual([second.id]);
  }, OPEN_TIMEOUT_MS);

  it('records removing one a saved version holds', async () => {
    const seen = await openDemo('remove-saved-figure', FigureBeneathCollection);
    const { key } = seen.wb!;
    expect((await readFigures(storeOf(key), 'table')).kept.map((f) => f.id)).toEqual([SAVED_FIGURE.id]);
    await removeFigure(key, 'table', SAVED_FIGURE);
    expect(seen.wb!.changes).toEqual([{ op: 'delete-figure', table: 'table', id: SAVED_FIGURE.id, title: SAVED_FIGURE.title }]);
    expect(await readFigures(storeOf(key), 'table')).toEqual({ kept: [], unreadable: [] });
  }, OPEN_TIMEOUT_MS);
});

describe('edits, discards and saves on one dataset', () => {
  it('puts an edit asked for while a save uploads into the draft the save leaves', async () => {
    const save = heldSave();
    const seen = await openDemo('edit-during-save', save.Collection);
    const { key } = seen.wb!;
    const before = await keep(key, 'Before the save');
    const saving = saveDraft(key, { title: 'Saved', message: '', createdBy: '', name: 'Saved' });
    await vi.waitFor(() => expect(save.saved).toHaveLength(1));
    const keeping = keep(key, 'During the save');
    save.release();
    await saving;
    const during = await keeping;
    expect(save.saved[0].note.parameters.changes).toEqual([{ op: 'set-figure', table: 'table', id: before.id, title: 'Before the save' }]);
    expect(seen.wb!.changes).toEqual([{ op: 'set-figure', table: 'table', id: during.id, title: 'During the save' }]);
    expect((await readFigures(storeOf(key), 'table')).kept.map((f) => f.id)).toEqual([during.id]);
  }, OPEN_TIMEOUT_MS);

  it('takes back an edit still being written when the draft is discarded', async () => {
    const seen = await openDemo('discard-during-edit');
    const { key } = seen.wb!;
    const keeping = keep(key, 'Being written');
    await discardDraft(key);
    await keeping;
    expect(seen.wb!.changes).toEqual([]);
    expect(seen.wb!.draftBytes).toBe(0);
    expect(await readFigures(storeOf(key), 'table')).toEqual({ kept: [], unreadable: [] });
  }, OPEN_TIMEOUT_MS);
});

describe('reading the expression matrix', () => {
  it('reads it once for a store and every version on it', async () => {
    // The version's store is the demo opened as `chunkless-base`. Each handle's read is
    // replaced below, so the chunks it refuses don't come into it.
    const store = await openDemo('chunkless-base');
    const version = await openDemo('matrix-version', ChunklessVersionCollection, 'version');
    const matrix: ExpressionMatrix = { nCells: 0, genes: [], indptr: new Float64Array(1), indices: new Int32Array(0), data: new Float32Array(0) };
    const reads: string[] = [];
    for (const seen of [store, version]) {
      const { key, handle } = seen.wb!;
      handle!.source.getExpressionMatrix = async () => {
        reads.push(key);
        return matrix;
      };
    }
    expect(await readMatrix(store.wb!.key, store.wb!.handle!)).toBe(matrix);
    expect(await readMatrix(version.wb!.key, version.wb!.handle!)).toBe(matrix);
    expect(reads).toEqual([store.wb!.key]);
  }, OPEN_TIMEOUT_MS);
});
