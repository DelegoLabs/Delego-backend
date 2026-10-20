import { createHash } from 'node:crypto';

export interface BlendYieldAccrualSummaryInput {
  referenceId: string;
  stakedPrincipalStroops: number;
  accruedYieldStroops: number;
  protocolCutBps: number;
  thresholdLimit?: number;
}

export interface BlendYieldAccrualSummary {
  referenceId: string;
  stakedPrincipalStroops: number;
  accruedYieldStroops: number;
  protocolCutBps: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function computeBlendEscrowYieldAccrual(input: BlendYieldAccrualSummaryInput): BlendYieldAccrualSummary {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('computeBlendEscrowYieldAccrual: referenceId is required');
  }
  if (
    !Number.isFinite(input.stakedPrincipalStroops) ||
    !Number.isFinite(input.accruedYieldStroops) ||
    !Number.isFinite(input.protocolCutBps)
  ) {
    throw new Error('computeBlendEscrowYieldAccrual: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.stakedPrincipalStroops));
  const v2 = Math.max(0, Math.trunc(input.accruedYieldStroops));
  const v3 = Math.max(0, Math.trunc(input.protocolCutBps));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (stakedPrincipalStroops=${v1}, accruedYieldStroops=${v2}, protocolCutBps=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, protocolCutBps=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    stakedPrincipalStroops: v1,
    accruedYieldStroops: v2,
    protocolCutBps: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    stakedPrincipalStroops: v1,
    accruedYieldStroops: v2,
    protocolCutBps: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
