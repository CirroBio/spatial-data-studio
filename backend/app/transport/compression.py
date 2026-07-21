"""Content-type-targeted gzip for HTTP responses.

Starlette's built-in GZipMiddleware compresses every response above a size
threshold regardless of type, which is wrong for this app: it would re-compress
the already-compressed WebP tiles and zstd raster chunks (CPU for ~0 gain),
corrupt the Range/206 responses the raster endpoint serves to zarrita, and
buffer the `text/event-stream` live-log stream (defeating incremental flushing).

This compresses only the whole-response payloads that actually shrink on the
wire — Arrow IPC field/geoarrow streams (gene columns gzip ~17x, categorical
codes ~6x) and JSON — and streams everything else through untouched. Browsers
decode `Content-Encoding: gzip` transparently, so no client change is needed.
"""
import gzip

import anyio
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Only these content types are buffered and gzipped. WebP/PNG tiles, the raster
# octet-stream chunks, SVG/PDF figures, zip snapshots, and text/event-stream are
# deliberately absent so they stream through byte-for-byte.
_COMPRESSIBLE_PREFIXES = ("application/vnd.apache.arrow.stream", "application/json")


class SelectiveGZipMiddleware:
    def __init__(self, app: ASGIApp, minimum_size: int = 500, level: int = 6) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.level = level

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or "gzip" not in Headers(scope=scope).get("accept-encoding", ""):
            await self.app(scope, receive, send)
            return

        start_message: Message = {}
        body = bytearray()
        compress = False

        async def send_wrapper(message: Message) -> None:
            nonlocal compress
            if message["type"] == "http.response.start":
                headers = Headers(raw=message["headers"])
                ctype = headers.get("content-type", "")
                compress = (message["status"] == 200
                            and "content-encoding" not in headers
                            and ctype.startswith(_COMPRESSIBLE_PREFIXES))
                if not compress:
                    await send(message)
                    return
                start_message.update(message)  # held until the body is buffered
                return

            if not compress:
                await send(message)
                return

            body.extend(message.get("body", b""))
            if message.get("more_body", False):
                return

            if len(body) < self.minimum_size:
                await send(start_message)
                await send({"type": "http.response.body", "body": bytes(body), "more_body": False})
                return

            # gzip is CPU-bound and would otherwise run inline on uvicorn's single
            # event loop, stalling every concurrent request for the whole compress
            # (multi-MB Arrow cell streams take seconds). zlib releases the GIL, so
            # a worker thread frees the loop for the duration.
            compressed = await anyio.to_thread.run_sync(gzip.compress, bytes(body), self.level)
            headers = MutableHeaders(raw=start_message["headers"])
            headers["content-encoding"] = "gzip"
            headers["content-length"] = str(len(compressed))
            headers["vary"] = "Accept-Encoding"
            await send(start_message)
            await send({"type": "http.response.body", "body": compressed, "more_body": False})

        await self.app(scope, receive, send_wrapper)
