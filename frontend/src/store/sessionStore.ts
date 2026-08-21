import { create } from 'zustand';
import {
  ApiError,
  defaultFill,
  defaultStroke,
  fetchWhenIdle,
  formatError,
  isSpatialDisplay,
  selectionShapeRing,
  type DataSource,
  type DisplaySpec,
  type LocalCategorical,
  type ShapeAnnotation,
  type ShapeGeometry,
  type ShapeKind,
  type SelectionShape,
  type SelectionTool,
  type SnapshotExportParams,
  type SpatialDisplaySpec,
} from '@cirrobio/spatial-viewer';
import type {
  SessionSummary,
  SessionState,
  SessionPresence,
  FunctionEntry,
  ResourceSample,
  SessionLoadingEvent,
  HistEntry,
  MainView,
  PlotEntry,
  RegionSet,
} from '../types';
import { clientName, setClientName, editBlockReason } from '../lib/presence';
import { putDisplay, getSession, listShapeAnnotations, createShapeAnnotation, updateShapeAnnotation, deleteShapeAnnotation, postPresence, getCirroUploads } from '../api';
import type { CirroAuth, CirroUpload } from '../api';
import { checkpointUrlFromLocation, themeFromLocation, type CheckpointIndex } from '../data/checkpointIndex';
import { initialUiOverlay } from '../lib/urlViewState';

// Level 0 of a locally-labelled column: every cell starts here and stays here
// until a lasso claims it, so unlabelled cells still render (greyed) instead of
// vanishing from the colouring.
const UNLABELLED = 'unlabelled';

// The locally-labelled columns themselves, keyed by field path. Kept outside
// reactive state — the codes array is large and nothing renders off it directly;
// the canvas reads it back through the data source like any other column.
const localRegionColumns = new Map<string, LocalCategorical>();

// A job's status lands in whichever collection holds it; these narrow the shared
// status union so setEntryStatus can update the right record type without a cast.
const HIST_STATUSES = ['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'] as const;
const PLOT_STATUSES = ['pending', 'queued', 'running', 'drawn', 'invalidated', 'failed'] as const;
const isHistStatus = (s: HistEntry['status'] | PlotEntry['status']): s is HistEntry['status'] =>
  (HIST_STATUSES as readonly string[]).includes(s);
const isPlotStatus = (s: HistEntry['status'] | PlotEntry['status']): s is PlotEntry['status'] =>
  (PLOT_STATUSES as readonly string[]).includes(s);

// Flushers for debounced display PUTs still in flight (registered by the canvas
// persistence hooks). Kept outside reactive state — nothing renders off it — so
// mutating the set never triggers a re-render.
const displayFlushers = new Set<() => Promise<void>>();

// Shapes are edited optimistically but persisted via async `shape_annotate` jobs, so a
// wholesale refresh (refreshShapeAnnotations fires on *any* shape job completing) can
// clobber a shape whose own job hasn't landed yet — reverting an edit, dropping a
// just-created shape, or resurrecting a just-deleted one. A shape with ≥1 outstanding
// job is "locally owned": the refresh keeps the optimistic version (or the tombstone,
// if it was deleted locally) instead of the server's pre-edit copy. Counted, because a
// drag and a style edit can be in flight at once; the job→shape map clears each count on
// that job's completion. Kept outside reactive state — nothing renders off it.
const shapeJobShape = new Map<string, string>();     // job_id -> shape_id
const pendingShapeJobs = new Map<string, number>();  // shape_id -> outstanding job count
function bumpShapePending(shapeId: string, delta: number) {
  const n = (pendingShapeJobs.get(shapeId) ?? 0) + delta;
  if (n <= 0) pendingShapeJobs.delete(shapeId);
  else pendingShapeJobs.set(shapeId, n);
}

// The shape editor coalesces rapid edits (a slider drag, characters typed into the
// text field) into one update job. The window is locally owned from the *first* edit,
// not from when the request goes out: a refresh landing in between would otherwise
// adopt the server's pre-edit copy and silently drop everything edited since. The
// claim is released only once the flush has taken the job's own claim, so ownership
// never lapses between the two. One timer per shape id — editing shape B inside shape
// A's window must not cancel A's pending flush.
const SHAPE_EDIT_DEBOUNCE_MS = 500;
const shapeEditTimers = new Map<string, ReturnType<typeof setTimeout>>();

