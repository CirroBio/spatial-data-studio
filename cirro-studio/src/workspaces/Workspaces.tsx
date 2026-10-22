// The project's Spatial Data Studio workspaces: a top-bar button that says what they are
// doing from any page, a sheet that lists them (open, extend, stop, start, change,
// delete) and starts new ones, and a notice when one finishes starting. Loaded only for a
// signed-in Cirro project, so the examples never load the Cirro client for it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace, WorkspaceEnvironment } from '@cirrobio/api-client';
import { useStudio } from '../app/studio';
import { describeError, type CirroSession } from '../cirro/session';
import {
  AUTO_STOP_HOURS, MOUNT_FOLDER, deleteWorkspace, isBeingDeleted, isBooting, isOurs, isRunning, isStopped, isStopping,
  labelOf, listWorkspaces, openWorkspace, ownWorkspaces, statusText, studioEnvironment,
} from './cirro';
import { NewWorkspace } from './NewWorkspace';
import { closeForm, closeWorkspaces, openWorkspaces, showForm, useWorkspacesSheet, type WorkspaceRequest } from './request';

// How often the list is read again: often while one of the app's workspaces changes
// state, now and then while one runs or the sheet is open, and not at all otherwise.
const CHANGING_POLL_MS = 10_000;
const WATCHING_POLL_MS = 60_000;

function useWorkspaceList(session: CirroSession, projectId: string, watching: boolean) {
  const [list, setList] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Workspaces of the app's that finished starting while this page watched them boot.
  const [ready, setReady] = useState<Workspace[]>([]);
  const booting = useRef(new Set<string>());
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    listWorkspaces(session, projectId).then(
      (all) => {
        if (!live) return;
        const started = all.filter((w) => isOurs(w) && isRunning(w) && booting.current.has(w.id));
        if (started.length) setReady((now) => [...now.filter((r) => !started.some((s) => s.id === r.id)), ...started]);
        booting.current = new Set(all.filter((w) => isOurs(w) && isBooting(w)).map((w) => w.id));
        setList(all);
        setError(null);
      },
      (e: unknown) => live && setError(describeError(e, 'list workspaces')),
    );
    return () => {
      live = false;
    };
  }, [session, projectId, reads]);

  const ours = list?.filter(isOurs) ?? [];
  const changing = ours.some((w) => isBooting(w) || isStopping(w) || isBeingDeleted(w));
  const delay = changing ? CHANGING_POLL_MS : watching || ours.some(isRunning) ? WATCHING_POLL_MS : null;
  useEffect(() => {
    if (delay === null) return;
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [delay, list, refresh]);

  const dismiss = (id: string) => setReady((now) => now.filter((w) => w.id !== id));
  return { list, error, refresh, ready, dismiss };
}

