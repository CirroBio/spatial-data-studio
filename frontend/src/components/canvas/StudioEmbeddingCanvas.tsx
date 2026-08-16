import { useState } from 'react';
import {
  EmbeddingCanvas, type EmbeddingDisplaySpec, type ObsField, type ObsmField,
} from '@cirrobio/spatial-viewer';
import EmbeddingControls from './EmbeddingControls';

// The Studio app's embedding canvas. Same slot arrangement as StudioSpatialCanvas.
export default function StudioEmbeddingCanvas({
  display, sessionId, obsmFields, obsFields, layerNames, canvasMode, annotationTarget, embedded,
}: {
  display: EmbeddingDisplaySpec;
  sessionId: string;
  obsmFields: ObsmField[];
  obsFields: ObsField[];
  layerNames: string[];
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
  embedded: boolean;
}) {
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  return (
    <EmbeddingCanvas
      display={display}
      sessionId={sessionId}
      obsmFields={obsmFields}
      obsFields={obsFields}
      layerNames={layerNames}
      canvasMode={canvasMode}
      annotationTarget={annotationTarget}
      followDisplayViewport={embedded}
      controls={embedded ? undefined : (api) => (
        <EmbeddingControls
          {...api}
          panelCollapsed={panelCollapsed}
          setPanelCollapsed={setPanelCollapsed}
        />
      )}
    />
  );
}
