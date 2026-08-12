// DataSource backed by a live session's HTTP API — the existing behavior, moved
// behind the interface so the canvas can be pointed at a checkpoint instead.
import { loadOmeZarr } from '@vivjs/loaders';
import {
  getElements, getFieldData, getImageInfo, getImageThumbnailUrl, getShapesGeoArrow, searchVarNames,
} from '../api';
import type { DataSource, ImageLoader } from './types';

export function createApiSource(sessionId: string): DataSource {
  return {
    kind: 'live',
    id: sessionId,
    getFieldData: (fieldPath) => getFieldData(sessionId, fieldPath),
    getImageInfo: (element) => getImageInfo(sessionId, element),
    getShapesGeoArrow: (element, bbox, limit) =>
      getShapesGeoArrow(sessionId, element, bbox, limit),
    getElements: () => getElements(sessionId),
    searchVarNames: (query, limit) => searchVarNames(sessionId, query, limit),
    imageThumbnailUrl: (element, channels, maxPx) =>
      getImageThumbnailUrl(sessionId, element, channels, maxPx),

    async openImageLoader(element): Promise<ImageLoader> {
      const info = await getImageInfo(sessionId, element);
      if (!info.raster_base_url || !info.zarr_group_path) {
        throw new Error(`image ${element} has no raster store to read`);
      }
      // zarrita's FetchStore does `new URL(root)`, which rejects a root-relative
      // path, so resolve against the current origin (the dev proxy and prod both
      // serve /api there).
      const url = new URL(`${info.raster_base_url}/${info.zarr_group_path}`, window.location.origin).href;
      const { data } = await loadOmeZarr(url, { type: 'multiscales' });
      return data;
    },
  };
}
