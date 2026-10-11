"""HTTP tests: the demo path with no key, the deterministic endpoints, and the live path
with a scripted client."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from app import demo
from app.dataset import MAX_ROWS
from app.http import Live, RateLimiter, get_client, respond_stream
from app.main import app, assess_rate_limit, data_rate_limit
from tests.test_assess import ScriptedClient

client = TestClient(app)


@pytest.fixture(autouse=True)
def fresh_limits(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv("ALLOW_SERVER_KEY", raising=False)
    monkeypatch.delenv("RECORD_FIXTURES", raising=False)
    data_rate_limit._windows.clear()
    assess_rate_limit._windows.clear()
    yield
    app.dependency_overrides.clear()


def frames(text: str) -> list[dict[str, Any]]:
    return [json.loads(chunk.removeprefix("data: ")) for chunk in text.split("\n\n") if chunk]


def test_health() -> None:
    assert client.get("/health").json() == {"status": "ok"}


# ----------------------------------------------------------------- demo mode (the smoke test)


def test_demo_mode_replays_the_sample_run_without_a_key() -> None:
    res = client.post("/api/assess", json={"demoId": "sample-loans", "dataset": "sample"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    stream = frames(res.text)
    fixture = demo.find_fixture("assess", "sample-loans")
    assert fixture is not None
    assert stream[0]["type"] == "meta" and stream[0]["meta"]["mode"] == "demo"
    # Hand-written sample output is never passed off as a recorded run.
    assert stream[0]["meta"]["placeholder"] is fixture["placeholder"]
    events = [f["event"] for f in stream if f["type"] == "event"]
    columns = [e for e in events if e["type"] == "column"]
    assert len(columns) == 25 and columns[0]["assessment"]["column"] == "loan_id"
    done = stream[-1]
    assert done["type"] == "done" and done["meta"]["mode"] == "demo"
    assert [a["column"] for a in done["data"]["assessments"]][:2] == ["loan_id", "servicer_id"]
    assert len(done["data"]["assessments"]) == 25 and done["data"]["relationships"]
    ssn = next(a for a in done["data"]["assessments"] if a["column"] == "borrower_ssn")
    assert ssn["sensitivity"] in ("Confidential", "Restricted") and ssn["rules"]


def test_demo_miss_is_explained() -> None:
    res = client.post("/api/assess", json={"dataset": "sample"})
    assert res.status_code == 404
    assert res.json()["error"]["kind"] == "demo_miss"


def test_malformed_key_is_rejected_and_not_echoed() -> None:
    res = client.post(
        "/api/assess",
        json={"demoId": "sample-loans", "dataset": "sample"},
        headers={"x-anthropic-key": "definitely-not-a-key"},
    )
    assert res.status_code == 401
    assert res.json()["error"]["kind"] == "auth"
    assert "definitely-not-a-key" not in res.text


# ----------------------------------------------------------------- deterministic endpoints


def test_profile_of_the_sample_needs_no_key() -> None:
    res = client.post("/api/profile", json={"dataset": "sample"})
    body = res.json()
    assert res.status_code == 200 and body["ok"] is True
    assert body["meta"]["model"] == "none" and body["meta"]["costUsd"] == 0
    data = body["data"]
    assert data["profile"]["row_count"] == 5014 and data["profile"]["as_of"] == "2025-09-30"
    assert data["key_columns"] == ["loan_id"]
    masked = {c["name"] for c in data["model_view"]["columns"] if c["values_masked"]}
    assert "borrower_ssn" in masked and "occupancy_code" not in masked


def test_profile_of_an_upload_sanitizes_headers_and_ignores_the_file_name() -> None:
    csv_text = 'Order ID,"Total; DROP TABLE dataset",When\n1,10.5,2024-01-02\n2,20.0,2024-01-03\n'
    res = client.post(
        "/api/profile",
        json={"csv": csv_text, "name": "../../secrets/orders.csv", "as_of": "2024-06-30"},
    )
    profile = res.json()["data"]["profile"]
    assert profile["dataset"] == "orders.csv"
    assert [c["name"] for c in profile["columns"]] == [
        "order_id",
        "total_drop_table_dataset",
        "when",
    ]
    assert [c["inferred_type"] for c in profile["columns"]] == ["integer", "decimal", "date"]
    assert profile["columns"][1]["source_name"] == "Total; DROP TABLE dataset"


def test_bad_uploads_get_a_clear_error_in_the_standard_envelope() -> None:
    too_many = "n\n" + "1\n" * (MAX_ROWS + 1)
    res = client.post("/api/profile", json={"csv": too_many})
    assert res.status_code == 400
    assert res.json() == {
        "ok": False,
        "error": {"kind": "invalid", "message": "The file has 50,001 rows; the limit is 50,000."},
    }
    assert client.post("/api/profile", json={"csv": "a,b\n"}).json()["error"]["message"] == (
        "The file has a header but no data rows."
    )
    for body in ({}, {"dataset": "sample", "csv": "a\n1\n"}, {"dataset": "other"}, {"csv": 5}):
        res = client.post("/api/profile", json=body)
        assert res.status_code == 400
        assert res.json()["error"] == {"kind": "invalid", "message": "Request body has an invalid shape."}  # fmt: skip
    assert client.post("/api/profile", json={"dataset": "sample", "as_of": "2025-02-30"}).status_code == 400  # fmt: skip


def test_body_limits_are_per_path() -> None:
    big = "a\n" + "x" * 80_000 + "\n"
    assert client.post("/api/profile", json={"csv": big}).status_code == 200
    assert client.post("/api/assess", content=b'{"x":"' + b"a" * 600_000 + b'"}').status_code == 413
    assert client.post("/api/profile", content=b'{"csv":"' + b"a" * 8_000_000 + b'"}').status_code == 413  # fmt: skip


def test_rules_run_on_the_sample_including_an_edited_and_an_invalid_rule() -> None:
    res = client.post(
        "/api/rules/run",
        json={
            "dataset": "sample",
            "context_columns": ["loan_id", "not_a_column"],
            "rules": [
                {"type": "range", "column": "fico_score", "min": 300, "max": 850},
                {"type": "range", "column": "fico_score", "min": 620, "max": 850},
                {"type": "not_null", "column": "nope"},
                {"type": "date_not_future", "column": "origination_date"},
            ],
        },
    )
    data = res.json()["data"]
    assert data["as_of"] == "2025-09-30"
    first, edited, invalid, future = data["results"]
    assert (first["status"], first["evaluated"], first["failed"]) == ("fail", 4864, 9)
    assert edited["failed"] > first["failed"] and edited["rule_id"] != first["rule_id"]
    assert first["sample_columns"] == ["loan_id", "fico_score"]
    assert (invalid["status"], invalid["error"]) == ("error", "Unknown column 'nope' in 'column'.")
    assert future["failed"] == 6
    later = client.post(
        "/api/rules/run",
        json={"dataset": "sample", "as_of": "2040-01-01", "rules": [future["rule"]]},
    )
    assert later.json()["data"]["results"][0]["failed"] == 0


def test_a_rule_with_a_non_finite_number_is_an_error_result_not_a_500() -> None:
    body = '{"dataset": "sample", "rules": [{"type": "range", "column": "fico_score", "min": Infinity, "max": null}]}'  # fmt: skip
    res = client.post("/api/rules/run", content=body, headers={"content-type": "application/json"})
    assert res.status_code == 200
    (result,) = res.json()["data"]["results"]
    assert (result["status"], result["error"]) == ("error", "'min' must be a finite number.")
    assert result["rule"]["min"] == "inf"


def test_rules_run_on_an_uploaded_csv() -> None:
    res = client.post(
        "/api/rules/run",
        json={
            "csv": "id,state\n1,UT\n2,ut\n2,CA\n",
            "rules": [
                {"type": "unique", "columns": ["id"]},
                {"type": "in_set", "column": "state", "values": ["UT", "CA"]},
            ],
        },
    )
    unique, in_set = res.json()["data"]["results"]
    assert (unique["failed"], in_set["failed"]) == (2, 1)
    assert in_set["samples"] == [{"row": 2, "values": {"state": "ut"}}]
    too_many = [{"type": "not_null", "column": "id"}] * 301
    assert client.post("/api/rules/run", json={"csv": "id\n1\n", "rules": too_many}).status_code == 400  # fmt: skip


def test_catalog_lists_every_rule_type() -> None:
    types = [t["type"] for t in client.get("/api/catalog").json()["data"]["catalog"]]
    assert len(types) == 11 and types[0] == "not_null" and "derived_ratio" in types


# ----------------------------------------------------------------- live path, scripted client


def test_live_assess_streams_columns_and_reports_usage() -> None:
    scripted = ScriptedClient()
    app.dependency_overrides[get_client] = lambda: scripted
    res = client.post("/api/assess", json={"dataset": "sample"})
    stream = frames(res.text)
    assert stream[0]["meta"]["mode"] == "live"
    assert [f["type"] for f in stream].count("event") == 29
    done = stream[-1]
    assert done["type"] == "done"
    assert done["meta"]["mode"] == "live" and done["meta"]["model"] == "claude-opus-5-5"
    assert done["meta"]["usage"]["cache_read_input_tokens"] == 9000 * 25
    assert done["meta"]["costUsd"] > 0
    assert len(done["data"]["assessments"]) == 25 and done["data"]["failures"] == []
    assert len(scripted.requests) == 26


def test_live_assess_accepts_a_client_profile_and_never_needs_rows() -> None:
    profile = client.post("/api/profile", json={"csv": "id,state\n1,UT\n2,CA\n3,UT\n"}).json()["data"]["profile"]  # fmt: skip

    def responder(params: dict[str, Any], index: int) -> Any:
        from app.assess import COLUMN_TOOL, RELATIONSHIP_TOOL
        from tests.test_assess import reply, requested_column, tool_use

        column = requested_column(params)
        if column is None:
            return reply([tool_use(RELATIONSHIP_TOOL, {"relationships": []})], "tool_use", cached=True)  # fmt: skip
        payload = {
            "column": column,
            "business_definition": f"The {column}.",
            "sensitivity": "Internal",
            "confidence": "medium",
            "rationale": "From the profile.",
            "rules": [{"rule": {"type": "not_null", "column": column}, "severity": "error", "reason": "No nulls."}],
        }  # fmt: skip
        return reply([tool_use(COLUMN_TOOL, payload)], "tool_use", cached=index > 0)

    scripted = ScriptedClient(responder)
    app.dependency_overrides[get_client] = lambda: scripted
    res = client.post("/api/assess", json={"profile": profile})
    done = frames(res.text)[-1]
    assert [a["column"] for a in done["data"]["assessments"]] == ["id", "state"]
    assert done["data"]["assessments"][0]["rules"][0]["rule"] == {
        "type": "not_null",
        "column": "id",
    }
    # A doctored profile is rejected before any model call.
    profile["columns"][0]["name"] = "id; DROP TABLE x"
    assert client.post("/api/assess", json={"profile": profile}).status_code == 400


def test_a_refused_run_is_reported_as_a_refusal() -> None:
    from tests.fakes import block
    from tests.test_assess import reply

    details = block("refusal", category="policy", explanation="declined")
    scripted = ScriptedClient(lambda params, index: reply([], "refusal", cached=False, stop_details=details))  # fmt: skip
    app.dependency_overrides[get_client] = lambda: scripted
    last = frames(client.post("/api/assess", json={"dataset": "sample"}).text)[-1]
    assert last["type"] == "error" and last["error"]["kind"] == "refusal"
    assert "policy" in last["error"]["message"]


def test_recording_a_live_run_writes_a_fixture_the_export_can_use(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """What `pnpm record` does, with a scripted client standing in for the API."""
    from app.assess import AssessmentRun, all_rules

    monkeypatch.setenv("RECORD_FIXTURES", "1")
    monkeypatch.setattr(demo, "FIXTURE_DIR", tmp_path)
    app.dependency_overrides[get_client] = lambda: ScriptedClient()
    try:
        res = client.post("/api/assess", json={"demoId": "sample-loans", "dataset": "sample"})
        assert frames(res.text)[-1]["type"] == "done"
        recorded = json.loads((tmp_path / "assess.json").read_text())["sample-loans"]
    finally:
        demo.load_store.cache_clear()
    assert recorded["placeholder"] is False and recorded["recordedAt"]
    assert recorded["model"] == "claude-opus-5-5" and recorded["costUsd"] > 0
    assert recorded["usage"]["cache_read_input_tokens"] == 9000 * 25
    run = AssessmentRun.model_validate(recorded["data"])
    assert len(run.assessments) == 25 and len(all_rules(run)) == 57
    kinds = [item["event"]["type"] for item in recorded["events"]]
    assert kinds.count("column") == 25 and kinds[-1] == "pass"


# ----------------------------------------------------------------- kit behavior


def test_rate_limiter_blocks_after_the_limit() -> None:
    limiter = RateLimiter(limit=2, window_seconds=1)
    assert limiter.check("ip", now=0.0)
    assert limiter.check("ip", now=0.1)
    assert not limiter.check("ip", now=0.2)
    assert limiter.check("other", now=0.2)
    assert limiter.check("ip", now=1.5)


def test_assess_is_rate_limited_per_address() -> None:
    body = {"demoId": "sample-loans", "dataset": "sample"}
    codes = [client.post("/api/assess", json=body).status_code for _ in range(7)]
    assert codes == [200] * 6 + [429]


def test_request_key_prefers_a_safe_demo_id() -> None:
    assert demo.request_key({"demoId": "preset-1", "x": 1}) == "preset-1"
    unsafe = demo.request_key({"demoId": "../../etc/passwd"})
    assert unsafe != "../../etc/passwd" and len(unsafe) == 16
    assert demo.request_key({"a": 1, "b": 2}) == demo.request_key({"b": 2, "a": 1})


def test_a_chunked_body_over_the_limit_is_cut_off_and_answered_with_a_cors_visible_413() -> None:
    sent = 0

    def chunks() -> Iterator[bytes]:
        # No Content-Length: the size is only known as the bytes arrive.
        nonlocal sent
        yield b'{"csv":"'
        for _ in range(4000):
            sent += 1
            yield b"a" * 4096
        yield b'"}'

    res = client.post(
        "/api/profile",
        content=chunks(),
        headers={"content-type": "application/json", "origin": "http://localhost:3130"},
    )
    assert res.status_code == 413
    assert res.json() == {"ok": False, "error": {"kind": "too_large", "message": "Request body is too large."}}  # fmt: skip
    assert res.headers["access-control-allow-origin"] == "http://localhost:3130"
    assert sent == 4000  # the test client sends it all; the server stopped keeping it
    # A small endpoint keeps its small cap, and a normal upload still works.
    assert client.post("/api/assess", content=b"x" * 600_000).status_code == 413
    assert client.post("/api/profile", json={"csv": "id\n1\n2\n"}).status_code == 200


def test_closing_the_stream_tells_the_live_work_to_stop_and_records_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    import asyncio
    import time

    monkeypatch.setenv("RECORD_FIXTURES", "1")
    monkeypatch.setattr(demo, "FIXTURE_DIR", tmp_path)
    answers: list[bool] = []

    def live(_: Any, emit: Any) -> Live:
        for step in range(500):
            answers.append(emit({"step": step}))
            if not answers[-1]:
                break
            time.sleep(0.005)
        return Live(data={"steps": len(answers)})

    response = respond_stream("x", {"demoId": "p"}, object(), live)  # type: ignore[arg-type]

    async def read_two_frames_then_leave(body: Any) -> list[str]:
        got = [await body.__anext__(), await body.__anext__()]
        await body.aclose()
        return got

    read = asyncio.run(read_two_frames_then_leave(response.body_iterator))  # type: ignore[union-attr]
    meta, first = frames("".join(read))
    assert meta["type"] == "meta" and first["event"] == {"step": 0}
    deadline = time.monotonic() + 5
    while (not answers or answers[-1]) and time.monotonic() < deadline:
        time.sleep(0.01)
    assert answers[-1] is False and len(answers) < 500
    time.sleep(0.05)
    assert not (tmp_path / "x.json").exists()
    demo.load_store.cache_clear()


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
    replayed = frames(res.text)
    assert [f["type"] for f in replayed] == ["meta", "event", "event", "done"]
    assert replayed[1]["event"] == {"step": 1}
    assert replayed[3]["data"] == {"answer": "final"}
