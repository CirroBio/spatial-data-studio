import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAppStore } from '../store/sessionStore';
import { useEditGate } from '../hooks/usePresence';
import { useDisplayPersistence } from '../hooks/useDisplayPersistence';
import { CanvasHostProvider, type CanvasHost } from '@cirrobio/spatial-viewer';
import TransformEditor from './TransformEditor';

// The Studio app's implementation of the canvas host contract
// (components/canvas/canvas-host.tsx). This adapter is the only place the app's store
// and the canvas components meet: everything the canvases read or write goes through
// the object built here, so the canvas package itself stays host-agnostic and can also
// be driven from a Cirro dashboard tile.
//
// The host object is memoized on its members so a store tick that changes nothing the
// canvas reads doesn't hand it a fresh identity.
export default function StudioCanvasHost({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const store = useAppStore();
  const { canEdit, reason: editBlockedReason } = useEditGate();
  const { onDisplayChange, currentSpec } = useDisplayPersistence(sessionId, canEdit);
  // The transform editor PUTs through the REST layer, so it is app UI: the canvas
  // only raises the intent and this adapter renders the modal.
  const [transformOpen, setTransformOpen] = useState(false);
  const onEditTransform = useCallback(() => setTransformOpen(true), []);

  const {
    sessionState, theme, isolatedCategory, hiddenCells,
    drawPolygons, drawRing, selectionTool, drawShape, setDrawShape,
    addDrawVertex, clearDraw, setRegionCellCount, setRegionCellIndices,
    shapeAnnotations, activeShapeTool, selectedShapeId, draftVertices,
    setSelectedShapeId, addDraftVertex, clearDraft,
    upsertShapeAnnotation, sendShapeUpdate, commitNewShape,
    openSnapshotExport, setSnapshotHandler,
  } = store;

  const host = useMemo((): CanvasHost => ({
    viewName: sessionState?.summary.name ?? '',
    fields: sessionState?.fields ?? null,
    dataVersions: sessionState?.data_versions ?? {},
    theme,
    canEdit,
    editBlockedReason,
    onDisplayChange,
    currentSpec,
    isolatedCategory,
    hiddenCells,
    regions: {
      drawPolygons, drawRing, selectionTool, drawShape, setDrawShape,
      addDrawVertex, clearDraw, setRegionCellCount, setRegionCellIndices,
    },
    annotations: {
      shapeAnnotations, activeShapeTool, selectedShapeId, draftVertices,
      setSelectedShapeId, addDraftVertex, clearDraft,
      upsertShapeAnnotation, sendShapeUpdate, commitNewShape,
    },
    snapshot: { openSnapshotExport, setSnapshotHandler },
    onEditTransform,
  }), [
    sessionState?.summary.name, sessionState?.fields, sessionState?.data_versions,
    theme, canEdit, editBlockedReason, onDisplayChange, currentSpec,
    isolatedCategory, hiddenCells,
    drawPolygons, drawRing, selectionTool, drawShape, setDrawShape,
    addDrawVertex, clearDraw, setRegionCellCount, setRegionCellIndices,
    shapeAnnotations, activeShapeTool, selectedShapeId, draftVertices,
    setSelectedShapeId, addDraftVertex, clearDraft,
    upsertShapeAnnotation, sendShapeUpdate, commitNewShape,
    openSnapshotExport, setSnapshotHandler, onEditTransform,
  ]);

  return (
    <CanvasHostProvider host={host}>
      {children}
      {transformOpen && <TransformEditor sessionId={sessionId} onClose={() => setTransformOpen(false)} />}
    </CanvasHostProvider>
  );
}
