import { create } from 'zustand';
import type {
  SessionSummary,
  SessionState,
  FunctionEntry,
  ResourceSample,
  DisplaySpec,
  SpatialDisplaySpec,
  HistEntry,
  PlotEntry,
} from '../types';
import { isSpatialDisplay } from '../types';
import { putDisplay } from '../api';

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
  updateDataVersions: (versions: Record<string, number>) => void;
  updateDisplay: (display: DisplaySpec) => void;
  addDisplay: (display: DisplaySpec) => void;
  // Optimistically show a submitted compute/plot as queued straight from the
  // job.queued event — a refetch can't do this because it blocks on the session
  // read lock until the (already-running) job finishes.
  addQueuedEntry: (
    effectClass: 'compute' | 'plot',
    base: { id: string; namespace: string; function: string; params: Record<string, unknown> },
  ) => void;
  setEntryStatus: (id: string, status: HistEntry['status'] | PlotEntry['status']) => void;

  // functions list
  functions: FunctionEntry[];
  squidpyVersion: string;
  setFunctions: (fns: FunctionEntry[], version: string) => void;

  // sidebar selection
  selectedComputeId: string | null;
  setSelectedComputeId: (id: string | null) => void;
  selectedPlotId: string | null;
  setSelectedPlotId: (id: string | null) => void;
  sidebarTab: 'compute' | 'plots' | 'annotations' | 'subsetting';
  setSidebarTab: (tab: 'compute' | 'plots' | 'annotations' | 'subsetting') => void;

  // main viewer mode — spatial canvas, embedding scatter, or the data-table inspector
  mainView: 'canvas' | 'embedding' | 'tables';
  setMainView: (view: 'canvas' | 'embedding' | 'tables') => void;

  // light/dark theme — persisted in localStorage so it survives reloads
  theme: 'dark' | 'light';
  setTheme: (theme: 'dark' | 'light') => void;

  // annotations tab state
  activeRegionSetId: string | null;
  setActiveRegionSetId: (id: string | null) => void;
  isolatedCategory: string | null;
  setIsolatedCategory: (cat: string | null) => void;
  // annotation drawing target (set name + category + color) — read by SpatialCanvas
  annotationNewSetName: string;
  annotationCategoryName: string;
  annotationColor: string;
  setAnnotationTarget: (setName: string, category: string, color: string) => void;

  // polygon draw state — shared between the canvas (draws) and the active tab's
  // panel (commit / apply / clear). drawPolygons holds committed rings; drawRing is
  // the in-progress ring being clicked out.
  drawPolygons: [number, number][][];
  drawRing: [number, number][];
  addDrawVertex: (pt: [number, number]) => void;
  commitDrawRing: () => void;
  clearDraw: () => void;

  // resource sample
  resourceSample: ResourceSample | null;
  setResourceSample: (sample: ResourceSample) => void;

  // active jobs (session-level)
  activeJobIds: Set<string>;
  addActiveJob: (jobId: string) => void;
  removeActiveJob: (jobId: string) => void;

  // the in-flight "save session" job, if any — drives the blocking save overlay
  savingJobId: string | null;
  setSavingJobId: (jobId: string | null) => void;

  // transient notifications (e.g. a compute job that failed and vanished from history)
  notifications: AppNotification[];
  pushNotification: (n: Omit<AppNotification, 'id'>) => void;
  dismissNotification: (id: number) => void;

  // Cirro upload
  cirroEnabled: boolean;
  setCirroEnabled: (on: boolean) => void;
  cirroUploads: { uploading: number; pending: number };
  setCirroUploads: (u: { uploading: number; pending: number }) => void;
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
            activeJobIds: new Set() }
    ),
  sessionState: null,
  setSessionState: (state) => set({ sessionState: state }),
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
            ...base, status: 'queued' as const, squidpy_version: s.squidpyVersion,
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
  squidpyVersion: '',
  setFunctions: (fns, version) => set({ functions: fns, squidpyVersion: version }),

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
  annotationNewSetName: '',
  annotationCategoryName: '',
  annotationColor: '#e05c5c',
  setAnnotationTarget: (setName, category, color) =>
    set({ annotationNewSetName: setName, annotationCategoryName: category, annotationColor: color }),

  drawPolygons: [],
  drawRing: [],
  addDrawVertex: (pt) => set((s) => ({ drawRing: [...s.drawRing, pt] })),
  commitDrawRing: () =>
    set((s) => (s.drawRing.length >= 3
      ? { drawPolygons: [...s.drawPolygons, s.drawRing], drawRing: [] }
      : {})),
  clearDraw: () => set({ drawPolygons: [], drawRing: [] }),

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

  savingJobId: null,
  setSavingJobId: (jobId) => set({ savingJobId: jobId }),

  notifications: [],
  pushNotification: (n) =>
    set((s) => ({ notifications: [...s.notifications, { ...n, id: ++_notificationSeq }] })),
  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((x) => x.id !== id) })),

  cirroEnabled: false,
  setCirroEnabled: (on) => set({ cirroEnabled: on }),
  cirroUploads: { uploading: 0, pending: 0 },
  setCirroUploads: (u) => set({ cirroUploads: u }),
}));
