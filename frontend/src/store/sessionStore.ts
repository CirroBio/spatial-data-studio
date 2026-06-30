import { create } from 'zustand';
import type {
  SessionSummary,
  SessionState,
  FunctionEntry,
  ResourceSample,
  DisplaySpec,
} from '../types';

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

  // transient notifications (e.g. a compute job that failed and vanished from history)
  notifications: AppNotification[];
  pushNotification: (n: Omit<AppNotification, 'id'>) => void;
  dismissNotification: (id: number) => void;

  // AI chat (v3 Parts 6-8)
  aiEnabled: boolean;
  setAiEnabled: (on: boolean) => void;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  chatAutoMode: boolean;
  setChatAutoModeState: (auto: boolean) => void;
  chatMessages: ChatMessage[];
  appendChatMessage: (m: ChatMessage) => void;
  setChatMessages: (m: ChatMessage[]) => void;
  chatBusy: boolean;
  setChatBusy: (b: boolean) => void;
  chatPending: ApprovalRequest | null;
  setChatPending: (a: ApprovalRequest | null) => void;
}

export interface AppNotification {
  id: number;
  kind: 'error' | 'info';
  message: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
}

export interface ApprovalRequest {
  call_id: string;
  name: string;
  params: Record<string, unknown>;
}

let _notificationSeq = 0;

export const useAppStore = create<AppStore>((set) => ({
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
  // and a half-drawn polygon belongs to the old session's coordinates.
  setActiveSessionId: (id) =>
    set((s) =>
      id === s.activeSessionId
        ? { activeSessionId: id }
        : { activeSessionId: id, isolatedCategory: null, drawPolygons: [], drawRing: [],
            chatMessages: [], chatPending: null, chatBusy: false }
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

  functions: [],
  squidpyVersion: '',
  setFunctions: (fns, version) => set({ functions: fns, squidpyVersion: version }),

  selectedComputeId: null,
  setSelectedComputeId: (id) => set({ selectedComputeId: id, selectedPlotId: null }),
  selectedPlotId: null,
  setSelectedPlotId: (id) => set({ selectedPlotId: id, selectedComputeId: null }),
  sidebarTab: 'compute',
  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  activeRegionSetId: null,
  setActiveRegionSetId: (id) => set({ activeRegionSetId: id }),
  isolatedCategory: null,
  setIsolatedCategory: (cat) => set({ isolatedCategory: cat }),
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

  notifications: [],
  pushNotification: (n) =>
    set((s) => ({ notifications: [...s.notifications, { ...n, id: ++_notificationSeq }] })),
  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((x) => x.id !== id) })),

  aiEnabled: false,
  setAiEnabled: (on) => set({ aiEnabled: on }),
  chatOpen: true,
  setChatOpen: (open) => set({ chatOpen: open }),
  chatAutoMode: false,
  setChatAutoModeState: (auto) => set({ chatAutoMode: auto }),
  chatMessages: [],
  appendChatMessage: (m) => set((s) => ({ chatMessages: [...s.chatMessages, m] })),
  setChatMessages: (m) => set({ chatMessages: m }),
  chatBusy: false,
  setChatBusy: (b) => set({ chatBusy: b }),
  chatPending: null,
  setChatPending: (a) => set({ chatPending: a }),
}));
