import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  NotificationDeduplicator,
  type NotificationEvent,
  type DeduplicationConfig,
} from "./deduplication.js";

function createMockRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();

  return {
    set: vi.fn(async (key: string, value: string, ex?: string, ttl?: number, nx?: string) => {
      if (nx === "NX" && store.has(key)) {
        return null;
      }
      store.set(key, value);
      if (ex === "EX" && ttl) {
        ttls.set(key, Date.now() + ttl * 1000);
      }
      return "OK";
    }),
    ttl: vi.fn(async (key: string) => {
      const expiry = ttls.get(key);
      if (!expiry) return -1;
      return Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
    }),
    pipeline: vi.fn(() => {
      const commands: Array<{ key: string; args: unknown[] }> = [];
      return {
        set: vi.fn((key: string, value: string, ex?: string, ttl?: number, nx?: string) => {
          commands.push({ key, args: [key, value, ex, ttl, nx] });
        }),
        exec: vi.fn(async () => {
          return commands.map(({ key, args }) => {
            const nx = args[4];
            if (nx === "NX" && store.has(key)) {
              return [null, null];
            }
            store.set(key, args[1] as string);
            return [null, "OK"];
          });
        }),
      };
    }),
    hset: vi.fn(async () => "OK"),
    hgetall: vi.fn(async () => null),
  };
}

describe("NotificationDeduplicator", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let deduplicator: NotificationDeduplicator;

  const testEvent: NotificationEvent = {
    userId: "user-123",
    category: "transaction",
    type: "payment_received",
    identifier: "tx-456",
    payload: { amount: "100" },
  };

  beforeEach(() => {
    redis = createMockRedis();
    deduplicator = new NotificationDeduplicator(redis as any);
  });

  describe("check", () => {
    it("should allow new notifications", async () => {
      const result = await deduplicator.check(testEvent);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("new");
    });

    it("should block duplicate notifications within window", async () => {
      await deduplicator.check(testEvent);
      const result = await deduplicator.check(testEvent);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("duplicate");
      expect(result.windowExpiresAt).toBeDefined();
    });

    it("should bypass critical categories", async () => {
      const criticalEvent: NotificationEvent = {
        ...testEvent,
        category: "security",
      };

      const result = await deduplicator.check(criticalEvent);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("bypassed");
    });

    it("should allow notifications when disabled", async () => {
      const disabledDedup = new NotificationDeduplicator(redis as any, {
        enabled: false,
      });

      await disabledDedup.check(testEvent);
      const result = await disabledDedup.check(testEvent);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("new");
    });

    it("should use custom key generator", async () => {
      const customDedup = new NotificationDeduplicator(redis as any, {
        keyGenerator: (event) => `custom:${event.identifier}`,
      });

      const result = await customDedup.check(testEvent);

      expect(result.allowed).toBe(true);
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining("custom:tx-456"),
        "1",
        "EX",
        expect.any(Number),
        "NX"
      );
    });

    it("should handle Redis errors gracefully", async () => {
      redis.set.mockRejectedValueOnce(new Error("Redis connection failed"));

      const result = await deduplicator.check(testEvent);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe("new");
    });
  });

  describe("checkBatch", () => {
    it("should check multiple events in batch", async () => {
      const events: NotificationEvent[] = [
        testEvent,
        { ...testEvent, identifier: "tx-789" },
        { ...testEvent, identifier: "tx-101" },
      ];

      const results = await deduplicator.checkBatch(events);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.allowed)).toBe(true);
    });

    it("should detect duplicates in batch", async () => {
      await deduplicator.check(testEvent);

      const results = await deduplicator.checkBatch([testEvent]);

      expect(results[0].allowed).toBe(false);
      expect(results[0].reason).toBe("duplicate");
    });

    it("should bypass critical events in batch", async () => {
      const events: NotificationEvent[] = [
        testEvent,
        { ...testEvent, category: "security" },
      ];

      const results = await deduplicator.checkBatch(events);

      expect(results[0].reason).toBe("new");
      expect(results[1].reason).toBe("bypassed");
    });
  });

  describe("metrics", () => {
    it("should track deduplication metrics", async () => {
      await deduplicator.check(testEvent);
      await deduplicator.check(testEvent);
      await deduplicator.check({ ...testEvent, category: "security" });

      const metrics = await deduplicator.getMetrics();

      expect(metrics.totalChecks).toBe(3);
      expect(metrics.allowed).toBe(1);
      expect(metrics.duplicatesBlocked).toBe(1);
      expect(metrics.bypassed).toBe(1);
      expect(metrics.deduplicationRate).toBeCloseTo(1 / 3);
    });

    it("should reset metrics", async () => {
      await deduplicator.check(testEvent);
      await deduplicator.resetMetrics();

      const metrics = await deduplicator.getMetrics();

      expect(metrics.totalChecks).toBe(0);
      expect(metrics.duplicatesBlocked).toBe(0);
    });

    it("should store metrics to Redis", async () => {
      await deduplicator.check(testEvent);
      await deduplicator.storeMetrics();

      expect(redis.hset).toHaveBeenCalledWith(
        "notif:dedup:metrics",
        expect.objectContaining({
          totalChecks: "1",
          lastUpdated: expect.any(String),
        })
      );
    });
  });

  describe("scope", () => {
    it("should deduplicate per user by default", async () => {
      const user1Event = { ...testEvent, userId: "user-1" };
      const user2Event = { ...testEvent, userId: "user-2" };

      await deduplicator.check(user1Event);
      const result = await deduplicator.check(user2Event);

      expect(result.allowed).toBe(true);
    });

    it("should deduplicate globally when scope is global", async () => {
      const globalDedup = new NotificationDeduplicator(redis as any, {
        scope: "global",
      });

      const user1Event = { ...testEvent, userId: "user-1" };
      const user2Event = { ...testEvent, userId: "user-2" };

      await globalDedup.check(user1Event);
      const result = await globalDedup.check(user2Event);

      expect(result.allowed).toBe(false);
    });
  });
});
