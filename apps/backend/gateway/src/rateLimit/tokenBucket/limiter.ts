/**
 * Token bucket rate limiter with tiers (Issue #51).
 *
 * Each `(identifier, tier, endpoint, method)` combination gets its own
 * bucket, sized `requestsPerWindow + burstAllowance` tokens, refilling at
 * `refillRatePerSecond`. A steady caller under the per-window rate never
 * empties the bucket; a caller who bursts above it can still borrow from
 * `burstAllowance` before being throttled, then must wait for tokens to
 * trickle back in.
 */

import { recordRateLimitOutcome } from "./metrics.js";
import { resolveRateLimitConfig } from "./tierConfig.js";
import { getTokenBucketStore } from "./store.js";
import type { RateLimitConfig, RateLimitKey, RateLimitResult } from "./types.js";

/** How long an idle bucket survives in Redis before it's evicted (2x the window is generous headroom). */
function ttlSecondsFor(config: RateLimitConfig): number {
  return Math.max(60, Math.ceil((config.windowMs / 1000) * 2));
}

function bucketKey(key: RateLimitKey): string {
  const endpoint = key.method && key.endpoint ? `${key.method}:${key.endpoint}` : "global";
  return `ratebucket:${key.tier}:${key.identifier}:${endpoint}`;
}

function metricsKey(key: RateLimitKey): string {
  const endpoint = key.method && key.endpoint ? `${key.method}:${key.endpoint}` : "global";
  return `${key.identifier}:${endpoint}`;
}

/**
 * Checks (and consumes from) the caller's token bucket for this request.
 *
 * @param key            Identifies the caller and, optionally, the endpoint being called.
 * @param overrideConfig Bypasses tier/endpoint resolution entirely — mainly for tests.
 */
export async function checkRateLimit(
  key: RateLimitKey,
  overrideConfig?: RateLimitConfig
): Promise<RateLimitResult> {
  const config = overrideConfig ?? resolveRateLimitConfig(key.tier, key.endpoint, key.method);
  const capacity = config.requestsPerWindow + config.burstAllowance;
  const refillPerMs = config.refillRatePerSecond / 1000;
  const now = Date.now();

  const store = getTokenBucketStore();
  const { allowed, tokensRemaining } = await store.consume(
    bucketKey(key),
    capacity,
    refillPerMs,
    1,
    now,
    ttlSecondsFor(config)
  );

  recordRateLimitOutcome(metricsKey(key), allowed);

  const remaining = Math.max(0, Math.floor(tokensRemaining));
  const msUntilFull = refillPerMs > 0 ? (capacity - tokensRemaining) / refillPerMs : 0;
  const resetAt = new Date(now + Math.max(0, msUntilFull)).toISOString();

  const result: RateLimitResult = {
    allowed,
    remaining,
    resetAt,
    limit: capacity,
  };

  if (!allowed) {
    const msUntilNextToken = refillPerMs > 0 ? (1 - tokensRemaining) / refillPerMs : config.windowMs;
    result.retryAfterMs = Math.max(0, Math.ceil(msUntilNextToken));
  }

  return result;
}
