import { useState } from 'react';
import { SpatialCanvas, type SpatialDisplaySpec } from '@cirrobio/spatial-viewer';
import { SpatialSettings } from '@cirrobio/studio-ui';

// The Studio app's spatial canvas: the library canvas with the app's in-canvas
// settings panel dropped into its `controls` slot. The panel is Tailwind-styled app
// UI (shared with the Cirro app through @cirrobio/studio-ui), so it does not ship
// with the library — a host that renders the canvas without the app's stylesheet (a
// Cirro dashboard tile) passes no controls and drives the display from its own
// inspector instead.
export default function StudioSpatialCanvas({
  display, sessionId, canvasMode, annotationTarget, embedded, restoreViewport,
}: {
  display: SpatialDisplaySpec;
  sessionId: string;
  canvasMode: 'regions' | 'shapes' | 'subset' | null;
  annotationTarget: { regionSetId: string; category: string; color: string } | null;
  // Embedded under a hosting dashboard: it owns the display settings over
  // postMessage, so the in-canvas panel would be a second, competing control surface
  // over the same state.
  embedded: boolean;
  // Put the camera where the display says, rather than fitting to the data. Separate
  // from `embedded` because a shared view link restores the camera while keeping the
  // controls — the two happen to coincide only for a dashboard host.
  restoreViewport: boolean;
}) {
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  return (
    <SpatialCanvas
      display={display}
      sessionId={sessionId}
      canvasMode={canvasMode}
      annotationTarget={annotationTarget}
      followDisplayViewport={restoreViewport}
      controls={embedded ? undefined : (api) => (
        <SpatialSettings api={api} collapsed={panelCollapsed} onCollapse={setPanelCollapsed} />
      )}
    />
  );
}
