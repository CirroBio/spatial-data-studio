// The line above a picture: its name, what it is, how big, where it came from and what
// it was made into, and a way to its page in Cirro.
import type { ReactNode } from 'react';
import type { CatalogItem } from '../data/model';
import { stageOf, type Library, type StageId } from '../app/library';
import { backToMap, openItem, STAGE_PARAM, useRoute } from '../app/route';
import { useStudio } from '../app/studio';
import { formatBytes, formatDate, Popover, tint } from '../app/ui';
import { openWorkspaces, requestFor } from '../workspaces/request';

export interface Kin { item: CatalogItem; label: string; color: string }

export function Facts({ title, item, kind, stage, from, into, extra, unsaved = false }: {
  title: string; item: CatalogItem; kind: string; stage: StageId; from: Kin[]; into: Kin[]; extra?: ReactNode;
  // Changes not saved as a version, which a workspace opening the item can't see.
  unsaved?: boolean;
}) {
  const { catalog, collection, library } = useStudio();
  const fromStage = useRoute().params.has(STAGE_PARAM);
  const dataset = catalog.byId.get(item.datasetId);
  const url = collection.datasetUrl(item.datasetId);
  const { color, label } = stageOf(stage);
  return (
    <div className="facts" style={tint(color)}>
      <button type="button" className="facts-back" title="Back to the map (Esc)" onClick={() => backToMap(fromStage)}>
        <svg className="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
        {fromStage ? label : 'All data'}
      </button>
      <h1 className="facts-title">{title}</h1>
      <span className="facts-kind"><span className="dot" /> {kind}</span>
      {item.size > 0 && <span>{formatBytes(item.size)}</span>}
      {dataset && <span className="muted">{dataset.processName}</span>}
      {dataset?.createdAt && <span className="muted">{formatDate(dataset.createdAt)}</span>}
      {from.length > 0 && <span className="facts-kin">from {from.map((k) => <KinChip key={k.item.key} kin={k} />)}</span>}
      {into.length > 0 && <span className="facts-kin">made into {into.slice(0, 3).map((k) => <KinChip key={k.item.key} kin={k} />)}{into.length > 3 && <span className="muted"> +{into.length - 3}</span>}</span>}
      {extra}
      <span className="facts-spacer" />
      {collection.kind === 'cirro' && (
        <button type="button" className="button button-small" title="A workspace running the full Spatial Data Studio on it, in a new tab"
          onClick={() => openWorkspaces(requestFor(item, title, library, unsaved))}>
          Open in the full Studio
        </button>
      )}
      <Popover align="right" label={<>Details ▾</>} className="facts-details">
        {() => (
          <dl className="details">
            <dt>Dataset</dt><dd>{dataset?.name ?? item.datasetId}</dd>
            <dt>Path</dt><dd className="mono">{item.path || '(whole dataset)'}</dd>
            {dataset?.createdBy && <><dt>Made by</dt><dd>{dataset.createdBy}</dd></>}
            {dataset?.folders.length ? <><dt>Folder</dt><dd>{dataset.folders.join(', ')}</dd></> : null}
            {dataset?.share && <><dt>Shared from</dt><dd>{dataset.share}</dd></>}
            {url && <><dt>In Cirro</dt><dd><a href={url} target="_blank" rel="noreferrer">Open the dataset ↗</a></dd></>}
          </dl>
        )}
      </Popover>
    </div>
  );
}

function KinChip({ kin }: { kin: Kin }) {
  return (
    <button type="button" className="kin-chip" style={tint(kin.color)} onClick={() => openItem(kin.item.datasetId, kin.item.path)}>
      <span className="dot" /> {kin.label}
    </button>
  );
}

/** Runs and images in the datasets an item's dataset was made from, and spatial data
 * made from an item's dataset. */
export function kinOf(item: CatalogItem, library: Library, sourceIds: (datasetId: string) => string[]): { from: Kin[]; into: Kin[] } {
  const kin = (i: CatalogItem): Kin => ({
    item: i,
    label: i.label,
    color: i.kind === 'image' ? '--sds-stage-image' : i.kind === 'run' ? '--sds-stage-run' : '--sds-stage-store',
  });
  const sources = new Set(sourceIds(item.datasetId));
  const from = [...library.images, ...library.runs].filter((i) => sources.has(i.datasetId) && i.key !== item.key).map(kin);
  const into = library.spatial.flatMap((e) => (e.base && sourceIds(e.base.datasetId).includes(item.datasetId) ? [kin(e.base)] : []));
  return { from, into };
}
