// Save the view open now (the tissue, or the cell map) as a figure: its spec (what is drawn,
// colors, camera) goes into the draft's `uns`, so the version redraws it from its own data.
// Export draws it now, at print size, as SVG, PDF or a 300 dpi PNG: the canvas as an image,
// with the title, legend and (on the tissue) a scale bar as vectors.
import { useMemo, useState } from 'react';
import { colorByLabel, downloadBlob, plotCanvas, VIRIDIS_CSS_STOPS, type DisplaySpec } from '@cirrobio/spatial-viewer';
import { LENS_PARAM, useRoute } from '../app/route';
import { useStudio } from '../app/studio';
import { plural } from '../app/ui';
import { describeError } from '../cirro/session';
import { pdfBlob, pngBlob, svgBlob } from '../figures/export';
import { figureLayout, figureSvg, SIZE_PRESETS, type FigureLegend, type SizePreset } from '../figures/layout';
import { coordinateUnit, scaleBar, storeReader } from '../figures/scaleBar';
import { figureContent, keepFigure, removeFigure, type FigureSpec } from '../figures/spec';
import { currentDisplay, useDisplays, useFreshDisplay, viewCanvasOf, worldPerPixelOf } from '../item/displayState';
import { useColorKey, type ColorKey } from '../item/useColorField';
import { storeOf } from '../workbench/workbench';
import type { TaskProps } from './TaskPanel';

const FIGURE_FONT = 'Arial';
const FIGURE_PT = 7;

function legendOf(key: ColorKey | null, title: string): FigureLegend | null {
  // Past the category cap the canvas draws every cell grey: there is nothing to key.
  if (!key || key.kind === 'too-many-categories') return null;
  // The canvas draws every value field in viridis, whatever the display's `colormap` says.
  if (key.kind === 'numeric') {
    return {
      kind: 'numeric', title, min: key.min, max: key.max,
      beyondMin: key.dataMin < key.min, beyondMax: key.dataMax > key.max, stops: VIRIDIS_CSS_STOPS,
    };
  }
  return { kind: 'categorical', title, items: key.items.map((i) => ({ label: i.label, color: i.color })) };
}

/** The canvas between the open drawers, which is the view the user framed. */
function visiblePart(canvas: HTMLCanvasElement, inset: { left: number; right: number }): { image: HTMLCanvasElement; cssWidth: number } {
  const ratio = canvas.width / canvas.clientWidth;
  const left = Math.round(inset.left * ratio);
  const image = document.createElement('canvas');
  image.width = Math.max(1, canvas.width - left - Math.round(inset.right * ratio));
  image.height = canvas.height;
  image.getContext('2d')!.drawImage(canvas, left, 0, image.width, image.height, 0, 0, image.width, image.height);
  return { image, cssWidth: image.width / ratio };
}

const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'figure';

