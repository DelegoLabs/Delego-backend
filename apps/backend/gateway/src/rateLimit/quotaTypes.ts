/**
 * Customer-tiered API quota types (Issue #103).
 */

export type OverageAction = "throttle" | "block" | "bill";

export interface RateLimitTier {
  name: string;
  requestsPerWindow: number;
  windowMs: number;
  burstAllowance: number;
  overageAction: OverageAction;
  overageRate?: number;
  features: string[];
}

export interface CustomerQuota {
  customerId: string;
  tier: string;
  customQuotas: Record<
    string,
    {
      requestsPerWindow: number;
      windowMs: number;
    }
  >;
  currentUsage: Record<string, number>;
  windowStart: Record<string, string>;
  overageCount: number;
  billingCycleStart: string;
}

export interface QuotaCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
  overage: boolean;
  retryAfterMs?: number;
  headers: Record<string, string>;
}

export interface QuotaAlert {
  customerId: string;
  endpoint: string;
  thresholdPct: 80 | 95;
  usage: number;
  limit: number;
  triggeredAt: string;
}

export interface QuotaUsageSummary {
  customerId: string;
  tier: string;
  endpoints: Array<{
    endpoint: string;
    used: number;
    limit: number;
    resetAt: string;
  }>;
  overageCount: number;
  billingCycleStart: string;
}
