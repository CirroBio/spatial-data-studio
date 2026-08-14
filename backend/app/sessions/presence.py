"""Viewer presence and the per-session edit lock (DESIGN §16.5).

One process-wide registry, no persistence: a viewer is a browser client
identified by a client-minted id (stable in the browser's localStorage) that
heartbeats `POST /api/presence` every few seconds (5 s — hooks/usePresence.ts) with
its display name and the session it is looking at. A client that goes silent for
`PRESENCE_TIMEOUT_S` drops out and any lock it held is released, so a closed tab
never strands a session.

Lock rules, all implemented here:

- Attaching to a session nobody has locked takes its lock, so the ordinary
  single-user case is protected without anyone clicking anything. Only the
  attach *transition* does this — a deliberate unlock isn't undone by the
  holder's next heartbeat. Leaving a session (switching away, or the closing
  tab's parting beat) releases the lock the same moment.
- A mutating request claims the lock the same way (`claim`), which is what stops
  two viewers from both writing during the window after a deliberate unlock.
- While another viewer holds the lock, every mutating request is refused
  (`deps._claim_lock` → 423). Read paths are never gated: a viewer without the
  lock still gets the full session and changes their own display settings
  locally (the frontend skips the PUT).
- Callers with no client id — the offline CLI, the e2e harness, scripts — write
  without taking the lock, but are still refused while a viewer holds it.
"""
import json
import threading
import time
from dataclasses import dataclass

from ..config import config
from ..transport.sse import BUS

MAX_NAME_LEN = 40


@dataclass
class Viewer:
    client_id: str
    name: str
    session_id: str | None = None
    last_seen: float = 0.0


class Presence:
    def __init__(self):
        # Heartbeats, mutating requests and session close all reach this from
        # different threads (event loop, executor, session workers).
        self._mutex = threading.Lock()
        self._viewers: dict[str, Viewer] = {}
        self._locks: dict[str, str] = {}      # session_id -> holder client_id
        self._published: str | None = None    # last broadcast view, for change detection

    # ---- viewer lifecycle -------------------------------------------------
    def heartbeat(self, client_id: str, name: str, session_id: str | None) -> dict:
        """Register/refresh one client and return the current view. Also the rename
        call (the name simply arrives changed) and the client's initial fetch."""
        with self._mutex:
            self._expire()
            viewer = self._viewers.get(client_id)
            if viewer is None:
                viewer = self._viewers[client_id] = Viewer(client_id, name)
            viewer.name = name
            viewer.last_seen = time.monotonic()
            was_on = viewer.session_id
            viewer.session_id = session_id
            if was_on is not None and was_on != session_id:
                # A lock belongs to whoever is looking at the session, so leaving it —
                # switching sessions, or the tab's parting `session_id: null` beat —
                # frees the lock at once instead of holding it for the timeout.
                if self._locks.get(was_on) == client_id:
                    del self._locks[was_on]
            if session_id is not None and session_id != was_on:
                self._locks.setdefault(session_id, client_id)
            return self._touch()

    def claim(self, session_id: str, client_id: str | None) -> Viewer | None:
        """Take `session_id`'s lock for a write. Returns the conflicting holder when
        another viewer holds it (the caller refuses the write), else None. An unknown
        client id (no heartbeat yet) and no client id at all both write without
        taking the lock rather than stranding it on a caller nobody can see."""
        with self._mutex:
            self._expire()
            holder = self._locks.get(session_id)
            if holder is not None:
                return None if holder == client_id else self._viewers[holder]
            if client_id in self._viewers:
                self._locks[session_id] = client_id
                self._touch()
            return None

    def takeover(self, session_id: str, client_id: str) -> None:
        """Transfer `session_id`'s lock to `client_id` even if another viewer holds
        it — the MCP assistant's explicit `take_control(force=True)`. A browser
        viewer auto-holds the lock of the session it is watching (see heartbeat), so
        without a takeover the assistant could never edit a watched session. The
        displaced viewer keeps watching (reads are never gated) and their LockBadge
        flips to the new holder's name; they reclaim it the same way once released.
        The caller must already be a registered viewer (heartbeating)."""
        with self._mutex:
            self._expire()
            if client_id in self._viewers:
                self._locks[session_id] = client_id
                self._touch()

    def release(self, session_id: str, client_id: str) -> bool:
        """Give up a lock this client holds. False if it holds no lock here."""
        with self._mutex:
            if self._locks.get(session_id) != client_id:
                return False
            del self._locks[session_id]
            self._touch()
            return True

    def drop_session(self, session_id: str) -> None:
        """Forget a closed session: its lock and everyone's attachment to it."""
        with self._mutex:
            self._locks.pop(session_id, None)
            for viewer in self._viewers.values():
                if viewer.session_id == session_id:
                    viewer.session_id = None
            self._touch()

    def view(self) -> dict:
        with self._mutex:
            self._expire()
            return self._touch()

    # ---- internals (caller holds the mutex) -------------------------------
    def _expire(self) -> None:
        cutoff = time.monotonic() - config.PRESENCE_TIMEOUT_S
        for client_id in [c for c, v in self._viewers.items() if v.last_seen < cutoff]:
            del self._viewers[client_id]
        for session_id in [s for s, holder in self._locks.items() if holder not in self._viewers]:
            del self._locks[session_id]

    def _touch(self) -> dict:
        """Recompute the view and broadcast it when it differs from the last one —
        heartbeats arrive every few seconds per client and mostly change nothing."""
        view = self._view()
        payload = json.dumps(view, sort_keys=True)
        if payload != self._published:
            self._published = payload
            BUS.publish("presence.updated", view)
        return view

    def _view(self) -> dict:
        sessions: dict[str, dict] = {}

        def entry(session_id: str) -> dict:
            return sessions.setdefault(session_id, {"lock": None, "viewers": []})

        for viewer in self._viewers.values():
            if viewer.session_id is not None:
                entry(viewer.session_id)["viewers"].append(viewer.name)
        for session_id, holder in self._locks.items():
            entry(session_id)["lock"] = {"client_id": holder, "name": self._viewers[holder].name}
        for record in sessions.values():
            record["viewers"].sort()
        return {"sessions": sessions}


def clean_name(raw: object, fallback: str) -> str:
    """A client's display name, trusted only after being bounded — it is shown to
    every other viewer. Collapses whitespace and caps the length."""
    name = " ".join(str(raw or "").split())[:MAX_NAME_LEN]
    return name or fallback


PRESENCE = Presence()
