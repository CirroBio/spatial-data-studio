import type { RegionSet } from '../types';

// Resolve the annotation draw target to the obs column it will actually write
// to. `activeRegionSetId` is a region set's UUID (`RegionSet.id`), but the
// backend's annotate endpoint treats `region_set` as a literal obs column
// name (`adata.obs[set_name] = ...`, see backend/app/sessions/regions.py). If
// the id were sent as-is, selecting an existing set without retyping its name
// would silently create a new obs column named after the UUID.
export function resolveRegionSetColumn(
  newSetName: string,
  activeRegionSetId: string | null,
  regionSets: RegionSet[]
): string {
  if (newSetName) return newSetName;
  return regionSets.find((r) => r.id === activeRegionSetId)?.obs_column ?? '';
}
