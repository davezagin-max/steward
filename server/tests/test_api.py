import json

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from app import demo
from app.http import Live, RateLimiter, respond_stream
from app.main import app

client = TestClient(app)


def test_health() -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_demo_mode_replays_a_fixture_without_a_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ALLOW_SERVER_KEY", raising=False)
    res = client.post("/api/example", json={"demoId": "powder-day", "topic": "snow"})
    body = res.json()
    assert res.status_code == 200
    assert body["ok"] is True
    assert body["meta"]["mode"] == "demo"
    assert body["meta"]["placeholder"] is True
    assert len(body["data"]["lines"]) == 3


def test_demo_miss_is_explained(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ALLOW_SERVER_KEY", raising=False)
    res = client.post("/api/example", json={"topic": "something unrecorded"})
    assert res.status_code == 404
    assert res.json()["error"]["kind"] == "demo_miss"


def test_malformed_key_is_rejected_and_not_echoed() -> None:
    res = client.post(
        "/api/example", json={"topic": "x"}, headers={"x-anthropic-key": "definitely-not-a-key"}
    )
    assert res.status_code == 401
    assert res.json()["error"]["kind"] == "auth"
    assert "definitely-not-a-key" not in res.text


def test_oversized_body_is_rejected() -> None:
    res = client.post("/api/example", content=b'{"topic":"' + b"a" * 70_000 + b'"}')
    assert res.status_code == 413


def test_rate_limiter_blocks_after_the_limit() -> None:
    limiter = RateLimiter(limit=2, window_seconds=1)
    assert limiter.check("ip", now=0.0)
    assert limiter.check("ip", now=0.1)
    assert not limiter.check("ip", now=0.2)
    assert limiter.check("other", now=0.2)
    assert limiter.check("ip", now=1.5)


def test_request_key_prefers_a_safe_demo_id() -> None:
    assert demo.request_key({"demoId": "preset-1", "x": 1}) == "preset-1"
    unsafe = demo.request_key({"demoId": "../../etc/passwd"})
    assert unsafe != "../../etc/passwd" and len(unsafe) == 16
    assert demo.request_key({"a": 1, "b": 2}) == demo.request_key({"b": 2, "a": 1})


def test_stream_replays_recorded_events_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = {
        "placeholder": False,
        "recordedAt": "2026-10-11T00:00:00+00:00",
        "model": "claude-opus-5-5",
        "data": {"answer": "final"},
        "events": [{"at": 0, "event": {"step": 1}}, {"at": 5, "event": {"step": 2}}],
    }
    monkeypatch.setattr(demo, "find_fixture", lambda store, key: fixture)

    def live(*_: object) -> Live:
        raise AssertionError("the model must not be called in demo mode")

    stream_app = FastAPI()

    @stream_app.post("/stream")
    def stream() -> Response:
        return respond_stream("x", {"demoId": "p"}, None, live, replay_speed=100)

    res = TestClient(stream_app).post("/stream")
    assert res.headers["content-type"].startswith("text/event-stream")
    frames = [json.loads(c.removeprefix("data: ")) for c in res.text.split("\n\n") if c]
    assert [f["type"] for f in frames] == ["meta", "event", "event", "done"]
    assert frames[1]["event"] == {"step": 1}
    assert frames[3]["data"] == {"answer": "final"}
