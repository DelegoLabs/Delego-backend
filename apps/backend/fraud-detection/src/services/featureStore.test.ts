import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FeatureStore } from "./featureStore.js";

// ---------------------------------------------------------------------------
// Redis mock
// ---------------------------------------------------------------------------
// We mock ioredis so tests run without a real Redis instance. Each command
// returns sensible defaults that drive the FeatureStore logic.
// ---------------------------------------------------------------------------

const redisMock = {
  on: vi.fn(),
  zcount: vi.fn().mockResolvedValue(0),
  get: vi.fn().mockResolvedValue(null),
  scard: vi.fn().mockResolvedValue(0),
  zadd: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
  incrbyfloat: vi.fn().mockResolvedValue("0"),
  setex: vi.fn().mockResolvedValue("OK"),
  quit: vi.fn().mockResolvedValue("OK"),
};

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => redisMock),
}));

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  for (const fn of Object.values(redisMock)) {
    if (typeof fn.mockReset === "function") fn.mockReset();
  }
  // Restore default return values after reset
  redisMock.on.mockReturnValue(undefined);
  redisMock.zcount.mockResolvedValue(0);
  redisMock.get.mockResolvedValue(null);
  redisMock.scard.mockResolvedValue(0);
  redisMock.zadd.mockResolvedValue(1);
  redisMock.sadd.mockResolvedValue(1);
  redisMock.incrbyfloat.mockResolvedValue("0");
  redisMock.setex.mockResolvedValue("OK");
  redisMock.quit.mockResolvedValue("OK");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeatureStore", () => {
  let store: FeatureStore;

  beforeEach(() => {
    resetMocks();
    store = new FeatureStore("redis://localhost:6379");
  });

  afterEach(async () => {
    await store.close();
  });

  // -------------------------------------------------------------------------
  // getCustomerVelocity — feature extraction
  // -------------------------------------------------------------------------

  describe("getCustomerVelocity", () => {
    it("extracts transaction count, total amount, distinct merchants and cards from Redis", async () => {
      redisMock.zcount.mockResolvedValue(5);
      redisMock.get.mockResolvedValue("249.99");
      redisMock.scard.mockResolvedValueOnce(3).mockResolvedValueOnce(2);

      const result = await store.getCustomerVelocity("cust-001");

      expect(result.transactionCount).toBe(5);
      expect(result.totalAmount).toBeCloseTo(249.99);
      expect(result.distinctMerchants).toBe(3);
      expect(result.distinctCards).toBe(2);
    });

    it("honours a custom time window when querying zcount", async () => {
      redisMock.zcount.mockResolvedValue(2);
      redisMock.get.mockResolvedValue("50");
      redisMock.scard.mockResolvedValue(1);

      await store.getCustomerVelocity("cust-002", 30);

      // zcount is always called; the cutoff is a time calculation — we just
      // verify the call happened with the right key pattern.
      expect(redisMock.zcount).toHaveBeenCalledWith(
        expect.stringContaining("velocity:cust-002"),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it("returns missing-feature defaults (zeros) when Redis raises an error", async () => {
      redisMock.zcount.mockRejectedValue(new Error("connection refused"));

      const result = await store.getCustomerVelocity("cust-err");

      expect(result).toEqual({
        transactionCount: 0,
        totalAmount: 0,
        distinctMerchants: 0,
        distinctCards: 0,
      });
    });

    it("defaults totalAmount to 0 when Redis returns null for the amount key", async () => {
      redisMock.zcount.mockResolvedValue(3);
      redisMock.get.mockResolvedValue(null); // amount key missing
      redisMock.scard.mockResolvedValue(1);

      const result = await store.getCustomerVelocity("cust-003");

      expect(result.totalAmount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getIPVelocity — feature extraction
  // -------------------------------------------------------------------------

  describe("getIPVelocity", () => {
    it("extracts transaction count, distinct customers, and flagged count", async () => {
      redisMock.zcount.mockResolvedValueOnce(10).mockResolvedValueOnce(2);
      redisMock.scard.mockResolvedValue(4);

      const result = await store.getIPVelocity("1.2.3.4");

      expect(result.transactionCount).toBe(10);
      expect(result.distinctCustomers).toBe(4);
      expect(result.flaggedCount).toBe(2);
    });

    it("returns missing-feature defaults when Redis raises an error", async () => {
      redisMock.zcount.mockRejectedValue(new Error("timeout"));

      const result = await store.getIPVelocity("1.2.3.4");

      expect(result).toEqual({
        transactionCount: 0,
        distinctCustomers: 0,
        flaggedCount: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  // getEmailVelocity — feature extraction + email normalisation
  // -------------------------------------------------------------------------

  describe("getEmailVelocity", () => {
    it("extracts transaction count and distinct accounts", async () => {
      redisMock.zcount.mockResolvedValue(7);
      redisMock.scard.mockResolvedValue(3);

      const result = await store.getEmailVelocity("user@example.com");

      expect(result.transactionCount).toBe(7);
      expect(result.distinctAccounts).toBe(3);
    });

    it("normalises email to lower-case before building the Redis key", async () => {
      redisMock.zcount.mockResolvedValue(1);
      redisMock.scard.mockResolvedValue(1);

      await store.getEmailVelocity("User@EXAMPLE.COM");

      expect(redisMock.zcount).toHaveBeenCalledWith(
        expect.stringContaining("user@example.com"),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it("strips whitespace from email during normalisation", async () => {
      redisMock.zcount.mockResolvedValue(1);
      redisMock.scard.mockResolvedValue(1);

      await store.getEmailVelocity("  user @example.com  ");

      expect(redisMock.zcount).toHaveBeenCalledWith(
        expect.stringContaining("user@example.com"),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it("returns missing-feature defaults when Redis raises an error", async () => {
      redisMock.zcount.mockRejectedValue(new Error("socket hangup"));

      const result = await store.getEmailVelocity("user@example.com");

      expect(result).toEqual({ transactionCount: 0, distinctAccounts: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // storeTransactionFeature — write path
  // -------------------------------------------------------------------------

  describe("storeTransactionFeature", () => {
    it("writes customer, IP, and email velocity keys to Redis", async () => {
      await store.storeTransactionFeature("cust-1", "10.0.0.1", "a@b.com", "merch-1", "1234", 99.5);

      // Customer velocity sorted set
      expect(redisMock.zadd).toHaveBeenCalledWith(
        expect.stringContaining("velocity:cust-1"),
        expect.any(Number),
        expect.any(String),
      );
      // IP velocity sorted set
      expect(redisMock.zadd).toHaveBeenCalledWith(
        expect.stringContaining("velocity:ip:10.0.0.1"),
        expect.any(Number),
        expect.any(String),
      );
      // Email velocity sorted set (normalised)
      expect(redisMock.zadd).toHaveBeenCalledWith(
        expect.stringContaining("velocity:email:a@b.com"),
        expect.any(Number),
        expect.any(String),
      );
    });

    it("writes to the IP flagged sorted set only when isFlagged is true", async () => {
      await store.storeTransactionFeature("cust-1", "10.0.0.1", "a@b.com", "merch-1", "1234", 99.5, true);

      const flaggedCall = redisMock.zadd.mock.calls.find((args: string[]) =>
        String(args[0]).includes(":flagged"),
      );
      expect(flaggedCall).toBeDefined();
    });

    it("does NOT write to the IP flagged set when isFlagged is false (default)", async () => {
      await store.storeTransactionFeature("cust-1", "10.0.0.1", "a@b.com", "merch-1", "1234", 50);

      const flaggedCall = redisMock.zadd.mock.calls.find((args: string[]) =>
        String(args[0]).includes(":flagged"),
      );
      expect(flaggedCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getDeviceHistory
  // -------------------------------------------------------------------------

  describe("getDeviceHistory", () => {
    it("returns totalTransactions and flaggedTransactions from Redis", async () => {
      redisMock.get.mockResolvedValueOnce("20").mockResolvedValueOnce("3").mockResolvedValueOnce("3");

      const result = await store.getDeviceHistory("fp-abc");

      expect(result.totalTransactions).toBe(20);
      expect(result.flaggedTransactions).toBe(3);
    });

    it("defaults totalTransactions and flaggedTransactions to 0 when keys are absent", async () => {
      redisMock.get.mockResolvedValue(null);

      const result = await store.getDeviceHistory("fp-new");

      expect(result.totalTransactions).toBe(0);
      expect(result.flaggedTransactions).toBe(0);
      expect(result.isFlagged).toBe(false);
    });

    it("returns all-zero defaults when Redis raises an error", async () => {
      redisMock.get.mockRejectedValue(new Error("timeout"));

      const result = await store.getDeviceHistory("fp-err");

      expect(result).toEqual({ totalTransactions: 0, flaggedTransactions: 0, isFlagged: false });
    });
  });

  // -------------------------------------------------------------------------
  // getRegionFraudRate
  // -------------------------------------------------------------------------

  describe("getRegionFraudRate", () => {
    it("computes fraud rate as flagged / total", async () => {
      redisMock.zcount.mockResolvedValueOnce(100).mockResolvedValueOnce(10);

      const rate = await store.getRegionFraudRate("US");

      expect(rate).toBeCloseTo(0.1);
    });

    it("returns 0 when total transaction count is zero (avoids division by zero)", async () => {
      redisMock.zcount.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

      const rate = await store.getRegionFraudRate("XX");

      expect(rate).toBe(0);
    });

    it("returns 0 when Redis raises an error (missing-feature default)", async () => {
      redisMock.zcount.mockRejectedValue(new Error("connection lost"));

      const rate = await store.getRegionFraudRate("YY");

      expect(rate).toBe(0);
    });
  });
});
