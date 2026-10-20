import { createHash } from 'node:crypto';

export interface ContractRestoreJobResultInput {
  referenceId: string;
  archivedEntryCount: number;
  estimatedFeeStroops: number;
  remainingBudgetStroops: number;
  thresholdLimit?: number;
}

export interface ContractRestoreJobResult {
  referenceId: string;
  archivedEntryCount: number;
  estimatedFeeStroops: number;
  remainingBudgetStroops: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function planSorobanInstanceRestoration(input: ContractRestoreJobResultInput): ContractRestoreJobResult {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('planSorobanInstanceRestoration: referenceId is required');
  }
  if (
    !Number.isFinite(input.archivedEntryCount) ||
    !Number.isFinite(input.estimatedFeeStroops) ||
    !Number.isFinite(input.remainingBudgetStroops)
  ) {
    throw new Error('planSorobanInstanceRestoration: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.archivedEntryCount));
  const v2 = Math.max(0, Math.trunc(input.estimatedFeeStroops));
  const v3 = Math.max(0, Math.trunc(input.remainingBudgetStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (archivedEntryCount=${v1}, estimatedFeeStroops=${v2}, remainingBudgetStroops=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, remainingBudgetStroops=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    archivedEntryCount: v1,
    estimatedFeeStroops: v2,
    remainingBudgetStroops: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    archivedEntryCount: v1,
    estimatedFeeStroops: v2,
    remainingBudgetStroops: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
