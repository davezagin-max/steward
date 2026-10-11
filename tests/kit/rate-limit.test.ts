import { describe, expect, it } from "vitest";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";

describe("createRateLimiter", () => {
  it("allows up to the limit, then blocks until the window resets", () => {
    const check = createRateLimiter(2, 1000);
    expect(check("ip", 0).allowed).toBe(true);
    expect(check("ip", 10).remaining).toBe(0);
    const blocked = check("ip", 20);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    expect(check("ip", 1000).allowed).toBe(true);
  });

  it("tracks each key independently", () => {
    const check = createRateLimiter(1, 1000);
    expect(check("a", 0).allowed).toBe(true);
    expect(check("b", 0).allowed).toBe(true);
    expect(check("a", 1).allowed).toBe(false);
  });

  it("stays bounded when many distinct keys arrive", () => {
    const check = createRateLimiter(1, 1000, 3);
    for (let i = 0; i < 50; i++) expect(check(`ip-${i}`, i).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  it("takes the first forwarded hop", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } });
    expect(clientIp(req)).toBe("1.2.3.4");
    expect(clientIp(new Request("http://x"))).toBe("local");
  });
});
