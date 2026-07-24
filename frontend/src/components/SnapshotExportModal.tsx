import { useEffect, useMemo, useState } from 'react';
import { saveSnapshot, snapshotPreview, type SnapshotRenderSpec } from '../api';
import { reportError } from '../lib/errors';
import { formatError } from '../lib/format';
import { useAppStore } from '../store/sessionStore';
import type { SnapshotExportParams, SnapshotFormat } from '../lib/snapshots';
import { ModalOverlay, ModalHeader } from './DetailModal';

// Frame + export a high-quality figure snapshot. Seeded from the live canvas view
// (viewport + size); the user tweaks zoom, output size, resolution, and format, sees a
// server-rendered preview + the output dimensions, and saves. Styling (colors,
// channels, contrast) is inherited from the display and reproduced server-side.
export default function SnapshotExportModal({ params, onClose }: { params: SnapshotExportParams; onClose: () => void }) {
  const { openSnapshots, pushNotification } = useAppStore();
  const aspect = Math.max(params.canvasSize.width, 1) / Math.max(params.canvasSize.height, 1);

  const [zoom, setZoom] = useState(params.viewport.zoom);
  const [width, setWidth] = useState(Math.round(params.canvasSize.width));
  const [height, setHeight] = useState(Math.round(params.canvasSize.height));
  const [lockAspect, setLockAspect] = useState(true);
  const [dpi, setDpi] = useState(200);
  const [formats, setFormats] = useState<Record<SnapshotFormat, boolean>>({ pdf: true, png: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const setW = (v: number) => { setWidth(v); if (lockAspect) setHeight(Math.max(1, Math.round(v / aspect))); };
  const setH = (v: number) => { setHeight(v); if (lockAspect) setWidth(Math.max(1, Math.round(v * aspect))); };

  const spec = useMemo<SnapshotRenderSpec>(() => ({
    viewport: { target: params.viewport.target, zoom },
    width_px: width, height_px: height, dpi,
    formats: (Object.keys(formats) as SnapshotFormat[]).filter((f) => formats[f]),
    label: params.label, display_id: params.displayId,
  }), [params, zoom, width, height, dpi, formats]);

  // Debounced preview: a small PNG at the current framing (aspect only — resolution
  // doesn't change the composition), superseding any in-flight request.
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      const previewW = Math.min(width, 480);
      const previewH = Math.max(1, Math.round(previewW / (width / height)));
      try {
        const blob = await snapshotPreview(params.sessionId,
          { ...spec, width_px: previewW, height_px: previewH, dpi: 96, formats: ['png'] }, ctrl.signal);
        const url = URL.createObjectURL(blob);
        setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      } catch (e) {
        if (!ctrl.signal.aborted) setError(formatError(e));
      } finally {
        if (!ctrl.signal.aborted) setPreviewLoading(false);
      }
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [params.sessionId, spec, width, height]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const noFormat = spec.formats.length === 0;
  const megapixels = (width * height) / 1e6;

  async function save() {
    if (noFormat) return;
    setSaving(true);
    setError(null);
    try {
      const r = await saveSnapshot(params.sessionId, spec);
      pushNotification({
        kind: 'info',
        message: r.rasterized_points
          ? 'Snapshot saved (points rasterized — too many cells in view for vectors).'
          : 'Snapshot saved.',
      });
      onClose();
      openSnapshots(r.name);
    } catch (e) {
      setError(formatError(e));
      reportError('Snapshot failed', e);
      setSaving(false);
    }
  }

  const numberField = (label: string, value: number, onChange: (v: number) => void, opts?: { min?: number; max?: number; step?: number }) => (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <input
        type="number" value={value} min={opts?.min} max={opts?.max} step={opts?.step ?? 1}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-2 py-1 rounded bg-surface border border-border text-text text-sm"
      />
    </label>
  );

  return (
    <ModalOverlay onClose={onClose} widthClassName="w-[720px] max-w-[95vw]">
      <ModalHeader title="Save snapshot" subtitle="Frame a high-quality figure and export it as PDF and/or PNG." onClose={onClose} />

      <div className="flex flex-col md:flex-row gap-4 p-4">
        <div className="flex-1 min-w-0 flex items-center justify-center bg-black/20 rounded border border-border min-h-[240px]">
          {previewUrl
            ? <img src={previewUrl} alt="snapshot preview" className={`max-w-full max-h-[360px] object-contain ${previewLoading ? 'opacity-60' : ''}`} />
            : <span className="text-xs text-muted">{previewLoading ? 'Rendering preview…' : 'No preview'}</span>}
        </div>

        <div className="w-full md:w-64 shrink-0 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Zoom
            <div className="flex items-center gap-2">
              <input type="range" min={params.viewport.zoom - 4} max={params.viewport.zoom + 4} step={0.1}
                value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="flex-1" />
              <span className="w-10 text-right text-text tabular-nums">{zoom.toFixed(1)}</span>
            </div>
          </label>

          <div className="grid grid-cols-2 gap-2">
            {numberField('Width (px)', width, setW, { min: 1 })}
            {numberField('Height (px)', height, setH, { min: 1 })}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} />
            Lock aspect ratio
          </label>

          {numberField('Resolution (DPI)', dpi, setDpi, { min: 36, max: 600, step: 1 })}

          <div className="flex flex-col gap-1 text-xs text-muted">
            Format
            <div className="flex gap-3 text-text">
              {(['pdf', 'png'] as SnapshotFormat[]).map((f) => (
                <label key={f} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={formats[f]} onChange={(e) => setFormats((s) => ({ ...s, [f]: e.target.checked }))} />
                  {f.toUpperCase()}
                </label>
              ))}
            </div>
          </div>

          <div className="text-[11px] text-muted/80 leading-relaxed border-t border-border pt-2">
            Output: <span className="text-text tabular-nums">{width} × {height} px</span>{' '}
            (<span className="tabular-nums">{megapixels.toFixed(1)} MP</span>,{' '}
            <span className="tabular-nums">{(width / dpi).toFixed(1)}″ × {(height / dpi).toFixed(1)}″</span> @ {dpi} DPI)
          </div>
        </div>
      </div>

      {error && <div className="px-4 pb-2 text-xs text-danger">{error}</div>}

      <div className="p-3 border-t border-border flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-2 text-sm text-muted hover:text-text transition-colors">Cancel</button>
        <button onClick={save} disabled={saving || noFormat}
          className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white rounded text-sm transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </ModalOverlay>
  );
}
