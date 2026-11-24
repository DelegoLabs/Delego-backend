/**
 * Anti-Sybil Score Calculator — Unit Tests
 *
 * Covers:
 *  - trustWeight < 0.2 for accounts younger than 7 days
 *  - trustWeight < 0.2 for transactions below 1 USDC
 *  - trustWeight = 1.0 for clean accounts
 *  - Weighted average rating computation
 *  - Reciprocal wash-trade flagging
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateSybilRisk,
  computeWeightedAverageRating,
  resetReciprocalStore,
  setReciprocalStore,
  InMemoryReciprocalStore,
  RedisReciprocalStore,
  PostgresReciprocalStore,
  type ReciprocalRedisClient,
  type ReciprocalPgPool,
  type StellarAccountInfo,
} from "./sybilScorer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function isoNDaysAgo(days: number): string {
  return isoHoursAgo(days * 24);
}

/** Build a StellarAccountInfo with the given age and volume. */
function makeAccountInfo(ageDays: number, stroops: string): StellarAccountInfo {
  return {
    createdAt: isoNDaysAgo(ageDays),
    totalTransactionStroops: stroops,
  };
}

// 1 USDC = 10 XLM = 100_000_000 stroops (at the 0.1 USDC/XLM rate in sybilScorer)
const ONE_USDC_IN_STROOPS = "100000000"; // 100_000_000
const HALF_USDC_IN_STROOPS = "50000000"; // 50_000_000

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evaluateSybilRisk", () => {
  beforeEach(() => {
    resetReciprocalStore();
  });

  it("flags accounts younger than 7 days with trustWeight < 0.2", async () => {
    const info = makeAccountInfo(3, ONE_USDC_IN_STROOPS); // 3 days old — below threshold
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);

    expect(result.isSuspicious).toBe(true);
    expect(result.trustWeight).toBeLessThan(0.2);
    expect(result.reasons.some((r) => r.includes("days old"))).toBe(true);
  });

  it("flags transactions below 1 USDC with trustWeight < 0.2", async () => {
    const info = makeAccountInfo(30, HALF_USDC_IN_STROOPS); // 30 days old but tiny volume
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", HALF_USDC_IN_STROOPS, info);

    expect(result.isSuspicious).toBe(true);
    expect(result.trustWeight).toBeLessThan(0.2);
    expect(result.reasons.some((r) => r.includes("below the minimum"))).toBe(true);
  });

  it("assigns trustWeight = 1.0 for clean, established accounts", async () => {
    const info = makeAccountInfo(30, ONE_USDC_IN_STROOPS); // 30 days old, ≥ 1 USDC
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);

    expect(result.isSuspicious).toBe(false);
    expect(result.trustWeight).toBe(1.0);
    expect(result.reasons).toHaveLength(0);
  });

  it("flags repeat reciprocal transactions between the same buyer/merchant pair", async () => {
    const info = makeAccountInfo(30, ONE_USDC_IN_STROOPS);

    // First transaction — clean
    const first = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(first.isSuspicious).toBe(false);

    // Second transaction — same pair → should flag
    const second = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(second.isSuspicious).toBe(true);
    expect(second.reasons.some((r) => r.includes("reciprocal"))).toBe(true);
  });

  it("does not cross-contaminate different buyer/merchant pairs", async () => {
    const info = makeAccountInfo(30, ONE_USDC_IN_STROOPS);

    await evaluateSybilRisk("GBUYER1", "GMERCHANT1", ONE_USDC_IN_STROOPS, info);

    // Different pair — should not be flagged as reciprocal
    const result = await evaluateSybilRisk("GBUYER2", "GMERCHANT2", ONE_USDC_IN_STROOPS, info);
    expect(result.reasons.some((r) => r.includes("reciprocal"))).toBe(false);
  });

  it("returns correct accountAgeDays and escrowVolumeUsdc in result", async () => {
    const info = makeAccountInfo(10, ONE_USDC_IN_STROOPS);
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);

    // accountAgeDays should be approximately 10 (slight tolerance for execution time)
    expect(result.accountAgeDays).toBeGreaterThan(9.9);
    expect(result.accountAgeDays).toBeLessThan(10.1);
    // escrowVolumeUsdc = 100_000_000 stroops / 10_000_000 * 0.1 = 1.0 USDC
    expect(result.escrowVolumeUsdc).toBeCloseTo(1.0, 5);
  });

  it("flags both age AND volume when both conditions are violated", async () => {
    const info = makeAccountInfo(1, HALF_USDC_IN_STROOPS);
    const result = await evaluateSybilRisk("GBUYER", "GMERCHANT", HALF_USDC_IN_STROOPS, info);

    expect(result.isSuspicious).toBe(true);
    expect(result.trustWeight).toBeLessThan(0.2);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("computeWeightedAverageRating", () => {
  it("returns null for an empty reviews array", () => {
    expect(computeWeightedAverageRating([])).toBeNull();
  });

  it("returns null when all trust weights are zero", () => {
    const result = computeWeightedAverageRating([
      { rating: 5, trustWeight: 0 },
      { rating: 1, trustWeight: 0 },
    ]);
    expect(result).toBeNull();
  });

  it("returns the simple average when all weights are 1.0", () => {
    const result = computeWeightedAverageRating([
      { rating: 4, trustWeight: 1.0 },
      { rating: 2, trustWeight: 1.0 },
    ]);
    expect(result).toBeCloseTo(3.0, 5);
  });

  it("discounts low-trust reviews towards the weighted mean", () => {
    // Three 5-star reviews from trusted accounts, one 1-star from sybil (weight 0.1)
    const result = computeWeightedAverageRating([
      { rating: 5, trustWeight: 1.0 },
      { rating: 5, trustWeight: 1.0 },
      { rating: 5, trustWeight: 1.0 },
      { rating: 1, trustWeight: 0.1 }, // sybil — barely counts
    ]);
    // Weighted: (5+5+5+0.1) / (1+1+1+0.1) = 15.1 / 3.1 ≈ 4.87
    expect(result).toBeGreaterThan(4.5);
    expect(result).toBeLessThan(5.0);
  });

  it("correctly weighs a single review", () => {
    const result = computeWeightedAverageRating([{ rating: 3, trustWeight: 0.5 }]);
    expect(result).toBeCloseTo(3.0, 5);
  });
});

// ---------------------------------------------------------------------------
// Reciprocal-transaction stores (TTL windowing & cross-replica detection)
// ---------------------------------------------------------------------------

function makeFakeRedis(nowFn: () => number): ReciprocalRedisClient {
  const store = new Map<string, { value: number; expiresAt: number | null }>();

  function getLive(key: string): { value: number; expiresAt: number | null } | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= nowFn()) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  return {
    async incr(key: string): Promise<number> {
      const live = getLive(key);
      if (live) {
        live.value += 1;
        return live.value;
      }
      store.set(key, { value: 1, expiresAt: null });
      return 1;
    },
    async pexpire(key: string, milliseconds: number): Promise<number> {
      const live = getLive(key);
      if (!live) return 0;
      live.expiresAt = nowFn() + milliseconds;
      return 1;
    },
    async get(key: string): Promise<string | null> {
      const live = getLive(key);
      return live ? String(live.value) : null;
    },
    async del(...keys: string[]): Promise<number> {
      let deleted = 0;
      for (const k of keys) {
        if (store.delete(k)) deleted += 1;
      }
      return deleted;
    },
  };
}

function makeFakePgPool(): ReciprocalPgPool {
  const rows: Array<{
    buyer_address: string;
    merchant_address: string;
    recorded_at: string;
    expires_at: string;
  }> = [];

  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: unknown[] = []
    ): Promise<{ rows: T[] }> {
      if (text.startsWith("INSERT INTO")) {
        rows.push({
          buyer_address: String(params[0]),
          merchant_address: String(params[1]),
          recorded_at: String(params[2]),
          expires_at: String(params[3]),
        });
        return { rows: [] };
      }
      if (text.startsWith("SELECT COUNT(*)")) {
        const [buyer, merchant, nowIso] = params as [string, string, string];
        const count = rows.filter(
          (r) =>
            r.buyer_address === buyer &&
            r.merchant_address === merchant &&
            r.expires_at > nowIso
        ).length;
        return { rows: [{ count } as unknown as T] };
      }
      if (text.startsWith("DELETE FROM")) {
        rows.length = 0;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL query: ${text}`);
    },
  };
}

describe("ReciprocalTransactionStore TTL windowing & cross-replica detection", () => {
  beforeEach(() => {
    resetReciprocalStore();
  });

  it("InMemoryReciprocalStore expires entries after the TTL window elapses", async () => {
    let now = 1_000_000;
    const store = new InMemoryReciprocalStore(60_000, () => now);

    await store.record("GBUYER", "GMERCHANT");
    expect(await store.getCount("GBUYER", "GMERCHANT")).toBe(1);

    // Still inside 60s window
    now += 30_000;
    await store.record("GBUYER", "GMERCHANT");
    expect(await store.getCount("GBUYER", "GMERCHANT")).toBe(2);

    // First entry expired, second still active
    now += 35_000;
    expect(await store.getCount("GBUYER", "GMERCHANT")).toBe(1);

    // Both expired
    now += 30_000;
    expect(await store.getCount("GBUYER", "GMERCHANT")).toBe(0);
  });

  it("RedisReciprocalStore shares cross-request velocity across replicas and respects TTL", async () => {
    let now = 2_000_000;
    const sharedRedis = makeFakeRedis(() => now);
    const replicaA = new RedisReciprocalStore(sharedRedis, { windowMs: 60_000 });
    const replicaB = new RedisReciprocalStore(sharedRedis, { windowMs: 60_000 });
    const info = makeAccountInfo(30, ONE_USDC_IN_STROOPS);

    // Request 1 handled by Replica A — clean
    setReciprocalStore(replicaA);
    const first = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(first.isSuspicious).toBe(false);
    expect(first.trustWeight).toBe(1.0);

    // Request 2 handled by Replica B within TTL window — flagged as reciprocal
    now += 10_000;
    setReciprocalStore(replicaB);
    const second = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(second.isSuspicious).toBe(true);
    expect(second.trustWeight).toBeLessThan(0.2);
    expect(second.reasons.some((r) => r.includes("reciprocal"))).toBe(true);
    expect(await replicaA.getCount("GBUYER", "GMERCHANT")).toBe(2);

    // After TTL window expires — pair is clean again
    now += 60_001;
    const third = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(third.isSuspicious).toBe(false);
    expect(third.trustWeight).toBe(1.0);
  });

  it("PostgresReciprocalStore shares cross-request velocity across replicas and respects TTL", async () => {
    let now = 3_000_000;
    const sharedPool = makeFakePgPool();
    const replicaA = new PostgresReciprocalStore(sharedPool, {
      windowMs: 60_000,
      nowFn: () => now,
    });
    const replicaB = new PostgresReciprocalStore(sharedPool, {
      windowMs: 60_000,
      nowFn: () => now,
    });
    const info = makeAccountInfo(30, ONE_USDC_IN_STROOPS);

    // Request 1 on Replica A — clean
    setReciprocalStore(replicaA);
    const first = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(first.isSuspicious).toBe(false);

    // Request 2 on Replica B within TTL — flagged
    now += 15_000;
    setReciprocalStore(replicaB);
    const second = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(second.isSuspicious).toBe(true);
    expect(second.trustWeight).toBeLessThan(0.2);
    expect(second.reasons.some((r) => r.includes("reciprocal"))).toBe(true);

    // Advance past both entries' TTL — clean again
    now += 60_001;
    const third = await evaluateSybilRisk("GBUYER", "GMERCHANT", ONE_USDC_IN_STROOPS, info);
    expect(third.isSuspicious).toBe(false);
    expect(third.trustWeight).toBe(1.0);
  });

  it("PostgresReciprocalStore rejects unsafe table names", () => {
    const pool = makeFakePgPool();
    expect(
      () => new PostgresReciprocalStore(pool, { tableName: "users; DROP TABLE users;--" })
    ).toThrow("Invalid SQL table name");
  });
});
