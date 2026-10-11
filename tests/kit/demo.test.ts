import { describe, expect, it } from "vitest";
import { findFixture, hashRequest, requestKey, stableStringify } from "@/lib/demo";

describe("stableStringify", () => {
  it("is independent of key order", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it("drops undefined values the way JSON does", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("requestKey", () => {
  it("hashes equal bodies to the same 16-hex key", async () => {
    const a = await hashRequest({ topic: "snow", n: 1 });
    const b = await hashRequest({ n: 1, topic: "snow" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashRequest({ topic: "sun", n: 1 })).not.toBe(a);
  });

  it("prefers a valid demoId and ignores an unsafe one", async () => {
    expect(await requestKey({ demoId: "preset-1", topic: "x" })).toBe("preset-1");
    const unsafe = { demoId: "../../etc/passwd", topic: "x" };
    expect(await requestKey(unsafe)).toBe(await hashRequest(unsafe));
  });
});

describe("findFixture", () => {
  it("does not resolve inherited object properties", () => {
    expect(findFixture({}, "constructor")).toBeNull();
    expect(findFixture({}, "__proto__")).toBeNull();
  });
});
