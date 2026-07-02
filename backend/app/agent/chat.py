"""The agent chat turn loop (v3 Part 6). One Bedrock conversation per session.

A turn replays: system prompt + rolled-up context + current data manifest + the
user message + tool definitions (Bedrock is stateless — Part 7.4). Within a turn
the tool-use message list is maintained; across turns only the distilled context
carries. Read-only tool calls run freely; state-changing calls are gated by the
auto-mode toggle, approved one at a time (Part 6.3). Denials and failures both
flow back to the model as tool results.
"""
from __future__ import annotations

import threading

from ..config import config
from ..transport.sse import BUS
from ..manifest import build_manifest
from . import tools, context as ctx
from .provider import get_provider

SYSTEM = (
    "You are an analysis assistant embedded in Spatial Data Studio, a spatial-omics app. "
    "You help the user analyze a SpatialData object. Use the tools to inspect the catalog "
    "(list_functions, describe_function) and the data manifest (get_data_manifest) BEFORE "
    "running anything. Run work with run_function using params that conform to the function's "
    "schema. You cannot annotate regions or subset — those are human-only. Be concise. "
    "End your final message of each turn with one line: 'LEARNED: <one durable fact you newly "
    "learned this turn>' (what worked/failed and why, user preferences, key parameter values)."
)


class ChatState:
    def __init__(self):
        self.auto_mode = False
        self.turn_lock = threading.Lock()
        self.pending: dict[str, dict] = {}   # call_id -> {event, decision}


_CHATS: dict[str, ChatState] = {}


def state_for(sid: str) -> ChatState:
    return _CHATS.setdefault(sid, ChatState())


def discard_chat_state(sid: str) -> None:
    """Drop a session's chat state (lock + pending approvals) once its session closes.
    No-op if the session never populated _CHATS (AI chat wasn't enabled)."""
    _CHATS.pop(sid, None)


def set_auto_mode(sid: str, auto: bool):
    state_for(sid).auto_mode = auto


def decide(sid: str, call_id: str, decision: dict) -> bool:
    """Resolve a pending approval from the /approve endpoint (a different thread)."""
    p = state_for(sid).pending.get(call_id)
    if not p:
        return False
    p["decision"] = decision
    p["event"].set()
    return True


def _publish(sid: str, event: str, data: dict):
    BUS.publish(event, {"session_id": sid, **data})


def _short(result: dict) -> dict:
    """Trim a tool result for the SSE event (manifests/heads can be large)."""
    out = {}
    for k, v in (result or {}).items():
        out[k] = (v[:800] + "…") if isinstance(v, str) and len(v) > 800 else v
    return out


def _extract_note(text: str) -> str | None:
    for line in reversed((text or "").splitlines()):
        if line.strip().upper().startswith("LEARNED:"):
            return line.split(":", 1)[1].strip()
    return None


def start_turn(session, user_text: str):
    """Run a turn on its own background thread. A chat turn's run_function tool
    calls block (session.run_and_wait) on the session's single-worker job queue,
    so the turn itself must never run as a job on that same queue — it needs an
    independent thread, not the queue's worker."""
    threading.Thread(target=run_turn, args=(session, user_text), daemon=True).start()


def run_turn(session, user_text: str):
    provider = get_provider()
    if provider is None:
        _publish(session.id, "ai.error", {"error": "AI is not configured"})
        return
    st = state_for(session.id)
    if not st.turn_lock.acquire(blocking=False):
        _publish(session.id, "ai.error", {"error": "a turn is already running"})
        return
    try:
        _run_turn(session, st, provider, user_text)
    except Exception as e:
        _publish(session.id, "ai.error", {"error": str(e)})
    finally:
        st.turn_lock.release()


def _run_turn(session, st: ChatState, provider, user_text: str):
    app_state = session.app_state
    with session.lock.writing():
        transcript = app_state.setdefault("ai_transcript", [])
        transcript.append({"role": "user", "text": user_text})

    with session.lock.reading():
        manifest = build_manifest(session)
    preamble = (f"{SYSTEM}\n\n# Prior learnings\n{ctx.rolled_up(app_state) or '(none)'}\n\n"
                f"# Current data manifest\n{manifest}")

    messages = [{"role": "user", "content": [{"text": user_text}]}]
    final_text = ""
    for _ in range(config.AI_MAX_TOOL_ITERS):
        reply = provider.converse(preamble, messages, tools.TOOL_SPECS)
        if reply["text"]:
            _publish(session.id, "ai.message", {"text": reply["text"]})
            with session.lock.writing():
                transcript.append({"role": "assistant", "text": reply["text"]})
            final_text = reply["text"]
        if reply["stop"] != "tool_use" or not reply["tool_calls"]:
            break
        assistant_content = ([{"text": reply["text"]}] if reply["text"] else [])
        assistant_content += [{"toolUse": {"toolUseId": tc["id"], "name": tc["name"], "input": tc["input"]}}
                              for tc in reply["tool_calls"]]
        messages.append({"role": "assistant", "content": assistant_content})
        result_blocks = []
        for tc in reply["tool_calls"]:  # sequential: each approval re-reflects current state
            result = _handle_tool(session, st, tc)
            result_blocks.append({"toolResult": {"toolUseId": tc["id"], "content": [{"json": result}]}})
        messages.append({"role": "user", "content": result_blocks})

    note = _extract_note(final_text)
    if note:
        with session.lock.writing():
            ctx.add_note(app_state, note)
        # maybe_consolidate takes its own short-held locks around the dict access,
        # not across the Bedrock round-trip in between (would stall the session).
        ctx.maybe_consolidate(session, provider, SYSTEM)
    _publish(session.id, "ai.turn_done", {"context_size": len(app_state.get("ai_context", []))})


def _handle_tool(session, st: ChatState, tc: dict) -> dict:
    name, args = tc["name"], tc["input"] or {}
    _publish(session.id, "ai.tool", {"call_id": tc["id"], "name": name, "input": args, "phase": "proposed"})
    if not tools.is_state_changing(name) or st.auto_mode:
        result = tools.run_tool(name, args, session)
    else:
        result = _gated(session, st, tc, name, args)
    _publish(session.id, "ai.tool", {"call_id": tc["id"], "name": name, "phase": "result", "result": _short(result)})
    return result


def _gated(session, st: ChatState, tc: dict, name: str, args: dict) -> dict:
    ev = threading.Event()
    st.pending[tc["id"]] = {"event": ev, "decision": None}
    _publish(session.id, "ai.approval", {"call_id": tc["id"], "name": name, "params": args})
    if not ev.wait(timeout=600):
        st.pending.pop(tc["id"], None)
        return {"status": "failed", "error": "approval timed out"}
    decision = (st.pending.pop(tc["id"], {}) or {}).get("decision") or {}
    action = decision.get("action")
    if action == "approve":
        return tools.run_tool(name, args, session)
    if action == "edit":
        return tools.run_tool(name, decision.get("params") or args, session)
    return {"status": "denied", "reason": decision.get("reason", "(no reason given)")}
