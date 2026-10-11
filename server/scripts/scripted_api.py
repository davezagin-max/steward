"""The real Steward API with the Anthropic client swapped for a scripted stand-in.

    uv run uvicorn scripts.scripted_api:app --port 8130

Development only. It lets the browser's live path (upload, streamed assessment, rule
runs) be exercised end to end without an API key: any `x-anthropic-key` header selects
the scripted client, which never makes a network call. `pnpm e2e:live` uses it.
Never deploy this module; the deployed app is `app.main:app`.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import Header

from app.assess import COLUMN_TOOL, RELATIONSHIP_TOOL
from app.http import get_client
from app.main import app
from tests.test_assess import CALLS, ScriptedClient, reply, requested_column, tool_use


def _respond(params: dict[str, Any], index: int) -> Any:
    """Sample columns get the hand-written suggestions; any other column gets a stub."""
    time.sleep(0.1)  # long enough for the progress bar to be visible
    column = requested_column(params)
    if column is None:
        if '"name":"loan_id"' in params["system"][0]["text"]:
            return None
        empty = tool_use(RELATIONSHIP_TOOL, {"relationships": []})
        return reply([empty], "tool_use", cached=True)
    if column in CALLS:
        return None
    payload = {
        "column": column,
        "business_definition": f"Scripted definition for {column}.",
        "sensitivity": "Confidential" if "email" in column else "Internal",
        "confidence": "high",
        "rationale": "Scripted rationale; no model was called.",
        "rules": [
            {
                "rule": {"type": "not_null", "column": column},
                "severity": "error",
                "reason": "Scripted.",
            },
            {
                "rule": {"type": "not_null", "column": "no_such_column"},
                "severity": "error",
                "reason": "Shows the validator rejecting a rule.",
            },
        ],
    }
    return reply([tool_use(COLUMN_TOOL, payload)], "tool_use", cached=index > 0)


_scripted = ScriptedClient(_respond)


def _client(x_anthropic_key: str | None = Header(default=None)) -> Any:
    return _scripted if x_anthropic_key else None


app.dependency_overrides[get_client] = _client
