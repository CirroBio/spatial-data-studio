// Versions saved in this browser: what a read-only project saves (a public project, or a
// Cirro project the user can only read), filed under the project it was saved in. They
// hold the same files a Cirro dataset would, so the rest of the app reads them alike.
import { APP_TAG } from '../app/appInfo';
import type { VersionFile } from '../stack/version';
import type { NewVersion } from './collection';
import { kvGet, kvPut, kvValues } from './idb';
import type { DatasetRecord } from './model';

export interface BrowserDataset {
  id: string;
  // The project it was made in; absent on versions saved before there were several.
  projectId?: string;
  name: string;
  description: string;
  createdAt: string;
  sourceIds: string[];
  files: VersionFile[];
}

export const BROWSER_FOLDER = 'Saved in this browser';

export const listBrowserDatasets = () => kvValues<BrowserDataset>('datasets');
export const getBrowserDataset = (id: string) => kvGet<BrowserDataset>('datasets', id);
const putBrowserDataset = (dataset: BrowserDataset) => kvPut('datasets', dataset.id, dataset);

/** A version saved in this browser, listed like a project's datasets. */
export const browserRecord = (d: BrowserDataset): DatasetRecord => ({
  id: d.id,
  name: d.name,
  description: d.description,
  processId: 'browser-version',
  processName: 'Version saved in this browser',
  status: 'COMPLETED',
  createdAt: d.createdAt,
  createdBy: 'you',
  tags: [{ key: '', ...APP_TAG }],
  folders: [BROWSER_FOLDER],
  sourceIds: d.sourceIds,
  share: null,
});

/** Saves a version in this browser, in the project it was made in; resolves to its ID. */
export async function saveInBrowser(projectId: string, version: NewVersion): Promise<string> {
  const id = crypto.randomUUID();
  await putBrowserDataset({
    id, projectId, name: version.name, description: version.description,
    createdAt: new Date().toISOString(), sourceIds: version.sourceIds, files: version.files,
  });
  return id;
}

async function saved(datasetId: string): Promise<BrowserDataset> {
  const dataset = await getBrowserDataset(datasetId);
  if (!dataset) throw new Error(`Dataset ${datasetId} is not in this browser.`);
  return dataset;
}

/** The files of a version saved in this browser, listed as a dataset's are. */
export const browserListing = async (datasetId: string) => (await saved(datasetId)).files.map((f) => ({ path: f.name, size: f.bytes.length }));

/** One file of a version saved in this browser. */
export async function browserFile(datasetId: string, path: string): Promise<Uint8Array> {
  const file = (await saved(datasetId)).files.find((f) => f.name === path);
  if (!file) throw new Error(`Dataset ${datasetId} has no file ${path}.`);
  return file.bytes;
}
