"""The process pool that runs the actual squidpy/scanpy/custom-function call
(registry/kernel.py), so CPU-bound compute never holds the API process's GIL —
see registry/kernel.py for why the call itself, not just the whole session
model, is what needs to cross the process boundary.

Uses joblib's vendored loky executor (already a squidpy/scikit-learn
dependency) rather than `concurrent.futures.ProcessPoolExecutor`: loky submits
via cloudpickle, so a custom function's `mutate` closure (registry/custom/*.py)
crosses the boundary as-is — stdlib `pickle` can't serialize a closure at all.
"""
from joblib.externals.loky import get_reusable_executor

from ..config import config

_EXECUTOR = None


def executor():
    global _EXECUTOR
    if _EXECUTOR is None:
        _EXECUTOR = get_reusable_executor(max_workers=config.COMPUTE_POOL_WORKERS, context="loky")
    return _EXECUTOR
