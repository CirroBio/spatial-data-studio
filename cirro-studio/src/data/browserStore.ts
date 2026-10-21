// Versions saved while exploring the examples, kept in this browser: the same files a
// Cirro dataset would hold, so the rest of the app reads them alike.
import type { VersionFile } from '../stack/version';
import { kvGet, kvPut, kvValues } from './idb';

export interface BrowserDataset {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  sourceIds: string[];
  files: VersionFile[];
}

export const listBrowserDatasets = () => kvValues<BrowserDataset>('datasets');
export const getBrowserDataset = (id: string) => kvGet<BrowserDataset>('datasets', id);
export const putBrowserDataset = (dataset: BrowserDataset) => kvPut('datasets', dataset.id, dataset);
