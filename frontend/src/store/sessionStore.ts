import { create } from 'zustand';
import type {
  SessionSummary,
  SessionState,
  FunctionEntry,
  ResourceSample,
  SessionLoadingEvent,
  DisplaySpec,
  SpatialDisplaySpec,
  HistEntry,
  PlotEntry,
} from '../types';
import { isSpatialDisplay } from '../types';
import { putDisplay, getSession, listShapeAnnotations, createShapeAnnotation, ApiError, fetchWhenIdle } from '../api';
import type { ShapeAnnotation, ShapeGeometry, ShapeKind } from '../schemas/annotations';
import { defaultStroke, defaultFill } from '../schemas/annotations';

// A job's status lands in whichever collection holds it; these narrow the shared
// status union so setEntryStatus can update the right record type without a cast.
const HIST_STATUSES = ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'] as const;
const PLOT_STATUSES = ['pending', 'queued', 'running', 'drawn', 'invalidated', 'failed'] as const;
const isHistStatus = (s: HistEntry['status'] | PlotEntry['status']): s is HistEntry['status'] =>
  (HIST_STATUSES as readonly string[]).includes(s);
const isPlotStatus = (s: HistEntry['status'] | PlotEntry['status']): s is PlotEntry['status'] =>
  (PLOT_STATUSES as readonly string[]).includes(s);

interface AppStore {
  // sessions list
  sessions: SessionSummary[];
  setSessions: (sessions: SessionSummary[]) => void;
  upsertSession: (summary: SessionSummary) => void;
  removeSession: (id: string) => void;

  // active session
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  sessionState: SessionState | null;
  setSessionState: (state: SessionState | null) => void;
  // Refetch a session's full state, applying it only if that session is still active
  // when the fetch resolves. The read fast-fails with 503 while a job holds the write
  // lock, so this retries with backoff (fetchWhenIdle) — a switch during a compute can
  // still let a stale resolve arrive, hence the active-session guard before applying.
  refreshSessionState: (sessionId: string) => Promise<void>;
  updateDataVersions: (versions: Record<string, number>) => void;
  updateDisplay: (display: DisplaySpec) => void;
  addDisplay: (display: DisplaySpec) => void;
  // Optimistically show a submitted compute/plot as queued straight from the
  // job.queued event — a refetch can't do this because the read won't return until
  // the (already-running) job frees the write lock (it 503s and retries until then).
  addQueuedEntry: (
    effectClass: 'compute' | 'plot',
    base: { id: string; namespace: string; function: string; params: Record<string, unknown> },
  ) => void;
  setEntryStatus: (id: string, status: HistEntry['status'] | PlotEntry['status']) => void;

  // functions list
  functions: FunctionEntry[];
  libraryVersions: Record<string, string>;
  setFunctions: (fns: FunctionEntry[], versions: Record<string, string>) => void;

  // sidebar selection
  selectedComputeId: string | null;
  setSelectedComputeId: (id: string | null) => void;
  selectedPlotId: string | null;
  setSelectedPlotId: (id: string | null) => void;
  sidebarTab: 'compute' | 'plots' | 'regions' | 'annotations' | 'subsetting';
  setSidebarTab: (tab: 'compute' | 'plots' | 'regions' | 'annotations' | 'subsetting') => void;

  // main viewer mode — spatial canvas, embedding scatter, or the data-table inspector
  mainView: 'canvas' | 'embedding' | 'tables';
  setMainView: (view: 'canvas' | 'embedding' | 'tables') => void;

  // light/dark theme — persisted in localStorage so it survives reloads
  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light') => void;

  // regions tab state
  activeRegionSetId: string | null;
  setActiveRegionSetId: (id: string | null) => void;
  isolatedCategory: string | null;
  setIsolatedCategory: (cat: string | null) => void;
  // region-labeling drawing target (set name + category + color) — read by SpatialCanvas
  regionNewSetName: string;
  regionCategoryName: string;
  regionColor: string;
  setRegionTarget: (setName: string, category: string, color: string) => void;

