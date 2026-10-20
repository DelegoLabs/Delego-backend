import { createHash } from 'node:crypto';

export interface PayoutBatchPlanInput {
  referenceId: string;
  recipientCount: number;
  totalAmountStroops: number;
  baseFeeStroops: number;
  thresholdLimit?: number;
}

export interface PayoutBatchPlan {
  referenceId: string;
  recipientCount: number;
  totalAmountStroops: number;
  baseFeeStroops: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function planConsolidatedPayoutBatch(input: PayoutBatchPlanInput): PayoutBatchPlan {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('planConsolidatedPayoutBatch: referenceId is required');
  }
  if (
    !Number.isFinite(input.recipientCount) ||
    !Number.isFinite(input.totalAmountStroops) ||
    !Number.isFinite(input.baseFeeStroops)
  ) {
    throw new Error('planConsolidatedPayoutBatch: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.recipientCount));
  const v2 = Math.max(0, Math.trunc(input.totalAmountStroops));
  const v3 = Math.max(0, Math.trunc(input.baseFeeStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (recipientCount=${v1}, totalAmountStroops=${v2}, baseFeeStroops=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, baseFeeStroops=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    recipientCount: v1,
    totalAmountStroops: v2,
    baseFeeStroops: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    recipientCount: v1,
    totalAmountStroops: v2,
    baseFeeStroops: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
