"""A stand-in Anthropic client that returns queued responses and records each request."""

from __future__ import annotations

import copy
from types import SimpleNamespace
from typing import Any

from app.config import OPUS


def block(type_: str, **fields: Any) -> SimpleNamespace:
    return SimpleNamespace(type=type_, **fields)


def message(content: list[Any], stop_reason: str = "end_turn", **extra: Any) -> SimpleNamespace:
    return SimpleNamespace(
        model=OPUS,
        content=content,
        stop_reason=stop_reason,
        stop_details=extra.pop("stop_details", None),
        usage=SimpleNamespace(
            input_tokens=100,
            output_tokens=50,
            cache_creation_input_tokens=None,
            cache_read_input_tokens=0,
        ),
        **extra,
    )


class FakeClient:
    def __init__(self, responses: list[Any]):
        self._responses = list(responses)
        self.requests: list[dict[str, Any]] = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **params: Any) -> Any:
        # Snapshot: the helper keeps appending to the same history list.
        self.requests.append(copy.deepcopy(params))
        return self._responses.pop(0)
