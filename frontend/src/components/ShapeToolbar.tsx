import type { ShapeKind } from '../schemas/annotations';
import { SHAPE_KINDS } from '../schemas/annotations';

const TOOL_LABELS: Record<ShapeKind, string> = {
  line: 'Line / Arrow',
  box: 'Box',
  trapezoid: 'Trapezoid',
  ellipse: 'Ellipse',
};

interface Props {
  activeShapeTool: ShapeKind | null;
  setActiveShapeTool: (tool: ShapeKind | null) => void;
  draftVertexCount: number;
  onCancelDraft: () => void;
}

// Tool-selection toolbar for the shape-annotation editor — the drag/click drawing
// interactions themselves live on the canvas (SpatialCanvas); this just arms a
// tool. Shares DrawControls' "in-progress" affordance for the click-built
// trapezoid, since line/box/ellipse are single drag gestures with nothing to
// cancel mid-shape.
export default function ShapeToolbar({ activeShapeTool, setActiveShapeTool, draftVertexCount, onCancelDraft }: Props) {
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
      {activeShapeTool === 'trapezoid' && (
        <p className="text-[10px] text-muted/60 leading-snug">
          Click 4 points on the canvas ({draftVertexCount}/4) to place the trapezoid.
          {draftVertexCount > 0 && (
            <button onClick={onCancelDraft} className="ml-1 underline hover:text-text">Cancel</button>
          )}
        </p>
      )}
      {activeShapeTool === 'line' && (
        <p className="text-[10px] text-muted/60 leading-snug">Drag on the canvas from start to end.</p>
      )}
      {(activeShapeTool === 'box' || activeShapeTool === 'ellipse') && (
        <p className="text-[10px] text-muted/60 leading-snug">Drag on the canvas to size it.</p>
      )}
    </div>
  );
}