// A job's id exists only once its POST resolves, so a `job.completed` frame can beat the
// response that would have mapped it — resolveShapeJob then finds no shape and the count
// never comes back down, marking that shape locally owned forever (refreshShapeAnnotations
// would never adopt the server's copy of it again). Such a job id parks here until
// persistShapeJob claims it. Only a frame arriving while some request is still awaiting its
// id can possibly be ours, hence the counter: other viewers' shape jobs reach the same
// handler, and dropping the set when nothing is outstanding keeps them from accumulating.
const completedBeforeMapped = new Set<string>();
let unmappedShapeRequests = 0;

// Refetches for one session overlap freely — useSession fires one on mount, every shape
// job's completion fires another, and each may sit in fetchWhenIdle's retry loop behind a
// write lock for seconds — and nothing makes them resolve in submission order, so an older
// response can land last and put pre-job state on screen. Each call takes the next ticket
// for its session and applies its result only while it still holds the newest one. Kept
// outside reactive state for the same reason as the maps above: nothing renders off it.
const sessionRefreshSeq = new Map<string, number>();
const shapeRefreshSeq = new Map<string, number>();
function nextRefreshTicket(seq: Map<string, number>, sessionId: string): number {
  const ticket = (seq.get(sessionId) ?? 0) + 1;
  seq.set(sessionId, ticket);
  return ticket;
}

// A read-only session cannot be written to, so any shape edit that happens against
// one stays in this tab: keep the optimistic update and skip the job. That is the
// serverless viewer's whole annotation story (the sidebar only offers the tools
// there — see useLocalEditsOnly); for a live read-only session the tools are
// disabled, so this branch is simply never reached.
function shapesAreLocalOnly(state: { sessionState: SessionState | null }): boolean {
  return state.sessionState?.summary.read_only === true;
}

// The persistence protocol shared by create/update/delete: mark the shape locally
// owned before the request so a refresh can't clobber the optimistic edit, map the
// accepted job back to the shape (resolveShapeJob clears the mark when that job
// lands), and on request failure roll the mark back and toast. Resolves false on
// failure so a caller can undo its own optimistic edit.
function persistShapeJob(
  shapeId: string,
  label: string,
  call: () => Promise<{ job_id: string }>,
): Promise<boolean> {
  bumpShapePending(shapeId, 1);
  unmappedShapeRequests += 1;
  return call()
    .then(({ job_id }) => {
      // Already completed while this request was in flight: clear the mark now, since no
      // further frame is coming for this job and a mapping would never be consumed.
      if (completedBeforeMapped.delete(job_id)) bumpShapePending(shapeId, -1);
      else shapeJobShape.set(job_id, shapeId);
      return true;
    })
    .catch((err: unknown) => {
      bumpShapePending(shapeId, -1);
      useAppStore.getState().pushNotification({
        kind: 'error',
        message: `${label}: ${formatError(err)}`,
      });
      return false;
    })
    .finally(() => {
      unmappedShapeRequests -= 1;
      if (unmappedShapeRequests === 0) completedBeforeMapped.clear();
    });
}

interface AppStore {
  // The `index.json` collection backing a serverless deployment, once discovered.
  // Null in a live app (there is none) and until the probe finishes.
  checkpointIndex: CheckpointIndex | null;
  setCheckpointIndex: (index: CheckpointIndex | null) => void;

  // sessions list
  sessions: SessionSummary[];
  setSessions: (sessions: SessionSummary[]) => void;
  upsertSession: (summary: SessionSummary) => void;
  removeSession: (id: string) => void;

  // Who is viewing which session and who holds each session's edit lock, keyed by
  // session id. Seeded by the presence heartbeat's response and kept current by the
  // `presence.updated` SSE event (usePresence / useSSE). A session with no entry is
  // unlocked and unwatched.
  presence: Record<string, SessionPresence>;
  setPresence: (presence: Record<string, SessionPresence>) => void;
  // The viewer's own display name, editable and persisted in localStorage; renaming
  // heartbeats immediately so the other viewers' lists update without a delay.
  clientName: string;
  renameClient: (name: string) => void;

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
  // Canvas persistence hooks register a flusher that immediately sends any debounced
  // PUT /display still counting down. refreshSessionState awaits these before its GET so
  // an optimistic encoding edit (e.g. the "Show cells" toggle) isn't read back as the
  // server's pre-edit copy while the 500ms debounce is still pending. Returns an
  // unregister for the hook's effect cleanup.
  registerDisplayFlush: (flush: () => Promise<void>) => () => void;
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

