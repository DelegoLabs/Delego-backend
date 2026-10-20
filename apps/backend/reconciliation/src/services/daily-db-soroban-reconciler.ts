import { createHash } from 'node:crypto';

export interface SorobanDbReconciliationInput {
  referenceId: string;
  dbBalanceStroops: number;
  sorobanBalanceStroops: number;
  pendingTxCount: number;
  thresholdLimit?: number;
}

export interface SorobanDbReconciliation {
  referenceId: string;
  dbBalanceStroops: number;
  sorobanBalanceStroops: number;
  pendingTxCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function reconcileDbWithSorobanEscrow(input: SorobanDbReconciliationInput): SorobanDbReconciliation {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('reconcileDbWithSorobanEscrow: referenceId is required');
  }
  if (
    !Number.isFinite(input.dbBalanceStroops) ||
    !Number.isFinite(input.sorobanBalanceStroops) ||
    !Number.isFinite(input.pendingTxCount)
  ) {
    throw new Error('reconcileDbWithSorobanEscrow: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.dbBalanceStroops));
  const v2 = Math.max(0, Math.trunc(input.sorobanBalanceStroops));
  const v3 = Math.max(0, Math.trunc(input.pendingTxCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (dbBalanceStroops=${v1}, sorobanBalanceStroops=${v2}, pendingTxCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, pendingTxCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    dbBalanceStroops: v1,
    sorobanBalanceStroops: v2,
    pendingTxCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    dbBalanceStroops: v1,
    sorobanBalanceStroops: v2,
    pendingTxCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
