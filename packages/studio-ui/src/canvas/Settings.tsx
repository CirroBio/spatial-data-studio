import type { EmbeddingCanvasControls, SpatialCanvasControls } from '@cirrobio/spatial-viewer';
import CanvasControls from './CanvasControls';
import EmbeddingControls from './EmbeddingControls';

// A canvas's `controls` slot filled with the Studio's display settings: the one place a
// canvas's controls API becomes the panel's props, for both apps. The panel floats over
// the canvas and minimizes to a gear (the Studio), or is docked in the host's own panel.
interface Placement {
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  docked?: boolean;
}

const stay = () => undefined;

export function SpatialSettings({ api, collapsed = false, onCollapse = stay, docked = false }: Placement & { api: SpatialCanvasControls }) {
  return (
    <CanvasControls
      {...api}
      setShowPoints={(v) => api.updateEncoding({ show_points: v })}
      setShowImage={(v) => api.updateEncoding({ show_image: v })}
      setInvertX={(v) => api.updateEncoding({ invert_x: v })}
      setInvertY={(v) => api.updateEncoding({ invert_y: v })}
      setBackground={(v) => api.updateEncoding({ background: v })}
      setShowLegend={(v) => api.updateEncoding({ show_channel_legend: v })}
      setShowMinimap={(v) => api.updateEncoding({ show_minimap: v })}
      setRenderMode={(v) => api.updateEncoding({ render_mode: v })}
      setShapesElement={(v) => api.updateEncoding({ shapes_layer: v })}
      panelCollapsed={collapsed}
      setPanelCollapsed={onCollapse}
      docked={docked}
    />
  );
}

export function EmbeddingSettings({ api, collapsed = false, onCollapse = stay, docked = false }: Placement & { api: EmbeddingCanvasControls }) {
  return <EmbeddingControls {...api} panelCollapsed={collapsed} setPanelCollapsed={onCollapse} docked={docked} />;
}
