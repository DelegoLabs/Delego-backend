/**
 * Customer-tiered quota enforcement (Issue #103).
 *
 * Tracks per-customer, per-endpoint usage in Redis using the same
 * fixed-window counter approach as ./rateLimiter.ts, but keyed on the
 * customer's billing window (tier-defined, e.g. daily or monthly) rather
 * than a fixed short window, and layered with tier-aware overage handling.
 */

import { getRedisClient } from "./redisClient.js";
import { getTier, resolveEffectiveQuota } from "./quotaTiers.js";
import type { QuotaAlert, QuotaCheckResult, QuotaUsageSummary } from "./quotaTypes.js";

export const ALERT_THRESHOLDS = [80, 95] as const;

function buildQuotaKey(customerId: string, endpoint: string, windowStartMs: number): string {
  return `quota:${customerId}:${endpoint}:${windowStartMs}`;
}

function currentWindowStart(windowMs: number): number {
  return Math.floor(Date.now() / windowMs) * windowMs;
}

export interface QuotaCheckOptions {
  redisClient?: any;
  onAlert?: (alert: QuotaAlert) => void;
}

/**
 * Check and record one request against a customer's quota for an endpoint.
 *
 * Overage handling depends on the tier's `overageAction`:
 * - "block": requests beyond the limit are rejected (allowed: false).
 * - "throttle": requests beyond the limit are still rejected, but the caller
 *   is expected to retry after `retryAfterMs` rather than being cut off.
 * - "bill": requests beyond the limit are allowed through (allowed: true,
 *   overage: true) and billed at the tier's overageRate — enforcement of the
 *   monetary side is out of scope here; this only reports the overage.
 */
export async function checkQuota(
  customerId: string,
  tierName: string,
  endpoint: string,
  customQuotas: Record<string, { requestsPerWindow: number; windowMs: number }> = {},
  options: QuotaCheckOptions = {},
): Promise<QuotaCheckResult> {
  const tier = getTier(tierName);
  const { requestsPerWindow, windowMs } = resolveEffectiveQuota(tier, customQuotas, endpoint);
  const effectiveLimit = requestsPerWindow + tier.burstAllowance;

  const redis = options.redisClient ?? getRedisClient();
  const windowStartMs = currentWindowStart(windowMs);
  const key = buildQuotaKey(customerId, endpoint, windowStartMs);

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, Math.ceil(windowMs / 1000));
  }

  const resetAtMs = windowStartMs + windowMs;
  const resetAt = new Date(resetAtMs).toISOString();
  const overage = count > requestsPerWindow;
  const withinBurst = count <= effectiveLimit;

  maybeFireAlert(customerId, endpoint, count, requestsPerWindow, options.onAlert);

  if (!overage) {
    return {
      allowed: true,
      remaining: Math.max(0, requestsPerWindow - count),
      limit: requestsPerWindow,
      resetAt,
      overage: false,
      headers: quotaHeaders(requestsPerWindow, Math.max(0, requestsPerWindow - count), resetAt),
    };
  }

  // Over the base limit — behavior depends on the tier's overage action.
  if (tier.overageAction === "bill" && withinBurst) {
    return {
      allowed: true,
      remaining: 0,
      limit: requestsPerWindow,
      resetAt,
      overage: true,
      headers: quotaHeaders(requestsPerWindow, 0, resetAt),
    };
  }

  const retryAfterMs = resetAtMs - Date.now();
  return {
    allowed: false,
    remaining: 0,
    limit: requestsPerWindow,
    resetAt,
    overage: true,
    retryAfterMs: Math.max(0, retryAfterMs),
    headers: quotaHeaders(requestsPerWindow, 0, resetAt),
  };
}

function quotaHeaders(limit: number, remaining: number, resetAt: string): Record<string, string> {
  return {
    "X-Quota-Limit": String(limit),
    "X-Quota-Remaining": String(remaining),
    "X-Quota-Reset": resetAt,
  };
}

function maybeFireAlert(
  customerId: string,
  endpoint: string,
  usage: number,
  limit: number,
  onAlert?: (alert: QuotaAlert) => void,
): void {
  if (!onAlert || limit <= 0) return;

  const pct = (usage / limit) * 100;
  for (const threshold of ALERT_THRESHOLDS) {
    // Fire exactly once per threshold crossing: only when usage lands on the
    // request count that first crosses it, not every request above it.
    const crossingCount = Math.ceil((threshold / 100) * limit);
    if (usage === crossingCount) {
      onAlert({
        customerId,
        endpoint,
        thresholdPct: threshold,
        usage,
        limit,
        triggeredAt: new Date().toISOString(),
      });
    }
  }
  void pct;
}

/** Build a usage summary for a customer across the endpoints they've hit
 * this window (used by the customer-facing quota usage API). */
export async function getQuotaUsage(
  customerId: string,
  tierName: string,
  endpoints: string[],
  customQuotas: Record<string, { requestsPerWindow: number; windowMs: number }> = {},
  options: { redisClient?: any } = {},
): Promise<QuotaUsageSummary> {
  const tier = getTier(tierName);
  const redis = options.redisClient ?? getRedisClient();

  const entries = await Promise.all(
    endpoints.map(async (endpoint) => {
      const { requestsPerWindow, windowMs } = resolveEffectiveQuota(tier, customQuotas, endpoint);
      const windowStartMs = currentWindowStart(windowMs);
      const key = buildQuotaKey(customerId, endpoint, windowStartMs);
      const raw = await redis.get(key);
      const used = raw ? Number(raw) : 0;
      const resetAt = new Date(windowStartMs + windowMs).toISOString();
      return { endpoint, used, limit: requestsPerWindow, resetAt };
    }),
  );

  return {
    customerId,
    tier: tier.name,
    endpoints: entries,
    overageCount: entries.filter((e) => e.used > e.limit).length,
    billingCycleStart: new Date(currentWindowStart(tier.windowMs)).toISOString(),
  };
}
