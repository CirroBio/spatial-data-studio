"""Self-curated agent context (v3 Part 7). The only carried memory is a short
list of LLM-authored "what I newly learned" notes — the raw transcript is never
replayed to the model. Notes live in app_state["ai_context"], so they persist
into the .zarr.zip and survive reload alongside the v2 app-state.

Two-tier compaction: per-turn a delta note is appended; when the total exceeds
CONTEXT_TOKEN_LIMIT the older notes are consolidated by the model while the most
recent CONTEXT_KEEP_RECENT_N stay verbatim.
"""
from __future__ import annotations

from ..config import config

_CONSOLIDATE_PROMPT = (
    "Consolidate these analysis notes into a tighter list of durable facts "
    "(what worked, what failed and why, user preferences, key parameter values). "
    "Drop redundancy; keep specifics. Return only the consolidated bullet list.")


def add_note(app_state: dict, note: str):
    if note:
        app_state.setdefault("ai_context", []).append(note.strip())


def rolled_up(app_state: dict) -> str:
    return "\n".join(f"- {n}" for n in app_state.get("ai_context", []))


def _tokens(notes: list[str]) -> int:
    return sum(len(n) for n in notes) // 4  # cheap heuristic, ~4 chars/token


def maybe_consolidate(app_state: dict, provider, system: str):
    notes = app_state.get("ai_context", [])
    if _tokens(notes) <= config.CONTEXT_TOKEN_LIMIT or len(notes) <= config.CONTEXT_KEEP_RECENT_N:
        return
    keep = notes[-config.CONTEXT_KEEP_RECENT_N:]
    old = notes[:-config.CONTEXT_KEEP_RECENT_N]
    msg = [{"role": "user", "content": [{"text": _CONSOLIDATE_PROMPT + "\n\n" + "\n".join(f"- {n}" for n in old)}]}]
    try:
        summary = provider.converse(system, msg, [])["text"]
    except Exception:
        return  # consolidation is best-effort; keep the raw notes if it fails
    app_state["ai_context"] = ([f"(consolidated) {summary}"] if summary else []) + keep