  functions: FunctionEntry[];
  libraryVersions: Record<string, string>;
  setFunctions: (fns: FunctionEntry[], versions: Record<string, string>) => void;

  // sidebar selection
  selectedComputeId: string | null;
  setSelectedComputeId: (id: string | null) => void;
  selectedPlotId: string | null;
  setSelectedPlotId: (id: string | null) => void;
  // Plot shown fullscreen by FigureLightbox — opened from the Plots view or the plot
  // detail panel, which is why it lives here rather than in either of them.
  expandedPlotId: string | null;
  setExpandedPlotId: (id: string | null) => void;
  sidebarTab: 'compute' | 'plots' | 'regions' | 'annotations' | 'subsetting';
  setSidebarTab: (tab: 'compute' | 'plots' | 'regions' | 'annotations' | 'subsetting') => void;

  // main viewer mode — spatial canvas, embedding scatter, the saved plot figures, or
  // the data-table inspector
  mainView: MainView;
  setMainView: (view: MainView) => void;

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

  // cell-selection draw state — shared between the canvas (draws) and the active tab's
  // panel (commit / apply / clear). drawPolygons holds committed rings; drawRing is
  // the in-progress ring being clicked out, and drawShape the in-progress geometric
  // shape (one at a time, like the ring) placed by the circle/ellipse/square/rectangle
  // tools. Both in-progress items count toward the selection before being committed.
  drawPolygons: [number, number][][];
  drawRing: [number, number][];
  // Which selection tool a canvas drag drives: the click-built lasso, or one of the
  // geometric shapes. A panel-level choice, shared by the Regions and Subset tabs.
  selectionTool: SelectionTool;
  setSelectionTool: (tool: SelectionTool) => void;
  drawShape: SelectionShape | null;
  setDrawShape: (shape: SelectionShape | null) => void;
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
  // Cells hidden from the canvas, by row index. Presentation only — the serverless
  // viewer's stand-in for subsetting, which really creates a new session from a
  // `polygon_query` and so needs the backend. Null means nothing is hidden.
  hiddenCells: Set<number> | null;
  setHiddenCells: (cells: Set<number> | null) => void;
  // Label cells entirely in the browser (serverless viewer). Writes a local
  // categorical column onto the data source and mirrors it into the session state
  // the pickers and legend read, so the result is indistinguishable from a
  // backend-assigned region set — except that it lives only in this tab.
  applyLocalRegion: (args: {
    source: DataSource;
    cellIndices: number[];
    nCells: number;
    obsColumn: string;
    category: string;
    color: string;
  }) => void;
  setRegionCellIndices: (idx: number[] | null) => void;
  addDrawVertex: (pt: [number, number]) => void;
  // Bank whatever is in progress — the closeable ring and/or the placed geometric
  // shape — as committed rings, freeing the surface for the next area.
  commitDrawRegion: () => void;
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
  // Apply an edited shape locally and persist it once the edits stop coming, coalescing
  // a slider drag or a typed label into one update job. Used by the annotations panel.
  editShapeAnnotation: (shape: ShapeAnnotation) => void;
  // Persist the current (already-upserted) state of a shape via an update job, reading
  // the latest stored version so a captured-early snapshot can't revert a concurrent
  // edit, and marking it locally owned until the job lands. Used by the canvas
  // (drag-to-move/resize), which persists per gesture, and by editShapeAnnotation.
  sendShapeUpdate: (shapeId: string) => void;
  // Optimistically remove a shape and enqueue its delete job, tombstoning it so a
  // refetch before the job lands can't resurrect it.
  deleteShape: (id: string) => void;
  // Clear a shape's locally-owned mark once its job completes/fails (called from the
  // SSE handlers before the reconciling refetch). Safe to clear before that refetch
  // lands: an edit made since is covered by its own claim (see SHAPE_EDIT_DEBOUNCE_MS),
  // and one made before it is what the completed job just persisted.
  resolveShapeJob: (jobId: string) => void;
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

  // Snapshot gallery modal — opened from the settings panel and, after saving a
  // snapshot, from the export modal (preselecting the freshly saved one).
  snapshotsOpen: boolean;
  snapshotsInitialSelect: string | null;  // snapshot name to preselect
  openSnapshots: (selectName?: string) => void;
  closeSnapshots: () => void;

