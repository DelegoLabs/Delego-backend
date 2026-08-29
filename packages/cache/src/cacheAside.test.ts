import { describe, it, expect, beforeEach } from "vitest";
// @ts-ignore -- ioredis-mock has no first-party types
import MockRedis from "ioredis-mock";
import { getOrSet, setCacheEntry, invalidate, getCacheStats, resetCacheStats } from "./cacheAside.js";
import type { CacheRedisClient } from "./client.js";

/**
 * ioredis-mock (v6+) simulates a shared Redis *server*: separate
 * `new MockRedis()` instances on the same host:port all read/write the
 * same in-memory keyspace, mirroring real Redis. Each test needs its own
 * isolated keyspace, so we give every client a distinct fake port.
 */
let nextMockPort = 10000;
function newClient(): CacheRedisClient {
  return new MockRedis(nextMockPort++) as unknown as CacheRedisClient;
}

describe("getOrSet", () => {
  let client: CacheRedisClient;

  beforeEach(() => {
    client = newClient();
    resetCacheStats();
  });

  it("calls the loader on a miss and caches the result", async () => {
    let loaderCalls = 0;
    const value = await getOrSet(client, "user:1", {
      ttlSeconds: 60,
      loader: async () => {
        loaderCalls += 1;
        return { id: "1", name: "Ada" };
      },
    });

    expect(value).toEqual({ id: "1", name: "Ada" });
    expect(loaderCalls).toBe(1);
  });

  it("returns the cached value on a hit without calling the loader again", async () => {
    let loaderCalls = 0;
    const loader = async () => {
      loaderCalls += 1;
      return { id: "1", name: "Ada" };
    };

    await getOrSet(client, "user:1", { ttlSeconds: 60, loader });
    const second = await getOrSet(client, "user:1", { ttlSeconds: 60, loader });

    expect(second).toEqual({ id: "1", name: "Ada" });
    expect(loaderCalls).toBe(1);
  });

  it("tracks hit/miss stats and computes hit ratio", async () => {
    const loader = async () => "value";
    await getOrSet(client, "k1", { ttlSeconds: 60, loader }); // miss
    await getOrSet(client, "k1", { ttlSeconds: 60, loader }); // hit
    await getOrSet(client, "k1", { ttlSeconds: 60, loader }); // hit

    const stats = getCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.hitRatio).toBeCloseTo(2 / 3);
  });

  it("respects TTL by expiring the underlying key", async () => {
    await getOrSet(client, "short-lived", {
      ttlSeconds: 60,
      loader: async () => "v",
    });
    const ttl = await (client as any).ttl("short-lived");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});

describe("setCacheEntry", () => {
  it("stores tags in per-tag index sets", async () => {
    const client = newClient();
    await setCacheEntry(client, "product:1", { id: "1" }, 120, ["products", "catalog"]);

    const productsMembers = await client.smembers("cache:tag:products");
    const catalogMembers = await client.smembers("cache:tag:catalog");

    expect(productsMembers).toContain("product:1");
    expect(catalogMembers).toContain("product:1");
  });

  it("returns the CacheEntry with createdAt and hits populated", async () => {
    const client = newClient();
    const entry = await setCacheEntry(client, "k", "v", 30, ["tag-a"]);

    expect(entry.key).toBe("k");
    expect(entry.value).toBe("v");
    expect(entry.tags).toEqual(["tag-a"]);
    expect(entry.ttlSeconds).toBe(30);
    expect(entry.hits).toBe(0);
    expect(() => new Date(entry.createdAt)).not.toThrow();
    expect(Number.isNaN(new Date(entry.createdAt).getTime())).toBe(false);
  });
});

describe("invalidate", () => {
  let client: CacheRedisClient;

  beforeEach(() => {
    client = newClient();
  });

  it("mode=exact deletes the literal keys", async () => {
    await setCacheEntry(client, "a", 1, 60);
    await setCacheEntry(client, "b", 2, 60);

    const deleted = await invalidate(client, { tags: ["a", "b"], mode: "exact" });

    expect(deleted).toBe(2);
    expect(await client.get("a")).toBeNull();
    expect(await client.get("b")).toBeNull();
  });

  it("mode=prefix deletes all matching keys", async () => {
    await setCacheEntry(client, "session:1", "x", 60);
    await setCacheEntry(client, "session:2", "y", 60);
    await setCacheEntry(client, "other:1", "z", 60);

    const deleted = await invalidate(client, { tags: [], pattern: "session:", mode: "prefix" });

    expect(deleted).toBe(2);
    expect(await client.get("session:1")).toBeNull();
    expect(await client.get("session:2")).toBeNull();
    expect(await client.get("other:1")).not.toBeNull();
  });

  it("mode=tag deletes every member tagged with any of the given tags", async () => {
    await setCacheEntry(client, "product:1", "a", 60, ["catalog"]);
    await setCacheEntry(client, "product:2", "b", 60, ["catalog"]);
    await setCacheEntry(client, "order:1", "c", 60, ["orders"]);

    const deleted = await invalidate(client, { tags: ["catalog"], mode: "tag" });

    expect(deleted).toBe(2);
    expect(await client.get("product:1")).toBeNull();
    expect(await client.get("product:2")).toBeNull();
    expect(await client.get("order:1")).not.toBeNull();

    const remainingTagMembers = await client.smembers("cache:tag:catalog");
    expect(remainingTagMembers).toEqual([]);
  });

  it("mode=tag with an unknown tag deletes nothing and does not throw", async () => {
    const deleted = await invalidate(client, { tags: ["does-not-exist"], mode: "tag" });
    expect(deleted).toBe(0);
  });

  it("mode=prefix with no pattern returns 0", async () => {
    const deleted = await invalidate(client, { tags: [], mode: "prefix" });
    expect(deleted).toBe(0);
  });

  it("mode=exact with an empty key list returns 0", async () => {
    const deleted = await invalidate(client, { tags: [], mode: "exact" });
    expect(deleted).toBe(0);
  });
});
