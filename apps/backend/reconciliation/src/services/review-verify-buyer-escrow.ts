import { createHash } from 'node:crypto';

export interface VerifiedBuyerReviewVerdictInput {
  referenceId: string;
  escrowReleasedFlag: number;
  orderAgeDays: number;
  disputeCount: number;
  thresholdLimit?: number;
}

export interface VerifiedBuyerReviewVerdict {
  referenceId: string;
  escrowReleasedFlag: number;
  orderAgeDays: number;
  disputeCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function verifyBuyerSorobanEscrowPurchase(input: VerifiedBuyerReviewVerdictInput): VerifiedBuyerReviewVerdict {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('verifyBuyerSorobanEscrowPurchase: referenceId is required');
  }
  if (
    !Number.isFinite(input.escrowReleasedFlag) ||
    !Number.isFinite(input.orderAgeDays) ||
    !Number.isFinite(input.disputeCount)
  ) {
    throw new Error('verifyBuyerSorobanEscrowPurchase: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.escrowReleasedFlag));
  const v2 = Math.max(0, Math.trunc(input.orderAgeDays));
  const v3 = Math.max(0, Math.trunc(input.disputeCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (escrowReleasedFlag=${v1}, orderAgeDays=${v2}, disputeCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, disputeCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    escrowReleasedFlag: v1,
    orderAgeDays: v2,
    disputeCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    escrowReleasedFlag: v1,
    orderAgeDays: v2,
    disputeCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
