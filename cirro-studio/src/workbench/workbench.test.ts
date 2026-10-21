import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ZipFileStore from '@zarrita/storage/zip';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ExampleCollection } from '../data/examples';
import type { StackEditor } from '../stack/editor';
import { applyEdit, useWorkbench, type Workbench } from './workbench';

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

class DemoCollection extends ExampleCollection {
  override async openStore() {
    return ZipFileStore.fromBlob(new Blob([readFileSync(DEMO)]));
  }
}

// Opened through its hook, as the page opens it; `seen.wb` follows its state.
async function openDemo(datasetId: string) {
  const seen: { wb: Workbench | null } = { wb: null };
  const top = { datasetId, path: 'demo.zarr.zip', kind: 'store' as const };
  const collection = new DemoCollection();
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
