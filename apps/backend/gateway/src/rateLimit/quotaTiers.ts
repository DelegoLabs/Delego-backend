import type { RateLimitTier } from "./quotaTypes.js";

export const QUOTA_TIERS: Record<string, RateLimitTier> = {
  free: {
    name: "free",
    requestsPerWindow: 1_000,
    windowMs: 24 * 60 * 60 * 1000, // daily
    burstAllowance: 0,
    overageAction: "block",
    features: ["basic-endpoints"],
  },
  starter: {
    name: "starter",
    requestsPerWindow: 10_000,
    windowMs: 24 * 60 * 60 * 1000,
    burstAllowance: 100,
    overageAction: "throttle",
    features: ["basic-endpoints", "webhooks"],
  },
  pro: {
    name: "pro",
    requestsPerWindow: 100_000,
    windowMs: 30 * 24 * 60 * 60 * 1000, // monthly
    burstAllowance: 1_000,
    overageAction: "bill",
    overageRate: 0.001, // per request, in the platform's billing currency
    features: ["basic-endpoints", "webhooks", "grpc", "priority-support"],
  },
  enterprise: {
    name: "enterprise",
    requestsPerWindow: 1_000_000,
    windowMs: 30 * 24 * 60 * 60 * 1000,
    burstAllowance: 10_000,
    overageAction: "bill",
    overageRate: 0.0005,
    features: ["basic-endpoints", "webhooks", "grpc", "priority-support", "custom-quotas"],
  },
};

export const DEFAULT_TIER = "free";

export function getTier(tierName: string): RateLimitTier {
  return QUOTA_TIERS[tierName] ?? QUOTA_TIERS[DEFAULT_TIER];
}

/** Resolve the effective quota for an endpoint, preferring a customer's
 * per-endpoint override over their tier's blanket allowance. */
export function resolveEffectiveQuota(
  tier: RateLimitTier,
  customQuotas: Record<string, { requestsPerWindow: number; windowMs: number }>,
  endpoint: string,
): { requestsPerWindow: number; windowMs: number } {
  const override = customQuotas[endpoint];
  if (override) {
    return override;
  }
  return { requestsPerWindow: tier.requestsPerWindow, windowMs: tier.windowMs };
}
