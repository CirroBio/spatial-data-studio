// What a task that reads cell positions starts from: the opened store, who is signed in
// (kept with its result), and the positions the tissue is drawn from.
import { useStudio } from '../app/studio';
import { useDisplays } from '../item/displayState';
import type { Workbench } from '../workbench/workbench';

export function useSpatialTask(wb: Workbench) {
  const handle = wb.handle!;
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  return { handle, session, coords: displays.spatial?.encoding.coords ?? 'obsm:spatial' };
}
