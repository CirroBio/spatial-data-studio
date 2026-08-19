import { useEffect, useState } from 'react';
import { formatError, useDataSource, type FigureFormat } from '@cirrobio/spatial-viewer';

interface FigureState {
  // Object URL for an <img>, or null while loading / when there is no figure.
  url: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Object URL for one plot's rendered figure, read through the data source so it works
 * against a live session and a checkpoint alike. Revoked when the plot, the format or
 * the component goes away, so a carousel stepping through twenty figures holds one.
 *
 * `format` null means "nothing to load" (the caller found no figure for this plot) and
 * leaves the state empty rather than making the caller branch around the hook.
 */
export function useFigure(plotId: string | null, format: FigureFormat | null): FigureState {
  const source = useDataSource();
  const [state, setState] = useState<FigureState>({ url: null, loading: false, error: null });

  useEffect(() => {
    if (!source || !plotId || !format) {
      setState({ url: null, loading: false, error: null });
      return;
    }
    let url: string | null = null;
    let stale = false;
    setState({ url: null, loading: true, error: null });
    source.getPlotFigure(plotId, format)
      .then((blob) => {
        // A superseded response must touch nothing: a slow figure resolving after the
        // carousel has already stepped on would otherwise blank the newer plot's url.
        if (stale) return;
        if (!blob) {
          setState({ url: null, loading: false, error: null });
          return;
        }
        url = URL.createObjectURL(blob);
        setState({ url, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (!stale) setState({ url: null, loading: false, error: formatError(err) });
      });
    return () => {
      stale = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, plotId, format]);

  return state;
}
