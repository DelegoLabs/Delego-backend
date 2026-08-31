/** Token Bucket Rate Limiting with Tiers (Issue #51) — public API. */

export { checkRateLimit } from "./limiter.js";
export { resolveTier } from "./tierResolver.js";
export {
  DEFAULT_TIER_CONFIGS,
  ENDPOINT_OVERRIDES,
  normalizeTier,
  resolveRateLimitConfig,
} from "./tierConfig.js";
export { getRateLimitMetrics, recordRateLimitOutcome, resetRateLimitMetrics } from "./metrics.js";
export {
  getTokenBucketStore,
  setTokenBucketStore,
  resetTokenBucketStore,
  InMemoryTokenBucketStore,
  RedisTokenBucketStore,
  type ConsumeResult,
  type TokenBucketStore,
} from "./store.js";
export type { RateLimitConfig, RateLimitKey, RateLimitMetrics, RateLimitResult, RateLimitTier } from "./types.js";
