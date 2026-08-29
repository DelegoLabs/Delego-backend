/**
 * Unit tests for #26 — Redis-backed rate limiting middleware.
 *
 * Covers `checkRateLimit` (the core sliding/fixed-window counter) and
 * `getRateLimitConfig` / env-var overrides (config.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkRateLimit } from "./rateLimiter.js";
import { getRateLimitConfig, getDefaultRateLimit } from "./config.js";

// ─── Mock Redis client ──────────────────────────────────────────────────────

function buildMockRedis(initial: Record<string, number> = {}) {
  const store = new Map<string, number>(Object.entries(initial));
  const expireCalls: Array<{ key: string; seconds: number }> = [];

  return {
    store,
    expireCalls,
    multi() {
      const ops: Array<() => Promise<[Error | null, unknown]>> = [];
      const pipeline = {
        incr(key: string) {
          ops.push(async () => {
            const next = (store.get(key) ?? 0) + 1;
            store.set(key, next);
            return [null, next];
          });
          return pipeline;
        },
        async exec() {
          const results: Array<[Error | null, unknown]> = [];
          for (const op of ops) {
            results.push(await op());
          }
          return results;
        },
      };
      return pipeline;
    },
    async expire(key: string, seconds: number) {
      expireCalls.push({ key, seconds });
      return 1;
    },
  };
}

describe("checkRateLimit", () => {
  it("allows requests under the configured limit", async () => {
    const redis = buildMockRedis();
    const result = await checkRateLimit("1.2.3.4", "GET:/api/v1/orders", {
      maxRequests: 5,
      windowMs: 60000,
      redisClient: redis,
    });

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.remaining).toBe(4);
  });

  it("continues to allow requests up to and including the exact limit", async () => {
    const redis = buildMockRedis();
    let result;
    for (let i = 0; i < 5; i++) {
      result = await checkRateLimit("1.2.3.4", "GET:/api/v1/orders", {
        maxRequests: 5,
        windowMs: 60000,
        redisClient: redis,
      });
    }

    expect(result!.allowed).toBe(true);
    expect(result!.remaining).toBe(0);
  });

  it("blocks requests once the limit is exceeded", async () => {
    // Seed the store as if 5 requests already happened in this window.
    const redis = buildMockRedis({ "ratelimit:1.2.3.4:GET:/x:0": 5 });
    vi.spyOn(Date, "now").mockReturnValue(0);

    const result = await checkRateLimit("1.2.3.4", "GET:/x", {
      maxRequests: 5,
      windowMs: 60000,
      redisClient: redis,
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(5);

    vi.restoreAllMocks();
  });

  it("exposes a resetInSeconds usable as a Retry-After value when blocked", async () => {
    const redis = buildMockRedis({ "ratelimit:1.2.3.4:GET:/x:0": 10 });
    vi.spyOn(Date, "now").mockReturnValue(0);

    const result = await checkRateLimit("1.2.3.4", "GET:/x", {
      maxRequests: 5,
      windowMs: 60000,
      redisClient: redis,
    });

    expect(result.allowed).toBe(false);
    expect(result.resetInSeconds).toBeGreaterThan(0);
    expect(result.resetInSeconds).toBeLessThanOrEqual(60);

    vi.restoreAllMocks();
  });

  it("sets a TTL on the window key only on the first increment", async () => {
    const redis = buildMockRedis();
    await checkRateLimit("5.5.5.5", "GET:/y", {
      maxRequests: 5,
      windowMs: 60000,
      redisClient: redis,
    });
    await checkRateLimit("5.5.5.5", "GET:/y", {
      maxRequests: 5,
      windowMs: 60000,
      redisClient: redis,
    });

    expect(redis.expireCalls).toHaveLength(1);
    expect(redis.expireCalls[0].seconds).toBe(60);
  });

  it("tracks separate identifiers independently", async () => {
    const redis = buildMockRedis({ "ratelimit:ip-a:GET:/x:0": 5 });
    vi.spyOn(Date, "now").mockReturnValue(0);

    const blocked = await checkRateLimit("ip-a", "GET:/x", {
      maxRequests: 5,
      windowMs: 60000,
      redisClient: redis,
    });
    const allowed = await checkRateLimit("ip-b", "GET:/x", {
      maxRequests: 5,
      windowMs: 60000,
      redisClient: redis,
    });

    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);

    vi.restoreAllMocks();
  });

  it("falls back to the configured default (100 req/min) for unmatched GET routes", () => {
    const config = getRateLimitConfig("GET", "/api/v1/some/new/route");
    expect(config.maxRequests).toBe(100);
    expect(config.windowMs).toBe(60000);
  });
});

describe("env-var configurable limits (issue #26)", () => {
  const ENV_KEYS = [
    "RATE_LIMIT_DEFAULT_MAX",
    "RATE_LIMIT_DEFAULT_WINDOW_MS",
    "RATE_LIMIT_GET_MAX",
    "RATE_LIMIT_GET_WINDOW_MS",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("overrides the catch-all default limit via RATE_LIMIT_DEFAULT_MAX / _WINDOW_MS", () => {
    process.env.RATE_LIMIT_DEFAULT_MAX = "10";
    process.env.RATE_LIMIT_DEFAULT_WINDOW_MS = "1000";

    const config = getDefaultRateLimit();
    expect(config.maxRequests).toBe(10);
    expect(config.windowMs).toBe(1000);
  });

  it("overrides the GET:* rule via RATE_LIMIT_GET_MAX / _WINDOW_MS", () => {
    process.env.RATE_LIMIT_GET_MAX = "250";
    process.env.RATE_LIMIT_GET_WINDOW_MS = "30000";

    const config = getRateLimitConfig("GET", "/anything");
    expect(config.maxRequests).toBe(250);
    expect(config.windowMs).toBe(30000);
  });

  it("ignores invalid (non-numeric or non-positive) overrides and falls back to defaults", () => {
    process.env.RATE_LIMIT_DEFAULT_MAX = "not-a-number";
    process.env.RATE_LIMIT_DEFAULT_WINDOW_MS = "-5";

    const config = getDefaultRateLimit();
    expect(config.maxRequests).toBe(60);
    expect(config.windowMs).toBe(60000);
  });

  it("leaves limits at their hardcoded defaults when no env vars are set", () => {
    const config = getDefaultRateLimit();
    expect(config.maxRequests).toBe(60);
    expect(config.windowMs).toBe(60000);
  });
});
