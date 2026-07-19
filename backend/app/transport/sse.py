"""Single multiplexed SSE stream (DESIGN §14.2). One async broadcast bus;
every client subscribes once and filters by `session_id`. Monotonic event ids
support `Last-Event-ID` resume.
"""
import asyncio
import json
from collections import deque

# Sentinel enqueued to a subscriber that has fallen too far behind: it ends that
# subscriber's stream so the browser's EventSource reconnects with Last-Event-ID.
_CLOSE = object()


class EventBus:
    def __init__(self, ring_size: int = 2048):
        self._subscribers: set[asyncio.Queue] = set()
        self._counter = 0
        self._ring: deque = deque(maxlen=ring_size)  # (id, type, data) for resume
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop):
        self._loop = loop

    def publish(self, event_type: str, data: dict):
        """Thread-safe publish — worker threads call this; marshals onto the loop."""
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._publish_inloop, event_type, data)

    def _publish_inloop(self, event_type: str, data: dict):
        self._counter += 1
        item = (self._counter, event_type, data)
        self._ring.append(item)
        for q in list(self._subscribers):
            try:
                q.put_nowait(item)
            except asyncio.QueueFull:
                # A subscriber that can't keep up: drop it and end its stream rather
                # than silently discarding events (which would leave its UI diverged
                # with no recovery signal). It reconnects and replays from the ring.
                self._subscribers.discard(q)
                try:
                    q.get_nowait()  # free a slot for the sentinel
                except asyncio.QueueEmpty:
                    pass
                q.put_nowait(_CLOSE)

    async def subscribe(self, last_event_id: int | None = None):
        q: asyncio.Queue = asyncio.Queue(maxsize=1024)
        self._subscribers.add(q)
        try:
            if last_event_id is not None:
                for item in list(self._ring):
                    if item[0] > last_event_id:
                        yield self._format(*item)
            while True:
                item = await q.get()
                if item is _CLOSE:
                    return
                yield self._format(*item)
        finally:
            self._subscribers.discard(q)

    @staticmethod
    def _format(event_id: int, event_type: str, data: dict) -> bytes:
        return (f"id: {event_id}\nevent: {event_type}\n"
                f"data: {json.dumps(data)}\n\n").encode()


BUS = EventBus()
