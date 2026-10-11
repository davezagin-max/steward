import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { jsonRoute, streamRoute, type ApiResponse, type StreamFrame } from "@/lib/api";
import { ZERO_USAGE } from "@/lib/config";
import type { FixtureStore } from "@/lib/demo";

const schema = z.object({ demoId: z.string().optional(), topic: z.string().max(50) });
type Data = { answer: string };

const fixture = (data: Data, extra: object = {}) => ({
  label: "preset",
  placeholder: false,
  recordedAt: "2026-10-11T00:00:00.000Z",
  model: "claude-opus-5-5",
  usage: ZERO_USAGE,
  costUsd: 0.01,
  data,
  ...extra,
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("jsonRoute", () => {
  const live = vi.fn();
  const fixtures: FixtureStore<Data> = { "preset-1": fixture({ answer: "recorded" }) };
  const route = () => jsonRoute({ store: "x", fixtures, schema, live });

  it("replays a recorded run with no key and never calls the model", async () => {
    const res = await route()(post({ demoId: "preset-1", topic: "snow" }));
    const json = (await res.json()) as ApiResponse<Data>;
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, data: { answer: "recorded" }, meta: { mode: "demo" } });
    expect(live).not.toHaveBeenCalled();
  });

  it("explains a demo miss instead of failing silently", async () => {
    const res = await route()(post({ topic: "something unrecorded" }));
    const json = (await res.json()) as ApiResponse<Data>;
    expect(res.status).toBe(404);
    expect(json.ok === false && json.error.kind).toBe("demo_miss");
  });

  it("rejects invalid JSON, wrong shapes, and oversized bodies", async () => {
    expect((await route()(post("{not json"))).status).toBe(400);
    expect((await route()(post({ topic: 42 }))).status).toBe(400);
    const small = jsonRoute({ store: "x", fixtures, schema, live, maxBytes: 20 });
    expect((await small(post({ topic: "this body is longer than twenty bytes" }))).status).toBe(413);
  });

  it("rate limits per IP", async () => {
    const limited = jsonRoute({ store: "x", fixtures, schema, live, rateLimit: { limit: 1, windowMs: 60_000 } });
    const headers = { "x-forwarded-for": "9.9.9.9" };
    expect((await limited(post({ demoId: "preset-1", topic: "a" }, headers))).status).toBe(200);
    const blocked = await limited(post({ demoId: "preset-1", topic: "a" }, headers));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
  });

  it("rejects a malformed key with 401 and does not echo it", async () => {
    const res = await route()(post({ topic: "x" }, { "x-anthropic-key": "definitely-not-a-key" }));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("definitely-not-a-key");
  });
});

describe("streamRoute", () => {
  it("replays recorded events in order, then the final result", async () => {
    const fixtures: FixtureStore<Data, { step: number }> = {
      "preset-1": fixture(
        { answer: "final" },
        { events: [{ at: 0, event: { step: 1 } }, { at: 5, event: { step: 2 } }] },
      ),
    };
    const route = streamRoute({ store: "x", fixtures, schema, live: vi.fn(), replaySpeed: 100 });
    const res = await route(post({ demoId: "preset-1", topic: "a" }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await res.text())
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")) as StreamFrame<Data, { step: number }>);
    expect(frames.map((frame) => frame.type)).toEqual(["meta", "event", "event", "done"]);
    expect(frames[1]).toEqual({ type: "event", event: { step: 1 } });
    expect(frames[3]).toMatchObject({ type: "done", data: { answer: "final" } });
  });
});
