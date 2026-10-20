import { createHash } from 'node:crypto';

export interface DisputeReserveAllocationInput {
  referenceId: string;
  monthlyVolumeCents: number;
  chargebackRateBps: number;
  existingReserveCents: number;
  thresholdLimit?: number;
}

export interface DisputeReserveAllocation {
  referenceId: string;
  monthlyVolumeCents: number;
  chargebackRateBps: number;
  existingReserveCents: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function calculateDisputeReserveFund(input: DisputeReserveAllocationInput): DisputeReserveAllocation {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('calculateDisputeReserveFund: referenceId is required');
  }
  if (
    !Number.isFinite(input.monthlyVolumeCents) ||
    !Number.isFinite(input.chargebackRateBps) ||
    !Number.isFinite(input.existingReserveCents)
  ) {
    throw new Error('calculateDisputeReserveFund: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.monthlyVolumeCents));
  const v2 = Math.max(0, Math.trunc(input.chargebackRateBps));
  const v3 = Math.max(0, Math.trunc(input.existingReserveCents));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (monthlyVolumeCents=${v1}, chargebackRateBps=${v2}, existingReserveCents=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, existingReserveCents=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    monthlyVolumeCents: v1,
    chargebackRateBps: v2,
    existingReserveCents: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    monthlyVolumeCents: v1,
    chargebackRateBps: v2,
    existingReserveCents: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
