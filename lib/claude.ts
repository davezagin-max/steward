/**
 * Server-side Claude helper. Import only from route handlers and scripts.
 *
 * One function, `callClaude`, covers every pattern the app needs:
 * plain text, structured output, strict tool calls, and a full tool loop.
 * It encodes the Claude Opus 5.5 API rules in one place:
 *
 * - Thinking is always on. We send `{ type: "adaptive" }` and control depth
 *   with `output_config.effort`; we never send `disabled` or a token budget.
 * - No forced tool use. `tool_choice` stays `auto`; tools are `strict: true`
 *   and the prompt says when a tool applies.
 * - Responses can start with `thinking` blocks, so content is selected by
 *   block `type`, never by position.
 * - Thinking blocks are bound to the conversation, so the history is
 *   append-only: the assistant turn is pushed back exactly as received.
 * - `stop_reason: "refusal"` is a normal outcome and is returned, not thrown.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import {
  MODELS,
  ZERO_USAGE,
  addUsage,
  costUsd,
  type Effort,
  type ModelId,
  type Usage,
} from "./config";

export const KEY_HEADER = "x-anthropic-key";

/**
 * A safety classifier can decline a benign request. With this on, the API
 * re-runs a declined Opus/Sonnet request on the model Anthropic recommends
 * for that refusal category, inside the same call. Set to false to disable.
 */
const REFUSAL_FALLBACK = true;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Returns the notes the model writes between tool calls as readable text. */
const UPDATES_BETA = "thinking-display-updates-2026-08-18";

export type Msg = Anthropic.Beta.BetaMessageParam;
export type ToolDef = Anthropic.Beta.BetaTool;
export type ToolHandler = (input: unknown) => unknown | Promise<unknown>;

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  /** Undefined when no handler ran (single-shot tool call the caller handles). */
  output?: unknown;
  isError: boolean;
  round: number;
}

export interface Refusal {
  category: string | null;
  explanation: string | null;
}

export interface CallOptions<T = unknown> {
  client: Anthropic;
  model?: ModelId;
  /** Always sent explicitly: the Opus 5.5 default (`medium`) differs from older models. */
  effort?: Effort;
  /** Stable instructions. Never edit mid-conversation; append a `role: "system"` message instead. */
  system?: string;
  /** Cache the system prompt (and tools). Only pays off for prompts of 512+ tokens. */
  cacheSystem?: boolean;
  /** Conversation so far. Not mutated; the result carries the extended history. */
  messages: Msg[];
  /** Tool definitions. Use `strictTool()` so inputs always match the schema. */
  tools?: ToolDef[];
  /** When given, tool calls are executed and fed back until the model stops calling tools. */
  handlers?: Record<string, ToolHandler>;
  maxToolRounds?: number;
  /** Structured output: the final text is JSON matching this schema. */
  schema?: z.ZodType<T>;
  /** Must leave room for thinking, which counts toward the limit. */
  maxTokens?: number;
  /** Streamed answer text. */
  onText?: (delta: string) => void;
  /** Progress notes the model writes between tool calls. */
  onProgress?: (note: string) => void;
  /** Fires after each tool call finishes. */
  onToolCall?: (call: ToolCallRecord) => void;
  signal?: AbortSignal;
}

export interface CallResult<T = unknown> {
  /** False on refusal, truncation, or a structured output that failed validation. */
  ok: boolean;
  text: string;
  parsed: T | null;
  toolCalls: ToolCallRecord[];
  /** Input history plus every turn appended by this call. Send this back next time. */
  messages: Msg[];
  stopReason: string | null;
  refusal: Refusal | null;
  usage: Usage;
  costUsd: number;
  /** The model that actually answered (differs from the request if a fallback ran). */
  model: string;
  rounds: number;
}

/** Thrown for a missing or malformed key before any network call is made. */
export class MissingKeyError extends Error {
  constructor(message = "No Anthropic API key was provided.") {
    super(message);
    this.name = "MissingKeyError";
  }
}

