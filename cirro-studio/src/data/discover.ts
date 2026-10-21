// What a dataset holds, judged from its file listing alone (no file is read):
// - runs: folders of raw instrument output, recognised with the Nextflow workflow's own
//   catalog (nextflow/data_types.json), applying its `detect` rules the way
//   nextflow/modules/discovery.nf does, so the app and the pipeline agree on what a
//   folder is;
// - stores: SpatialData stores the viewer can open (`.zarr.zip` files and `.zarr`
//   folders), judged the way packages/viewer's reader judges them;
// - images: microscopy images the browser can open (OME-TIFF), and other slide formats
//   Cirro lists but a browser can't decode;
// - versions: versions this app saved (`layer.json` beside an `overlay/` folder).
import catalog from '../../../nextflow/data_types.json';
import { LAYER_MANIFEST } from '../stack/manifest';

export interface ListedFile {
  // Relative to the dataset's data directory.
  path: string;
  size: number;
}

interface Detect {
  all_of?: string[];
  any_of?: string[][];
  none_of?: string[];
}

export interface RunType {
  id: string;
  label: string;
  detect: Detect;
  run_metrics?: { file: string; format: string; columns: string[] };
}

export const RUN_TYPES: RunType[] = catalog.data_types as RunType[];

export interface Run {
  // Folder within the dataset; '' for the dataset's whole data directory.
  path: string;
  name: string;
  type: RunType;
  metricsPath: string | null;
  size: number;
}

export interface Store {
  path: string;
  isFolder: boolean;
  // `checkpoint`: saved by Spatial Data Studio (carries the viewer/ sidecar).
  // `spatialdata`: written by another tool (spatialdata-io, nf-core/sopa).
  kind: 'checkpoint' | 'spatialdata';
  label: string;
  size: number;
}

export interface Image {
  path: string;
  label: string;
  size: number;
  // OME-TIFF opens in the browser; the others are listed so the user can find them.
  viewable: boolean;
}

export interface DatasetContents {
  runs: Run[];
  stores: Store[];
  images: Image[];
  // The path of a saved version's manifest, when the dataset is one.
  version: string | null;
  totalSize: number;
  fileCount: number;
}

// ---- Raw instrument folders (port of nextflow/modules/discovery.nf) -------------------

/** Every folder in the listing mapped to the names directly inside it. */
function folderTree(files: ListedFile[]): Map<string, Set<string>> {
  const tree = new Map<string, Set<string>>();
  const add = (dir: string, name: string) => {
    let children = tree.get(dir);
    if (!children) tree.set(dir, (children = new Set()));
    children.add(name);
  };
  for (const { path } of files) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i += 1) add(parts.slice(0, i).join('/'), parts[i]);
  }
  return tree;
}

