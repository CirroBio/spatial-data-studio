import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { OrthographicViewState } from '@deck.gl/core';
import { useAppStore } from '../../store/sessionStore';
import { useDataSource } from '../../data/context';
import { downloadCanvasPng } from '../../lib/canvasCapture';
import { reportError } from '../../lib/errors';
import type { EmbeddingViewState } from './useEmbeddingViewState';

interface Params {
  kind: 'spatial' | 'embedding';
  sessionId: string;
  displayId: string;
  viewState: OrthographicViewState | EmbeddingViewState | null;
  containerRef: RefObject<HTMLDivElement>;
  // Read at snapshot time (held behind a ref), so callers may pass a fresh closure
  // every render without re-registering the handler.
  getCanvasSize: () => { width: number; height: number };
  minimap?: boolean;  // spatial only: seeds the modal's "Minimap inset" checkbox
}

// Save Snapshot (settings panel) opens the export modal seeded with the live
// framing: the current viewport (read via a ref so it's where the user is looking,
// not the possibly-stale persisted one) and the canvas pixel size (seeds the output
// aspect). Whichever canvas is mounted registers this handler while mounted.
export function useSnapshotHandler(
  { kind, sessionId, displayId, viewState, containerRef, getCanvasSize, minimap }: Params,
): void {
  const { sessionState, openSnapshotExport, setSnapshotHandler } = useAppStore();
  const source = useDataSource();
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const getCanvasSizeRef = useRef(getCanvasSize);
  getCanvasSizeRef.current = getCanvasSize;

  const handleSnapshot = useCallback(() => {
    // A checkpoint has no backend to render the figure, so the snapshot action
    // captures the canvas as a PNG instead (see lib/canvasCapture).
    if (source?.kind === 'checkpoint') {
      void downloadCanvasPng(containerRef.current, sessionState?.summary.name ?? 'view')
        .catch((err) => reportError('PNG export failed', err));
      return;
    }
    const vs = viewStateRef.current;
    const target = vs?.target as number[] | undefined;
    if (!vs || !target || typeof vs.zoom !== 'number') return;
    openSnapshotExport({
      sessionId,
      displayId,
      kind,
      viewport: { target: target.slice(0, 2), zoom: vs.zoom },
      canvasSize: getCanvasSizeRef.current(),
      label: sessionState?.summary.name ?? 'snapshot',
      minimap,
    });
  }, [source, containerRef, sessionId, displayId, kind, openSnapshotExport,
      sessionState?.summary.name, minimap]);

  useEffect(() => {
    setSnapshotHandler(handleSnapshot);
    return () => setSnapshotHandler(null);
  }, [handleSnapshot, setSnapshotHandler]);
}
