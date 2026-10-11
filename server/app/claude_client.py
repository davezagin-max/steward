"""Claude helper with the same behavior as the TypeScript kit's `callClaude`.

It encodes the Claude Opus 5.5 API rules in one place:

- Thinking is always on. We send `{"type": "adaptive"}` and control depth with
  `output_config.effort`; we never send `disabled` or a token budget.
- No forced tool use. `tool_choice` stays `auto`; tools are `strict: True` and
  the prompt says when a tool applies.
- Responses can start with `thinking` blocks, so content is selected by block
  `type`, never by position.
- Thinking blocks are bound to the conversation, so the history is append-only:
  the assistant turn is appended exactly as received.
- `stop_reason == "refusal"` is a normal outcome and is returned, not raised.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import anthropic
from pydantic import BaseModel, ValidationError

from .config import HAIKU, OPUS, Effort, Usage, cost_usd

KEY_HEADER = "x-anthropic-key"

# A safety classifier can decline a benign request. With this on, the API re-runs
# a declined Opus/Sonnet request on the model Anthropic recommends for that
# refusal category, inside the same call. Set to False to disable.
REFUSAL_FALLBACK = True
FALLBACK_BETA = "server-side-fallback-2026-07-01"
# Returns the notes the model writes between tool calls as readable text.
UPDATES_BETA = "thinking-display-updates-2026-08-18"

ToolHandler = Callable[[dict[str, Any]], Any]

_KEY_PATTERN = re.compile(r"^sk-ant-[A-Za-z0-9_-]{16,}$")


class MissingKeyError(Exception):
    """A missing or malformed key, caught before any network call."""


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]
    round: int
    output: Any = None
    is_error: bool = False


@dataclass
class CallResult:
    ok: bool  # False on refusal, truncation, or structured output that failed validation
    text: str
    parsed: Any  # instance of `schema` when given and valid, else None
    tool_calls: list[ToolCall]
    messages: list[Any]  # input history plus every turn appended by this call
    stop_reason: str | None
    refusal: dict[str, str | None] | None
    usage: Usage
    cost_usd: float
    model: str  # the model that actually answered (differs if a fallback ran)
    rounds: int = 1
    progress: list[str] = field(default_factory=list)


def client_for_key(key: str | None) -> anthropic.Anthropic | None:
    """Build a client from a per-request key. The key is never logged or stored."""
    if not key:
        return None
    key = key.strip()
    if not _KEY_PATTERN.match(key):
        raise MissingKeyError("That does not look like an Anthropic API key.")
    # The SDK retries 408/409/429 and 5xx (including 529 overloaded) with backoff.
    return anthropic.Anthropic(api_key=key, max_retries=4)


def strict_tool(name: str, description: str, properties: dict[str, Any]) -> dict[str, Any]:
    """A custom tool whose inputs always match `properties`. All properties are required."""
    return {
        "name": name,
        "description": description,
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
    }


def untrusted(tag: str, text: str) -> str:
    """Wrap user-supplied text in a tag the system prompt can declare to be data.

    Any copy of the closing tag inside the text is defused so the input cannot
    break out of its container.
    """
    safe = text.replace(f"</{tag}", f"<​/{tag}")
    return f"<{tag}>\n{safe}\n</{tag}>"


def with_system_note(messages: list[Any], note: str) -> list[Any]:
    """Append an operator instruction mid-conversation without editing the system prompt.

    Editing the original prompt would invalidate the prompt cache and every
    earlier thinking block. The last message must be a user turn.
    """
    if not messages or messages[-1]["role"] != "user":
        raise ValueError("A mid-conversation system message must follow a user message.")
    return [*messages, {"role": "system", "content": note}]


def _text_of(content: list[Any]) -> str:
    return "".join(block.text for block in content if block.type == "text")


def _serialize(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, default=str)


def call_claude(
    client: anthropic.Anthropic,
    *,
    messages: list[Any],
    model: str = OPUS,
    effort: Effort = "medium",
    system: str | None = None,
    cache_system: bool = False,
    tools: list[dict[str, Any]] | None = None,
    handlers: dict[str, ToolHandler] | None = None,
    max_tool_rounds: int = 8,
    schema: type[BaseModel] | None = None,
    max_tokens: int = 16_000,
    on_progress: Callable[[str], None] | None = None,
    on_tool_call: Callable[[ToolCall], None] | None = None,
) -> CallResult:
    """One Claude request, or a full tool loop when `handlers` is given.

    `messages` is not mutated; the result carries the extended history.
    `max_tokens` must leave room for thinking, which counts toward the limit.
    """
    use_fallback = REFUSAL_FALLBACK and model != HAIKU
    wants_updates = on_progress is not None and model != HAIKU

    betas: list[str] = []
    if use_fallback:
        betas.append(FALLBACK_BETA)
    if wants_updates:
        betas.append(UPDATES_BETA)

    output_config: dict[str, Any] = {"effort": effort}
    if schema is not None:
        output_config["format"] = {
            "type": "json_schema",
            "schema": anthropic.transform_schema(schema),
        }

    params: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "thinking": {"type": "adaptive", "display": "updates"}
        if wants_updates
        else {"type": "adaptive"},
        "output_config": output_config,
    }
    if system:
        system_block: dict[str, Any] = {"type": "text", "text": system}
        if cache_system:
            system_block["cache_control"] = {"type": "ephemeral"}
        params["system"] = [system_block]
    if tools:
        params["tools"] = tools
    if betas:
        params["betas"] = betas
    if use_fallback:
        params["fallbacks"] = "default"

    history = list(messages)
    calls: list[ToolCall] = []
    notes: list[str] = []
    usage = Usage()
    cost = 0.0
    round_no = 0

    def finish(message: Any, stop_reason: str | None) -> CallResult:
        text = _text_of(message.content)
        parsed = None
        valid = True
        if schema is not None and stop_reason == "end_turn":
            try:
                parsed = schema.model_validate_json(text)
            except ValidationError:
                valid = False
        refusal = None
        if stop_reason == "refusal":
            details = getattr(message, "stop_details", None)
            refusal = {
                "category": getattr(details, "category", None),
                "explanation": getattr(details, "explanation", None),
            }
        return CallResult(
            ok=stop_reason in ("end_turn", "tool_use") and valid,
            text=text,
            parsed=parsed,
            tool_calls=calls,
            messages=history,
            stop_reason=stop_reason,
            refusal=refusal,
            usage=usage,
            cost_usd=cost,
            model=message.model,
            rounds=round_no,
            progress=notes,
        )

    while True:
        round_no += 1
        message = client.beta.messages.create(**params, messages=history)
        usage = usage.plus(message.usage)
        cost += cost_usd(message.model, Usage().plus(message.usage))

        # Under display "updates", a thinking block with text is a progress note.
        if on_progress is not None:
            for block in message.content:
                note = (getattr(block, "thinking", "") or "").strip()
                if block.type == "thinking" and note:
                    notes.append(note)
                    on_progress(note)

        # Check the stop reason before reading content: a refusal can cut a tool call short.
        if message.stop_reason == "refusal":
            return finish(message, "refusal")

        # Append the assistant turn unmodified so thinking blocks stay valid.
        history.append({"role": "assistant", "content": message.content})

        tool_uses = [block for block in message.content if block.type == "tool_use"]
        if message.stop_reason != "tool_use" or not tool_uses:
            return finish(message, message.stop_reason)

        if handlers is None:
            # Single-shot tool call: hand the validated inputs to the caller.
            calls.extend(ToolCall(use.id, use.name, use.input, round_no) for use in tool_uses)
            return finish(message, "tool_use")

        if round_no > max_tool_rounds:
            return finish(message, "tool_round_limit")

        def run(use: Any, round_no: int = round_no) -> ToolCall:
            call = ToolCall(use.id, use.name, use.input, round_no)
            try:
                handler = handlers.get(use.name)
                if handler is None:
                    raise KeyError(f"Unknown tool: {use.name}")
                call.output = handler(use.input)
            except Exception as error:  # a failed tool is reported to the model, not raised
                call.is_error = True
                call.output = str(error)
            return call

        # Run parallel tool calls concurrently and return every result in ONE user message.
        with ThreadPoolExecutor(max_workers=max(1, len(tool_uses))) as pool:
            finished = list(pool.map(run, tool_uses))
        results: list[dict[str, Any]] = []
        for call in finished:
            calls.append(call)
            if on_tool_call is not None:
                on_tool_call(call)
            result: dict[str, Any] = {
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": _serialize(call.output),
            }
            if call.is_error:
                result["is_error"] = True
            results.append(result)
        history.append({"role": "user", "content": results})


def api_error(error: Exception) -> tuple[int, str]:
    """Map SDK errors to a safe (status, message). Never includes the key or request body."""
    if isinstance(error, MissingKeyError):
        return 401, str(error)
    if isinstance(error, anthropic.AuthenticationError):
        return 401, "Anthropic rejected that API key."
    if isinstance(error, anthropic.PermissionDeniedError):
        return 403, "That API key is not allowed to use this model."
    if isinstance(error, anthropic.RateLimitError):
        return 429, "Anthropic rate limit reached. Try again shortly."
    if isinstance(error, anthropic.BadRequestError):
        return 400, "Claude rejected the request as invalid."
    if isinstance(error, anthropic.APIConnectionError):
        return 502, "Could not reach the Anthropic API."
    if isinstance(error, anthropic.APIError):
        return 502, "The Anthropic API returned an error. Try again."
    return 500, "Something went wrong."
