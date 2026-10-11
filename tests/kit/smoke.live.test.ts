/**
 * Live smoke test. Skipped unless ANTHROPIC_API_KEY is set (in the shell or
 * in ../.env or .env.local). Costs well under one cent.
 *
 * It proves the kit follows the Claude Opus 5.5 API rules against the real
 * API: adaptive thinking with explicit effort, structured output, a strict
 * tool with tool_choice auto, a full tool loop that replays thinking blocks,
 * and a mid-conversation system message on an append-only history.
 */
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callClaude, strictTool, withSystemNote } from "@/lib/claude";
import { MODELS } from "@/lib/config";

for (const file of [".env.local", "../.env"]) {
  if (!process.env.ANTHROPIC_API_KEY && existsSync(file)) process.loadEnvFile(file);
}

const key = process.env.ANTHROPIC_API_KEY;
const live = describe.skipIf(!key);

live("live Claude API", () => {
  const client = new Anthropic({ apiKey: key, maxRetries: 4 });
  let spent = 0;

  it("returns schema-valid structured output from Opus 5.5 at low effort", async () => {
    const schema = z.object({ capital: z.string(), country: z.string() });
    const result = await callClaude({
      client,
      model: MODELS.opus,
      effort: "low",
      schema,
      maxTokens: 2000,
      messages: [{ role: "user", content: "What is the capital of Utah's country? Answer for the USA." }],
    });
    spent += result.costUsd;
    expect(result.refusal).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.parsed?.capital.toLowerCase()).toContain("washington");
  });

  it("runs a strict-tool loop, replays thinking blocks, and accepts a mid-conversation system message", async () => {
    const tools = [
      strictTool("get_snow_depth", "Look up the current snow depth in inches at a ski resort.", {
        resort: { type: "string", description: "Resort name" },
      }),
    ];
    const handlers = { get_snow_depth: () => ({ inches: 87 }) };
    const first = await callClaude({
      client,
      model: MODELS.opus,
      effort: "low",
      tools,
      handlers,
      maxTokens: 4000,
      system: "Use the get_snow_depth tool whenever a question needs a snow depth. Never guess one.",
      messages: [{ role: "user", content: "How deep is the snow at Alta right now?" }],
    });
    spent += first.costUsd;
    expect(first.ok).toBe(true);
    expect(first.toolCalls.map((call) => call.name)).toContain("get_snow_depth");
    expect(first.text).toContain("87");

    // Continue the same append-only history; a rejected thinking block would 400 here.
    const followUp = withSystemNote(
      [...first.messages, { role: "user", content: "Is that more than 60 inches? One word." }],
      "From now on, answer in French.",
    );
    const second = await callClaude({
      client,
      model: MODELS.opus,
      effort: "low",
      tools,
      handlers,
      maxTokens: 4000,
      system: "Use the get_snow_depth tool whenever a question needs a snow depth. Never guess one.",
      messages: followUp,
    });
    spent += second.costUsd;
    expect(second.ok).toBe(true);
    expect(second.text.toLowerCase()).toContain("oui");
  });

  it("calls Haiku 5.5 for a cheap subtask", async () => {
    const result = await callClaude({
      client,
      model: MODELS.haiku,
      effort: "low",
      maxTokens: 1000,
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
    });
    spent += result.costUsd;
    expect(result.text.toLowerCase()).toContain("ready");
    console.log(`Smoke test spent about $${spent.toFixed(4)}`);
  });
});
