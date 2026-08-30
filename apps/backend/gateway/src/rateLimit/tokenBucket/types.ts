/**
 * Token Bucket Rate Limiting with Tiers (Issue #51).
 *
 * Lives alongside the legacy fixed-window limiter (`../rateLimiter.ts`) —
 * this is the tiered, burst-aware engine that actually backs the gateway's
 * `rateLimitMiddleware`. The legacy module stays in place only for its own
 * admin-analytics dashboard (`../analytics.ts`), which reads a different
 * Redis key scheme.
 */

export type RateLimitTier = "free" | "pro" | "enterprise" | "internal";

export interface RateLimitConfig {
  tier: RateLimitTier;
  /** Steady-state requests allowed per window — also the bucket's base capacity. */
  requestsPerWindow: number;
  windowMs: number;
  /** Extra tokens available on top of the steady-state capacity for bursts. */
  burstAllowance: number;
  /** Tokens restored per second once consumed (drives how fast a caller recovers after a burst). */
  refillRatePerSecond: number;
}

export interface RateLimitKey {
  /** User ID, API key, or IP — whatever identifies the caller. */
  identifier: string;
  tier: string;
  endpoint?: string;
  method?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** ISO-8601 timestamp for when the bucket is back to full capacity. */
  resetAt: string;
  limit: number;
  /** Present only when `allowed` is false — ms until at least one token is available. */
  retryAfterMs?: number;
}

export interface RateLimitMetrics {
  totalRequests: number;
  allowedRequests: number;
  deniedRequests: number;
  /** 0-1 — deniedRequests / totalRequests over the observed window (0 when no requests seen). */
  currentUtilization: number;
  topDeniedKeys: Array<{ key: string; count: number }>;
}
