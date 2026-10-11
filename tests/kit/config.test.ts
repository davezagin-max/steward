import { describe, expect, it } from "vitest";
import { MODELS, ZERO_USAGE, addUsage, costUsd, formatUsd } from "@/lib/config";

const usage = (input: number, output: number, write = 0, read = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
});

describe("costUsd", () => {
  it("prices Opus 5.5 at $4 in / $20 out per million tokens", () => {
    expect(costUsd(MODELS.opus, usage(1_000_000, 1_000_000))).toBeCloseTo(24, 10);
  });

  it("prices cache writes and reads separately from fresh input", () => {
    // 1M written at $5, 1M read at $0.20
    expect(costUsd(MODELS.opus, usage(0, 0, 1_000_000, 1_000_000))).toBeCloseTo(5.2, 10);
  });

  it("halves the price for batch requests", () => {
    expect(costUsd(MODELS.sonnet, usage(1_000_000, 1_000_000), { batch: true })).toBeCloseTo(6, 10);
  });

  it("applies the Haiku long-prompt tier above 100K prompt tokens", () => {
    expect(costUsd(MODELS.haiku, usage(100_000, 0))).toBeCloseTo(0.01, 10);
    expect(costUsd(MODELS.haiku, usage(200_000, 0))).toBeCloseTo(0.1, 10);
  });

  it("prices an unknown model as Opus rather than as free", () => {
    expect(costUsd("some-future-model", usage(1_000_000, 0))).toBeCloseTo(4, 10);
  });
});

describe("addUsage", () => {
  it("sums across rounds and treats missing cache fields as zero", () => {
    const total = addUsage(addUsage(ZERO_USAGE, { input_tokens: 10, output_tokens: 5 }), {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 7,
    });
    expect(total).toEqual(usage(11, 7, 0, 7));
  });
});

describe("formatUsd", () => {
  it("shows sub-cent amounts with four decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.239)).toBe("$1.24");
  });
});
