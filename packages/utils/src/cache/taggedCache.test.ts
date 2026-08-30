/**
 * Unit tests for #70 — tag-based cache invalidation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TaggedCache, type TaggedCacheRedisClient, type RedisPipeline } from "./taggedCache.js";

// ─── In-memory fake Redis client (mirrors the ioredis subset we depend on) ──

function buildFakeRedis(): TaggedCacheRedisClient {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();

  const client: TaggedCacheRedisClient = {
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async del(...keys) {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key)) count++;
        if (sets.delete(key)) count++;
      }
      return count;
    },
    async smembers(key) {
      return [...(sets.get(key) ?? new Set())];
    },
    async scan(cursor, _matchFlag, pattern) {
      if (cursor !== "0") return ["0", []];
      const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
      const matches = [...sets.keys()].filter((k) => regex.test(k));
      return ["0", matches];
    },
    async incr(key) {
      const current = store.has(key) ? parseInt(store.get(key)!, 10) : 0;
      const next = current + 1;
      store.set(key, String(next));
      return next;
    },
    multi() {
      const ops: Array<() => void> = [];
      const pipeline: RedisPipeline = {
        sadd(key, ...members) {
          ops.push(() => {
            const set = sets.get(key) ?? new Set<string>();
            for (const m of members) set.add(m);
            sets.set(key, set);
          });
          return pipeline;
        },
        async exec() {
          for (const op of ops) op();
          return ops.map(() => [null, 1]);
        },
      };
      return pipeline;
    },
  };

  return client;
}

describe("TaggedCache", () => {
  let redis: TaggedCacheRedisClient;
  let cache: TaggedCache;

  beforeEach(() => {
    redis = buildFakeRedis();
    cache = new TaggedCache(redis);
  });

  it("round-trips a value with no tags", async () => {
    await cache.set("user:1", { name: "Ada" });
    await expect(cache.get("user:1")).resolves.toEqual({ name: "Ada" });
  });

  it("returns null for a missing key", async () => {
    await expect(cache.get("nope")).resolves.toBeNull();
  });

  it("invalidates every entry sharing an invalidated tag", async () => {
    await cache.set("user:1", "a", { tags: ["users"] });
    await cache.set("user:2", "b", { tags: ["users"] });
    await cache.set("order:1", "c", { tags: ["orders"] });

    const result = await cache.invalidateByTag("users");

    expect(result.affectedEntries).toBe(2);
    expect(result.invalidatedKeys.sort()).toEqual(["user:1", "user:2"]);
    expect(result.errors).toEqual([]);

    await expect(cache.get("user:1")).resolves.toBeNull();
    await expect(cache.get("user:2")).resolves.toBeNull();
    // Untagged/differently-tagged entries survive.
    await expect(cache.get("order:1")).resolves.toBe("c");
  });

  it("supports an entry carrying multiple tags", async () => {
    await cache.set("order:1", "c", { tags: ["orders", "user:1"] });

    await cache.invalidateByTag("user:1");

    await expect(cache.get("order:1")).resolves.toBeNull();
  });

  it("invalidates by wildcard tag pattern", async () => {
    await cache.set("a", "1", { tags: ["region:us-east"] });
    await cache.set("b", "2", { tags: ["region:us-west"] });
    await cache.set("c", "3", { tags: ["region:eu"] });

    const result = await cache.invalidateByPattern("region:us-*");

    expect(result.affectedEntries).toBe(2);
    await expect(cache.get("a")).resolves.toBeNull();
    await expect(cache.get("b")).resolves.toBeNull();
    await expect(cache.get("c")).resolves.toBe("3");
  });

  it("invalidateByPattern is a no-op when nothing matches", async () => {
    const result = await cache.invalidateByPattern("nothing:*");
    expect(result).toEqual({ invalidatedKeys: [], affectedEntries: 0, durationMs: expect.any(Number), errors: [] });
  });

  it("bumping a namespace version lazily invalidates its entries without deleting them", async () => {
    await cache.set("profile:1", "v1", { namespace: "profiles" });
    await expect(cache.get("profile:1")).resolves.toBe("v1");

    await cache.bumpVersion("profiles");

    // The Redis key is untouched (still present) but reads are stale.
    await expect(redis.get("cache:entry:profile:1")).resolves.not.toBeNull();
    await expect(cache.get("profile:1")).resolves.toBeNull();
  });

  it("entries in a namespace that hasn't been bumped remain readable", async () => {
    await cache.set("profile:1", "v1", { namespace: "profiles" });
    await cache.bumpVersion("other-namespace");

    await expect(cache.get("profile:1")).resolves.toBe("v1");
  });

  it("writes made after a version bump are readable again", async () => {
    await cache.set("profile:1", "v1", { namespace: "profiles" });
    await cache.bumpVersion("profiles");
    await expect(cache.get("profile:1")).resolves.toBeNull();

    await cache.set("profile:1", "v2", { namespace: "profiles" });
    await expect(cache.get("profile:1")).resolves.toBe("v2");
  });

  it("delete() removes a single entry directly", async () => {
    await cache.set("k", "v");
    await cache.delete("k");
    await expect(cache.get("k")).resolves.toBeNull();
  });

  it("collects per-key errors without failing the whole invalidation", async () => {
    await cache.set("bad:1", "x", { tags: ["broken"] });

    const failingRedis: TaggedCacheRedisClient = {
      ...redis,
      async del(...keys: string[]) {
        if (keys[0] === "cache:entry:bad:1") {
          throw new Error("boom");
        }
        return redis.del(...keys);
      },
    };
    const failingCache = new TaggedCache(failingRedis);

    const result = await failingCache.invalidateByTag("broken");

    expect(result.affectedEntries).toBe(0);
    expect(result.errors).toEqual([{ key: "bad:1", error: "boom" }]);
  });

  it("passes the configured TTL through to the underlying set() call", async () => {
    const calls: Array<[string, string, string, number]> = [];
    const spyRedis: TaggedCacheRedisClient = {
      ...redis,
      async set(key, value, mode, seconds) {
        calls.push([key, value, mode, seconds]);
        return redis.set(key, value, mode, seconds);
      },
    };

    await new TaggedCache(spyRedis).set("k", "v", { ttlSeconds: 42 });

    expect(calls[0][0]).toBe("cache:entry:k");
    expect(calls[0][2]).toBe("EX");
    expect(calls[0][3]).toBe(42);
  });
});
