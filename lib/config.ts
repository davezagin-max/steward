/**
 * Single source of truth for model IDs and pricing.
 * Safe to import from both server and client code (no secrets, no Node APIs).
 */

export const MODELS = {
  /** Main model: reasoning, vision, agent loops. */
  opus: "claude-opus-5-5",
  /** Mid-tier: cheaper subtasks that still need judgment. */
  sonnet: "claude-sonnet-5-5",
  /** Cheapest: extraction, routing, classification. */
  haiku: "claude-haiku-5-5",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/** `output_config.effort`. Opus 5.5 thinking is always on; effort is the depth/cost control. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface Rates {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export const PRICING = {
  source: "https://platform.claude.com/docs/en/about-claude/pricing",
  lastVerified: "2026-10-11",
  /** USD per million tokens. */
  perMTok: {
    "claude-opus-5-5": { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
    // Haiku 5.5 rates for prompts up to 100K tokens; longer prompts are billed at 5x (see below).
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
    // Models a refused request can be re-run on by the server-side fallback.
    "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
    "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  } as Record<string, Rates>,
  /** Batch API: half price on input and output. */
  batchMultiplier: 0.5,
  haikuLongPromptThreshold: 100_000,
  haikuLongPromptMultiplier: 5,
} as const;

/** The subset of the API's `usage` object that cost depends on. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

type ApiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export function addUsage(total: Usage, next: ApiUsage): Usage {
  return {
    input_tokens: total.input_tokens + next.input_tokens,
    output_tokens: total.output_tokens + next.output_tokens,
    cache_creation_input_tokens:
      total.cache_creation_input_tokens + (next.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: total.cache_read_input_tokens + (next.cache_read_input_tokens ?? 0),
  };
}

/**
 * Cost of one request in USD. Cache writes are priced at the 5-minute rate,
 * which is the only TTL this kit uses. Unknown models are priced as Opus 5.5
 * so the meter over-reports rather than under-reports.
 */
export function costUsd(model: string, usage: Usage, opts: { batch?: boolean } = {}): number {
  const rates = PRICING.perMTok[model] ?? PRICING.perMTok[MODELS.opus];
  const promptTokens =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  const longPrompt =
    model === MODELS.haiku && promptTokens > PRICING.haikuLongPromptThreshold
      ? PRICING.haikuLongPromptMultiplier
      : 1;
  const dollars =
    (usage.input_tokens * rates.input +
      usage.output_tokens * rates.output +
      usage.cache_creation_input_tokens * rates.cacheWrite5m +
      usage.cache_read_input_tokens * rates.cacheRead) /
    1_000_000;
  return dollars * longPrompt * (opts.batch ? PRICING.batchMultiplier : 1);
}

export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
