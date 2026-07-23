import { useRef } from 'react';
import { useAppStore } from '../store/sessionStore';
import { updateShapeAnnotation, deleteShapeAnnotation } from '../api';
import { reportError } from '../lib/errors';
import ColorSwatchPicker from './ColorSwatchPicker';
import ShapeToolbar from './ShapeToolbar';
import type { ShapeAnnotation, StrokeStyle, FillStyle } from '../schemas/annotations';
import { defaultFill } from '../schemas/annotations';
import { polygonFromClicks } from '../lib/shapeAnnotations';

const SHAPE_COLORS = [
  '#3388ff', '#e05c5c', '#5cb85c', '#e0a83a', '#a05ce0', '#4ab8c4', '#e05cba', '#7a8b3a',
];

const KIND_LABEL: Record<ShapeAnnotation['geometry']['kind'], string> = {
  line: 'Line', box: 'Box', polygon: 'Polygon', ellipse: 'Ellipse', text: 'Text',
};

export default function AnnotationsPanel() {
  const {
    activeSessionId,
    shapeAnnotations,
    activeShapeTool,
    setActiveShapeTool,
    selectedShapeId,
    setSelectedShapeId,
    draftVertices,
    clearDraft,
    upsertShapeAnnotation,
    removeShapeAnnotationLocal,
    commitNewShape,
  } = useAppStore();

  function handleClosePolygon() {
    const geometry = polygonFromClicks(draftVertices);
    if (geometry) commitNewShape(geometry); // commitNewShape clears the draft + selects the new shape
  }

  // Style edits (color/width/alpha sliders) persist debounced, same 500ms
  // coalescing pattern SpatialCanvas uses for display-encoding edits, so a
  // slider drag doesn't fire a job per tick.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function persistShape(shape: ShapeAnnotation) {
    upsertShapeAnnotation(shape);
    if (!activeSessionId) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    const sid = activeSessionId;
    persistTimer.current = setTimeout(() => {
      updateShapeAnnotation(sid, shape.id, shape).catch((err) => reportError('Update shape failed', err));
    }, 500);
  }

  const selectedShape = shapeAnnotations.find((s) => s.id === selectedShapeId) ?? null;

  function patchStroke(patch: Partial<StrokeStyle>) {
    if (!selectedShape) return;
    persistShape({ ...selectedShape, stroke: { ...selectedShape.stroke, ...patch } });
  }

  function patchFill(patch: Partial<FillStyle>) {
    if (!selectedShape) return;
    const fill = selectedShape.fill ?? defaultFill();
    persistShape({ ...selectedShape, fill: { ...fill, ...patch } });
  }

  function patchText(patch: { text?: string; fontSize?: number }) {
    if (!selectedShape || selectedShape.geometry.kind !== 'text') return;
    persistShape({ ...selectedShape, geometry: { ...selectedShape.geometry, ...patch } });
  }

  async function handleDelete(id: string) {
    if (!activeSessionId) return;
    removeShapeAnnotationLocal(id);
    if (selectedShapeId === id) setSelectedShapeId(null);
    try {
      await deleteShapeAnnotation(activeSessionId, id);
    } catch (err) {
      reportError('Delete shape failed', err);
    }
  }

  if (!activeSessionId) {
    return <div className="px-3 py-4 text-xs text-muted/60 text-center">No session open</div>;
  }

  return (
    <div className="flex flex-col gap-0">
      <div className="px-3 py-2 border-b border-border/50">
        <label className="text-[10px] text-muted font-mono uppercase tracking-wide block mb-1.5">Draw shape</label>
        <ShapeToolbar
          activeShapeTool={activeShapeTool}
          setActiveShapeTool={setActiveShapeTool}
          draftVertexCount={draftVertices.length}
          onClosePolygon={handleClosePolygon}
          onCancelDraft={clearDraft}
        />
      </div>

      {selectedShape && (
        <div className="px-3 py-2 border-b border-border/50 flex flex-col gap-2.5">
          <label className="text-[10px] text-muted font-mono uppercase tracking-wide block">
            {KIND_LABEL[selectedShape.geometry.kind]} style
          </label>

          {selectedShape.geometry.kind === 'text' && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] text-muted/70">Text</span>
              <input
                type="text"
                value={selectedShape.geometry.text}
                onChange={(e) => patchText({ text: e.target.value })}
                placeholder="Label text"
                className="bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
              />
              <label className="flex items-center gap-2 text-[11px] text-text/80">
                Font size
                {/* fontSize is world-space, so it varies with the dataset's
                    coordinate scale; step relative to the current value keeps the
                    spinner useful whether it reads ~0.5 or ~12000. */}
                <input
                  type="number" min={0} step={Math.max(selectedShape.geometry.fontSize / 20, 0.01)}
                  value={selectedShape.geometry.fontSize}
                  onChange={(e) => patchText({ fontSize: Number(e.target.value) })}
                  className="w-16 bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
                />
              </label>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] text-muted/70">{selectedShape.geometry.kind === 'text' ? 'Text color' : 'Stroke'}</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={selectedShape.stroke.color}
                onChange={(e) => patchStroke({ color: e.target.value })}
                className="w-7 h-6 rounded border border-border bg-bg cursor-pointer"
              />
              <ColorSwatchPicker
                colors={SHAPE_COLORS}
                selected={selectedShape.stroke.color}
                onSelect={(c) => patchStroke({ color: c })}
              />
            </div>
            {selectedShape.geometry.kind !== 'text' && (
              <>
                <label className="flex items-center gap-2 text-[11px] text-text/80">
                  Width
                  <input
                    type="number" min={0} step={0.5}
                    value={selectedShape.stroke.width}
                    onChange={(e) => patchStroke({ width: Number(e.target.value) })}
                    className="w-16 bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
                  />
                </label>
                <label className="flex items-center gap-2 text-[11px] text-text/80">
                  Style
                  <select
                    value={selectedShape.stroke.dash}
                    onChange={(e) => patchStroke({ dash: e.target.value as StrokeStyle['dash'] })}
                    className="flex-1 bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
                  >
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                    <option value="dotted">Dotted</option>
                  </select>
                </label>
              </>
            )}
            {selectedShape.geometry.kind === 'line' && (
              <>
                <div className="flex gap-3 text-[11px] text-text/80">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={selectedShape.stroke.arrowStart}
                      onChange={(e) => patchStroke({ arrowStart: e.target.checked })} />
                    Arrow start
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={selectedShape.stroke.arrowEnd}
                      onChange={(e) => patchStroke({ arrowEnd: e.target.checked })} />
                    Arrow end
                  </label>
                </div>
                {(selectedShape.stroke.arrowStart || selectedShape.stroke.arrowEnd) && (
                  <label className="flex items-center gap-2 text-[11px] text-text/80">
                    Arrow size
                    <input
                      type="number" min={1} step={1}
                      value={selectedShape.stroke.arrowSize}
                      onChange={(e) => patchStroke({ arrowSize: Number(e.target.value) })}
                      className="w-16 bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
                    />
                  </label>
                )}
              </>
            )}
            <label className="flex items-center gap-2 text-[11px] text-text/80">
              Z-order
              <input
                type="number" step={1}
                value={selectedShape.stroke.z}
                onChange={(e) => patchStroke({ z: Number(e.target.value) })}
                className="w-16 bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
              />
            </label>
          </div>

          {selectedShape.geometry.kind !== 'line' && selectedShape.geometry.kind !== 'text' && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-[10px] text-muted/70">
                <input type="checkbox" checked={selectedShape.fill?.enabled ?? false}
                  onChange={(e) => patchFill({ enabled: e.target.checked })} />
                Fill
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={selectedShape.fill?.color ?? '#3388ff'}
                  onChange={(e) => patchFill({ color: e.target.value })}
                  className="w-7 h-6 rounded border border-border bg-bg cursor-pointer"
                  disabled={!selectedShape.fill?.enabled}
                />
                <ColorSwatchPicker
                  colors={SHAPE_COLORS}
                  selected={selectedShape.fill?.color ?? ''}
                  onSelect={(c) => patchFill({ color: c })}
                />
              </div>
              <label className="flex items-center gap-2 text-[11px] text-text/80">
                Alpha
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={selectedShape.fill?.alpha ?? 0}
                  onChange={(e) => patchFill({ alpha: Number(e.target.value) })}
                  className="flex-1"
                />
              </label>
              <label className="flex items-center gap-2 text-[11px] text-text/80">
                Z-order
                <input
                  type="number" step={1}
                  value={selectedShape.fill?.z ?? 0}
                  onChange={(e) => patchFill({ z: Number(e.target.value) })}
                  className="w-16 bg-bg border border-border rounded px-1.5 py-0.5 text-xs text-text focus:outline-none focus:border-accent"
                />
              </label>
            </div>
          )}

          <button
            onClick={() => handleDelete(selectedShape.id)}
            className="py-1 text-xs bg-danger/10 hover:bg-danger/20 text-danger rounded transition-colors"
          >
            Delete shape
          </button>
        </div>
      )}

      <div className="border-b border-border/50">
        <div className="px-3 py-1.5">
          <span className="text-[10px] text-muted font-mono uppercase tracking-wide">Shapes</span>
        </div>
        {shapeAnnotations.length === 0 ? (
          <div className="px-3 pb-2 text-[11px] text-muted/60">No shapes yet</div>
        ) : (
          <ul className="pb-1">
            {shapeAnnotations.map((shape) => (
              <li key={shape.id}>
                <button
                  onClick={() => setSelectedShapeId(selectedShapeId === shape.id ? null : shape.id)}
                  className={`w-full text-left px-3 py-1 flex items-center gap-2 hover:bg-accent-lo/20 transition-colors ${
                    selectedShapeId === shape.id ? 'bg-accent-lo/30' : ''
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-sm shrink-0 border border-black/20"
                    style={{ background: shape.stroke.color }}
                  />
                  <span className="text-[11px] text-text/90 truncate flex-1">
                    {shape.label
                      || (shape.geometry.kind === 'text' ? shape.geometry.text : '')
                      || KIND_LABEL[shape.geometry.kind]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
