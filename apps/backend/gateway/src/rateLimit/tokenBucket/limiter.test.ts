import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit } from "./limiter.js";
import { getRateLimitMetrics, resetRateLimitMetrics } from "./metrics.js";
import { InMemoryTokenBucketStore, resetTokenBucketStore, setTokenBucketStore } from "./store.js";
import type { RateLimitConfig, RateLimitKey } from "./types.js";

const CONFIG: RateLimitConfig = {
  tier: "free",
  requestsPerWindow: 2,
  windowMs: 60_000,
  burstAllowance: 1,
  refillRatePerSecond: 1,
};

function key(overrides: Partial<RateLimitKey> = {}): RateLimitKey {
  return { identifier: "user-1", tier: "free", endpoint: "/api/v1/orders", method: "GET", ...overrides };
}

describe("checkRateLimit", () => {
  beforeEach(() => {
    setTokenBucketStore(new InMemoryTokenBucketStore());
    resetRateLimitMetrics();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTokenBucketStore();
  });

  it("allows requests up to capacity (requestsPerWindow + burstAllowance)", async () => {
    // capacity = 2 + 1 = 3
    const r1 = await checkRateLimit(key(), CONFIG);
    const r2 = await checkRateLimit(key(), CONFIG);
    const r3 = await checkRateLimit(key(), CONFIG);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r1.limit).toBe(3);
    expect(r3.remaining).toBe(0);
  });

  it("denies the request once capacity is exhausted and reports retryAfterMs", async () => {
    await checkRateLimit(key(), CONFIG);
    await checkRateLimit(key(), CONFIG);
    await checkRateLimit(key(), CONFIG);

    const denied = await checkRateLimit(key(), CONFIG);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // refillRatePerSecond: 1 → ~1000ms for the next token.
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("allows a subsequent request once enough time has passed to refill", async () => {
    await checkRateLimit(key(), CONFIG);
    await checkRateLimit(key(), CONFIG);
    await checkRateLimit(key(), CONFIG);
    const denied = await checkRateLimit(key(), CONFIG);
    expect(denied.allowed).toBe(false);

    vi.advanceTimersByTime(1500); // 1.5s at 1 token/sec → 1 token available

    const afterWait = await checkRateLimit(key(), CONFIG);
    expect(afterWait.allowed).toBe(true);
  });

  it("keeps separate buckets per identifier", async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit(key({ identifier: "user-1" }), CONFIG);
    const userOneDenied = await checkRateLimit(key({ identifier: "user-1" }), CONFIG);
    const userTwoAllowed = await checkRateLimit(key({ identifier: "user-2" }), CONFIG);

    expect(userOneDenied.allowed).toBe(false);
    expect(userTwoAllowed.allowed).toBe(true);
  });

  it("keeps separate buckets per endpoint for the same identifier", async () => {
    for (let i = 0; i < 3; i++) await checkRateLimit(key({ endpoint: "/api/v1/orders" }), CONFIG);
    const ordersDenied = await checkRateLimit(key({ endpoint: "/api/v1/orders" }), CONFIG);
    const walletsAllowed = await checkRateLimit(key({ endpoint: "/api/v1/wallets" }), CONFIG);

    expect(ordersDenied.allowed).toBe(false);
    expect(walletsAllowed.allowed).toBe(true);
  });

  it("resolves the config from tier/endpoint when no override is passed", async () => {
    const result = await checkRateLimit(key({ tier: "enterprise", endpoint: undefined, method: undefined }));
    expect(result.limit).toBeGreaterThan(60); // enterprise capacity is far above free's
  });

  it("records outcomes into the metrics module", async () => {
    await checkRateLimit(key(), CONFIG);
    await checkRateLimit(key(), CONFIG);
    await checkRateLimit(key(), CONFIG);
    await checkRateLimit(key(), CONFIG); // denied

    const metrics = getRateLimitMetrics();
    expect(metrics.totalRequests).toBe(4);
    expect(metrics.allowedRequests).toBe(3);
    expect(metrics.deniedRequests).toBe(1);
    expect(metrics.currentUtilization).toBeCloseTo(0.25, 5);
    expect(metrics.topDeniedKeys[0].key).toContain("user-1");
  });
});
