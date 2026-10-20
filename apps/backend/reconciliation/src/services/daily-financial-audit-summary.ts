import { createHash } from 'node:crypto';

export interface DailyAuditDigestInput {
  referenceId: string;
  settledOrderCount: number;
  settledVolumeCents: number;
  unreconciledCount: number;
  thresholdLimit?: number;
}

export interface DailyAuditDigest {
  referenceId: string;
  settledOrderCount: number;
  settledVolumeCents: number;
  unreconciledCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function buildDailyFinancialAuditSummary(input: DailyAuditDigestInput): DailyAuditDigest {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('buildDailyFinancialAuditSummary: referenceId is required');
  }
  if (
    !Number.isFinite(input.settledOrderCount) ||
    !Number.isFinite(input.settledVolumeCents) ||
    !Number.isFinite(input.unreconciledCount)
  ) {
    throw new Error('buildDailyFinancialAuditSummary: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.settledOrderCount));
  const v2 = Math.max(0, Math.trunc(input.settledVolumeCents));
  const v3 = Math.max(0, Math.trunc(input.unreconciledCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (settledOrderCount=${v1}, settledVolumeCents=${v2}, unreconciledCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, unreconciledCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    settledOrderCount: v1,
    settledVolumeCents: v2,
    unreconciledCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    settledOrderCount: v1,
    settledVolumeCents: v2,
    unreconciledCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
