// Save the tissue as it is shown as a figure: its spec (what is drawn, colors, camera) goes
// into the draft's `uns`, so the version redraws it from its own data. Export draws it
// now, at print size, as SVG, PDF or a 300 dpi PNG: the canvas as an image, with the
// title, legend and a scale bar as vectors.
import { useState } from 'react';
import { colorByLabel, downloadBlob, plotCanvas, VIRIDIS_CSS_STOPS } from '@cirrobio/spatial-viewer';
import { useStudio } from '../app/studio';
import { plural } from '../app/ui';
import { describeError } from '../cirro/session';
import { pdfBlob, pngBlob, svgBlob } from '../figures/export';
import { figureLayout, figureSvg, SIZE_PRESETS, type FigureLegend, type SizePreset } from '../figures/layout';
import { coordinateUnit, scaleBar, storeReader } from '../figures/scaleBar';
import { keepFigure } from '../figures/spec';
import { currentDisplay, tissueCanvasOf, useDisplays, worldPerPixelOf } from '../item/displayState';
import { useColorKey, type ColorKey } from '../item/useColorField';
import { storeOf } from '../workbench/workbench';
import type { TaskProps } from './TaskPanel';

const FIGURE_FONT = 'Arial';
const FIGURE_PT = 7;

function legendOf(key: ColorKey | null, title: string): FigureLegend | null {
  // Past the category cap the canvas draws every cell grey: there is nothing to key.
  if (!key || key.kind === 'too-many-categories') return null;
  // The canvas draws every value field in viridis, whatever the display's `colormap` says.
  if (key.kind === 'numeric') return { kind: 'numeric', title, min: key.min, max: key.max, stops: VIRIDIS_CSS_STOPS };
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

export default function FigureTask({ wb, name, inset }: TaskProps) {
  const { session } = useStudio();
  const displays = useDisplays(wb.key, wb.handle);
  const display = displays.spatial;
  const colorBy = display?.encoding.color_by ?? null;
  const { key } = useColorKey(colorBy, wb.dataVersions[colorBy ?? ''] ?? 0, display?.encoding.category_colors?.[colorBy ?? '']);
  // Until edited, the title and caption follow what the tissue is colored by.
  const [titleEdit, setTitle] = useState<string | null>(null);
  const [captionEdit, setCaption] = useState<string | null>(null);
  const title = titleEdit ?? (colorBy ? `${name}: ${colorByLabel(colorBy)}` : name);
  const caption = captionEdit ?? (colorBy ? `Cells of ${name} on the tissue, colored by ${colorByLabel(colorBy)}.` : `${name} on the tissue.`);
  const [preset, setPreset] = useState<SizePreset>('single');
  const [saved, setSaved] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Legend categories the last download had no room for.
  const [omitted, setOmitted] = useState(0);
  const [exporting, setExporting] = useState(false);

  const keep = async () => {
    if (!display) return;
    setProblem(null);
    try {
      const spec = await keepFigure(wb.key, wb.handle!.tableKey, {
        title: title.trim(), caption: caption.trim(), created_by: session?.displayName ?? '',
        view: { kind: 'canvas', display: currentDisplay(wb.key, display) },
        width_mm: SIZE_PRESETS[preset].widthMm,
      });
      setSaved(spec.title);
    } catch (e) {
      setProblem(describeError(e));
    }
  };

  const exportAs = async (format: 'svg' | 'pdf' | 'png') => {
    const tissue = tissueCanvasOf(wb.key);
    if (!tissue) {
      setProblem('Nothing is drawn to download. Open the Tissue view, then download.');
      return;
    }
    setProblem(null);
    setOmitted(0);
    setExporting(true);
    try {
      const { image, cssWidth } = visiblePart(plotCanvas(tissue), inset);
      const unit = coordinateUnit(await storeReader(storeOf(wb.key)));
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
      downloadBlob(blob, `${slug(title)}.${format}`);
      setOmitted(layout.legend?.omitted ?? 0);
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="task-body">
      <p className="muted">The tissue as it is shown now: its colors, channels and framing. Pan and zoom first to frame it.</p>
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
      {saved && <p className="notice notice-info">“{saved}” is in the unsaved changes. Save a version to keep it.</p>}
      <button type="button" className="button button-primary" disabled={!display || !title.trim()} onClick={() => void keep()}>Keep with the data</button>
      <div className="button-row">
        <span className="muted">Download</span>
        {(['svg', 'pdf', 'png'] as const).map((f) => (
          <button key={f} type="button" className="button button-small" disabled={exporting} onClick={() => void exportAs(f)}>{f.toUpperCase()}</button>
        ))}
      </div>
      <p className="muted task-about">A kept figure is a description of the view, not a copy of the picture: it redraws from the version it is saved in, in this app or from Python (<code>uns["spatial_data_studio"]["figures"]</code>). Downloads use Arial at 7 pt, with a scale bar when the store says its coordinates are microns.</p>
    </div>
  );
}
