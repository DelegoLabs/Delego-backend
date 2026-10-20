import { createHash } from 'node:crypto';

export interface PartialRefundReconciliationInput {
  referenceId: string;
  originalEscrowCents: number;
  refundedCents: number;
  merchantPayoutCents: number;
  thresholdLimit?: number;
}

export interface PartialRefundReconciliation {
  referenceId: string;
  originalEscrowCents: number;
  refundedCents: number;
  merchantPayoutCents: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function reconcilePartialRefundSettlement(input: PartialRefundReconciliationInput): PartialRefundReconciliation {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('reconcilePartialRefundSettlement: referenceId is required');
  }
  if (
    !Number.isFinite(input.originalEscrowCents) ||
    !Number.isFinite(input.refundedCents) ||
    !Number.isFinite(input.merchantPayoutCents)
  ) {
    throw new Error('reconcilePartialRefundSettlement: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.originalEscrowCents));
  const v2 = Math.max(0, Math.trunc(input.refundedCents));
  const v3 = Math.max(0, Math.trunc(input.merchantPayoutCents));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (originalEscrowCents=${v1}, refundedCents=${v2}, merchantPayoutCents=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, merchantPayoutCents=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    originalEscrowCents: v1,
    refundedCents: v2,
    merchantPayoutCents: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    originalEscrowCents: v1,
    refundedCents: v2,
    merchantPayoutCents: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
