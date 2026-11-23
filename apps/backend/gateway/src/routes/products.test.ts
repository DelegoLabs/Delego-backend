import { describe, expect, it, vi } from "vitest";
import { getProductStockLevel } from "./products.js";

describe("getProductStockLevel", () => {
  it("returns the cached response when Redis has a value", async () => {
    const redis = {
      async get(key: string) {
        if (key === "stock:product-123") {
          return JSON.stringify({
            productId: "product-123",
            totalAvailable: 12,
            reserved: 3,
            inStock: true,
            lowStockWarning: false,
          });
        }
        return null;
      },
      async set() { return "OK"; },
      async del() { return 1; },
    };

    const lookup = vi.fn(async () => ({
      productId: "product-123",
      totalAvailable: 99,
      reserved: 0,
      inStock: true,
      lowStockWarning: false,
    }));

    const result = await getProductStockLevel("product-123", {
      redis,
      lookupProductStock: lookup,
      lockWaitMs: 0,
    });

    expect(result.totalAvailable).toBe(12);
    expect(result.reserved).toBe(3);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("protects against cache stampedes by ensuring only one database fetch occurs during a miss", async () => {
    const redis = {
      store: new Map<string, string>(),
      async get(key: string) {
        return this.store.get(key) ?? null;
      },
      async set(key: string, value: string, ...args: unknown[]) {
        this.store.set(key, value);
        return "OK";
      },
      async del(key: string) {
        this.store.delete(key);
        return 1;
      },
    };

    let fetchCount = 0;
    const lookup = vi.fn(async () => {
      fetchCount += 1;
      return {
        productId: "product-456",
        totalAvailable: 7,
        reserved: 1,
        inStock: true,
        lowStockWarning: true,
      };
    });

    const results = await Promise.all([
      getProductStockLevel("product-456", { redis, lookupProductStock: lookup, lockWaitMs: 5, ttlSeconds: 30 }),
      getProductStockLevel("product-456", { redis, lookupProductStock: lookup, lockWaitMs: 5, ttlSeconds: 30 }),
      getProductStockLevel("product-456", { redis, lookupProductStock: lookup, lockWaitMs: 5, ttlSeconds: 30 }),
    ]);

    expect(fetchCount).toBe(1);
    expect(results.every((r) => r.totalAvailable === 7)).toBe(true);
    expect(await redis.get("stock:product-456")).toContain('"productId":"product-456"');
  });

  it("benchmarks cache hits above 1000 req/sec", async () => {
    const store = new Map<string, string>();
    const redis = {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async set(key: string, value: string) {
        store.set(key, value);
        return "OK";
      },
      async del(key: string) {
        store.delete(key);
        return 1;
      },
    };

    const payload = {
      productId: "product-789",
      totalAvailable: 42,
      reserved: 2,
      inStock: true,
      lowStockWarning: false,
    };
    await redis.set("stock:product-789", JSON.stringify(payload));

    const lookup = vi.fn(async () => ({ ...payload, totalAvailable: 999 }));
    const start = performance.now();
    const iterations = 2000;

    for (let index = 0; index < iterations; index += 1) {
      const result = await getProductStockLevel("product-789", { redis, lookupProductStock: lookup, lockWaitMs: 0 });
      expect(result.totalAvailable).toBe(42);
    }

    const elapsedMs = performance.now() - start;
    const throughputRps = iterations / (elapsedMs / 1000);
    expect(throughputRps).toBeGreaterThan(1000);
    expect(lookup).not.toHaveBeenCalled();
  });
});
