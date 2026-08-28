import { describe, it, expect, beforeEach } from "vitest";
import {
  SlidingWindowRateLimiter,
  type RateLimitRedisClient,
  type RateLimitRule,
} from "./slidingWindowRateLimiter.js";

/**
 * A minimal in-process reimplementation of the Lua script's sliding-window
 * semantics, since these tests don't have a real Redis to eval against.
 * Mirrors the ZSET-per-key model exactly (timestamp-scored entries, trimmed
 * to the window on each check).
 */
class FakeRedis implements RateLimitRedisClient {
  private stores = new Map<string, number[]>();

  setNow: () => number = () => Date.now();

  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    now: number,
    windowMs: number,
    maxRequests: number,
    cost: number,
  ): Promise<[number, number, number]> {
    const windowStart = now - windowMs;
    const existing = (this.stores.get(String(key)) ?? []).filter((t) => t > windowStart);

    let allowed = 0;
    let count = existing.length;
    if (count + cost <= maxRequests) {
      for (let i = 0; i < cost; i++) existing.push(now);
      allowed = 1;
      count = existing.length;
    }

    this.stores.set(String(key), existing);
    const oldest = existing.length > 0 ? Math.min(...existing) : now;
    return [allowed, count, oldest];
  }
}

const rule: RateLimitRule = {
  keyPrefix: "orders",
  limits: [
    { tier: "default", windowMs: 1000, maxRequests: 3 },
    { tier: "premium", windowMs: 1000, maxRequests: 10 },
  ],
  exemptKeys: ["internal-service"],
};

describe("SlidingWindowRateLimiter", () => {
  let redis: FakeRedis;
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    redis = new FakeRedis();
    limiter = new SlidingWindowRateLimiter(redis);
  });

  it("allows requests under the limit", async () => {
    const r1 = await limiter.check(rule, { key: "user-1", tier: "default" });
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await limiter.check(rule, { key: "user-1", tier: "default" });
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
  });

  it("denies a request once the tier's limit is reached", async () => {
    await limiter.check(rule, { key: "user-2", tier: "default" });
    await limiter.check(rule, { key: "user-2", tier: "default" });
    await limiter.check(rule, { key: "user-2", tier: "default" });
    const denied = await limiter.check(rule, { key: "user-2", tier: "default" });

    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it("keeps different keys independent", async () => {
    await limiter.check(rule, { key: "user-a", tier: "default" });
    await limiter.check(rule, { key: "user-a", tier: "default" });
    await limiter.check(rule, { key: "user-a", tier: "default" });

    const other = await limiter.check(rule, { key: "user-b", tier: "default" });
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(2);
  });

  it("keeps different tiers of the same key independent", async () => {
    await limiter.check(rule, { key: "user-c", tier: "default" });
    await limiter.check(rule, { key: "user-c", tier: "default" });
    await limiter.check(rule, { key: "user-c", tier: "default" });

    const premium = await limiter.check(rule, { key: "user-c", tier: "premium" });
    expect(premium.allowed).toBe(true);
    expect(premium.remaining).toBe(9);
  });

  it("always allows exempt keys without consuming quota", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.check(rule, { key: "internal-service", tier: "default" })),
    );
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(results[0].headers["X-RateLimit-Exempt"]).toBe("true");
  });

  it("supports a weighted cost greater than 1", async () => {
    const r1 = await limiter.check(rule, { key: "user-d", tier: "default", cost: 3 });
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(0);

    const r2 = await limiter.check(rule, { key: "user-d", tier: "default", cost: 1 });
    expect(r2.allowed).toBe(false);
  });

  it("throws for an unconfigured tier", async () => {
    await expect(
      limiter.check(rule, { key: "user-e", tier: "nonexistent" }),
    ).rejects.toThrow(/No rate limit tier/);
  });

  it("includes RFC 6585-style headers", async () => {
    const result = await limiter.check(rule, { key: "user-f", tier: "default" });
    expect(result.headers["X-RateLimit-Limit"]).toBe("3");
    expect(result.headers["X-RateLimit-Remaining"]).toBe("2");
    expect(result.headers["X-RateLimit-Reset"]).toBeDefined();
  });
});