  // polygon draw state — shared between the canvas (draws) and the active tab's
  // panel (commit / apply / clear). drawPolygons holds committed rings; drawRing is
  // the in-progress ring being clicked out.
  drawPolygons: [number, number][][];
  drawRing: [number, number][];
  // Count of cells inside the current drawn region (union of committed rings + the
  // closeable in-progress ring), computed by the active canvas from its plotted
  // positions and surfaced on the Regions/Subset action buttons. 0 when nothing drawn.
  regionCellCount: number;
  setRegionCellCount: (n: number) => void;
  // Explicit table-row indices of the cells inside the drawn region, set by the
  // embedding canvas (whose lasso is in embedding/screen space, resolved to cells on
  // the client). null on the spatial canvas, where the backend resolves the lasso via
  // polygon_query — so a non-null value tells the Regions/Subset panels to send
  // cell_indices instead of polygons.
  regionCellIndices: number[] | null;
  setRegionCellIndices: (idx: number[] | null) => void;
  addDrawVertex: (pt: [number, number]) => void;
  commitDrawRing: () => void;
  clearDraw: () => void;

  // shape-annotation editor (arrows/lines/boxes/polygons/ellipses) — the fetched
  // list, which tool is armed, which shape is selected (shows edit handles), and
  // the vertices collected so far for an in-progress creation (a drag supplies two
  // points at once for line/box/ellipse; a polygon collects a click per vertex
  // until the user closes it).
  shapeAnnotations: ShapeAnnotation[];
  setShapeAnnotations: (shapes: ShapeAnnotation[]) => void;
  refreshShapeAnnotations: (sessionId: string) => Promise<void>;
  upsertShapeAnnotation: (shape: ShapeAnnotation) => void;
  removeShapeAnnotationLocal: (id: string) => void;
  // Persist a freshly drawn shape (optimistically; the job.completed refetch
  // reconciles) and select it. Shared by the canvas (drag/click creation) and the
  // annotations panel (the polygon Close Shape button).
  commitNewShape: (geometry: ShapeGeometry) => void;

  activeShapeTool: ShapeKind | null;
  setActiveShapeTool: (tool: ShapeKind | null) => void;
  selectedShapeId: string | null;
  setSelectedShapeId: (id: string | null) => void;

  draftVertices: [number, number][];
  addDraftVertex: (pt: [number, number]) => void;
  setDraftVertices: (pts: [number, number][]) => void;
  clearDraft: () => void;

  // resource sample
  resourceSample: ResourceSample | null;
  setResourceSample: (sample: ResourceSample) => void;

  // active jobs (session-level)
  activeJobIds: Set<string>;
  addActiveJob: (jobId: string) => void;
  removeActiveJob: (jobId: string) => void;

  // Live log lines streamed from a running reader (`job.log`), keyed by job_id, so the
  // import spinner and the compute detail view show progress before the job completes.
  // Dropped once the job finishes (the full log is then fetched from the store).
  jobLogs: Record<string, string>;
  appendJobLog: (jobId: string, chunk: string) => void;
  clearJobLog: (jobId: string) => void;

  // the in-flight UI-blocking job (save / transform / subset), if any — drives the
  // full-screen blocking overlay, whose spinner shows `label` until the job lands
  blockingJob: { id: string; label: string } | null;
  setBlockingJob: (job: { id: string; label: string } | null) => void;

  // transient notifications (e.g. a compute job that failed and vanished from history)
  notifications: AppNotification[];
  pushNotification: (n: Omit<AppNotification, 'id'>) => void;
  dismissNotification: (id: number) => void;

  // Snapshot browser modal — opened from the header button and, after saving a
  // snapshot, from the canvas (preselecting the freshly saved one).
  snapshotsOpen: boolean;
  snapshotsInitialSelect: string | null;  // snapshot name to preselect
  openSnapshots: (selectName?: string) => void;
  closeSnapshots: () => void;

  // Save Snapshot lives in the settings panel but must capture the active canvas's
  // live viewport, so whichever canvas is mounted registers its handler here
  // (null on the tables view / when no canvas is mounted → the menu item disables).
  snapshotHandler: (() => void) | null;
  setSnapshotHandler: (fn: (() => void) | null) => void;

  // The collapsible right-hand settings sidebar — toggled from the header hamburger.
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  // left navigation sidebar — collapsible to reclaim canvas width
  leftMenuOpen: boolean;
  setLeftMenuOpen: (open: boolean) => void;

