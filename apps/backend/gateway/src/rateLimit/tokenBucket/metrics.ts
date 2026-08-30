/**
 * In-process rate-limit metrics (Issue #51).
 *
 * Deliberately in-memory and per-process (not Redis-backed): metrics are an
 * observability aid, not a correctness mechanism, and every gateway
 * instance's own view is enough for the `/admin/rate-limit/metrics`
 * dashboard to spot hot callers. Reset on process restart, same as the
 * legacy analytics module's Redis windows expiring.
 */

import type { RateLimitMetrics } from "./types.js";

let totalRequests = 0;
let allowedRequests = 0;
let deniedRequests = 0;
const deniedCounts = new Map<string, number>();

export function recordRateLimitOutcome(key: string, allowed: boolean): void {
  totalRequests += 1;
  if (allowed) {
    allowedRequests += 1;
  } else {
    deniedRequests += 1;
    deniedCounts.set(key, (deniedCounts.get(key) ?? 0) + 1);
  }
}

export function getRateLimitMetrics(topN = 10): RateLimitMetrics {
  const topDeniedKeys = Array.from(deniedCounts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return {
    totalRequests,
    allowedRequests,
    deniedRequests,
    currentUtilization: totalRequests === 0 ? 0 : deniedRequests / totalRequests,
    topDeniedKeys,
  };
}

/** Test helper — clears all counters between test cases. */
export function resetRateLimitMetrics(): void {
  totalRequests = 0;
  allowedRequests = 0;
  deniedRequests = 0;
  deniedCounts.clear();
}
