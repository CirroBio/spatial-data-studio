// A version written by the browser code, read back by anndata and spatialdata through
// python/sds_layers.py. Needs the repo's Python environment (`.venv-introspect`, see
// DEVELOPMENT.md); without it there is nothing to run the Python half with.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ZipFileStore from '@zarrita/storage/zip';
import { describe, expect, it } from 'vitest';
import { datasetRef } from './cirroRef';
import { StackEditor } from './editor';
import { LayeredStore, MemoryLayer } from './layeredStore';
import { LAYER_FORMAT, LAYER_FORMAT_VERSION, LAYER_MANIFEST, OVERLAY_DIR } from './manifest';
import { versionFiles } from './version';

const REPO = resolve(__dirname, '../../..');
const PYTHON = join(REPO, '.venv-introspect/bin/python');
const DEMO = join(REPO, 'docs-site/viewer-data/visium-human-colon.sdata.zarr.zip');
const READER = resolve(__dirname, '../../python/sds_layers.py');

const CHECK = `
import json, sys
sys.path.insert(0, sys.argv[1])
import anndata, spatialdata, zarr
from sds_layers import Stack, flatten, open_stack
from pathlib import Path
top, out = Path(sys.argv[2]), Path(sys.argv[3])
t = anndata.read_zarr(zarr.open_group(open_stack(top), mode="r")["tables/table"])
flatten(Stack.resolve(top), out)
flat = spatialdata.read_zarr(out).tables["table"]
print(json.dumps({
  "n": t.n_obs,
  "label": [str(v) for v in t.obs["browser_label"].iloc[:4]],
  "categories": list(t.obs["browser_label"].cat.categories),
  "score": float(t.obs["browser_score"].iloc[5]),
  "has_leiden": "leiden" in t.obs.columns,
  "umap2": t.obsm["X_browser"].shape[1],
  "figure": json.loads(t.uns["spatial_data_studio"]["figures"]["f1"])["title"],
  "flat_label": [str(v) for v in flat.obs["browser_label"].iloc[:4]],
  "versions": len(Stack.resolve(top).versions),
}))
`;

describe.skipIf(!existsSync(PYTHON))('versions read from Python', () => {
  it('anndata and spatialdata see a two-version stack as the browser wrote it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sds-stack-'));
    const write = (path: string, bytes: Uint8Array) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    };
    mkdirSync(join(root, 'base/data'), { recursive: true });
    copyFileSync(DEMO, join(root, 'base/data/colon.sdata.zarr.zip'));
    const baseRef = datasetRef('base', 'colon.sdata.zarr.zip');
    const base = ZipFileStore.fromBlob(new Blob([readFileSync(DEMO)]));

    // Version 1: a label column and an embedding.
    const v1 = new MemoryLayer();
    const store1 = new LayeredStore(base, [v1]);
    const e1 = new StackEditor(store1, v1);
    const n = ((await e1.node('tables/table/obs/_index'))!.shape as number[])[0];
    const changes1 = [
      await e1.setObs('table', 'browser_label', { kind: 'categorical', categories: ['in', 'out'], codes: Int32Array.from({ length: n }, (_, i) => i % 2) }),
      await e1.setObsm('table', 'X_browser', Float32Array.from({ length: n * 2 }, (_, i) => i), 2),
    ];
    for (const f of versionFiles(v1, { parent: baseRef, base: baseRef, depth: 1, title: 'one', message: '', createdBy: 'test', changes: changes1 }).files) {
      write(join(root, 'v1/data', f.name), f.bytes);
    }

    // Version 2 on top: a numeric column, a figure, and a deleted column from the base.
    const v2 = new MemoryLayer();
    const saved1 = new MemoryLayer();
    saved1.put(v1.objects);
    const store2 = new LayeredStore(base, [saved1, v2]);
    const e2 = new StackEditor(store2, v2);
    const changes2 = [
      await e2.setObs('table', 'browser_score', { kind: 'numeric', values: Float32Array.from({ length: n }, (_, i) => i / 2) }),
      await e2.setUns('table', ['spatial_data_studio', 'figures', 'f1'], { kind: 'string', value: JSON.stringify({ title: 'Tissue' }) }),
      await e2.deleteObs('table', 'leiden'),
    ];
    for (const f of versionFiles(v2, { parent: datasetRef('v1', 'layer.json'), base: baseRef, depth: 2, title: 'two', message: '', createdBy: 'test', changes: changes2 }).files) {
      write(join(root, 'v2/data', f.name), f.bytes);
    }

    const out = execFileSync(PYTHON, ['-c', CHECK, dirname(READER), join(root, 'v2'), join(root, 'flat.zarr')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(out.trim().split('\n').pop()!);
    expect(result).toEqual({
      n, label: ['in', 'out', 'in', 'out'], categories: ['in', 'out'], score: 2.5, has_leiden: false,
      umap2: 2, figure: 'Tissue', flat_label: ['in', 'out', 'in', 'out'], versions: 2,
    });
  }, 120_000);
});

