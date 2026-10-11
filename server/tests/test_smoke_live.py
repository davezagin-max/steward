"""Live smoke test. Skipped unless ANTHROPIC_API_KEY is set. Costs well under one cent.

Proves the client follows the Claude Opus 5.5 API rules against the real API.
"""

import os

import anthropic
import pytest
from pydantic import BaseModel

from app.claude_client import call_claude, strict_tool, with_system_note
from app.config import HAIKU, OPUS

pytestmark = pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="no API key")


class Capital(BaseModel):
    capital: str
    country: str


def test_structured_output_and_tool_loop() -> None:
    client = anthropic.Anthropic(max_retries=4)
    first = call_claude(
        client,
        model=OPUS,
        effort="low",
        schema=Capital,
        max_tokens=2000,
        messages=[{"role": "user", "content": "What is the capital of the USA?"}],
    )
    assert first.ok and first.parsed is not None
    assert "washington" in first.parsed.capital.lower()

    system = "Use the get_snow_depth tool whenever a question needs a snow depth. Never guess one."
    tools = [
        strict_tool(
            "get_snow_depth",
            "Look up the current snow depth in inches at a ski resort.",
            {"resort": {"type": "string", "description": "Resort name"}},
        )
    ]
    handlers = {"get_snow_depth": lambda _: {"inches": 87}}
    loop = call_claude(
        client,
        effort="low",
        system=system,
        tools=tools,
        handlers=handlers,
        max_tokens=4000,
        messages=[{"role": "user", "content": "How deep is the snow at Alta right now?"}],
    )
    assert loop.ok and "87" in loop.text
    assert [c.name for c in loop.tool_calls] == ["get_snow_depth"]

    # Continue the same append-only history; a rejected thinking block would 400 here.
    follow_up = with_system_note(
        [*loop.messages, {"role": "user", "content": "Is that more than 60 inches? One word."}],
        "From now on, answer in French.",
    )
    second = call_claude(
        client,
        effort="low",
        system=system,
        tools=tools,
        handlers=handlers,
        max_tokens=4000,
        messages=follow_up,
    )
    assert second.ok and "oui" in second.text.lower()

    cheap = call_claude(
        client,
        model=HAIKU,
        effort="low",
        max_tokens=1000,
        messages=[{"role": "user", "content": "Reply with the single word: ready"}],
    )
    assert "ready" in cheap.text.lower()
    print(f"spent about ${first.cost_usd + loop.cost_usd + second.cost_usd + cheap.cost_usd:.4f}")
