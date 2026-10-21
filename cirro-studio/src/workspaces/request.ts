// What the workspaces sheet is asked to show. An item asks for a new workspace with
// itself in it; the top bar just opens the sheet. Kept apart from the sheet, which loads
// only for a signed-in project, so an item page asks without loading the Cirro client.
import { useSyncExternalStore } from 'react';
import type { Workspace } from '@cirrobio/api-client';
import { ancestry, type Library } from '../app/library';
import type { CatalogItem } from '../data/model';
import { parseCirroRef } from '../stack/cirroRef';

/** An item to open in a workspace, with every dataset it needs: a saved version brings
 * the datasets beneath it, which the Studio reads it through. */
export interface WorkspaceRequest {
  key: string;
  label: string;
  datasetIds: string[];
  // Changes not saved as a version, which a workspace can't see.
  unsaved: boolean;
}

export function requestFor(item: CatalogItem, label: string, library: Library, unsaved = false): WorkspaceRequest {
  if (item.kind !== 'version') return { key: item.key, label, datasetIds: [item.datasetId], unsaved };
  const entity = library.spatial.find((e) => e.baseRef === item.base);
  const chain = entity ? ancestry(entity, item) : [item.base];
  const datasetIds = [...new Set([...chain.flatMap((ref) => parseCirroRef(ref)?.datasetId ?? []), item.datasetId])];
  return { key: item.key, label, datasetIds, unsaved };
}

/** The sheet's form: a new workspace, or new datasets for a stopped one (`changing`).
 * `id` is new for every form, so one replacing another starts afresh. */
export interface WorkspaceForm { id: number; requests: WorkspaceRequest[]; changing: Workspace | null }
interface SheetState { open: boolean; form: WorkspaceForm | null }

let sheet: SheetState = { open: false, form: null };
let forms = 0;
const listeners = new Set<() => void>();
const setSheet = (next: SheetState) => {
  sheet = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Opens the sheet; with a request, on a new workspace form holding it. */
export const openWorkspaces = (request?: WorkspaceRequest) =>
  setSheet({ open: true, form: request ? { id: ++forms, requests: [request], changing: null } : null });
export const showForm = (requests: WorkspaceRequest[], changing: Workspace | null) =>
  setSheet({ open: true, form: { id: ++forms, requests, changing } });
export const closeForm = () => setSheet({ ...sheet, form: null });
export const closeWorkspaces = () => setSheet({ open: false, form: null });
export const useWorkspacesSheet = () => useSyncExternalStore(subscribe, () => sheet);
