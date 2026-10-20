import { createHash } from 'node:crypto';

export interface TrustlinePreflightReportInput {
  referenceId: string;
  trustlineLimitStroops: number;
  requiredAmountStroops: number;
  issuerFlagsBitmask: number;
  thresholdLimit?: number;
}

export interface TrustlinePreflightReport {
  referenceId: string;
  trustlineLimitStroops: number;
  requiredAmountStroops: number;
  issuerFlagsBitmask: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateStellarTrustlinePreflight(input: TrustlinePreflightReportInput): TrustlinePreflightReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateStellarTrustlinePreflight: referenceId is required');
  }
  if (
    !Number.isFinite(input.trustlineLimitStroops) ||
    !Number.isFinite(input.requiredAmountStroops) ||
    !Number.isFinite(input.issuerFlagsBitmask)
  ) {
    throw new Error('evaluateStellarTrustlinePreflight: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.trustlineLimitStroops));
  const v2 = Math.max(0, Math.trunc(input.requiredAmountStroops));
  const v3 = Math.max(0, Math.trunc(input.issuerFlagsBitmask));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (trustlineLimitStroops=${v1}, requiredAmountStroops=${v2}, issuerFlagsBitmask=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, issuerFlagsBitmask=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    trustlineLimitStroops: v1,
    requiredAmountStroops: v2,
    issuerFlagsBitmask: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    trustlineLimitStroops: v1,
    requiredAmountStroops: v2,
    issuerFlagsBitmask: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