const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{16,}$/;

/**
 * Builds a client from the per-request key header. The key lives only in this
 * request's memory: it is never logged, stored, or echoed back.
 *
 * A server-side `ANTHROPIC_API_KEY` is used only when `ALLOW_SERVER_KEY=1`,
 * which is meant for local development and fixture recording. A public deploy
 * leaves it unset so visitors can never spend the owner's credits.
 */
export function clientFromRequest(req: Request): Anthropic | null {
  const header = req.headers.get(KEY_HEADER)?.trim();
  const key =
    header || (process.env.ALLOW_SERVER_KEY === "1" ? process.env.ANTHROPIC_API_KEY : undefined);
  if (!key) return null;
  if (!KEY_PATTERN.test(key)) throw new MissingKeyError("That does not look like an Anthropic API key.");
  // The SDK retries 408/409/429 and 5xx (including 529 overloaded) with exponential backoff.
  return new Anthropic({ apiKey: key, maxRetries: 4 });
}

/** A custom tool whose inputs are guaranteed to match `properties`. All properties are required. */
export function strictTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
): ToolDef {
  return {
    name,
    description,
    strict: true,
    input_schema: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
}

/**
 * Wraps user-supplied text in a tag so the system prompt can tell the model to
 * treat it as data. Any copy of the closing tag inside the text is defused so
 * the input cannot break out of its container.
 */
export function untrusted(tag: string, text: string): string {
  const safe = text.replaceAll(`</${tag}`, `<​/${tag}`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function serialize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export async function callClaude<T = unknown>(opts: CallOptions<T>): Promise<CallResult<T>> {
  const model = opts.model ?? MODELS.opus;
  const streaming = Boolean(opts.onText || opts.onProgress);
  const useFallback = REFUSAL_FALLBACK && model !== MODELS.haiku;
  const wantsUpdates = Boolean(opts.onProgress) && model !== MODELS.haiku;
  const maxRounds = opts.maxToolRounds ?? 8;

  const betas: string[] = [];
  if (useFallback) betas.push(FALLBACK_BETA);
  if (wantsUpdates) betas.push(UPDATES_BETA);

  const format = opts.schema ? betaZodOutputFormat(opts.schema) : null;

  const base = {
    model,
    max_tokens: opts.maxTokens ?? (streaming ? 32_000 : 16_000),
    thinking: wantsUpdates
      ? ({ type: "adaptive", display: "updates" } as const)
      : ({ type: "adaptive" } as const),
    output_config: {
      effort: opts.effort ?? "medium",
      ...(format ? { format: { type: format.type, schema: format.schema } } : {}),
    },
    ...(opts.system
      ? {
          system: [
            {
              type: "text" as const,
              text: opts.system,
              ...(opts.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
            },
          ],
        }
      : {}),
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(betas.length ? { betas } : {}),
    ...(useFallback ? { fallbacks: "default" as const } : {}),
  };

  const history: Msg[] = [...opts.messages];
  const toolCalls: ToolCallRecord[] = [];
  let usage: Usage = ZERO_USAGE;
  let cost = 0;

  const finish = (
    message: Anthropic.Beta.BetaMessage,
    rounds: number,
    stopReason: string | null,
  ): CallResult<T> => {
    const text = textOf(message.content);
    let parsed: T | null = null;
    let valid = true;
    if (opts.schema && stopReason === "end_turn") {
      try {
        const check = opts.schema.safeParse(JSON.parse(text));
        if (check.success) parsed = check.data;
        else valid = false;
      } catch {
        valid = false;
      }
    }
    const refusal =
      stopReason === "refusal"
        ? {
            category: message.stop_details?.category ?? null,
            explanation: message.stop_details?.explanation ?? null,
          }
        : null;
    const completed = stopReason === "end_turn" || stopReason === "tool_use";
    return {
      ok: completed && valid,
      text,
      parsed,
      toolCalls,
      messages: history,
      stopReason,
      refusal,
      usage,
      costUsd: cost,
      model: message.model,
      rounds,
    };
  };

  for (let round = 1; ; round++) {
    const params = { ...base, messages: history };
    let message: Anthropic.Beta.BetaMessage;
    if (streaming) {
      const stream = opts.client.beta.messages.stream(params, { signal: opts.signal });
      if (opts.onText) stream.on("text", opts.onText);
      if (opts.onProgress) {
        const onProgress = opts.onProgress;
        // Under display "updates", a thinking block with text is a progress note.
        stream.on("contentBlock", (block) => {
          if (block.type === "thinking" && block.thinking.trim()) onProgress(block.thinking.trim());
        });
      }
      message = await stream.finalMessage();
    } else {
      message = await opts.client.beta.messages.create(params, { signal: opts.signal });
    }

    usage = addUsage(usage, message.usage);
    cost += costUsd(message.model, addUsage(ZERO_USAGE, message.usage));

    // Check the stop reason before reading content: a refusal can cut a tool call off mid-input.
    if (message.stop_reason === "refusal") return finish(message, round, "refusal");

    // Append the assistant turn unmodified so thinking blocks stay valid.
    history.push({ role: "assistant", content: message.content });

    const toolUses = message.content.filter(
      (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
    );

    if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
      return finish(message, round, message.stop_reason);
    }

    if (!opts.handlers) {
      // Single-shot tool call: hand the validated inputs to the caller.
      for (const use of toolUses) {
        toolCalls.push({ id: use.id, name: use.name, input: use.input, isError: false, round });
      }
      return finish(message, round, "tool_use");
    }

    if (round > maxRounds) return finish(message, round, "tool_round_limit");

    const handlers = opts.handlers;
    // Run parallel tool calls concurrently and return every result in ONE user message.
    const results = await Promise.all(
      toolUses.map(async (use) => {
        const record: ToolCallRecord = {
          id: use.id,
          name: use.name,
          input: use.input,
          isError: false,
          round,
        };
        const handler = handlers[use.name];
        try {
          if (!handler) throw new Error(`Unknown tool: ${use.name}`);
          record.output = await handler(use.input);
        } catch (error) {
          record.isError = true;
          record.output = error instanceof Error ? error.message : "Tool failed";
        }
        toolCalls.push(record);
        opts.onToolCall?.(record);
        return {
          type: "tool_result" as const,
          tool_use_id: use.id,
          content: serialize(record.output),
          ...(record.isError ? { is_error: true } : {}),
        };
      }),
    );
    history.push({ role: "user", content: results });
  }
}

/**
 * Appends an operator instruction mid-conversation without touching the
 * original system prompt, which would invalidate the prompt cache and every
 * earlier thinking block. The last message must be a user turn.
 */
export function withSystemNote(messages: Msg[], note: string): Msg[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") {
    throw new Error("A mid-conversation system message must follow a user message.");
  }
  return [...messages, { role: "system", content: note }];
}

export interface ApiError {
  status: number;
  message: string;
}

/** Maps SDK errors to a safe client-facing error. Never includes the key or request body. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof MissingKeyError) return { status: 401, message: error.message };
  if (error instanceof Anthropic.AuthenticationError) {
    return { status: 401, message: "Anthropic rejected that API key." };
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { status: 403, message: "That API key is not allowed to use this model." };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { status: 429, message: "Anthropic rate limit reached. Try again shortly." };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { status: 400, message: "Claude rejected the request as invalid." };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { status: 502, message: "Could not reach the Anthropic API." };
  }
  if (error instanceof Anthropic.APIError) {
    return { status: 502, message: "The Anthropic API returned an error. Try again." };
  }
  return { status: 500, message: "Something went wrong." };
}