// zipfile writes whatever member name it is given, which is how a hostile store would be made.
const ZIP_SLIP = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("zarr.json", "{}")
    z.writestr("../../escaped", "outside")
`;

// spawnSync blocks vitest's own timeout, so a reader that never returns is killed here,
// short of vitest's 5 s default.
const READER_TIMEOUT_MS = 4_000;

// A manifest and its base arrive with downloaded datasets, so nothing in them may steer
// flatten to a file outside the stack's datasets or outside the folder it writes, or
// round a loop of versions.
describe.skipIf(!existsSync(PYTHON))('flatten refuses a stack that reaches outside its folders or loops', () => {
  // `<root>/v1` is one hand-written version on `<root>/base/data/<basePath>`, flattened by
  // the CLI to `<root>/out/flat.zarr`. Returns the exit status and the error's last line.
  function flattenVersion(root: string, basePath: string, manifest: Record<string, unknown>) {
    mkdirSync(join(root, 'v1/data'), { recursive: true });
    writeFileSync(join(root, 'v1/data', LAYER_MANIFEST), JSON.stringify({
      format: LAYER_FORMAT, format_version: LAYER_FORMAT_VERSION, parent: datasetRef('base', basePath),
      overlay: OVERLAY_DIR, files: [], deleted: [], ...manifest,
    }));
    const run = spawnSync(PYTHON, ['-I', READER, 'flatten', join(root, 'v1'), join(root, 'out/flat.zarr')], {
      encoding: 'utf8', timeout: READER_TIMEOUT_MS,
    });
    return { status: run.status, error: run.stderr.trim().split('\n').pop() };
  }

  function folderBase(root: string) {
    mkdirSync(join(root, 'base/data/store.zarr'), { recursive: true });
    writeFileSync(join(root, 'base/data/store.zarr/zarr.json'), '{}');
    return 'store.zarr';
  }

  // What is at the top of `root` besides the output folder; the fixture alone made it.
  const besideOutput = (root: string) => readdirSync(root).filter((name) => name !== 'out').sort();

  it('a key with ../ in it', () => {
    const root = mkdtempSync(join(tmpdir(), 'sds-escape-'));
    // v1/data/overlay/../../escaped is v1/escaped: a real file for the key to copy from.
    mkdirSync(join(root, 'v1/data', OVERLAY_DIR), { recursive: true });
    writeFileSync(join(root, 'v1/escaped'), 'outside');
    const result = flattenVersion(root, folderBase(root), { files: [{ key: '../../escaped', size: 7 }] });
    expect(result.status).not.toBe(0);
    expect(result.error).toMatch(/^ValueError: .*'\.\.\/\.\.\/escaped'/);
    expect(besideOutput(root)).toEqual(['base', 'v1']);
  });

  it('an absolute overlay folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'sds-escape-'));
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'zarr.json'), '{}');
    const result = flattenVersion(root, folderBase(root), { overlay: elsewhere, files: [{ key: 'zarr.json', size: 2 }] });
    expect(result.status).not.toBe(0);
    expect(result.error).toMatch(/^ValueError: /);
    expect(result.error).toContain(`'${elsewhere}'`);
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  it('a zip base with a ../ member', () => {
    const root = mkdtempSync(join(tmpdir(), 'sds-escape-'));
    mkdirSync(join(root, 'base/data'), { recursive: true });
    execFileSync(PYTHON, ['-I', '-c', ZIP_SLIP, join(root, 'base/data/store.zarr.zip')]);
    const result = flattenVersion(root, 'store.zarr.zip', {});
    expect(result.status).not.toBe(0);
    expect(result.error).toMatch(/^ValueError: .*'\.\.\/\.\.\/escaped'/);
    expect(besideOutput(root)).toEqual(['base', 'v1']);
  });

  it('a parent reference outside its dataset', () => {
    const root = mkdtempSync(join(tmpdir(), 'sds-escape-'));
    folderBase(root);
    mkdirSync(join(root, 'secret'));
    writeFileSync(join(root, 'secret/zarr.json'), '{}');
    for (const parent of [datasetRef('base', '../../secret'), datasetRef('..', 'secret')]) {
      const result = flattenVersion(root, '', { parent });
      expect(result.status).not.toBe(0);
      expect(result.error).toMatch(/^ValueError: /);
      expect(result.error).toContain(`'${parent}'`);
      expect(existsSync(join(root, 'out'))).toBe(false);
    }
  });

  it('a version whose parent is itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'sds-escape-'));
    const parent = datasetRef('v1', LAYER_MANIFEST);
    const result = flattenVersion(root, '', { parent });
    // 1, not null: the reader stopped on its own rather than being killed at the timeout.
    expect(result.status).toBe(1);
    expect(result.error).toMatch(/^ValueError: the stack loops: /);
    expect(result.error).toContain(`'${parent}'`);
    expect(existsSync(join(root, 'out'))).toBe(false);
  });
});
