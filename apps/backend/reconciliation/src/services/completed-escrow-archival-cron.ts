import { createHash } from 'node:crypto';

export interface EscrowArchivalSummaryInput {
  referenceId: string;
  completedEscrowCount: number;
  retentionDaysElapsed: number;
  batchLimit: number;
  thresholdLimit?: number;
}

export interface EscrowArchivalSummary {
  referenceId: string;
  completedEscrowCount: number;
  retentionDaysElapsed: number;
  batchLimit: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function planCompletedEscrowArchival(input: EscrowArchivalSummaryInput): EscrowArchivalSummary {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('planCompletedEscrowArchival: referenceId is required');
  }
  if (
    !Number.isFinite(input.completedEscrowCount) ||
    !Number.isFinite(input.retentionDaysElapsed) ||
    !Number.isFinite(input.batchLimit)
  ) {
    throw new Error('planCompletedEscrowArchival: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.completedEscrowCount));
  const v2 = Math.max(0, Math.trunc(input.retentionDaysElapsed));
  const v3 = Math.max(0, Math.trunc(input.batchLimit));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (completedEscrowCount=${v1}, retentionDaysElapsed=${v2}, batchLimit=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, batchLimit=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    completedEscrowCount: v1,
    retentionDaysElapsed: v2,
    batchLimit: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    completedEscrowCount: v1,
    retentionDaysElapsed: v2,
    batchLimit: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
