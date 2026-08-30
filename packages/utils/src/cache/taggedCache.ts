/**
 * Tag-based cache invalidation (Issue #70).
 *
 * A thin caching layer over Redis that lets callers tag cache entries and
 * invalidate every entry sharing a tag — or a wildcard tag pattern — in one
 * call, without needing to enumerate the individual keys involved. Also
 * supports namespace versioning: bumping a namespace's version lazily
 * invalidates every entry written under it, without having to delete each
 * key eagerly.
 *
 * Redis key schema:
 *   cache:entry:{key}         → JSON-serialized CacheEntry (value + tags + version)
 *   cache:tag:{tag}           → SET of cache keys carrying that tag
 *   cache:version:{namespace} → INCRed integer, bumped to invalidate a whole namespace
 *
 * This module is Redis-client-agnostic (see `TaggedCacheRedisClient`) so each
 * service can inject its own `ioredis` singleton rather than this package
 * taking a hard dependency on it.
 *
 * Out of scope for this change (left as follow-ups — see PR description):
 * invalidation webhooks/pub-sub fan-out to other cache tiers, a persisted
 * invalidation audit log, and tag-based cache warming.
 */

export interface RedisPipeline {
  sadd(key: string, ...members: string[]): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

/** Minimal subset of the ioredis client API this module depends on. */
export interface TaggedCacheRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  scan(
    cursor: string,
    matchFlag: "MATCH",
    pattern: string,
    countFlag: "COUNT",
    count: number,
  ): Promise<[string, string[]]>;
  incr(key: string): Promise<number>;
  multi(): RedisPipeline;
}

export interface TaggedCacheEntry<T = unknown> {
  key: string;
  value: T;
  tags: string[];
  namespace: string | null;
  version: number;
  ttlSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface SetOptions {
  /** Tags this entry should be invalidated by. */
  tags?: string[];
  /** Time-to-live in seconds. Defaults to 1 hour. */
  ttlSeconds?: number;
  /** Namespace used for version-based bulk invalidation. */
  namespace?: string;
}

export interface InvalidationResult {
  invalidatedKeys: string[];
  affectedEntries: number;
  durationMs: number;
  errors: Array<{ key: string; error: string }>;
}

const ENTRY_PREFIX = "cache:entry:";
const TAG_PREFIX = "cache:tag:";
const VERSION_PREFIX = "cache:version:";
const DEFAULT_TTL_SECONDS = 3600;
const SCAN_COUNT = 200;

function entryKey(key: string): string {
  return `${ENTRY_PREFIX}${key}`;
}

function tagKey(tag: string): string {
  return `${TAG_PREFIX}${tag}`;
}

function versionKey(namespace: string): string {
  return `${VERSION_PREFIX}${namespace}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TaggedCache {
  constructor(private readonly redis: TaggedCacheRedisClient) {}

  /** Write a value, tagging it for later bulk invalidation. */
  async set<T>(key: string, value: T, options: SetOptions = {}): Promise<void> {
    const { tags = [], ttlSeconds = DEFAULT_TTL_SECONDS, namespace = null } = options;
    const version = namespace ? await this.getVersion(namespace) : 0;
    const now = new Date().toISOString();

    const entry: TaggedCacheEntry<T> = {
      key,
      value,
      tags,
      namespace,
      version,
      ttlSeconds,
      createdAt: now,
      updatedAt: now,
    };

    await this.redis.set(entryKey(key), JSON.stringify(entry), "EX", ttlSeconds);

    if (tags.length > 0) {
      const pipeline = this.redis.multi();
      for (const tag of tags) {
        pipeline.sadd(tagKey(tag), key);
      }
      await pipeline.exec();
    }
  }

  /**
   * Read a value back. Returns `null` on a miss, on expiry, or when the
   * entry's namespace has been bumped past the entry's stored version
   * (lazy invalidation — no eager delete required on version bump).
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(entryKey(key));
    if (raw === null) return null;

    const entry = JSON.parse(raw) as TaggedCacheEntry<T>;

    if (entry.namespace) {
      const currentVersion = await this.getVersion(entry.namespace);
      if (currentVersion !== entry.version) {
        return null;
      }
    }

    return entry.value;
  }

  /** Directly delete a single entry (does not clean up its tag memberships). */
  async delete(key: string): Promise<void> {
    await this.redis.del(entryKey(key));
  }

  /** Current version for a namespace (0 if it has never been bumped). */
  async getVersion(namespace: string): Promise<number> {
    const raw = await this.redis.get(versionKey(namespace));
    return raw ? parseInt(raw, 10) : 0;
  }

  /** Bump a namespace's version, lazily invalidating every entry within it. */
  async bumpVersion(namespace: string): Promise<number> {
    return this.redis.incr(versionKey(namespace));
  }

  /** Invalidate every entry carrying `tag`. */
  async invalidateByTag(tag: string): Promise<InvalidationResult> {
    return this.invalidateByTags([tag]);
  }

  /** Invalidate every entry carrying any of `tags`. */
  async invalidateByTags(tags: string[]): Promise<InvalidationResult> {
    const start = Date.now();
    const errors: Array<{ key: string; error: string }> = [];
    const keysToInvalidate = new Set<string>();

    for (const tag of tags) {
      try {
        const members = await this.redis.smembers(tagKey(tag));
        for (const member of members) keysToInvalidate.add(member);
      } catch (err) {
        errors.push({ key: tagKey(tag), error: errorMessage(err) });
      }
    }

    const invalidatedKeys: string[] = [];
    for (const key of keysToInvalidate) {
      try {
        await this.redis.del(entryKey(key));
        invalidatedKeys.push(key);
      } catch (err) {
        errors.push({ key, error: errorMessage(err) });
      }
    }

    // Best-effort cleanup of the tag sets themselves — a failure here just
    // leaves a stale tag pointing at already-deleted entries, which
    // self-heals the next time this tag is invalidated.
    try {
      await this.redis.del(...tags.map(tagKey));
    } catch {
      // ignore
    }

    return {
      invalidatedKeys,
      affectedEntries: invalidatedKeys.length,
      durationMs: Date.now() - start,
      errors,
    };
  }

  /**
   * Invalidate every tag matching a Redis glob `pattern` (e.g. `"user:*"`),
   * and every entry carrying one of those tags.
   */
  async invalidateByPattern(pattern: string): Promise<InvalidationResult> {
    const start = Date.now();
    const matchingTags: string[] = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        tagKey(pattern),
        "COUNT",
        SCAN_COUNT,
      );
      cursor = nextCursor;
      for (const key of keys) matchingTags.push(key.slice(TAG_PREFIX.length));
    } while (cursor !== "0");

    if (matchingTags.length === 0) {
      return { invalidatedKeys: [], affectedEntries: 0, durationMs: Date.now() - start, errors: [] };
    }

    const result = await this.invalidateByTags(matchingTags);
    return { ...result, durationMs: Date.now() - start };
  }
}
