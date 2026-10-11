"""FastAPI helpers that give every endpoint the same behavior as the TypeScript kit:
bring-your-own-key, demo replay, fixture recording, rate limiting, a body size cap,
and safe error mapping. Responses use the same JSON envelope and SSE frames, so the
Next.js frontend talks to this API with the kit's `callApi` / `streamApi` helpers.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

import anthropic
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import demo
from .claude_client import CallResult, MissingKeyError, api_error, client_for_key
from .config import Usage

MISS_MESSAGE = (
    "Demo mode only replays recorded runs. Pick one of the presets, "
    "or add your Anthropic key to run this live."
)


@dataclass
class Live:
    """What a live handler returns: data plus what it cost, or a refusal."""

    data: Any = None
    model: str = "none"
    usage: Usage = field(default_factory=Usage)
    cost_usd: float = 0.0
    refusal: dict[str, str | None] | None = None

    @classmethod
    def of(cls, result: CallResult, data: Any = None) -> Live:
        """Carry a `call_claude` result's model, usage, cost, and any refusal."""
        return cls(
            data=data,
            model=result.model,
            usage=result.usage,
            cost_usd=result.cost_usd,
            refusal=result.refusal,
        )


def get_client(x_anthropic_key: str | None = Header(default=None)) -> anthropic.Anthropic | None:
    """FastAPI dependency: a client built from the per-request key header, or None for demo mode.

    A server-side ANTHROPIC_API_KEY is used only when ALLOW_SERVER_KEY=1 (local development
    and fixture recording). A public deploy leaves it unset so visitors can never spend the
    owner's credits. The key is never stored or logged.
    """
    key = x_anthropic_key or (
        os.environ.get("ANTHROPIC_API_KEY") if os.environ.get("ALLOW_SERVER_KEY") == "1" else None
    )
    try:
        return client_for_key(key)
    except MissingKeyError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error


class RateLimiter:
    """Fixed-window, per-IP limiter held in memory (per process; see README tradeoffs)."""

    def __init__(self, limit: int = 20, window_seconds: float = 60.0, max_keys: int = 10_000):
        self.limit = limit
        self.window = window_seconds
        self.max_keys = max_keys
        self._windows: dict[str, tuple[int, float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            count, reset_at = self._windows.get(key, (0, 0.0))
            if now >= reset_at:
                if len(self._windows) >= self.max_keys:
                    self._windows = {k: v for k, v in self._windows.items() if now < v[1]}
                self._windows[key] = (1, now + self.window)
                return True
            if count >= self.limit:
                return False
            self._windows[key] = (count + 1, reset_at)
            return True

    def __call__(self, request: Request) -> None:
        """FastAPI dependency form."""
        if demo.recording_enabled():
            return
        forwarded = request.headers.get("x-forwarded-for", "")
        ip = forwarded.split(",")[0].strip() or (request.client.host if request.client else "local")
        if not self.check(ip):
            raise HTTPException(status_code=429, detail="Too many requests. Wait a moment.")


class BodyLimit:
    """ASGI middleware that caps the request body, per path.

    A declared Content-Length over the limit is refused before anything is read. A body
    sent in chunks is counted as it arrives and cut off at the limit, so an oversized
    upload is never held in memory, whatever the client claims about its size.
    """

    def __init__(self, app: ASGIApp, *, default: int, limits: dict[str, int]):
        self.app = app
        self.default = default
        self.limits = limits

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.limits.get(scope["path"], self.default)
        too_large = _fail(413, "too_large", "Request body is too large.")
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > limit:
            await too_large(scope, receive, send)
            return

        received = 0
        over = False

        async def counted_receive() -> Message:
            nonlocal received, over
            message = await receive()
            if message["type"] == "http.request" and not over:
                received += len(message.get("body", b""))
                if received > limit:
                    # End the body here. The app sees a truncated request; whatever it
                    # answers is replaced by the 413 below.
                    over = True
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        async def guarded_send(message: Message) -> None:
            if not over:
                await send(message)

        try:
            await self.app(scope, counted_receive, guarded_send)
        except Exception:
            if not over:
                raise  # only an error caused by our own truncation is ours to swallow
        if over:
            await too_large(scope, receive, send)


def create_app(
    title: str,
    *,
    max_body_bytes: int = 64 * 1024,
    body_limits: dict[str, int] | None = None,
    default_origins: tuple[str, ...] = ("http://localhost:3000",),
) -> FastAPI:
    """A FastAPI app with CORS for the frontend, a body size cap, and the kit's error envelope.

    `body_limits` raises (or lowers) the cap for individual paths, so one upload endpoint
    does not force every other endpoint to accept large bodies.
    """
    app = FastAPI(title=title)
    origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
    # Added first so CORS wraps it: a 413 from the size cap still carries CORS headers,
    # and the browser can show the message instead of a bare network error.
    app.add_middleware(BodyLimit, default=max_body_bytes, limits=body_limits or {})
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins or list(default_origins),
        allow_methods=["GET", "POST"],
        allow_headers=["content-type", "x-anthropic-key"],
    )

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException) -> JSONResponse:
        kind = {401: "auth", 403: "auth", 404: "invalid", 413: "too_large", 429: "rate_limit"}.get(
            error.status_code, "invalid" if error.status_code < 500 else "server"
        )
        return _fail(error.status_code, kind, str(error.detail))

    @app.exception_handler(RequestValidationError)
    async def invalid_body(_: Request, __: RequestValidationError) -> JSONResponse:
        # Same envelope as every other error, and no echo of what was sent.
        return _fail(400, "invalid", "Request body has an invalid shape.")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


def _fail(status: int, kind: str, message: str, meta: dict[str, Any] | None = None) -> JSONResponse:
    body: dict[str, Any] = {"ok": False, "error": {"kind": kind, "message": message}}
    if meta:
        body["meta"] = meta
    return JSONResponse(body, status_code=status)


