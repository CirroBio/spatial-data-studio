"""Dataset-free unit test for SelectiveGZipMiddleware (transport/compression.py).

Asserts the correctness contract (which content types compress, round-trip
integrity, size/type passthrough) and the regression guard that matters for the
single-worker event loop: the CPU-bound gzip must run OFF the loop so a
concurrent request is not stalled for the whole compress. If the compress is
ever moved back inline, the heartbeat gap below tracks the compress time and the
test fails.
"""
import asyncio
import gzip
import os
import time

from app.transport.compression import SelectiveGZipMiddleware


def _app_returning(body: bytes, content_type: str):
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", content_type.encode())]})
        await send({"type": "http.response.body", "body": body, "more_body": False})
    return app


async def _drive(body: bytes, content_type: str, accept_gzip: bool = True):
    """Run one response through the middleware; return (headers dict, body bytes)."""
    headers = [(b"accept-encoding", b"gzip")] if accept_gzip else []
    scope = {"type": "http", "headers": headers}
    sent = []

    async def send(m):
        sent.append(m)

    async def receive():
        return {}

    await SelectiveGZipMiddleware(_app_returning(body, content_type))(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    out = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return dict(start["headers"]), out


async def _run():
    big_json = b'{"v":"' + (b"squidpy" * 100_000) + b'"}'  # ~700 KB, compressible

    # 1. Compressible JSON is gzipped and round-trips.
    hdrs, out = await _drive(big_json, "application/json")
    assert hdrs.get(b"content-encoding") == b"gzip", hdrs
    assert gzip.decompress(out) == big_json
    assert int(hdrs[b"content-length"]) == len(out)

    # 2. Arrow IPC streams take the same path.
    hdrs, out = await _drive(big_json, "application/vnd.apache.arrow.stream")
    assert hdrs.get(b"content-encoding") == b"gzip", hdrs
    assert gzip.decompress(out) == big_json

    # 3. Already-compressed / binary types stream through byte-for-byte.
    hdrs, out = await _drive(big_json, "image/webp")
    assert b"content-encoding" not in hdrs
    assert out == big_json

    # 4. Payloads under minimum_size are not compressed.
    tiny = b'{"ok":1}'
    hdrs, out = await _drive(tiny, "application/json")
    assert b"content-encoding" not in hdrs
    assert out == tiny

    # 5. A client that does not accept gzip gets the raw body.
    hdrs, out = await _drive(big_json, "application/json", accept_gzip=False)
    assert b"content-encoding" not in hdrs
    assert out == big_json

    # 6. Regression guard: the compress must not block the event loop. Compress a
    # buffer large enough to take real CPU time while a heartbeat tries to wake
    # every 5 ms; the largest wakeup gap must stay far below the compress time
    # (inline compress would make them equal).
    # High-entropy so gzip spends real CPU (hundreds of ms), keeping the pass
    # threshold far above the offloaded heartbeat floor — no machine-speed flake.
    heavy = b'{"v":"' + os.urandom(12_000_000).hex().encode() + b'"}'  # ~24 MB
    inline_t0 = time.perf_counter()
    gzip.compress(heavy, 6)
    compress_time = time.perf_counter() - inline_t0

    gaps = []
    stop = asyncio.Event()

    async def heartbeat():
        last = time.perf_counter()
        while not stop.is_set():
            await asyncio.sleep(0.005)
            now = time.perf_counter()
            gaps.append(now - last)
            last = now

    hb = asyncio.create_task(heartbeat())
    await asyncio.sleep(0.02)  # let the heartbeat settle
    await _drive(heavy, "application/json")
    stop.set()
    await hb

    max_gap = max(gaps)
    assert max_gap < compress_time / 2, (
        f"event loop stalled {max_gap*1000:.0f}ms during a {compress_time*1000:.0f}ms "
        f"compress — gzip is running inline on the loop, not offloaded")

    print(f"OK compression: gzip offloaded (max loop stall {max_gap*1000:.0f}ms "
          f"vs {compress_time*1000:.0f}ms compress)")


if __name__ == "__main__":
    asyncio.run(_run())
