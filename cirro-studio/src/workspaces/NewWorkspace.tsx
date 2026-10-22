// The form for a workspace: which items it opens, on what size of machine. It starts a
// new one, or gives a stopped one new datasets (`changing`). At Cirro's per-user limit it
// lists the user's workspaces to delete one, as the app kit asks.
import { useMemo, useState } from 'react';
import type { Workspace, WorkspaceEnvironment } from '@cirrobio/api-client';
import { useStudio } from '../app/studio';
import { describeError, type CirroSession } from '../cirro/session';
import {
  AUTO_STOP_HOURS, SIZES, changeStudioWorkspace, createStudioWorkspace, deleteWorkspace, isBeingDeleted, isRunning, isStopped,
  labelOf, statusText, workspaceLimit,
} from './cirro';
import { requestFor, type WorkspaceForm, type WorkspaceRequest } from './request';

export function NewWorkspace({ session, projectId, env, form, mine, onDone, onCancel, onUse }: {
  session: CirroSession; projectId: string; env: WorkspaceEnvironment; form: WorkspaceForm;
  // The user's own workspaces in the project, which count toward their limit.
  mine: Workspace[];
  onDone: (workspaceId: string, notice: string | null) => void;
  onCancel: () => void;
  // Opens a running workspace that already has everything asked for, or starts a stopped one.
  onUse: (w: Workspace) => void;
}) {
  const { library, catalog } = useStudio();
  const nameOf = (id: string) => catalog.byId.get(id)?.name ?? id;
  const [requests, setRequests] = useState(form.requests);
  const [scale, setScale] = useState(1);
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [atLimit, setAtLimit] = useState<{ used: number; limit: number } | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);

  // What can be added: each spatial dataset as opened from the map (its newest version),
  // then instrument runs and images.
  const options = useMemo(() => [
    ...library.spatial.flatMap((e) => {
      const item = e.head ?? e.base;
      return item ? [{ request: requestFor(item, e.label, library), kind: 'Spatial data' }] : [];
    }),
    ...library.runs.map((i) => ({ request: requestFor(i, i.label, library), kind: 'Instrument run' })),
    ...library.images.map((i) => ({ request: requestFor(i, i.label, library), kind: 'Image' })),
  ], [library]);
  const shown = options.filter((o) => o.request.label.toLowerCase().includes(filter.trim().toLowerCase()));
  const has = (key: string) => requests.some((r) => r.key === key);
  const toggle = (r: WorkspaceRequest) => setRequests((now) => (has(r.key) ? now.filter((x) => x.key !== r.key) : [...now, r]));

  const wanted = [...new Set(requests.flatMap((r) => r.datasetIds))];
  // Reuse before making another: a workspace of the user's that already has every dataset.
  const existing = form.changing ? null : mine.find((w) => !isBeingDeleted(w) && wanted.length > 0
    && wanted.every((id) => w.mountedDatasets.some((m) => m.datasetId === id)));
  const unsaved = requests.filter((r) => r.unsaved);
  const { cpu, memoryGiB } = env.defaultComputeConfig;

  const submit = async () => {
    setBusy(form.changing ? 'Changing it…' : 'Starting…');
    setError(null);
    try {
      if (form.changing) {
        await changeStudioWorkspace(session, projectId, form.changing, env, requests, nameOf, scale);
        onDone(form.changing.id, null);
      } else {
        const { id, noteProblem } = await createStudioWorkspace(session, projectId, env, requests, nameOf, scale);
        onDone(id, noteProblem);
      }
    } catch (e) {
      const limit = workspaceLimit(e);
      if (limit) setAtLimit(limit);
      else setError(describeError(e, form.changing ? 'change workspaces' : 'start workspaces'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (w: Workspace) => {
    setBusy('Deleting… this can take a few minutes');
    setError(null);
    try {
      await deleteWorkspace(session, projectId, w.id);
    } catch (e) {
      setError(describeError(e, 'delete workspaces'));
      setBusy(null);
      return;
    }
    setDeleting(null);
    setAtLimit(null);
    await submit();
  };

  return (
    <form className="ws-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h3>{form.changing ? `Change ${labelOf(form.changing)}` : 'New workspace'}</h3>
      <div className="field">
        <span>Datasets</span>
        <div className="ws-chips">
          {requests.map((r) => (
            <span key={r.key} className="chip chip-static">
              {r.label}
              <button type="button" className="icon-button ws-chip-remove" aria-label={`Remove ${r.label}`} onClick={() => toggle(r)}>×</button>
            </span>
          ))}
          <button type="button" className="link-button" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
            {picking ? 'Done adding' : '+ Add from this project'}
          </button>
        </div>
      </div>
      {picking && (
        <div className="ws-picker">
          <input className="input" type="search" placeholder="Filter by name" value={filter} autoFocus onChange={(e) => setFilter(e.target.value)} />
          <ul>
            {shown.map(({ request, kind }) => (
              <li key={request.key}>
                <label>
                  <input type="checkbox" checked={has(request.key)} onChange={() => toggle(request)} />
                  <span>{request.label}</span>
                  <span className="muted">{kind}</span>
                </label>
              </li>
            ))}
            {!shown.length && <li className="muted">Nothing here matches.</li>}
          </ul>
        </div>
      )}
      {requests.filter((r) => r.datasetIds.length > 1).map((r) => (
        <p key={r.key} className="muted">{r.label} brings {r.datasetIds.length} datasets: the store and the versions saved on it.</p>
      ))}
      {unsaved.length > 0 && (
        <p className="notice notice-warning">
          {unsaved.map((r) => r.label).join(', ')} {unsaved.length === 1 ? 'has' : 'have'} changes not saved as a version.
          A workspace sees only saved versions, so save first to take them.
        </p>
      )}
      {existing && (
        <p className="notice notice-info ws-existing">
          {labelOf(existing)} already has {requests.length === 1 ? 'it' : 'all of these'} ({statusText(existing).toLowerCase()}).{' '}
          {(isRunning(existing) || isStopped(existing)) && (
            <button type="button" className="link-button" onClick={() => onUse(existing)}>{isRunning(existing) ? 'Open it ↗' : 'Start it'}</button>
          )}
        </p>
      )}
      <fieldset className="ws-sizes">
        <legend>Machine</legend>
        {SIZES.map((s) => (
          <label key={s.id}>
            <input type="radio" name={`ws-size-${form.id}`} checked={scale === s.scale} onChange={() => setScale(s.scale)} />
            {s.label}
            {cpu && memoryGiB ? <span className="muted"> {cpu * s.scale} CPU · {memoryGiB * s.scale} GiB</span> : null}
          </label>
        ))}
      </fieldset>
      <p className="muted">
        It runs every squidpy and scanpy analysis, billed to the project while it
        runs, and stops after {AUTO_STOP_HOURS} hours unless you extend it. Starting takes a few minutes; you can keep
        working here meanwhile.{form.changing && ' Changing it restarts it; the files in its home folder stay.'}
      </p>
      {atLimit && (
        <div className="notice notice-warning ws-limit">
          <p>
            You have {atLimit.used} of the {atLimit.limit} workspaces Cirro allows you in this project, and stopped ones
            count. Delete one to make room{mine.length < atLimit.used ? '; the rest are ones this app can\'t see, which you can delete in Cirro' : ''}.
          </p>
          <ul>
            {mine.filter((w) => !isBeingDeleted(w)).map((w) => (
              <li key={w.id}>
                <span>{labelOf(w)}</span> <span className="muted">{statusText(w)}</span>
                {deleting?.id === w.id
                  ? <button type="button" className="button button-small button-danger" disabled={!!busy} onClick={() => void remove(w)}>Delete it</button>
                  : <button type="button" className="button button-small" disabled={!!busy} onClick={() => setDeleting(w)}>Delete…</button>}
              </li>
            ))}
          </ul>
          {deleting && <p>Files in {labelOf(deleting)} that weren't saved to the project are lost with it.</p>}
        </div>
      )}
      {error && <p className="notice notice-danger">{error}</p>}
      <div className="button-row">
        <button type="submit" className="button button-primary" disabled={!requests.length || !!busy}>
          {busy ?? (form.changing ? 'Change and start' : 'Start workspace')}
        </button>
        <button type="button" className="button" disabled={!!busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
