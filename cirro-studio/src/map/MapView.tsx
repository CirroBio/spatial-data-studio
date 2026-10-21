import { useMemo, useState } from 'react';
import { STAGES, type StageId } from '../app/library';
import { STAGE_PARAM, useRoute } from '../app/route';
import { useStudio } from '../app/studio';
import { BubbleLayer, type Scene } from './BubbleLayer';
import { Home } from './Home';
import { stageNodes } from './nodes';
import { StageView } from './StageView';

// The overview and the stages share one layer of bubbles, which outlives the change
// between them so each bubble can move from one to the other.
export default function MapView() {
  const route = useRoute();
  const { library, catalog } = useStudio();
  const nodes = useMemo(() => stageNodes(library, catalog), [library, catalog]);
  const [scene, setScene] = useState<Scene | null>(null);
  const stage = route.params.get(STAGE_PARAM) as StageId | null;
  const known = stage && STAGES.some((s) => s.id === stage) ? stage : null;
  if (catalog.status === 'error') {
    return <div className="page-message"><p className="notice notice-danger">{catalog.error}</p></div>;
  }
  return (
    <div className="map">
      {route.section === 'stage' && known
        ? <StageView stage={known} nodes={nodes} onScene={setScene} />
        : <Home nodes={nodes} onScene={setScene} />}
      <BubbleLayer scene={scene} />
    </div>
  );
}