  // Snapshot export modal — set by the canvas's snapshot handler with the live framing
  // (viewport + display) so the modal can seed itself and render previews; null closed.
  snapshotExport: SnapshotExportParams | null;
  openSnapshotExport: (params: SnapshotExportParams) => void;
  closeSnapshotExport: () => void;

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

  // Cirro upload. `cirroAuth` is this browser's own Cirro login (device code), null
  // until the first status fetch resolves.
  cirroAuth: CirroAuth | null;
  setCirroAuth: (a: CirroAuth | null) => void;
  cirroUploads: CirroUpload[];
  setCirroUploads: (u: CirroUpload[]) => void;
  // Re-fetch this browser's own upload rows and toast the ones that just settled.
  // The `cirro.upload.state` event is a bare ping (rows name a Cirro project and
  // dataset, and that bus is broadcast), so the rows are pulled, not pushed.
  refreshCirroUploads: () => Promise<void>;
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

// A viewer without the edit lock changes display settings locally only — the PUT is
// skipped (useDisplayPersistence), so the server still holds the lock holder's copy.
// Adopting the fetched displays wholesale would therefore snap such a viewer's canvas
// back to the holder's settings on every refetch, so keep the local copy of any display
// already on screen for the same session; displays the holder has *added* still arrive.
function withLocalDisplays(store: AppStore, fetched: SessionState): SessionState {
  const local = store.sessionState;
  if (!local || local.summary.id !== fetched.summary.id) return fetched;
  if (!editBlockReason(fetched, store.presence)) return fetched;
  const localById = new Map(local.app_state.displays.map((d) => [d.id, d]));
  return {
    ...fetched,
    app_state: {
      ...fetched.app_state,
      displays: fetched.app_state.displays.map((d) => localById.get(d.id) ?? d),
    },
  };
}

let _notificationSeq = 0;

const THEME_KEY = 'sds-theme';

function readTheme(): 'dark' | 'light' {
  // `?theme=` wins over what is stored: it is how an embedding page states the theme
  // its own design needs, and it must not leave that behind in the reader's storage.
  const fromUrl = themeFromLocation();
  if (fromUrl) return fromUrl;
  const t = localStorage.getItem(THEME_KEY);
  return t === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: 'dark' | 'light') {
  document.documentElement.dataset.theme = theme;
}

// Apply the theme before first paint to avoid a flash.
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

  presence: {},
  setPresence: (presence) => set({ presence }),
  clientName: clientName(),
  renameClient: (name) => {
    setClientName(name);
    set({ clientName: clientName() });
    postPresence(get().activeSessionId, clientName())
      .then(({ sessions }) => set({ presence: sessions }))
      .catch((err) => get().pushNotification({
        kind: 'error', message: `Rename failed: ${formatError(err)}`,
      }));
  },