export default function Workspaces({ session }: { session: CirroSession }) {
  const { collection, catalog } = useStudio();
  const projectId = collection.id;
  const sheet = useWorkspacesSheet();
  const { list, error, refresh, ready, dismiss } = useWorkspaceList(session, projectId, sheet.open);
  // undefined while it is looked up; null where this Cirro doesn't offer the Studio.
  const [env, setEnv] = useState<WorkspaceEnvironment | null | undefined>(undefined);
  const [envError, setEnvError] = useState<string | null>(null);
  // Per workspace: what is in progress, and what went wrong.
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A notice tells how the last form went: a new form, or closing the sheet, clears it.
  const formId = sheet.form?.id;
  useEffect(() => {
    if (formId !== undefined) setNotice(null);
  }, [formId]);
  const close = () => {
    setNotice(null);
    closeWorkspaces();
  };
  // A connection URL the browser wouldn't open a tab for, offered as a link instead.
  const [blocked, setBlocked] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    studioEnvironment(session).then(setEnv, (e: unknown) => {
      setEnv(null);
      setEnvError(describeError(e, 'list workspace environments'));
    });
  }, [session]);

  // Esc closes the sheet before the page beneath can take it as a step back.
  useEffect(() => {
    if (!sheet.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setNotice(null);
      closeWorkspaces();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sheet.open]);

  const ours = list?.filter(isOurs) ?? [];
  const others = list?.filter((w) => !isOurs(w)) ?? [];
  const mine = ownWorkspaces(list ?? [], session.username);
  const nameOf = (id: string) => catalog.byId.get(id)?.name ?? id;

  const act = async (w: Workspace, doing: string, what: string, run: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [w.id]: doing }));
    setProblems(({ [w.id]: _, ...rest }) => rest);
    try {
      await run();
    } catch (e) {
      setProblems((p) => ({ ...p, [w.id]: describeError(e, what) }));
    } finally {
      setBusy(({ [w.id]: _, ...rest }) => rest);
      refresh();
    }
  };
  // The tab has to open during the click, so this runs straight from it.
  const open = (w: Workspace) => act(w, 'Opening…', 'open workspaces', async () => {
    const url = await openWorkspace(session, projectId, w.id);
    setBlocked(url ? { id: w.id, url } : null);
  });
  const start = (w: Workspace) => act(w, 'Starting…', 'start workspaces', () => session.data.workspaces.startWorkspace({ projectId, workspaceId: w.id }));
  const stop = (w: Workspace) => act(w, 'Stopping…', 'stop workspaces', () => session.data.workspaces.stopWorkspace({ projectId, workspaceId: w.id }));
  const extend = (w: Workspace) => act(w, 'Extending…', 'extend workspaces', () => session.data.workspaces.postponeAutoStop({
    projectId, workspaceId: w.id, postponeWorkspaceAutostopInput: { autoStopTimeout: AUTO_STOP_HOURS },
  }));
  const remove = (w: Workspace) => act(w, 'Deleting… this can take a few minutes', 'delete workspaces', async () => {
    setConfirmDelete(null);
    await deleteWorkspace(session, projectId, w.id);
  });
  const change = (w: Workspace) => showForm(w.mountedDatasets.flatMap((m): WorkspaceRequest[] => (m.datasetId
    ? [{ key: `dataset:${m.datasetId}`, label: nameOf(m.datasetId), datasetIds: [m.datasetId], unsaved: false }]
    : [])), w);

  const bootingNow = ours.filter(isBooting).length;
  const running = ours.filter(isRunning).length;

  return (
    <>
      <button type="button" className="topbar-button ws-button" onClick={() => openWorkspaces()}>
        {bootingNow > 0
          ? <><span className="spinner" aria-hidden="true" /> Starting workspace</>
          : running > 0 ? <><span className="dot ws-running" aria-hidden="true" /> Workspaces · {running} running</> : 'Workspaces'}
      </button>

      {ready.length > 0 && (
        <div className="ws-toasts" role="status">
          {ready.map((w) => (
            <div key={w.id} className="ws-toast">
              <span>{labelOf(w)} is ready.</span>
              <button type="button" className="button button-small button-primary" onClick={() => { dismiss(w.id); void open(w); }}>Open ↗</button>
              <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismiss(w.id)}>×</button>
            </div>
          ))}
        </div>
      )}

      {sheet.open && (
        <div className="ws-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <aside className="ws-sheet" role="dialog" aria-modal="true" aria-label="Analysis Workspaces">
            <header className="ws-head">
              <h2>Analysis Workspaces</h2>
              <span className="muted">{collection.name}</span>
              <span className="facts-spacer" />
              <button type="button" className="icon-button" aria-label="Close" onClick={close}>×</button>
            </header>
            <p className="muted">
              An Analysis Workspace runs every squidpy and scanpy analysis on a machine in this project, with the datasets you choose
              under <code>{MOUNT_FOLDER}/</code> in its data folder: saved versions and checkpoints in its Open Checkpoint
              list, other stores and instrument runs through Import Data. It opens in a new tab.
            </p>

            {env === undefined && <p className="muted">Looking for Analysis Workspaces in this Cirro…</p>}
            {env === null && (
              <p className="notice notice-warning">
                {envError ?? 'This Cirro doesn\'t offer Analysis Workspaces (the Spatial Data Studio workspace environment, Cirro/spatial-data-studio). A Cirro admin can make it available.'}
              </p>
            )}
            {notice && <p className="notice notice-info">{notice}</p>}

            {env && (sheet.form
              ? (
                <NewWorkspace key={sheet.form.id} session={session} projectId={projectId} env={env} form={sheet.form} mine={mine}
                  onCancel={closeForm}
                  onUse={(w) => { closeForm(); void (isRunning(w) ? open(w) : start(w)); }}
                  onDone={(_id, problem) => { closeForm(); setNotice(problem ? `Started. ${problem}` : 'Starting. It takes a few minutes; you can keep working, and this page says when it\'s ready.'); refresh(); }} />
              )
              : <button type="button" className="button" onClick={() => showForm([], null)}>New workspace</button>)}

            {error && <p className="notice notice-danger">{error}</p>}
            {list === null && !error && <p className="muted">Reading this project's workspaces…</p>}
            {list && !ours.length && <p className="muted">You have no Analysis Workspaces in this project yet.</p>}

            <ul className="ws-list">
              {ours.map((w) => (
                <li key={w.id} className="ws-card">
                  <div className="ws-card-head">
                    <span className={`dot ${isRunning(w) ? 'ws-running' : isBooting(w) || isStopping(w) ? 'ws-changing' : ''}`} aria-hidden="true" />
                    <strong>{labelOf(w)}</strong>
                    <span className="muted">{busy[w.id] ?? statusText(w)}</span>
                  </div>
                  {w.mountedDatasets.length > 0 && (
                    <div className="ws-chips">
                      {w.mountedDatasets.map((m) => <span key={m.name} className="chip chip-static" title={`${MOUNT_FOLDER}/${m.name}`}>{m.datasetId ? nameOf(m.datasetId) : m.name}</span>)}
                    </div>
                  )}
                  {!busy[w.id] && !isBeingDeleted(w) && (
                    <div className="button-row">
                      {isRunning(w) && <>
                        <button type="button" className="button button-small button-primary" onClick={() => void open(w)}>Open ↗</button>
                        <button type="button" className="button button-small" onClick={() => void extend(w)}>Extend {AUTO_STOP_HOURS} hours</button>
                      </>}
                      {(isRunning(w) || isBooting(w)) && <button type="button" className="button button-small" onClick={() => void stop(w)}>Stop</button>}
                      {isStopped(w) && <>
                        <button type="button" className="button button-small" onClick={() => void start(w)}>Start</button>
                        <button type="button" className="button button-small" disabled={!env} onClick={() => change(w)}>Change datasets…</button>
                        {confirmDelete === w.id
                          ? <button type="button" className="button button-small button-danger" onClick={() => void remove(w)}>Delete it</button>
                          : <button type="button" className="button button-small" onClick={() => setConfirmDelete(w.id)}>Delete…</button>}
                      </>}
                    </div>
                  )}
                  {confirmDelete === w.id && <p className="muted">Files in it that weren't saved to the project are lost with it.</p>}
                  {blocked?.id === w.id && (
                    <a className="button button-small" href={blocked.url} target="_blank" rel="noreferrer" onClick={() => setBlocked(null)}>
                      The browser blocked the new tab: open it here (works once, for a few minutes)
                    </a>
                  )}
                  {problems[w.id] && <p className="notice notice-danger">{problems[w.id]}</p>}
                </li>
              ))}
            </ul>
            <p className="muted">
              A workspace keeps running when you leave this page, until it stops by itself. Stopping keeps its files;
              what you save in an Analysis Workspace stays in it until you upload it to Cirro from there.
            </p>

            {others.length > 0 && (
              <details className="ws-others">
                <summary>Other workspaces in this project ({others.length})</summary>
                <ul>
                  {others.map((w) => (
                    <li key={w.id}>
                      <span>{w.name}</span> <span className="muted">{statusText(w)} · {w.createdBy}</span>{' '}
                      <a href={`${session.tenant.url}/project/${projectId}/workspace/${w.id}`} target="_blank" rel="noreferrer">In Cirro ↗</a>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
