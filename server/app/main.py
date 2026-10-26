"""Steward API: profile a dataset, run rules on it, and ask Claude for suggestions.

Run locally:  uv run uvicorn app.main:app --reload --port 8130

Three endpoints do the work:

- `POST /api/profile`    deterministic; a CSV in, a profile out. No key needed.
- `POST /api/rules/run`  deterministic; rules in the DSL in, pass/fail counts out. No key needed.
- `POST /api/assess`     the two Claude passes, streamed. Needs the visitor's key; without
                         one it replays the recorded run for the bundled sample.

Uploaded data is parsed into an in-memory DuckDB that lives for one request. The assess
endpoint never receives rows at all: it takes a profile (or profiles the bundled sample).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import date
from typing import Any, Literal

import anthropic
from fastapi import Depends, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, model_validator

from .assess import run_assessment
from .config import Usage
from .dataset import (
    MANIFEST_PATH,
    MAX_UPLOAD_BYTES,
    Dataset,
    DatasetError,
    load_csv,
    load_sample,
)
from .http import Live, RateLimiter, create_app, get_client, respond_stream
from .profiler import Profile, model_view, profile_dataset
from .rules import MAX_RULES_PER_RUN, RuleError, catalog_json, run_rules

# A CSV travels inside a JSON string, and JSON writes every quote, backslash, tab, and newline
# as two characters. Twice the file limit covers a file made of nothing else, plus the wrapper.
UPLOAD_BODY_BYTES = 2 * MAX_UPLOAD_BYTES + 256 * 1024
ASSESS_STORE = "assess"

app = create_app(
    "Steward API",
    body_limits={
        "/api/profile": UPLOAD_BODY_BYTES,
        "/api/rules/run": UPLOAD_BODY_BYTES,
        "/api/assess": 512 * 1024,
    },
    default_origins=("http://localhost:3130", "http://127.0.0.1:3130"),
)
data_rate_limit = RateLimiter(limit=30, window_seconds=60)
assess_rate_limit = RateLimiter(limit=6, window_seconds=60)

IsoDate = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class DataSource(BaseModel):
    """Either the bundled sample or an uploaded CSV, never both."""

    dataset: Literal["sample"] | None = None
    csv: str | None = Field(default=None, max_length=UPLOAD_BODY_BYTES)
    name: str = Field(default="upload.csv", max_length=200)
    as_of: str | None = IsoDate

    @model_validator(mode="after")
    def one_source(self) -> DataSource:
        if (self.dataset is None) == (self.csv is None):
            raise ValueError("Send either dataset: 'sample' or a csv string.")
        return self


class RunRulesBody(DataSource):
    rules: list[Any] = Field(max_length=MAX_RULES_PER_RUN)
    context_columns: list[str] = Field(default_factory=list, max_length=4)


class AssessBody(BaseModel):
    demoId: str | None = Field(default=None, max_length=64)
    dataset: Literal["sample"] | None = None
    profile: Profile | None = None

    @model_validator(mode="after")
    def one_source(self) -> AssessBody:
        if (self.dataset is None) == (self.profile is None):
            raise ValueError("Send either dataset: 'sample' or a profile.")
        return self


def sample_as_of() -> date:
    return date.fromisoformat(json.loads(MANIFEST_PATH.read_text())["as_of"])


def _as_of(source: DataSource) -> date:
    if source.as_of:
        try:
            return date.fromisoformat(source.as_of)
        except ValueError as error:
            raise HTTPException(status_code=400, detail="as_of is not a real date.") from error
    return sample_as_of() if source.dataset == "sample" else date.today()


def _with_dataset(source: DataSource, work: Callable[[Dataset], Any]) -> Any:
    """Load the request's data into a private DuckDB, run `work`, and always close it."""
    try:
        if source.dataset == "sample":
            dataset = load_sample()
        else:
            dataset = load_csv((source.csv or "").encode("utf-8"), source.name)
    except DatasetError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    try:
        return work(dataset)
    finally:
        dataset.close()


def _ok(data: Any) -> JSONResponse:
    """The kit envelope for a deterministic result: no model was called."""
    meta = {
        "mode": "live",
        "placeholder": False,
        "recordedAt": None,
        "model": "none",
        "usage": Usage().as_dict(),
        "costUsd": 0,
    }
    return JSONResponse({"ok": True, "data": data, "meta": meta})


def key_columns(profile: Profile) -> list[str]:
    """Columns shown beside failing rows so a reviewer can tell which record it is."""
    singles = [key.columns[0] for key in profile.candidate_keys if len(key.columns) == 1]
    plain = [
        name for name in singles if not next(c for c in profile.columns if c.name == name).sensitive
    ]
    return plain[:1]


@app.get("/api/catalog")
def catalog() -> JSONResponse:
    return _ok({"catalog": catalog_json()})


@app.post("/api/profile", dependencies=[Depends(data_rate_limit)])
def profile(body: DataSource) -> JSONResponse:
    as_of = _as_of(body)

    def work(dataset: Dataset) -> dict[str, Any]:
        result = profile_dataset(dataset, as_of)
        return {
            "profile": result.model_dump(),
            "model_view": model_view(result),
            "key_columns": key_columns(result),
        }

    return _ok(_with_dataset(body, work))


@app.post("/api/rules/run", dependencies=[Depends(data_rate_limit)])
def rules_run(body: RunRulesBody) -> JSONResponse:
    as_of = _as_of(body)

    def work(dataset: Dataset) -> dict[str, Any]:
        try:
            results = run_rules(
                dataset, body.rules, as_of=as_of, context_columns=body.context_columns
            )
        except RuleError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"as_of": as_of.isoformat(), "results": [r.model_dump() for r in results]}

    return _ok(_with_dataset(body, work))


@app.post("/api/assess", dependencies=[Depends(assess_rate_limit)])
def assess(body: AssessBody, client: anthropic.Anthropic | None = Depends(get_client)) -> Response:
    def live(client: anthropic.Anthropic, emit: Callable[[Any], bool]) -> Live:
        if body.profile is not None:
            target = body.profile
        else:
            dataset = load_sample()
            try:
                target = profile_dataset(dataset, sample_as_of())
            finally:
                dataset.close()
        outcome = run_assessment(client, target, emit=emit)
        return Live(
            data=outcome.run.model_dump(),
            model=outcome.model,
            usage=outcome.usage,
            cost_usd=outcome.cost_usd,
            refusal=outcome.refusal,
        )

    # The fixture key is the demoId when there is one, otherwise a hash of the request.
    key_body = body.model_dump(exclude_none=True)
    return respond_stream(ASSESS_STORE, key_body, client, live, replay_speed=6)
