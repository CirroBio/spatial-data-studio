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


def _accepts_gzip(accept_encoding: str) -> bool:
    """Whether the client's `Accept-Encoding` actually permits gzip.

    A substring test cannot tell `gzip` from `gzip;q=0`, which is a client *refusing*
    the coding (RFC 9110 12.5.3) — and the difference is a body it can decode versus
    one it cannot. Handled here: the comma-separated coding list, case folding, a
    per-coding `q=` (q<=0 is a refusal, an explicit `gzip` entry outranks `*`), and
    `*` standing in for a list that never names gzip. Deliberately not handled:
    ranking codings by q (gzip is the only coding this middleware offers, so relative
    preference cannot change the outcome) and the `x-gzip` alias, which no client of
    this app sends.
    """
    wildcard = False
    for part in accept_encoding.split(","):
        coding, _, params = part.partition(";")
        coding = coding.strip().lower()
        if coding not in ("gzip", "*"):
            continue
        q = 1.0
        for param in params.split(";"):
            name, _, value = param.partition("=")
            if name.strip().lower() == "q":
                try:
                    q = float(value.strip())
                except ValueError:
                    q = 0.0  # an unreadable q is not permission
                break
        if coding == "gzip":
            return q > 0
        wildcard = q > 0
    return wildcard


class SelectiveGZipMiddleware:
    def __init__(self, app: ASGIApp, minimum_size: int = 500, level: int = 6) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.level = level

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _accepts_gzip(Headers(scope=scope).get("accept-encoding", "")):
            await self.app(scope, receive, send)
            return

        start_message: Message = {}
        chunks: list[bytes] = []
        compress = False

        async def send_wrapper(message: Message) -> None:
            nonlocal compress
            if message["type"] == "http.response.start":
                headers = MutableHeaders(raw=message["headers"])
                ctype = headers.get("content-type", "")
                compressible = ctype.startswith(_COMPRESSIBLE_PREFIXES)
                if compressible:
                    # These types have two representations on the wire, so a shared
                    # cache must key them apart whichever way *this* response goes: an
                    # identity body sent without the header (too small to compress, a
                    # non-200, an already-encoded body) can otherwise be stored under
                    # the same key as the gzipped variant and handed to a client that
                    # asked for the other one. Types this middleware never compresses
                    # stay Vary-free so tile caching is not fragmented for nothing.
                    headers.add_vary_header("Accept-Encoding")
                compress = (message["status"] == 200
                            and "content-encoding" not in headers
                            and compressible)
                if not compress:
                    await send(message)
                    return
                start_message.update(message)  # held until the body is buffered
                return

            if not compress:
                await send(message)
                return

            chunks.append(message.get("body", b""))
            if message.get("more_body", False):
                return

            # Every compressible route returns a whole Response, so the body arrives as
            # one message: hold the app's own bytes instead of accumulating a second
            # copy of a payload that reaches the ~80 MB `_MAX_SPARSE_EDGES` cap.
            body = chunks[0] if len(chunks) == 1 else b"".join(chunks)
            if len(body) < self.minimum_size:
                await send(start_message)
                await send({"type": "http.response.body", "body": body, "more_body": False})
                return

            # gzip is CPU-bound and would otherwise run inline on uvicorn's single
            # event loop, stalling every concurrent request for the whole compress
            # (multi-MB Arrow cell streams take seconds). zlib releases the GIL, so
            # a worker thread frees the loop for the duration.
            compressed = await anyio.to_thread.run_sync(gzip.compress, body, self.level)
            headers = MutableHeaders(raw=start_message["headers"])
            headers["content-encoding"] = "gzip"
            headers["content-length"] = str(len(compressed))
            await send(start_message)
            await send({"type": "http.response.body", "body": compressed, "more_body": False})

        await self.app(scope, receive, send_wrapper)
