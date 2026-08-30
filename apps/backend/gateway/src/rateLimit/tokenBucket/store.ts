/**
 * Token bucket storage backend (Issue #51).
 *
 * The bucket state (`tokens`, `lastRefillMs`) must be read, refilled, and
 * decremented atomically per key — otherwise concurrent requests from the
 * same caller can each read a stale token count and both be admitted past
 * the limit. Two backends:
 *
 *  - `RedisTokenBucketStore`: a Lua script (`EVAL`) does the refill+consume
 *    math atomically inside Redis — safe across multiple gateway processes.
 *  - `InMemoryTokenBucketStore`: plain JS on a `Map`, used in tests/CI and
 *    local dev. Node's single-threaded event loop makes this equally atomic
 *    for a single process, matching the mock-fallback pattern used
 *    elsewhere in this codebase (e.g. the escrow funding lock).
 */

import { getRedisClient } from "../redisClient.js";

export interface ConsumeResult {
  /** Tokens left in the bucket *after* this attempt (whether or not it was allowed). */
  tokensRemaining: number;
  allowed: boolean;
}

export interface TokenBucketStore {
  /**
   * Attempts to consume `cost` tokens from the bucket at `key`, refilling it
   * first based on elapsed time since the last touch.
   */
  consume(
    key: string,
    capacity: number,
    refillPerMs: number,
    cost: number,
    nowMs: number,
    ttlSeconds: number
  ): Promise<ConsumeResult>;
}

// ---------------------------------------------------------------------------
// Redis backend (production) — atomic via a Lua script
// ---------------------------------------------------------------------------

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttlSeconds = tonumber(ARGV[5])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then
  elapsed = 0
end
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttlSeconds)

return {allowed, tostring(tokens)}
`;

type EvalClient = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
};

export class RedisTokenBucketStore implements TokenBucketStore {
  constructor(private readonly client: EvalClient = getRedisClient() as unknown as EvalClient) {}

  async consume(
    key: string,
    capacity: number,
    refillPerMs: number,
    cost: number,
    nowMs: number,
    ttlSeconds: number
  ): Promise<ConsumeResult> {
    const raw = (await this.client.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      capacity,
      refillPerMs,
      cost,
      nowMs,
      ttlSeconds
    )) as [number, string];

    const [allowedFlag, tokensStr] = raw;
    return { allowed: allowedFlag === 1, tokensRemaining: Number(tokensStr) };
  }
}

// ---------------------------------------------------------------------------
// In-memory backend (tests / CI / local dev)
// ---------------------------------------------------------------------------

interface BucketState {
  tokens: number;
  ts: number;
}

export class InMemoryTokenBucketStore implements TokenBucketStore {
  private readonly buckets = new Map<string, BucketState>();

  async consume(
    key: string,
    capacity: number,
    refillPerMs: number,
    cost: number,
    nowMs: number
  ): Promise<ConsumeResult> {
    const existing = this.buckets.get(key);
    let tokens = existing?.tokens ?? capacity;
    const ts = existing?.ts ?? nowMs;

    const elapsed = Math.max(0, nowMs - ts);
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);

    const allowed = tokens >= cost;
    if (allowed) {
      tokens -= cost;
    }

    this.buckets.set(key, { tokens, ts: nowMs });
    return { allowed, tokensRemaining: tokens };
  }

  /** Test helper — clears all bucket state between test cases. */
  reset(): void {
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

function isMockMode(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.MOCK_REDIS === "true" ||
    process.env.CI === "true" ||
    Object.keys(process.env).some((k) => k.includes("TEST"))
  );
}

let store: TokenBucketStore | null = null;

export function getTokenBucketStore(): TokenBucketStore {
  if (!store) {
    store = isMockMode() ? new InMemoryTokenBucketStore() : new RedisTokenBucketStore();
  }
  return store;
}

export function setTokenBucketStore(newStore: TokenBucketStore): void {
  store = newStore;
}

export function resetTokenBucketStore(): void {
  store = null;
}
