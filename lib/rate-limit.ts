/**
 * Fixed-window, per-IP rate limiter held in memory.
 *
 * Tradeoff: state is per server instance, so on serverless it limits bursts
 * against one warm instance rather than enforcing a global quota. That is
 * enough to blunt abuse of a bring-your-own-key demo without adding a
 * database; a shared store (Redis/Upstash) is the upgrade path.
 */
interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function createRateLimiter(limit: number, windowMs: number, maxKeys = 10_000) {
  const windows = new Map<string, Window>();

  return function check(key: string, now = Date.now()): RateLimitResult {
    const current = windows.get(key);
    if (!current || now >= current.resetAt) {
      // Evict expired entries before the map can grow without bound.
      if (windows.size >= maxKeys) {
        for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
        if (windows.size >= maxKeys) windows.clear();
      }
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000),
      };
    }
    current.count += 1;
    return { allowed: true, remaining: limit - current.count, retryAfterSeconds: 0 };
  };
}

/** Best-effort client address. Behind Vercel the first `x-forwarded-for` hop is the client. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
