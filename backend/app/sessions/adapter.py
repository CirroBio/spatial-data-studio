"""The single call adapter (DESIGN §4.6). Every function — squidpy or custom —
executes through `CallAdapter.execute`, which resolves the descriptor to its
`Function` in the registry and delegates to `Function.execute`. All per-function
variation lives in the function class; this layer only routes.
"""
from ..registry.base import CallResult
from ..registry.introspect import REGISTRY


class CallAdapter:
    def execute(self, descriptor: dict, session) -> CallResult:
        fn = REGISTRY.get(f"{descriptor['namespace']}.{descriptor['function']}")
        if fn is None:
            return CallResult(status="failed", error=f"unknown function {descriptor}")
        return fn.execute(descriptor.get("params", {}), session)


ADAPTER = CallAdapter()
