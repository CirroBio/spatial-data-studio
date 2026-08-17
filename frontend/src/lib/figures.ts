// Rendered plot figures, as the Plots view / carousel / detail panel consume them.
//
// A figure's bytes come from the data source (a live session's render, or the
// `viewer/figures` group of a checkpoint), so everything here works the same in the
// serverless viewer as in the backed app. `SessionState.figures` says which plot has
// which format, so nothing has to fetch to find out.
import { downloadBlob, type DataSource, type FigureFormat, type FigureIndex } from '@cirrobio/spatial-viewer';
import type { PlotEntry, SessionState } from '../types';

// Display order: the vector figure is the one to look at, and the raster is the
// fallback for a plot saved without it.
const DISPLAY_PREFERENCE: FigureFormat[] = ['svg', 'png'];
// Thumbnails go the other way — a grid of matplotlib SVGs is a lot of parsing for
// images a few hundred pixels wide.
const THUMBNAIL_PREFERENCE: FigureFormat[] = ['png', 'svg'];

// Every format a figure can be stored in (persistence.store.FIGURE_FORMATS), in the
// order the export buttons offer them.
const ALL_FORMATS: FigureFormat[] = ['svg', 'pdf', 'png'];

/** Formats available for one plot. */
export function figureFormats(figures: FigureIndex, plotId: string): FigureFormat[] {
  const available = figures[plotId] ?? {};
  return ALL_FORMATS.filter((fmt) => available[fmt]);
}

/** Best format to render `plotId` with, or null when there is no figure for it. */
export function displayFormat(figures: FigureIndex, plotId: string,
                              thumbnail = false): FigureFormat | null {
  const order = thumbnail ? THUMBNAIL_PREFERENCE : DISPLAY_PREFERENCE;
  return order.find((fmt) => figures[plotId]?.[fmt]) ?? null;
}

/** The plots with a figure to show, in history order — what the Plots view lists and
 * the carousel steps through. */
export function plotsWithFigures(state: SessionState | null): PlotEntry[] {
  if (!state) return [];
  return state.app_state.plots.filter((p) => displayFormat(state.figures, p.id) !== null);
}

/** Total bytes of every format kept for one plot — what the save dialog sizes its
 * figures rows with. */
export function figureBytes(figures: FigureIndex, plotId: string): number {
  return Object.values(figures[plotId] ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
}

export async function downloadFigure(
  source: DataSource, plot: PlotEntry, format: FigureFormat,
): Promise<void> {
  const blob = await source.getPlotFigure(plot.id, format);
  if (!blob) throw new Error(`no ${format.toUpperCase()} figure for this plot`);
  downloadBlob(blob, `${plot.function}.${format}`);
}
