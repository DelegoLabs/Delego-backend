import { createHash } from 'node:crypto';

export interface DiscountQuotaDecisionInput {
  referenceId: string;
  activeDiscountCount: number;
  discountBps: number;
  tierMaxDiscounts: number;
  thresholdLimit?: number;
}

export interface DiscountQuotaDecision {
  referenceId: string;
  activeDiscountCount: number;
  discountBps: number;
  tierMaxDiscounts: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function enforceMerchantDiscountQuota(input: DiscountQuotaDecisionInput): DiscountQuotaDecision {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('enforceMerchantDiscountQuota: referenceId is required');
  }
  if (
    !Number.isFinite(input.activeDiscountCount) ||
    !Number.isFinite(input.discountBps) ||
    !Number.isFinite(input.tierMaxDiscounts)
  ) {
    throw new Error('enforceMerchantDiscountQuota: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.activeDiscountCount));
  const v2 = Math.max(0, Math.trunc(input.discountBps));
  const v3 = Math.max(0, Math.trunc(input.tierMaxDiscounts));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (activeDiscountCount=${v1}, discountBps=${v2}, tierMaxDiscounts=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, tierMaxDiscounts=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    activeDiscountCount: v1,
    discountBps: v2,
    tierMaxDiscounts: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    activeDiscountCount: v1,
    discountBps: v2,
    tierMaxDiscounts: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