  // Cirro upload
  cirroEnabled: boolean;
  setCirroEnabled: (on: boolean) => void;
  cirroUploads: { uploading: number; pending: number };
  setCirroUploads: (u: { uploading: number; pending: number }) => void;
  // Live progress of a checkpoint load, keyed by the New Session dialog's load_id.
  // useSSE writes it from `session.loading`; the dialog reads the entry for its own
  // load_id and clears it when the load resolves.
  loadProgress: SessionLoadingEvent | null;
  setLoadProgress: (p: SessionLoadingEvent | null) => void;
  // Accumulated reader log lines for the in-flight checkpoint load (the `log` chunks of
  // `session.loading`), shown live in the dialog overlay and reset per load.
  loadLog: string;
  appendLoadLog: (chunk: string) => void;
  resetLoadLog: () => void;
}

export interface AppNotification {
  id: number;
  kind: 'error' | 'info';
  message: string;
}

let _notificationSeq = 0;

const THEME_KEY = 'sds-theme';

function readTheme(): 'dark' | 'light' {
  const t = localStorage.getItem(THEME_KEY);
  return t === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
}

// Apply the persisted theme before first paint to avoid a flash.
applyTheme(readTheme());

export const useAppStore = create<AppStore>((set, get) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
  upsertSession: (summary) =>
    set((s) => {
      const existing = s.sessions.findIndex((x) => x.id === summary.id);
      if (existing >= 0) {
        const sessions = [...s.sessions];
        sessions[existing] = summary;
        return { sessions };
      }
      return { sessions: [summary, ...s.sessions] };
    }),
  removeSession: (id) =>
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),

  activeSessionId: null,
  // Switching sessions must drop per-session view state: a lingering isolated
  // category would dim the new session's other categories (looking like data loss),
  // a half-drawn polygon belongs to the old session's coordinates, and the running-job
  // set is per-session (only the active session's jobs are tracked).
  setActiveSessionId: (id) =>
    set((s) =>
      id === s.activeSessionId
        ? { activeSessionId: id }
        : { activeSessionId: id, isolatedCategory: null, drawPolygons: [], drawRing: [],
            activeJobIds: new Set(), shapeAnnotations: [], activeShapeTool: null,
            selectedShapeId: null, draftVertices: [] }
    ),
  sessionState: null,
  setSessionState: (state) => set({ sessionState: state }),
  refreshSessionState: async (sessionId) => {
    try {
      const state = await fetchWhenIdle(() => getSession(sessionId));
      if (get().activeSessionId !== sessionId) return; // switched away mid-fetch
      set({ sessionState: state });
      // Restore the persisted isolated category (setActiveSessionId cleared it).
      const spatial = state.app_state.displays.find(isSpatialDisplay);
      get().setIsolatedCategory(spatial ? spatial.encoding.isolated_category ?? null : null);
    } catch (err) {
      // Still busy after retries: the next job.completed re-triggers this, so stay quiet.
      if (err instanceof ApiError && err.status === 503) return;
      get().pushNotification({
        kind: 'error',
        message: `Failed to refresh session: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
  updateDataVersions: (versions) =>
    set((s) => {
      if (!s.sessionState) return {};
      return {
        sessionState: {
          ...s.sessionState,
          data_versions: { ...s.sessionState.data_versions, ...versions },
        },
      };
    }),
  updateDisplay: (display) =>
    set((s) => {
      if (!s.sessionState) return {};
      const displays = s.sessionState.app_state.displays.map((d) =>
        d.id === display.id ? display : d
      );
      return {
        sessionState: {
          ...s.sessionState,
          app_state: { ...s.sessionState.app_state, displays },
        },
      };
    }),
  addDisplay: (display) =>
    set((s) => {
      if (!s.sessionState) return {};
      if (s.sessionState.app_state.displays.some((d) => d.id === display.id)) return {};
      return {
        sessionState: {
          ...s.sessionState,
          app_state: {
            ...s.sessionState.app_state,
            displays: [...s.sessionState.app_state.displays, display],
          },
        },
      };
    }),
  addQueuedEntry: (effectClass, base) =>
    set((s) => {
      if (!s.sessionState) return {};
      const app = s.sessionState.app_state;
      if (effectClass === 'plot') {
        const plots = app.plots.some((p) => p.id === base.id)
          ? app.plots.map((p) => (p.id === base.id ? { ...p, status: 'queued' as const } : p))
          : [...app.plots, { ...base, status: 'queued' as const, references: [] }];
        return { sessionState: { ...s.sessionState, app_state: { ...app, plots } } };
      }
      const compute_history = app.compute_history.some((h) => h.id === base.id)
        ? app.compute_history.map((h) => (h.id === base.id ? { ...h, status: 'queued' as const } : h))
        : [...app.compute_history, {
            ...base, status: 'queued' as const, library_versions: s.libraryVersions,
            started_at: null, finished_at: null,
          }];
      return { sessionState: { ...s.sessionState, app_state: { ...app, compute_history } } };
    }),
  setEntryStatus: (id, status) =>
    set((s) => {
      if (!s.sessionState) return {};
      const app = s.sessionState.app_state;
      const compute_history = isHistStatus(status)
        ? app.compute_history.map((h) => (h.id === id ? { ...h, status } : h))
        : app.compute_history;
      const plots = isPlotStatus(status)
        ? app.plots.map((p) => (p.id === id ? { ...p, status } : p))
        : app.plots;
      return { sessionState: { ...s.sessionState, app_state: { ...app, compute_history, plots } } };
    }),

  functions: [],
  libraryVersions: {},
  setFunctions: (fns, versions) => set({ functions: fns, libraryVersions: versions }),

  selectedComputeId: null,
  setSelectedComputeId: (id) => set({ selectedComputeId: id, selectedPlotId: null }),
  selectedPlotId: null,
  setSelectedPlotId: (id) => set({ selectedPlotId: id, selectedComputeId: null }),
  sidebarTab: 'compute',
  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  mainView: 'canvas',
  setMainView: (view) => set({ mainView: view }),

  theme: readTheme(),
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },

  activeRegionSetId: null,
  setActiveRegionSetId: (id) => set({ activeRegionSetId: id }),
  isolatedCategory: null,
  // The isolated category is session-global (set from AnnotationsPanel, read by both
  // canvases) but has no dedicated persisted slot, so it write-throughs to the spatial
  // display's encoding and is re-hydrated on load (useSession).
  setIsolatedCategory: (cat) => {
    set({ isolatedCategory: cat });
    const s = get();
    const spatial = s.sessionState?.app_state.displays.find(isSpatialDisplay);
    if (spatial && s.activeSessionId && (spatial.encoding.isolated_category ?? null) !== cat) {
      const updated: SpatialDisplaySpec = {
        ...spatial,
        encoding: { ...spatial.encoding, isolated_category: cat },
      };
      s.updateDisplay(updated);
      putDisplay(s.activeSessionId, updated).catch(console.error);
    }
  },
  regionNewSetName: '',
  regionCategoryName: '',
  regionColor: '#e05c5c',
  setRegionTarget: (setName, category, color) =>
    set({ regionNewSetName: setName, regionCategoryName: category, regionColor: color }),

  drawPolygons: [],
  drawRing: [],
  regionCellCount: 0,
  setRegionCellCount: (n) => set({ regionCellCount: n }),
  regionCellIndices: null,
  setRegionCellIndices: (idx) => set({ regionCellIndices: idx }),
  addDrawVertex: (pt) => set((s) => ({ drawRing: [...s.drawRing, pt] })),
  commitDrawRing: () =>
    set((s) => (s.drawRing.length >= 3
      ? { drawPolygons: [...s.drawPolygons, s.drawRing], drawRing: [] }
      : {})),
  clearDraw: () => set({ drawPolygons: [], drawRing: [] }),

  shapeAnnotations: [],
  setShapeAnnotations: (shapes) => set({ shapeAnnotations: shapes }),
  refreshShapeAnnotations: async (sessionId) => {
    try {
      const { shapes } = await fetchWhenIdle(() => listShapeAnnotations(sessionId));
      if (get().activeSessionId !== sessionId) return; // switched away mid-fetch
      set({ shapeAnnotations: shapes });
    } catch (err) {
      // Still busy after retries: the next job.completed re-triggers this, so stay quiet.
      if (err instanceof ApiError && err.status === 503) return;
      get().pushNotification({
        kind: 'error',
        message: `Failed to refresh annotations: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
  upsertShapeAnnotation: (shape) =>
    set((s) => {
      const i = s.shapeAnnotations.findIndex((x) => x.id === shape.id);
      if (i < 0) return { shapeAnnotations: [...s.shapeAnnotations, shape] };
      const shapeAnnotations = [...s.shapeAnnotations];
      shapeAnnotations[i] = shape;
      return { shapeAnnotations };
    }),
  removeShapeAnnotationLocal: (id) =>
    set((s) => ({ shapeAnnotations: s.shapeAnnotations.filter((x) => x.id !== id) })),
  commitNewShape: (geometry) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const shape: ShapeAnnotation = {
      id: crypto.randomUUID(),
      geometry,
      // Line and text have no interior to fill.
      stroke: defaultStroke(),
      fill: geometry.kind === 'line' || geometry.kind === 'text' ? undefined : defaultFill(),
    };
    get().upsertShapeAnnotation(shape); // optimistic — the job.completed refetch reconciles
    createShapeAnnotation(sessionId, shape).catch((err) => {
      get().pushNotification({ kind: 'error', message: `Create shape failed: ${err instanceof Error ? err.message : String(err)}` });
      get().removeShapeAnnotationLocal(shape.id);
    });
    get().setSelectedShapeId(shape.id); // also clears activeShapeTool + draft (see setSelectedShapeId)
  },

  activeShapeTool: null,
  setActiveShapeTool: (tool) => set({ activeShapeTool: tool, selectedShapeId: null, draftVertices: [] }),
  selectedShapeId: null,
  setSelectedShapeId: (id) => set({ selectedShapeId: id, activeShapeTool: null, draftVertices: [] }),

  draftVertices: [],
  addDraftVertex: (pt) => set((s) => ({ draftVertices: [...s.draftVertices, pt] })),
  setDraftVertices: (pts) => set({ draftVertices: pts }),
  clearDraft: () => set({ draftVertices: [] }),

  resourceSample: null,
  setResourceSample: (sample) => set({ resourceSample: sample }),

  activeJobIds: new Set(),
  addActiveJob: (jobId) =>
    set((s) => ({ activeJobIds: new Set([...s.activeJobIds, jobId]) })),
  removeActiveJob: (jobId) =>
    set((s) => {
      const next = new Set(s.activeJobIds);
      next.delete(jobId);
      return { activeJobIds: next };
    }),

  jobLogs: {},
  appendJobLog: (jobId, chunk) =>
    set((s) => ({ jobLogs: { ...s.jobLogs, [jobId]: (s.jobLogs[jobId] ?? '') + chunk } })),
  clearJobLog: (jobId) =>
    set((s) => {
      if (!(jobId in s.jobLogs)) return {};
      const next = { ...s.jobLogs };
      delete next[jobId];
      return { jobLogs: next };
    }),

  blockingJob: null,
  setBlockingJob: (job) => set({ blockingJob: job }),

  notifications: [],
  pushNotification: (n) =>
    set((s) => ({ notifications: [...s.notifications, { ...n, id: ++_notificationSeq }] })),
  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((x) => x.id !== id) })),

  snapshotsOpen: false,
  snapshotsInitialSelect: null,
  openSnapshots: (selectName) =>
    set({ snapshotsOpen: true, snapshotsInitialSelect: selectName ?? null }),
  closeSnapshots: () => set({ snapshotsOpen: false, snapshotsInitialSelect: null }),

  snapshotHandler: null,
  setSnapshotHandler: (fn) => set({ snapshotHandler: fn }),

  menuOpen: false,
  setMenuOpen: (open) => set({ menuOpen: open }),
  leftMenuOpen: true,
  setLeftMenuOpen: (open) => set({ leftMenuOpen: open }),

  cirroEnabled: false,
  setCirroEnabled: (on) => set({ cirroEnabled: on }),
  cirroUploads: { uploading: 0, pending: 0 },
  setCirroUploads: (u) => set({ cirroUploads: u }),
  loadProgress: null,
  setLoadProgress: (p) => set({ loadProgress: p }),
  loadLog: '',
  appendLoadLog: (chunk) => set((s) => ({ loadLog: s.loadLog + chunk })),
  resetLoadLog: () => set({ loadLog: '' }),
}));
