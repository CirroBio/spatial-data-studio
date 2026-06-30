# Skill: change-agent-behavior

**Triggers on:** modifying the chat loop, the tools, approval, or context.

## Steps
1. Keep the meta-tool set fixed and small (`agent/tools.py::TOOL_SPECS`); never add
   annotate/subset. New capability = a new meta-tool over the registry, not a tool
   per function.
2. State-changing tools stay gated in auto-off (sequential approve / edit / deny);
   read-only tools run freely. Denials and failures both return to the model.
3. Memory stays self-curated: only the per-turn LEARNED note carries across turns;
   the transcript is persisted for the human but never replayed
   (`agent/chat.py`, `agent/context.py`).
4. `make check` — R11 (context-only replay) and R12 (fixed tools, no annotate/subset).

**Satisfies:** R11, R12.