def _live_meta(result: Live) -> dict[str, Any]:
    return {
        "mode": "live",
        "placeholder": False,
        "recordedAt": None,
        "model": result.model,
        "usage": result.usage.as_dict(),
        "costUsd": result.cost_usd,
    }


def _demo_meta(fixture: dict[str, Any]) -> dict[str, Any]:
    return {
        "mode": "demo",
        "placeholder": fixture.get("placeholder", False),
        "recordedAt": fixture.get("recordedAt"),
        "model": fixture.get("model"),
        "usage": fixture.get("usage", Usage().as_dict()),
        "costUsd": fixture.get("costUsd", 0),
    }


def _refusal_message(refusal: dict[str, str | None]) -> str:
    category = refusal.get("category")
    if category:
        return f"Claude declined this request (safety category: {category}). Try rephrasing it."
    return "Claude declined this request. Try rephrasing it."


def _error_kind(status: int) -> str:
    return {401: "auth", 403: "auth", 429: "rate_limit", 400: "invalid"}.get(status, "server")


def _record(store: str, key: str, body: dict[str, Any], result: Live, events: list | None) -> None:
    if not demo.recording_enabled():
        return
    fixture: dict[str, Any] = {
        "label": body.get("demoId") or "recorded request",
        "placeholder": False,
        "recordedAt": demo.now_iso(),
        "model": result.model,
        "usage": result.usage.as_dict(),
        "costUsd": result.cost_usd,
        "data": result.data,
    }
    if events is not None:
        fixture["events"] = events
    demo.save_fixture(store, key, fixture)


def respond_json(
    store: str,
    body: dict[str, Any],
    client: anthropic.Anthropic | None,
    live: Callable[[anthropic.Anthropic], Live],
) -> JSONResponse:
    """Replay a fixture when there is no key; otherwise run `live` and wrap its result."""
    key = demo.request_key(body)
    if client is None:
        fixture = demo.find_fixture(store, key)
        if fixture is None:
            return _fail(404, "demo_miss", MISS_MESSAGE)
        return JSONResponse({"ok": True, "data": fixture["data"], "meta": _demo_meta(fixture)})
    try:
        result = live(client)
    except Exception as error:
        status, message = api_error(error)
        return _fail(status, _error_kind(status), message)
    if result.refusal is not None:
        return _fail(422, "refusal", _refusal_message(result.refusal), _live_meta(result))
    _record(store, key, body, result, None)
    return JSONResponse({"ok": True, "data": result.data, "meta": _live_meta(result)})


def respond_stream(
    store: str,
    body: dict[str, Any],
    client: anthropic.Anthropic | None,
    live: Callable[[anthropic.Anthropic, Callable[[Any], bool]], Live],
    *,
    replay_speed: float = 4.0,
) -> StreamingResponse | JSONResponse:
    """Server-sent events: `meta`, then `event` frames as work progresses, then `done` or `error`.

    `live` gets an `emit` function that returns False once the response is no longer being
    read (the visitor cancelled or disconnected), so long-running work can stop early.
    """
    key = demo.request_key(body)
    fixture = None if client else demo.find_fixture(store, key)
    if client is None and fixture is None:
        return _fail(404, "demo_miss", MISS_MESSAGE)

    def frame(payload: dict[str, Any]) -> str:
        return f"data: {json.dumps(payload, default=str)}\n\n"

    def replay(fixture: dict[str, Any]) -> Iterator[str]:
        yield frame(
            {
                "type": "meta",
                "meta": {k: _demo_meta(fixture)[k] for k in ("mode", "placeholder", "recordedAt")},
            }
        )
        clock = 0.0
        for item in fixture.get("events", []):
            time.sleep(min(max(item["at"] - clock, 0) / 1000 / replay_speed, 1.5))
            clock = item["at"]
            yield frame({"type": "event", "event": item["event"]})
        yield frame({"type": "done", "data": fixture["data"], "meta": _demo_meta(fixture)})

    def run_live(client: anthropic.Anthropic) -> Iterator[str]:
        yield frame(
            {"type": "meta", "meta": {"mode": "live", "placeholder": False, "recordedAt": None}}
        )
        frames: queue.Queue[dict[str, Any] | None] = queue.Queue()
        events: list[dict[str, Any]] = []
        started = time.monotonic()
        gone = threading.Event()  # set when this generator is closed: nobody is reading

        def emit(event: Any) -> bool:
            if gone.is_set():
                return False
            events.append({"at": int((time.monotonic() - started) * 1000), "event": event})
            frames.put({"type": "event", "event": event})
            return True

        def work() -> None:
            try:
                result = live(client, emit)
                if gone.is_set():
                    return  # a partial run: nothing to send and nothing worth recording
                if result.refusal is not None:
                    frames.put(
                        {
                            "type": "error",
                            "error": {
                                "kind": "refusal",
                                "message": _refusal_message(result.refusal),
                            },
                            "meta": _live_meta(result),
                        }
                    )
                else:
                    _record(store, key, body, result, events)
                    frames.put({"type": "done", "data": result.data, "meta": _live_meta(result)})
            except Exception as error:
                status, message = api_error(error)
                frames.put(
                    {"type": "error", "error": {"kind": _error_kind(status), "message": message}}
                )
            finally:
                frames.put(None)

        threading.Thread(target=work, daemon=True).start()
        try:
            while (item := frames.get()) is not None:
                yield frame(item)
        finally:
            gone.set()

    stream = replay(fixture) if fixture is not None else run_live(client)  # type: ignore[arg-type]
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={"cache-control": "no-cache, no-transform", "x-accel-buffering": "no"},
    )
