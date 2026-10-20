import { createHash } from 'node:crypto';

export interface MerchantBondStakeStatusInput {
  referenceId: string;
  stakedBondStroops: number;
  slashedStroops: number;
  requiredMinimumStroops: number;
  thresholdLimit?: number;
}

export interface MerchantBondStakeStatus {
  referenceId: string;
  stakedBondStroops: number;
  slashedStroops: number;
  requiredMinimumStroops: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateMerchantBondStake(input: MerchantBondStakeStatusInput): MerchantBondStakeStatus {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateMerchantBondStake: referenceId is required');
  }
  if (
    !Number.isFinite(input.stakedBondStroops) ||
    !Number.isFinite(input.slashedStroops) ||
    !Number.isFinite(input.requiredMinimumStroops)
  ) {
    throw new Error('evaluateMerchantBondStake: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.stakedBondStroops));
  const v2 = Math.max(0, Math.trunc(input.slashedStroops));
  const v3 = Math.max(0, Math.trunc(input.requiredMinimumStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (stakedBondStroops=${v1}, slashedStroops=${v2}, requiredMinimumStroops=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, requiredMinimumStroops=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    stakedBondStroops: v1,
    slashedStroops: v2,
    requiredMinimumStroops: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    stakedBondStroops: v1,
    slashedStroops: v2,
    requiredMinimumStroops: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
