// An item opened from the map: a spatial dataset (a store, or a version of one), an
// image, or an instrument run, each as its own picture.
import { useEffect, useState } from 'react';
import { backToMap, ITEM_PARAM, STAGE_PARAM, stepBack, useRoute } from '../app/route';
import { refOfItem, type SpatialEntity } from '../app/library';
import { useStudio } from '../app/studio';
import { itemKey, itemsOf, type CatalogItem } from '../data/model';
import { describeError } from '../cirro/session';
import { ImagePage } from './ImagePage';
import { RunPage } from './RunPage';
import { StorePage } from './StorePage';

// An item the catalog hasn't reached yet (a link into a dataset still being scanned, or
// a version in another project): scanned on its own.
function useItem(datasetId: string | null, path: string): { item: CatalogItem | null; error: string | null } {
  const { library, collection, catalog } = useStudio();
  const known = datasetId ? library.itemByKey.get(itemKey(datasetId, path)) ?? null : null;
  const [found, setFound] = useState<{ item: CatalogItem | null; error: string | null }>({ item: null, error: null });
  useEffect(() => {
    if (known || !datasetId) return;
    let live = true;
    (async () => {
      const dataset = catalog.byId.get(datasetId) ?? await collection.resolveDataset(datasetId);
      if (!dataset) throw new Error('This dataset isn\'t in this project, or you can\'t see it.');
      const item = itemsOf(dataset, await collection.scan(dataset)).find((i) => i.path === path);
      if (!item) throw new Error(`Nothing at ${path || 'the top'} of ${dataset.name} can be opened here.`);
      return item;
    })().then(
      (item) => live && setFound({ item, error: null }),
      (e: unknown) => live && setFound({ item: null, error: describeError(e) }),
    );
    return () => {
      live = false;
    };
  }, [known, datasetId, path, collection, catalog.byId]);
  return known ? { item: known, error: null } : found;
}

export default function ItemPage() {
  const route = useRoute();
  const { library } = useStudio();
  const path = route.params.get(ITEM_PARAM) ?? '';
  const { item, error } = useItem(route.dataset, path);
  const fromStage = route.params.has(STAGE_PARAM);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.popover-panel, .modal')) return;
      if (route.section === 'task') stepBack({ section: 'item', 'spatial-data-studio.task': null });
      else backToMap(fromStage);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route.section, fromStage]);

  if (error) {
    return (
      <div className="page-message">
        <p className="notice notice-danger">{error}</p>
        <button type="button" className="button" onClick={() => backToMap(fromStage)}>Back to the map</button>
      </div>
    );
  }
  if (!item) return <p className="page-message muted">Finding it…</p>;
  if (item.kind === 'image') return <ImagePage item={item} />;
  if (item.kind === 'run') return <RunPage item={item} />;
  const ref = item.kind === 'version' ? item.base : refOfItem(item);
  const entity: SpatialEntity | null = library.spatial.find((e) => e.baseRef === ref) ?? null;
  return <StorePage key={item.key} item={item} entity={entity} />;
}
