import type { ShapeKind } from '../schemas/annotations';
import { SHAPE_KINDS } from '../schemas/annotations';

const TOOL_LABELS: Record<ShapeKind, string> = {
  line: 'Line / Arrow',
  box: 'Box',
  polygon: 'Polygon',
  ellipse: 'Ellipse',
  text: 'Text',
};

interface Props {
  activeShapeTool: ShapeKind | null;
  setActiveShapeTool: (tool: ShapeKind | null) => void;
  draftVertexCount: number;
  onClosePolygon: () => void;
  onCancelDraft: () => void;
}

// Tool-selection toolbar for the shape-annotation editor — the drag/click drawing
// interactions themselves live on the canvas (SpatialCanvas); this just arms a
// tool. The click-built polygon collects a vertex per click and is committed by
// the Close Shape button here, since line/box/ellipse are single drag gestures
// with nothing to close or cancel mid-shape.
export default function ShapeToolbar({ activeShapeTool, setActiveShapeTool, draftVertexCount, onClosePolygon, onCancelDraft }: Props) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1">
        {SHAPE_KINDS.map((kind) => (
          <button
            key={kind}
            onClick={() => setActiveShapeTool(activeShapeTool === kind ? null : kind)}
            className={`py-1.5 text-xs rounded border transition-colors ${
              activeShapeTool === kind
                ? 'bg-accent text-white border-accent'
                : 'bg-bg border-border text-text hover:border-accent'
            }`}
          >
            {TOOL_LABELS[kind]}
          </button>
        ))}
      </div>
      {activeShapeTool === 'polygon' && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] text-muted/60 leading-snug">
            Click points on the canvas ({draftVertexCount} placed) to outline a polygon, then close it.
          </p>
          <div className="flex gap-1">
            <button
              onClick={onClosePolygon}
              disabled={draftVertexCount < 3}
              className="flex-1 py-1.5 text-xs rounded border border-accent bg-accent text-white enabled:hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              Close Shape
            </button>
            {draftVertexCount > 0 && (
              <button
                onClick={onCancelDraft}
                className="px-2 py-1.5 text-xs rounded border border-border text-muted hover:text-text hover:border-accent transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {activeShapeTool === 'line' && (
        <p className="text-[10px] text-muted/60 leading-snug">Drag on the canvas from start to end.</p>
      )}
      {(activeShapeTool === 'box' || activeShapeTool === 'ellipse') && (
        <p className="text-[10px] text-muted/60 leading-snug">Drag on the canvas to size it.</p>
      )}
      {activeShapeTool === 'text' && (
        <p className="text-[10px] text-muted/60 leading-snug">Click on the canvas to place a label, then edit its text below.</p>
      )}
    </div>
  );
}