  activeSessionId: null,
  // Switching sessions must drop per-session view state: a lingering isolated
  // category would dim the new session's other categories (looking like data loss),
  // a half-drawn polygon belongs to the old session's coordinates, and the running-job
  // set is per-session (only the active session's jobs are tracked).
  setActiveSessionId: (id) =>
    set((s) => {
      if (id === s.activeSessionId) return { activeSessionId: id };
      // The module-scope maps hold per-session data too, and nothing else clears them:
      // a locally-labelled column is keyed by field path (`obs:<col>`), so switching to
      // another session or checkpoint reused the PREVIOUS dataset's codes array under the
      // same key — labels landing on the wrong cells, or dropped when the new table is
      // larger. The in-flight shape bookkeeping is equally stale once the session is gone.
      localRegionColumns.clear();
      shapeJobShape.clear();
      pendingShapeJobs.clear();
      completedBeforeMapped.clear();
      // sessionState belongs to the session being left: useSession only clears it when the
      // id goes null, so without this the tree renders the previous session's displays and
      // fields for a frame while dataSource already points at the new id.
      return { activeSessionId: id, sessionState: null, isolatedCategory: null, hiddenCells: null,
               drawPolygons: [], drawRing: [], drawShape: null, activeJobIds: new Set(), shapeAnnotations: [],
               activeShapeTool: null, selectedShapeId: null, draftVertices: [] };
    }),
  checkpointIndex: null,
  setCheckpointIndex: (index) => set({ checkpointIndex: index }),
  sessionState: null,
  setSessionState: (state) => set({ sessionState: state }),
  registerDisplayFlush: (flush) => {
    displayFlushers.add(flush);
    return () => { displayFlushers.delete(flush); };
  },
  refreshSessionState: async (sessionId) => {
    const ticket = nextRefreshTicket(sessionRefreshSeq, sessionId);
    // Send any pending display PUT before reading, so the GET reflects the latest
    // encoding edit instead of clobbering the optimistic value with the pre-edit copy.
    await Promise.all([...displayFlushers].map((flush) => flush().catch(() => {})));
    const superseded = () => sessionRefreshSeq.get(sessionId) !== ticket;
    try {
      const state = await fetchWhenIdle(() => getSession(sessionId));
      if (get().activeSessionId !== sessionId) return; // switched away mid-fetch
      if (superseded()) return; // a later refetch is authoritative; this read is pre-job
      const applied = withLocalDisplays(get(), state);
      set({ sessionState: applied });
      // Restore the persisted isolated category (setActiveSessionId cleared it) — from
      // the state actually applied, so a viewer without the lock keeps their own.
      const spatial = applied.app_state.displays.find(isSpatialDisplay);
      get().setIsolatedCategory(spatial ? spatial.encoding.isolated_category ?? null : null);
    } catch (err) {
      // Still busy after retries: the next job.completed re-triggers this, so stay quiet.
      if (err instanceof ApiError && err.status === 503) return;
      if (superseded()) return; // a newer refetch owns the outcome, including its errors
      get().pushNotification({
        kind: 'error',
        message: `Failed to refresh session: ${formatError(err)}`,
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
  // A shared link can name the plot it opens on, the same way it names the view.
  expandedPlotId: initialUiOverlay().expandedPlotId ?? null,
  setExpandedPlotId: (id) => set({ expandedPlotId: id }),
  sidebarTab: 'compute',
  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  // Seeded from a shared view link before the first render: this decides which canvas
  // mounts, so applying it afterwards would flash the wrong view (lib/urlViewState.ts).
  mainView: initialUiOverlay().mainView ?? 'canvas',
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
      // Isolation is a display setting, so a viewer without the lock gets it locally
      // and it stays out of the session (the PUT would 423 anyway).
      if (!editBlockReason(s.sessionState, s.presence)) {
        putDisplay(s.activeSessionId, updated).catch(console.error);
      }
    }
  },
  regionNewSetName: '',
  regionCategoryName: '',
  regionColor: '#e05c5c',
  setRegionTarget: (setName, category, color) =>
    set({ regionNewSetName: setName, regionCategoryName: category, regionColor: color }),

  drawPolygons: [],
  drawRing: [],
  selectionTool: 'lasso',
  setSelectionTool: (tool) =>
    set((s) => {
      if (tool === s.selectionTool) return {};
      // Arming a shape tool needs an empty surface to drag on — only one geometric
      // shape is in progress at a time. Going back to the lasso keeps the placed one,
      // which is still part of the selection.
      return tool === 'lasso' ? { selectionTool: tool } : { selectionTool: tool, drawShape: null };
    }),
  drawShape: null,
  setDrawShape: (shape) => set({ drawShape: shape }),
  regionCellCount: 0,
  setRegionCellCount: (n) => set({ regionCellCount: n }),
  regionCellIndices: null,
  setRegionCellIndices: (idx) => set({ regionCellIndices: idx }),
  hiddenCells: null,
  setHiddenCells: (cells) => set({ hiddenCells: cells && cells.size ? cells : null }),
  applyLocalRegion: ({ source, cellIndices, nCells, obsColumn, category, color }) =>
    set((s) => {
      if (!s.sessionState || !source.setLocalColumn) return {};
      const path = `obs:${obsColumn}`;
      const regions = s.sessionState.app_state.regions ?? [];
      const existing = regions.find((r) => r.obs_column === obsColumn);

      // Categories carry an explicit "unlabelled" level at code 0 so cells outside
      // every lasso stay visible (and greyed) rather than dropping out of the
      // colouring. Re-labelling a cell overwrites its previous category.
      const previous = localRegionColumns.get(path);
      const categories = previous ? [...previous.categories] : [UNLABELLED];
      let code = categories.indexOf(category);
      if (code < 0) {
        code = categories.length;
        categories.push(category);
      }
      const codes = previous ? Int32Array.from(previous.codes) : new Int32Array(nCells);
      for (const i of cellIndices) {
        if (i >= 0 && i < codes.length) codes[i] = code;
      }
      localRegionColumns.set(path, { categories, codes });
      source.setLocalColumn(path, { categories, codes });

      // Recount every category from the codes, so re-labelling over an earlier
      // selection reports the truth rather than accumulating.
      const counts = new Map<string, number>();
      for (const c of codes) {
        const label = categories[c];
        if (label !== UNLABELLED) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const colorOf = new Map(existing?.categories.map((c) => [c.label, c.color]) ?? []);
      colorOf.set(category, color);
      const regionSet: RegionSet = {
        id: existing?.id ?? `local:${obsColumn}`,
        name: existing?.name ?? obsColumn,
        obs_column: obsColumn,
        categories: [...counts].map(([label, n_cells]) => ({
          label, n_cells, color: colorOf.get(label) ?? color,
        })),
      };

      const fields = s.sessionState.fields;
      const obs = fields.obs.some((f) => f.name === obsColumn)
        ? fields.obs
        : [...fields.obs, { name: obsColumn, kind: 'categorical' as const }];

      return {
        sessionState: {
          ...s.sessionState,
          fields: { ...fields, obs },
          app_state: {
            ...s.sessionState.app_state,
            regions: existing
              ? regions.map((r) => (r.id === regionSet.id ? regionSet : r))
              : [...regions, regionSet],
          },
          // Bumping the version is what invalidates useArrowField's cache entry for
          // this column, so the canvas re-reads it from the source.
          data_versions: {
            ...s.sessionState.data_versions,
            [path]: (s.sessionState.data_versions[path] ?? 0) + 1,
          },
        },
      };
    }),
  addDrawVertex: (pt) => set((s) => ({ drawRing: [...s.drawRing, pt] })),
  commitDrawRegion: () =>
    set((s) => {
      const committed = [...s.drawPolygons];
      if (s.drawShape) committed.push(selectionShapeRing(s.drawShape));
      if (s.drawRing.length >= 3) committed.push(s.drawRing);
      if (committed.length === s.drawPolygons.length) return {};
      return {
        drawPolygons: committed,
        // A ring too short to close is still being drawn; leave those clicks alone.
        drawRing: s.drawRing.length >= 3 ? [] : s.drawRing,
        drawShape: null,
      };
    }),
  clearDraw: () => set({ drawPolygons: [], drawRing: [], drawShape: null }),

  shapeAnnotations: [],
  setShapeAnnotations: (shapes) => set({ shapeAnnotations: shapes }),
  refreshShapeAnnotations: async (sessionId) => {
    const ticket = nextRefreshTicket(shapeRefreshSeq, sessionId);
    const superseded = () => shapeRefreshSeq.get(sessionId) !== ticket;
    try {
      const { shapes } = await fetchWhenIdle(() => listShapeAnnotations(sessionId));
      if (get().activeSessionId !== sessionId) return; // switched away mid-fetch
      if (superseded()) return; // a later list is authoritative; this one predates it
      if (pendingShapeJobs.size === 0) { set({ shapeAnnotations: shapes }); return; }
      // Keep locally-owned shapes (an edit/create/delete whose job hasn't landed) as they
      // are locally: the server copy is still pre-edit. Preserve server order — substitute
      // the optimistic version for a pending edit/move in place, drop a pending delete
      // (absent locally = tombstone), and append a pending create the server doesn't have.
      const localById = new Map(get().shapeAnnotations.map((s) => [s.id, s]));
      const serverIds = new Set(shapes.map((s) => s.id));
      const merged = shapes
        .filter((s) => !pendingShapeJobs.has(s.id) || localById.has(s.id))
        .map((s) => (pendingShapeJobs.has(s.id) ? localById.get(s.id)! : s));
      for (const id of pendingShapeJobs.keys()) {
        if (!serverIds.has(id)) { const local = localById.get(id); if (local) merged.push(local); }
      }
      set({ shapeAnnotations: merged });
    } catch (err) {
      // Still busy after retries: the next job.completed re-triggers this, so stay quiet.
      if (err instanceof ApiError && err.status === 503) return;
      if (superseded()) return; // a newer list owns the outcome, including its errors
      get().pushNotification({
        kind: 'error',
        message: `Failed to refresh annotations: ${formatError(err)}`,
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
    get().setSelectedShapeId(shape.id);
    if (shapesAreLocalOnly(get())) return;
    void persistShapeJob(shape.id, 'Create shape failed', () => createShapeAnnotation(sessionId, shape))
      .then((ok) => { if (!ok) get().removeShapeAnnotationLocal(shape.id); });
  },
  editShapeAnnotation: (shape) => {
    get().upsertShapeAnnotation(shape);
    if (!get().activeSessionId) return;
    const armed = shapeEditTimers.get(shape.id);
    if (armed === undefined) bumpShapePending(shape.id, 1);
    else clearTimeout(armed);
    shapeEditTimers.set(shape.id, setTimeout(() => {
      shapeEditTimers.delete(shape.id);
      get().sendShapeUpdate(shape.id);   // takes the job's own claim
      bumpShapePending(shape.id, -1);    // releases this window's
    }, SHAPE_EDIT_DEBOUNCE_MS));
  },
  sendShapeUpdate: (shapeId) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const shape = get().shapeAnnotations.find((s) => s.id === shapeId);
    if (!shape) return; // deleted meanwhile
    if (shapesAreLocalOnly(get())) return;  // already upserted; nowhere to persist it
    void persistShapeJob(shapeId, 'Update shape failed', () => updateShapeAnnotation(sessionId, shapeId, shape));
  },
  deleteShape: (id) => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    get().removeShapeAnnotationLocal(id);
    if (get().selectedShapeId === id) get().setSelectedShapeId(null);
    if (shapesAreLocalOnly(get())) return;
    void persistShapeJob(id, 'Delete shape failed', () => deleteShapeAnnotation(sessionId, id));
  },
  resolveShapeJob: (jobId) => {
    const shapeId = shapeJobShape.get(jobId);
    if (shapeId === undefined) {
      // Either this frame beat its own POST's response (park the id — the response will
      // clear the mark) or the job belongs to another viewer, in which case there is
      // nothing of ours to clear and no request outstanding to claim it.
      if (unmappedShapeRequests > 0) completedBeforeMapped.add(jobId);
      return;
    }
    shapeJobShape.delete(jobId);
    bumpShapePending(shapeId, -1);
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

  snapshotExport: null,
  openSnapshotExport: (params) => set({ snapshotExport: params }),
  closeSnapshotExport: () => set({ snapshotExport: null }),

  snapshotHandler: null,
  setSnapshotHandler: (fn) => set({ snapshotHandler: fn }),

  menuOpen: false,
  setMenuOpen: (open) => set({ menuOpen: open }),
  // A checkpoint viewer opens with the sidebar collapsed — the visualization is the
  // point there, and the sidebar holds only the analysis history (Sidebar.tsx).
  leftMenuOpen: initialUiOverlay().leftMenuOpen ?? checkpointUrlFromLocation() === null,
  setLeftMenuOpen: (open) => set({ leftMenuOpen: open }),

  cirroAuth: null,
  setCirroAuth: (a) => set({ cirroAuth: a }),
  cirroUploads: [],
  setCirroUploads: (u) => set({ cirroUploads: u }),
  // Guards itself rather than relying on each caller: the `cirro.upload.state` SSE
  // handler calls this as `void refreshCirroUploads()`, so an expired Cirro token made
  // getCirroUploads reject into an unhandled promise rejection with nothing on screen.
  refreshCirroUploads: async () => {
    const previous = new Map(get().cirroUploads.map((u) => [u.id, u.state]));
    try {
      const { uploads } = await getCirroUploads();
      for (const u of uploads) {
        if (previous.get(u.id) === u.state) continue;
        if (u.state === 'completed') {
          get().pushNotification({ kind: 'info', message: `Uploaded to Cirro as "${u.dataset_name}".` });
        } else if (u.state === 'failed') {
          get().pushNotification({ kind: 'error', message: `Cirro upload failed: ${u.error}` });
        }
      }
      set({ cirroUploads: uploads });
    } catch (err: unknown) {
      get().pushNotification({
        kind: 'error',
        message: `Could not refresh Cirro uploads: ${formatError(err)}`,
      });
    }
  },
  loadProgress: null,
  setLoadProgress: (p) => set({ loadProgress: p }),
  loadLog: '',
  appendLoadLog: (chunk) => set((s) => ({ loadLog: s.loadLog + chunk })),
  resetLoadLog: () => set({ loadLog: '' }),
}));
