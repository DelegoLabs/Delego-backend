/**
 * Per-tier token bucket defaults, plus stricter per-endpoint overrides for
 * sensitive routes (auth) that apply regardless of tier (Issue #51).
 */

import type { RateLimitConfig, RateLimitTier } from "./types.js";

const ONE_MINUTE_MS = 60_000;

export const DEFAULT_TIER_CONFIGS: Record<RateLimitTier, RateLimitConfig> = {
  free: {
    tier: "free",
    requestsPerWindow: 60,
    windowMs: ONE_MINUTE_MS,
    burstAllowance: 10,
    refillRatePerSecond: 1,
  },
  pro: {
    tier: "pro",
    requestsPerWindow: 600,
    windowMs: ONE_MINUTE_MS,
    burstAllowance: 100,
    refillRatePerSecond: 10,
  },
  enterprise: {
    tier: "enterprise",
    requestsPerWindow: 6000,
    windowMs: ONE_MINUTE_MS,
    burstAllowance: 1000,
    refillRatePerSecond: 100,
  },
  internal: {
    tier: "internal",
    requestsPerWindow: 100_000,
    windowMs: ONE_MINUTE_MS,
    burstAllowance: 100_000,
    refillRatePerSecond: 10_000,
  },
};

/**
 * Stricter overrides for specific `METHOD:path` endpoints, applied on top of
 * the caller's tier — e.g. login/register stay tightly capped even for
 * `enterprise`/`internal` callers, since they guard credential-stuffing
 * rather than API throughput.
 */
export const ENDPOINT_OVERRIDES: Record<string, Partial<Omit<RateLimitConfig, "tier">>> = {
  "POST:/api/v1/auth/login": { requestsPerWindow: 5, burstAllowance: 2, refillRatePerSecond: 0.1 },
  "POST:/api/v1/auth/register": { requestsPerWindow: 3, burstAllowance: 1, refillRatePerSecond: 0.05 },
};

function isValidTier(tier: string): tier is RateLimitTier {
  return tier === "free" || tier === "pro" || tier === "enterprise" || tier === "internal";
}

/** Normalizes an arbitrary tier string, falling back to "free" for anything unrecognized. */
export function normalizeTier(tier: string | undefined | null): RateLimitTier {
  return tier && isValidTier(tier) ? tier : "free";
}

/**
 * Resolves the effective config for a tier + endpoint, applying any
 * endpoint-specific override on top of the tier's base config. An override
 * never *raises* the endpoint's effective limit above the tier default —
 * it only tightens it (an override field larger than the tier's own value
 * is clamped down), so a stricter global rule can't accidentally loosen a
 * lower tier.
 */
export function resolveRateLimitConfig(
  tier: string,
  endpoint?: string,
  method?: string
): RateLimitConfig {
  const normalizedTier = normalizeTier(tier);
  const base = DEFAULT_TIER_CONFIGS[normalizedTier];

  const overrideKey = method && endpoint ? `${method}:${endpoint}` : undefined;
  const override = overrideKey ? ENDPOINT_OVERRIDES[overrideKey] : undefined;
  if (!override) {
    return base;
  }

  return {
    tier: normalizedTier,
    windowMs: base.windowMs,
    requestsPerWindow: Math.min(base.requestsPerWindow, override.requestsPerWindow ?? base.requestsPerWindow),
    burstAllowance: Math.min(base.burstAllowance, override.burstAllowance ?? base.burstAllowance),
    refillRatePerSecond: Math.min(
      base.refillRatePerSecond,
      override.refillRatePerSecond ?? base.refillRatePerSecond
    ),
  };
}
