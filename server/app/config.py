"""Single source of truth for model IDs and pricing."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

OPUS = "claude-opus-5-5"  # main model: reasoning, vision, agent loops
SONNET = "claude-sonnet-5-5"  # mid-tier subtasks
HAIKU = "claude-haiku-5-5"  # cheapest: extraction, routing, classification

# `output_config.effort`. Opus 5.5 thinking is always on; effort is the depth/cost control.
Effort = Literal["low", "medium", "high", "xhigh", "max"]

PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing"
PRICING_LAST_VERIFIED = "2026-10-11"

# USD per million tokens: (input, output, 5-minute cache write, cache read)
PRICING: dict[str, tuple[float, float, float, float]] = {
    OPUS: (4.0, 20.0, 5.0, 0.20),
    SONNET: (2.0, 10.0, 2.50, 0.10),
    HAIKU: (0.10, 0.50, 0.125, 0.01),  # prompts up to 100K tokens; 5x beyond that
    # Models a refused request can be re-run on by the server-side fallback.
    "claude-opus-5": (5.0, 25.0, 6.25, 0.50),
    "claude-opus-4-8": (5.0, 25.0, 6.25, 0.50),
}
BATCH_MULTIPLIER = 0.5  # Batch API: half price on input and output
HAIKU_LONG_PROMPT_THRESHOLD = 100_000
HAIKU_LONG_PROMPT_MULTIPLIER = 5


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0

    def plus(self, other: Any) -> Usage:
        """Add an API `usage` object (or another Usage); missing cache fields count as zero."""
        return Usage(
            self.input_tokens + (getattr(other, "input_tokens", 0) or 0),
            self.output_tokens + (getattr(other, "output_tokens", 0) or 0),
            self.cache_creation_input_tokens
            + (getattr(other, "cache_creation_input_tokens", 0) or 0),
            self.cache_read_input_tokens + (getattr(other, "cache_read_input_tokens", 0) or 0),
        )

    def as_dict(self) -> dict[str, int]:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
        }


def cost_usd(model: str, usage: Usage, *, batch: bool = False) -> float:
    """Cost of one request. Unknown models are priced as Opus so the meter never under-reports."""
    rate_in, rate_out, rate_write, rate_read = PRICING.get(model, PRICING[OPUS])
    prompt_tokens = (
        usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
    )
    long_prompt = (
        HAIKU_LONG_PROMPT_MULTIPLIER
        if model == HAIKU and prompt_tokens > HAIKU_LONG_PROMPT_THRESHOLD
        else 1
    )
    dollars = (
        usage.input_tokens * rate_in
        + usage.output_tokens * rate_out
        + usage.cache_creation_input_tokens * rate_write
        + usage.cache_read_input_tokens * rate_read
    ) / 1_000_000
    return dollars * long_prompt * (BATCH_MULTIPLIER if batch else 1)
