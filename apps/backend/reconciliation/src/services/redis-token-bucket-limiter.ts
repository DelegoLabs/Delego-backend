import { createHash } from 'node:crypto';

export interface TokenBucketQuotaDecisionInput {
  referenceId: string;
  availableTokens: number;
  requestedCost: number;
  refillRatePerSec: number;
  thresholdLimit?: number;
}

export interface TokenBucketQuotaDecision {
  referenceId: string;
  availableTokens: number;
  requestedCost: number;
  refillRatePerSec: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateTierTokenBucketQuota(input: TokenBucketQuotaDecisionInput): TokenBucketQuotaDecision {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateTierTokenBucketQuota: referenceId is required');
  }
  if (
    !Number.isFinite(input.availableTokens) ||
    !Number.isFinite(input.requestedCost) ||
    !Number.isFinite(input.refillRatePerSec)
  ) {
    throw new Error('evaluateTierTokenBucketQuota: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.availableTokens));
  const v2 = Math.max(0, Math.trunc(input.requestedCost));
  const v3 = Math.max(0, Math.trunc(input.refillRatePerSec));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (availableTokens=${v1}, requestedCost=${v2}, refillRatePerSec=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, refillRatePerSec=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    availableTokens: v1,
    requestedCost: v2,
    refillRatePerSec: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    availableTokens: v1,
    requestedCost: v2,
    refillRatePerSec: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
