"""The MCP assistant's presence identity (DESIGN: assistant surface).

The assistant is a first-class viewer in the same presence/edit-lock system the
browser clients use (sessions/presence.py): one fixed client id, a human-readable
name every other viewer sees in the LockBadge, and a 5 s heartbeat that runs as an
asyncio task while the assistant has an *active session*. Mutating MCP tools bind
`deps.CLIENT_ID` to this id, so the ordinary lock guard (`deps._claim_lock`)
attributes their writes to the assistant with no special-casing.

Lock etiquette: a browser viewer auto-holds the lock of the session it watches, so
the assistant can never edit a watched session without an explicit
`take_control(force)` — implemented here via `Presence.takeover`. The heartbeat
stops after `config.MCP_IDLE_RELEASE_S` without a tool call, releasing any lock via
the normal presence expiry, so a vanished agent cannot strand a session.
"""
from __future__ import annotations

import asyncio
import time

from ..config import config
from ..deps import CLIENT_ID
from ..sessions.presence import PRESENCE

AGENT_CLIENT_ID = "sds-mcp-assistant"
AGENT_NAME = "Claude (assistant)"
HEARTBEAT_S = 5.0

_active_session_id: str | None = None
_last_activity = 0.0
_beat_task: asyncio.Task | None = None


def touch() -> None:
    """Refresh the idle timer — called by long tool-side waits (job polls) so the
    assistant's presence outlives a slow compute."""
    global _last_activity
    _last_activity = time.monotonic()


def bind_agent() -> None:
    """Bind the request context's client id to the assistant, and refresh the idle
    timer. Every MCP tool calls this first (reads too — activity is activity)."""
    CLIENT_ID.set(AGENT_CLIENT_ID)
    touch()
    # Re-arm the heartbeat if it idled out while the assistant was still attached.
    if _active_session_id is not None:
        _ensure_beating()


def active_session_id() -> str | None:
    return _active_session_id


def set_active(session_id: str | None) -> None:
    """Point the assistant's presence at `session_id` (or detach with None). The
    heartbeat's attach transition takes the session's lock when it is free, exactly
    like a browser viewer opening it."""
    global _active_session_id, _last_activity
    _active_session_id = session_id
    _last_activity = time.monotonic()
    PRESENCE.heartbeat(AGENT_CLIENT_ID, AGENT_NAME, session_id)
    if session_id is not None:
        _ensure_beating()


def take_control(session_id: str, force: bool = False) -> dict:
    """Attach to `session_id` and take its edit lock. When another viewer holds it,
    `force=True` transfers the lock (Presence.takeover); without force, report the
    holder instead so the caller can decide."""
    set_active(session_id)
    holder = PRESENCE.claim(session_id, AGENT_CLIENT_ID)
    if holder is not None:
        if not force:
            return {"ok": False, "locked_by": holder.name,
                    "hint": "pass take_control=True/force to transfer the lock; the viewer keeps watching read-only"}
        PRESENCE.takeover(session_id, AGENT_CLIENT_ID)
    return {"ok": True, "locked_by": AGENT_NAME}


def release() -> None:
    """Detach: the parting heartbeat (session_id=None) releases any lock the
    assistant held, and the beat task stops on its own next tick."""
    set_active(None)


def lock_holder_name(session_id: str) -> str | None:
    """Who holds `session_id`'s lock right now (None when unlocked)."""
    entry = PRESENCE.view()["sessions"].get(session_id)
    return entry["lock"]["name"] if entry and entry.get("lock") else None


def _ensure_beating() -> None:
    global _beat_task
    if _beat_task is None or _beat_task.done():
        _beat_task = asyncio.get_running_loop().create_task(_beat_loop())


async def _beat_loop() -> None:
    """Keep the assistant present (and its locks alive) between tool calls; stop
    after the idle window so an abandoned connection frees its sessions."""
    while _active_session_id is not None:
        if time.monotonic() - _last_activity > config.MCP_IDLE_RELEASE_S:
            PRESENCE.heartbeat(AGENT_CLIENT_ID, AGENT_NAME, None)
            break
        PRESENCE.heartbeat(AGENT_CLIENT_ID, AGENT_NAME, _active_session_id)
        await asyncio.sleep(HEARTBEAT_S)
