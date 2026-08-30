/**
 * Cache-aside pattern helpers + tag-based invalidation (Issue #69).
 *
 * `getOrSet` implements the read path: check cache, on miss call the
 * loader, populate the cache (value + tag index), return the value.
 * `invalidate` implements exact-key, prefix, and tag-based eviction.
 *
 * Hit-ratio and per-key hit counters are tracked in-process via
 * `getCacheStats` / `resetCacheStats` — a real deployment would export
 * these to the cluster-wide metrics described in docs/deployment/redis-cluster.md
 * (Redis INFO / keyspace stats aggregated across nodes), which this module
 * cannot produce on its own since it only sees traffic from its own process.
 */
import type { CacheRedisClient } from "./client.js";
import type { CacheEntry, CacheInvalidation } from "./types.js";

const TAG_KEY_PREFIX = "cache:tag:";

function tagIndexKey(tag: string): string {
  return `${TAG_KEY_PREFIX}${tag}`;
}

export interface GetOrSetOptions<T> {
  ttlSeconds: number;
  tags?: string[];
  /** Called on a cache miss to produce the value that gets cached. */
  loader: () => Promise<T>;
}

interface CacheStats {
  hits: number;
  misses: number;
}

let stats: CacheStats = { hits: 0, misses: 0 };

/** In-process hit/miss counters for this instance (see module doc for scope). */
export function getCacheStats(): CacheStats & { hitRatio: number } {
  const total = stats.hits + stats.misses;
  return {
    ...stats,
    hitRatio: total === 0 ? 0 : stats.hits / total,
  };
}

/** Test-only seam: reset in-process hit/miss counters. */
export function resetCacheStats(): void {
  stats = { hits: 0, misses: 0 };
}

/**
 * Cache-aside read: return the cached value if present, otherwise invoke
 * `loader`, store the result (with TTL and tag index), and return it.
 *
 * Concurrency note: this does not implement single-flight / request
 * coalescing — two concurrent misses for the same key will both call
 * `loader`. That's an intentional simplicity tradeoff for a first cut;
 * callers with expensive loaders and high concurrency should add
 * coalescing (e.g. a per-key in-flight promise map) on top.
 */
export async function getOrSet<T>(
  client: CacheRedisClient,
  key: string,
  options: GetOrSetOptions<T>
): Promise<T> {
  const cached = await client.get(key);
  if (cached !== null) {
    stats.hits += 1;
    await client.incr(`cache:hits:${key}`);
    const entry = JSON.parse(cached) as CacheEntry<T>;
    return entry.value;
  }

  stats.misses += 1;
  const value = await options.loader();
  await setCacheEntry(client, key, value, options.ttlSeconds, options.tags ?? []);
  return value;
}

/** Write a value into the cache directly (bypassing the loader), with tags and TTL. */
export async function setCacheEntry<T>(
  client: CacheRedisClient,
  key: string,
  value: T,
  ttlSeconds: number,
  tags: string[] = []
): Promise<CacheEntry<T>> {
  const entry: CacheEntry<T> = {
    key,
    value,
    tags,
    ttlSeconds,
    createdAt: new Date().toISOString(),
    hits: 0,
  };

  await client.set(key, JSON.stringify(entry), "EX", ttlSeconds);

  for (const tag of tags) {
    await client.sadd(tagIndexKey(tag), key);
    // Tag index entries should not outlive the longest-lived member by much;
    // refreshing TTL on each add keeps abandoned tag sets from growing forever.
    await client.expire(tagIndexKey(tag), ttlSeconds);
  }

  return entry;
}

/**
 * Invalidate cache entries per the given `CacheInvalidation` request.
 *
 * - `mode: "exact"` deletes the literal keys in `tags` (treated as key
 *   names for this mode) or `pattern` if given as a literal key.
 * - `mode: "prefix"` uses `pattern` with `KEYS <pattern>*` and deletes
 *   all matches. `KEYS` is O(N) and blocking on a single Redis node;
 *   the deployment guide calls out `SCAN` for cluster-scale use — this
 *   helper favors simplicity/testability for the sandbox-scale cases
 *   this can actually be tested against.
 * - `mode: "tag"` looks up the tag's key-set (populated by `setCacheEntry`)
 *   and deletes every member, plus the tag-index set itself.
 *
 * Returns the number of cache keys removed (not counting tag-index bookkeeping keys).
 */
export async function invalidate(
  client: CacheRedisClient,
  request: CacheInvalidation
): Promise<number> {
  let deleted = 0;

  if (request.mode === "exact") {
    const keys = request.pattern ? [request.pattern] : request.tags;
    if (keys.length > 0) {
      deleted += await client.del(...keys);
    }
    return deleted;
  }

  if (request.mode === "prefix") {
    if (!request.pattern) return 0;
    const matches = await client.keys(`${request.pattern}*`);
    if (matches.length > 0) {
      deleted += await client.del(...matches);
    }
    return deleted;
  }

  // mode === "tag"
  for (const tag of request.tags) {
    const members = await client.smembers(tagIndexKey(tag));
    if (members.length > 0) {
      deleted += await client.del(...members);
      await client.srem(tagIndexKey(tag), ...members);
    }
    await client.del(tagIndexKey(tag));
  }
  return deleted;
}