// Only `*` and `?` are meaningful, matching discovery.nf's globToRegex.
function globToRegex(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

const join = (dir: string, rest: string) => (dir ? `${dir}/${rest}` : rest);

function patternPresent(tree: Map<string, Set<string>>, dir: string, pattern: string): boolean {
  const slash = pattern.lastIndexOf('/');
  const target = slash < 0 ? dir : join(dir, pattern.slice(0, slash));
  const leaf = globToRegex(slash < 0 ? pattern : pattern.slice(slash + 1));
  return [...(tree.get(target) ?? [])].some((name) => leaf.test(name));
}

function detectMatches(tree: Map<string, Set<string>>, dir: string, detect: Detect): boolean {
  return (detect.all_of ?? []).every((p) => patternPresent(tree, dir, p))
    && (detect.any_of ?? []).every((group) => group.some((p) => patternPresent(tree, dir, p)))
    && !(detect.none_of ?? []).some((p) => patternPresent(tree, dir, p));
}

const detectScore = (d: Detect) => (d.all_of ?? []).length + (d.any_of ?? []).length;

function runTypeOf(tree: Map<string, Set<string>>, dir: string): RunType | null {
  const matched = RUN_TYPES.filter((t) => detectMatches(tree, dir, t.detect));
  if (matched.length === 0) return null;
  // Most specific wins, as in discovery.nf.
  return matched.reduce((best, t) => (detectScore(t.detect) > detectScore(best.detect) ? t : best));
}

const sizeUnder = (files: ListedFile[], dir: string) => {
  const prefix = dir ? `${dir}/` : '';
  return files.reduce((sum, f) => (f.path.startsWith(prefix) ? sum + f.size : sum), 0);
};

export function findRuns(files: ListedFile[]): Run[] {
  const tree = folderTree(files);
  const runs: Run[] = [];
  const walk = (dir: string) => {
    // A SpatialData store holds folders that look like nothing in the catalog; don't
    // descend into one looking for runs.
    if (/\.zarr$/i.test(dir)) return;
    const type = runTypeOf(tree, dir);
    if (type) {
      const metricsPath = type.run_metrics && patternPresent(tree, dir, type.run_metrics.file)
        ? join(dir, type.run_metrics.file) : null;
      runs.push({ path: dir, name: dir.split('/').pop() || '', type, metricsPath, size: sizeUnder(files, dir) });
      return; // greedy: a classified folder is not descended into
    }
    for (const name of [...(tree.get(dir) ?? [])].sort()) {
      const child = join(dir, name);
      if (tree.has(child)) walk(child);
    }
  };
  walk('');
  return runs;
}

// ---- Viewable stores ------------------------------------------------------------------

const ZIPPED_STORE = /\.zarr\.zip$/i;
const CHECKPOINT_ZIP = /\.sdata\.zarr\.zip$/i;
// 10x Xenium's own archives (in a Xenium bundle, and in sopa's `.explorer/` export) are
// Zarr v2 in 10x's layout, not SpatialData; the reader refuses them.
const XENIUM_ZIP = /(^|\/)(cells|transcripts|analysis|cell_feature_matrix)\.zarr\.zip$/i;
const ZARR_ROOT = '/zarr.json';
// What makes a Zarr v3 folder a SpatialData store the viewer can draw: a table with
// cell positions, or an image (image-only stores open too).
const DRAWABLE = /^(.+)\/(tables\/[^/]+\/obsm\/spatial|images\/[^/]+)\/zarr\.json$/;

/** The store's own name without its extension and content hash
 * (`results-07b1a290f7f2.sdata.zarr.zip` → `results`). */
export function storeName(path: string): string {
  const last = path.replace(/\/+$/, '').split('/').pop() ?? path;
  return last.replace(/\.zarr(\.zip)?$/i, '').replace(/\.sdata$/i, '').replace(/-[0-9a-f]{12}$/i, '');
}

/** A store's name after its folder when it sits below the top level: workflows name
 * their outputs alike and tell them apart by folder
 * (`results/<sample>/results-<hash>.sdata.zarr.zip`). */
export function storeLabel(path: string): string {
  const segments = path.split('/');
  const name = storeName(path);
  return segments.length > 1 ? `${segments[segments.length - 2]} · ${name}` : name;
}

export function findStores(files: ListedFile[]): Store[] {
  const zipped: Store[] = files
    .filter((f) => ZIPPED_STORE.test(f.path) && !XENIUM_ZIP.test(f.path))
    .map((f) => ({
      path: f.path, isFolder: false, kind: CHECKPOINT_ZIP.test(f.path) ? 'checkpoint' : 'spatialdata',
      label: storeLabel(f.path), size: f.size,
    }));
  const paths = new Set(files.map((f) => f.path));
  // Every Zarr v3 node has a zarr.json; a store's root is the outermost one.
  const nodes = new Set(files.filter((f) => f.path.endsWith(ZARR_ROOT)).map((f) => f.path.slice(0, -ZARR_ROOT.length)));
  const isNested = (dir: string) => dir.split('/').some((_, i, parts) => i > 0 && nodes.has(parts.slice(0, i).join('/')));
  const drawable = new Set(files.flatMap((f) => DRAWABLE.exec(f.path)?.[1] ?? []));
  const folders: Store[] = [];
  for (const root of nodes) {
    if (isNested(root)) continue;
    const checkpoint = paths.has(`${root}/viewer${ZARR_ROOT}`);
    if (!checkpoint && !drawable.has(root)) continue;
    folders.push({ path: root, isFolder: true, kind: checkpoint ? 'checkpoint' : 'spatialdata', label: storeLabel(root), size: sizeUnder(files, root) });
  }
  return [...zipped, ...folders].sort((a, b) => a.path.localeCompare(b.path));
}

// ---- Images -----------------------------------------------------------------------------

const OME_TIFF = /\.ome\.tiff?$/i;
const SLIDE = /\.(tiff?|qptiff|svs|ndpi|scn|czi|lif|nd2|ims|lsm|vsi)$/i;

export function findImages(files: ListedFile[], stores: Store[]): Image[] {
  // Images a store holds, or that sit inside an instrument run, are part of that store
  // or run, not images of their own.
  const inStore = (path: string) => stores.some((s) => s.isFolder && path.startsWith(`${s.path}/`));
  return files
    .filter((f) => SLIDE.test(f.path) && !inStore(f.path))
    .map((f) => ({ path: f.path, label: f.path.split('/').pop()!, size: f.size, viewable: OME_TIFF.test(f.path) }));
}

export function datasetContents(files: ListedFile[]): DatasetContents {
  const version = files.find((f) => f.path === LAYER_MANIFEST)?.path ?? null;
  const stores = version ? [] : findStores(files);
  const runs = version ? [] : findRuns(files);
  const inRun = (path: string) => runs.some((r) => r.path === '' || path.startsWith(`${r.path}/`));
  return {
    runs,
    stores,
    images: version ? [] : findImages(files, stores).filter((i) => !inRun(i.path)),
    version,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    fileCount: files.length,
  };
}
