"""Warm the caches behind slow first-access menu lookups, off the event loop, so
the value is ready the moment the user first opens the menu that needs it.

Input readers are already built at startup (the function registry, see
`registry/introspect.py`), but two menu lists are otherwise paid lazily on first
open: the Cirro project list (network + OAuth) and the saved-dataset scan
(recursive filesystem walk). A single background worker drains an `asyncio.Queue`,
running each blocking warm task in the default executor so a slow network/auth
call or filesystem walk never blocks the loop. Warm tasks are best-effort: a
failure is logged and the endpoint still computes the value on demand the first
time it is asked, so a missing Cirro credential or an unmounted checkpoint dir
just means no speed-up, never a broken startup.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

_log = logging.getLogger(__name__)


class Prewarm:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[tuple[str, Callable[[], object]]] | None = None
        self._worker: asyncio.Task | None = None

    def start(self) -> None:
        """Bind to the running loop and start the drain worker (idempotent)."""
        if self._worker is not None:
            return
        self._queue = asyncio.Queue()
        self._worker = asyncio.get_running_loop().create_task(self._drain())

    def stop(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            self._worker = None

    def submit(self, name: str, fn: Callable[[], object]) -> None:
        """Enqueue a blocking warm task `fn` (labelled `name` for logs)."""
        if self._queue is None:
            raise RuntimeError("prewarm not started")
        self._queue.put_nowait((name, fn))

    async def _drain(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            name, fn = await self._queue.get()
            try:
                await loop.run_in_executor(None, fn)
                _log.info("prewarm: %s ready", name)
            except Exception as e:
                _log.warning("prewarm: %s failed (%s); will compute on demand", name, e)
            finally:
                self._queue.task_done()


PREWARM = Prewarm()
