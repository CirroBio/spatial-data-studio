"""LLM providers for the agent (v3 Part 8). The chat loop talks to a provider
through one `converse(system, messages, tool_specs) -> reply` method. Messages and
replies use the AWS Bedrock Converse content shape natively so the BedrockProvider
is a thin pass-through; the MockProvider returns scripted replies so the loop,
approval gating, and context machinery are testable without AWS credentials.

A reply is a dict: {"text": str, "tool_calls": [{"id","name","input"}], "stop": "tool_use"|"end_turn"}.
"""
from __future__ import annotations

from ..config import config


def tool_config(tool_specs: list[dict]) -> dict:
    """Convert our meta-tool specs into Converse toolConfig."""
    return {"tools": [{"toolSpec": {"name": t["name"], "description": t["description"],
                                    "inputSchema": {"json": t["input_schema"]}}}
                      for t in tool_specs]}


def _parse_converse_output(message: dict, stop_reason: str) -> dict:
    text_parts, tool_calls = [], []
    for block in message.get("content", []):
        if "text" in block:
            text_parts.append(block["text"])
        elif "toolUse" in block:
            tu = block["toolUse"]
            tool_calls.append({"id": tu["toolUseId"], "name": tu["name"], "input": tu.get("input", {})})
    stop = "tool_use" if (tool_calls or stop_reason == "tool_use") else "end_turn"
    return {"text": "\n".join(text_parts).strip(), "tool_calls": tool_calls, "stop": stop}


class BedrockProvider:
    """AWS Bedrock via the Converse API (native tool-use)."""

    def __init__(self):
        import boto3  # imported lazily so the app runs without boto3 when AI is off
        self._client = boto3.client("bedrock-runtime", region_name=config.AWS_REGION)
        self._model = config.BEDROCK_MODEL_ID

    def converse(self, system: str, messages: list[dict], tool_specs: list[dict]) -> dict:
        resp = self._client.converse(
            modelId=self._model,
            system=[{"text": system}],
            messages=messages,
            toolConfig=tool_config(tool_specs),
        )
        return _parse_converse_output(resp["output"]["message"], resp.get("stopReason", "end_turn"))


class MockProvider:
    """Deterministic provider for tests. Drives the loop through one read-only call
    (describe_function) and one state-changing call (run_function) so the approval
    round-trip and context note can be exercised without Bedrock."""

    def converse(self, system: str, messages: list[dict], tool_specs: list[dict]) -> dict:
        last = messages[-1]
        # Count how many tool results have come back so far this turn.
        n_results = sum(1 for m in messages if m["role"] == "user"
                        and any("toolResult" in b for b in m.get("content", [])))
        if n_results == 0:
            return {"text": "I'll inspect the leiden clustering tool, then run QC metrics.",
                    "tool_calls": [{"id": "t1", "name": "describe_function",
                                    "input": {"name": "sc.pp.calculate_qc_metrics"}}],
                    "stop": "tool_use"}
        if n_results == 1:
            return {"text": "Computing QC metrics now.",
                    "tool_calls": [{"id": "t2", "name": "run_function",
                                    "input": {"name": "sc.pp.calculate_qc_metrics", "params": {}}}],
                    "stop": "tool_use"}
        return {"text": "Done — QC metrics are now in obs.\n"
                        "LEARNED: sc.pp.calculate_qc_metrics adds per-cell QC columns (n_genes_by_counts, total_counts) to obs.",
                "tool_calls": [], "stop": "end_turn"}


_PROVIDER = None


def get_provider():
    """The configured provider, or None when AI is disabled (graceful degradation)."""
    global _PROVIDER
    if not config.ai_enabled():
        return None
    if _PROVIDER is None:
        _PROVIDER = MockProvider() if config.AI_PROVIDER == "mock" else BedrockProvider()
    return _PROVIDER
