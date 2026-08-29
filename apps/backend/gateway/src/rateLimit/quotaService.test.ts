/**
 * Unit tests for #103 — customer-tiered API quotas.
 */

import { describe, it, expect, vi } from "vitest";
import { checkQuota, getQuotaUsage } from "./quotaService.js";

function buildMockRedis(initial: Record<string, number> = {}) {
  const store = new Map<string, number>(Object.entries(initial));
  return {
    async incr(key: string) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async get(key: string) {
      const val = store.get(key);
      return val === undefined ? null : String(val);
    },
  };
}

describe("checkQuota", () => {
  it("allows requests within the free tier's limit", async () => {
    const redis = buildMockRedis();
    const result = await checkQuota("cust-1", "free", "GET:/api/v1/orders", {}, { redisClient: redis });
    expect(result.allowed).toBe(true);
    expect(result.overage).toBe(false);
    expect(result.limit).toBe(1_000);
    expect(result.remaining).toBe(999);
  });

  it("blocks requests once the free tier's limit is exceeded (overageAction: block)", async () => {
    const redis = buildMockRedis({ "quota:cust-1:GET:/x:0": 1_000 });
    vi.spyOn(Date, "now").mockReturnValue(0);
    const result = await checkQuota("cust-1", "free", "GET:/x", {}, { redisClient: redis });
    expect(result.allowed).toBe(false);
    expect(result.overage).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
    vi.restoreAllMocks();
  });

  it("allows overage requests through for a 'bill' tier, within burst allowance", async () => {
    const redis = buildMockRedis({ "quota:cust-1:GET:/x:0": 100_000 });
    vi.spyOn(Date, "now").mockReturnValue(0);
    const result = await checkQuota("cust-1", "pro", "GET:/x", {}, { redisClient: redis });
    expect(result.allowed).toBe(true);
    expect(result.overage).toBe(true);
    vi.restoreAllMocks();
  });

  it("rejects overage requests for a 'bill' tier once burst allowance is also exhausted", async () => {
    const redis = buildMockRedis({ "quota:cust-1:GET:/x:0": 100_000 + 1_000 });
    vi.spyOn(Date, "now").mockReturnValue(0);
    const result = await checkQuota("cust-1", "pro", "GET:/x", {}, { redisClient: redis });
    expect(result.allowed).toBe(false);
    expect(result.overage).toBe(true);
    vi.restoreAllMocks();
  });

  it("prefers a per-endpoint custom quota over the tier's blanket allowance", async () => {
    const redis = buildMockRedis();
    const customQuotas = { "GET:/api/v1/heavy": { requestsPerWindow: 5, windowMs: 60_000 } };
    const result = await checkQuota("cust-1", "enterprise", "GET:/api/v1/heavy", customQuotas, {
      redisClient: redis,
    });
    expect(result.limit).toBe(5);
  });

  it("defaults to the free tier for an unrecognized tier name", async () => {
    const redis = buildMockRedis();
    const result = await checkQuota("cust-1", "made-up-tier", "GET:/x", {}, { redisClient: redis });
    expect(result.limit).toBe(1_000);
  });

  it("fires an alert exactly once when usage crosses the 80% threshold", async () => {
    const redis = buildMockRedis({ "quota:cust-1:GET:/x:0": 799 });
    vi.spyOn(Date, "now").mockReturnValue(0);
    const onAlert = vi.fn();
    await checkQuota("cust-1", "free", "GET:/x", {}, { redisClient: redis, onAlert });
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith(
      expect.objectContaining({ thresholdPct: 80, customerId: "cust-1" }),
    );
    vi.restoreAllMocks();
  });

  it("fires an alert exactly once when usage crosses the 95% threshold", async () => {
    const redis = buildMockRedis({ "quota:cust-1:GET:/x:0": 949 });
    vi.spyOn(Date, "now").mockReturnValue(0);
    const onAlert = vi.fn();
    await checkQuota("cust-1", "free", "GET:/x", {}, { redisClient: redis, onAlert });
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert).toHaveBeenCalledWith(expect.objectContaining({ thresholdPct: 95 }));
    vi.restoreAllMocks();
  });

  it("does not re-fire an alert for requests past the threshold crossing point", async () => {
    const redis = buildMockRedis({ "quota:cust-1:GET:/x:0": 850 });
    vi.spyOn(Date, "now").mockReturnValue(0);
    const onAlert = vi.fn();
    await checkQuota("cust-1", "free", "GET:/x", {}, { redisClient: redis, onAlert });
    expect(onAlert).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("getQuotaUsage", () => {
  it("summarizes usage across multiple endpoints", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const redis = buildMockRedis({
      "quota:cust-1:GET:/a:0": 50,
      "quota:cust-1:GET:/b:0": 12_000,
    });
    const summary = await getQuotaUsage("cust-1", "starter", ["GET:/a", "GET:/b"], {}, {
      redisClient: redis,
    });
    expect(summary.tier).toBe("starter");
    expect(summary.endpoints).toHaveLength(2);
    expect(summary.overageCount).toBe(1);
    vi.restoreAllMocks();
  });

  it("reports zero usage for endpoints with no recorded requests", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const redis = buildMockRedis();
    const summary = await getQuotaUsage("cust-1", "free", ["GET:/unused"], {}, {
      redisClient: redis,
    });
    expect(summary.endpoints[0].used).toBe(0);
    vi.restoreAllMocks();
  });
});
