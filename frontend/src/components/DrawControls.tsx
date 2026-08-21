import { SELECTION_SHAPE_KINDS, type SelectionTool } from '@cirrobio/spatial-viewer';
import { useAppStore } from '../store/sessionStore';

const TOOL_LABELS: Record<SelectionTool, string> = {
  lasso: 'Lasso',
  circle: 'Circle',
  ellipse: 'Ellipse',
  square: 'Square',
  rectangle: 'Rectangle',
};
const TOOLS: SelectionTool[] = ['lasso', ...SELECTION_SHAPE_KINDS];

interface Props {
  regionCount: number;
  drawRingLength: number;
  drawPolygonsLength: number;
  shapePlaced: boolean;
  onFinish: () => void;
  onClear: () => void;
}

// Selection-tool picker plus the "Finish region / Clear" controls, shared by the
// regions and subsetting panels — the drawing itself happens on the canvas, these
// actions just manage what has been drawn. The lasso collects a vertex per click; a
// geometric tool places its shape with one drag, which is then moved by its body and
// resized/rotated by its handles (SpatialCanvas / useSelectionShape).
export default function DrawControls({
  regionCount, drawRingLength, drawPolygonsLength, shapePlaced, onFinish, onClear,
}: Props) {
  const { selectionTool, setSelectionTool } = useAppStore();
  const shapeTool = selectionTool !== 'lasso';
  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        {TOOLS.map((tool) => (
          <button
            key={tool}
            type="button"
            onClick={() => setSelectionTool(tool)}
            className={`py-1 text-[10px] rounded border transition-colors ${
              selectionTool === tool
                ? 'bg-accent text-on-accent border-accent'
                : 'bg-bg border-border text-text hover:border-accent'
            }`}
          >
            {TOOL_LABELS[tool]}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted leading-snug">
        {regionCount} region{regionCount === 1 ? '' : 's'}
        {drawRingLength > 0 ? `, ${drawRingLength}-pt drawing` : ''}.
      </p>
      {shapeTool && (
        <p className="text-[10px] text-muted/60 leading-snug">
          {shapePlaced
            ? `Drag the shape to move it, its handles to resize${selectionTool === 'circle' ? '' : ' and rotate'}. Finish region to keep it and place another.`
            : 'Drag on the canvas to place it.'}
        </p>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={onFinish}
          disabled={drawRingLength < 3 && !shapePlaced}
          className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent disabled:opacity-40 transition-colors"
        >
          Finish region
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={drawPolygonsLength === 0 && drawRingLength === 0 && !shapePlaced}
          className="flex-1 py-1 text-[11px] bg-bg border border-border rounded text-text hover:border-accent disabled:opacity-40 transition-colors"
        >
          Clear
        </button>
      </div>
    </>
  );
}