export default function FigureTask({ wb, name, inset, figures }: TaskProps) {
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  const slot = useRoute().params.get(LENS_PARAM) === 'cells' && displays.embedding ? 'embedding' : 'spatial';
  const display = displays[slot];
  const where = slot === 'embedding' ? 'the cell map' : 'the tissue';
  const colorBy = display?.encoding.color_by ?? null;
  const { key } = useColorKey(
    colorBy, wb.dataVersions[colorBy ?? ''] ?? 0,
    display?.encoding.category_colors?.[colorBy ?? ''], display?.encoding.color_limits?.[colorBy ?? '']);
  // Until edited, the title and caption follow what the tissue is colored by.
  const [titleEdit, setTitle] = useState<string | null>(null);
  const [captionEdit, setCaption] = useState<string | null>(null);
  const title = titleEdit ?? (colorBy ? `${name}: ${colorByLabel(colorBy)}` : name);
  const caption = captionEdit ?? (colorBy ? `Cells of ${name} on ${where}, colored by ${colorByLabel(colorBy)}.` : `${name} on ${where}.`);
  const [preset, setPreset] = useState<SizePreset>('single');
  const widthMm = SIZE_PRESETS[preset].widthMm;
  const [keeping, setKeeping] = useState(false);
  // The figure kept last, known here before the figures are read again.
  const [lastKept, setLastKept] = useState<FigureSpec | null>(null);
  const inDraft = (f: FigureSpec) => wb.changes.some((c) => c.op === 'set-figure' && c.id === f.id);
  const lastInDraft = lastKept !== null && inDraft(lastKept);
  const kept = useMemo(
    () => new Map((lastInDraft ? [...figures, lastKept] : figures).map((f) => [figureContent(f), f])),
    [figures, lastKept, lastInDraft],
  );
  // The figure that keeping now would make again: the view, camera included, the words
  // and the size. Until one of them changes, there is nothing new to keep.
  const contentNow = (display: DisplaySpec) => figureContent({
    title: title.trim(), caption: caption.trim(), width_mm: widthMm, view: { kind: 'canvas', display },
  });
  const keptAs = useFreshDisplay(wb.key, slot, (d) => (d ? kept.get(contentNow(d)) ?? null : null));
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Legend categories the last download had no room for.
  const [omitted, setOmitted] = useState(0);
  const [exporting, setExporting] = useState(false);

  const keep = async () => {
    if (!display) return;
    setProblem(null);
    setKeeping(true);
    try {
      setLastKept(await keepFigure(wb.key, wb.handle!.tableKey, {
        title: title.trim(), caption: caption.trim(), created_by: session?.displayName ?? '',
        view: { kind: 'canvas', display: currentDisplay(wb.key, display) },
        width_mm: widthMm,
      }));
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setKeeping(false);
    }
  };

  const takeOut = async (figure: FigureSpec) => {
    setProblem(null);
    try {
      await removeFigure(wb.key, wb.handle!.tableKey, figure);
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  const exportAs = async (format: 'svg' | 'pdf' | 'png') => {
    const canvas = viewCanvasOf(wb.key, slot);
    if (!canvas) {
      setProblem('Nothing is drawn to download. Open the Tissue or the cell map, then download.');
      return;
    }
    setProblem(null);
    setDownloaded(null);
    setOmitted(0);
    setExporting(true);
    try {
      const { image, cssWidth } = visiblePart(plotCanvas(canvas), inset);
      // A scale bar only on the tissue: the cell map's axes have no length.
      const unit = slot === 'spatial' ? coordinateUnit(await storeReader(storeOf(wb.key))) : null;
      const perPixel = worldPerPixelOf(wb.key);
      const spec = {
        title: title.trim(),
        preset,
        legend: legendOf(key, colorByLabel(colorBy)),
        scaleBar: unit && perPixel ? scaleBar(cssWidth * perPixel) : null,
        capture: { dataUrl: image.toDataURL('image/png'), width: image.width, height: image.height, cssWidth },
        font: FIGURE_FONT,
        fontPt: FIGURE_PT,
      };
      const svg = figureSvg(spec);
      const layout = figureLayout(spec);
      const blob = format === 'svg' ? svgBlob(svg) : format === 'pdf' ? await pdfBlob(svg, layout) : await pngBlob(svg, layout);
      const file = `${slug(title)}.${format}`;
      downloadBlob(blob, file);
      setDownloaded(file);
      setOmitted(layout.legend?.omitted ?? 0);
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="task-body">
      <p className="muted">{where === 'the tissue' ? 'The tissue' : 'The cell map'} as it is shown now. Pan and zoom first to frame it.</p>
      <label className="field"><span>Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field"><span>Caption</span><textarea className="input" rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
      <label className="field">
        <span>Size</span>
        <select className="select" value={preset} onChange={(e) => setPreset(e.target.value as SizePreset)}>
          {Object.entries(SIZE_PRESETS).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
        </select>
      </label>
      {problem && <p className="notice notice-danger">{problem}</p>}
      {omitted > 0 && (
        <p className="notice notice-warning">
          The page has no room for the last {plural(omitted, ['group', 'groups'])} of the legend, which the download leaves out. A wider size fits more.
        </p>
      )}
      <div className="button-row">
        <span className="muted">Download</span>
        {(['png', 'pdf', 'svg'] as const).map((f) => (
          <button key={f} type="button" className={f === 'png' ? 'button button-primary' : 'button'} disabled={exporting} onClick={() => void exportAs(f)}>{f.toUpperCase()}</button>
        ))}
      </div>
      {downloaded && <p className="notice notice-info">Downloaded {downloaded}.</p>}
      <button type="button" className="button" disabled={!display || !title.trim() || keeping || keptAs !== null} onClick={() => void keep()}>
        {keptAs ? 'Kept with the data' : 'Keep with the data'}
      </button>
      {keptAs && (inDraft(keptAs) ? (
        <p className="notice notice-info">
          “{keptAs.title}” is in the unsaved changes. Save a version to keep it.{' '}
          <button type="button" className="link-button" onClick={() => void takeOut(keptAs)}>Take it out</button>
        </p>
      ) : <p className="notice notice-info">“{keptAs.title}” is kept with the data.</p>)}
      <p className="muted task-about">
        A kept figure redraws from the data when its version is opened again. To keep another, move the view or change its title,
        caption or size. Downloads on the tissue carry a scale bar when the data is in microns.
      </p>
    </div>
  );
}
