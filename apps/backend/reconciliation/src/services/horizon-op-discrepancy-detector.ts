import { createHash } from 'node:crypto';

export interface HorizonDiscrepancyReportInput {
  referenceId: string;
  horizonOpCount: number;
  dbLedgerCount: number;
  amountDriftStroops: number;
  thresholdLimit?: number;
}

export interface HorizonDiscrepancyReport {
  referenceId: string;
  horizonOpCount: number;
  dbLedgerCount: number;
  amountDriftStroops: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function detectUnmatchedHorizonOperations(input: HorizonDiscrepancyReportInput): HorizonDiscrepancyReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('detectUnmatchedHorizonOperations: referenceId is required');
  }
  if (
    !Number.isFinite(input.horizonOpCount) ||
    !Number.isFinite(input.dbLedgerCount) ||
    !Number.isFinite(input.amountDriftStroops)
  ) {
    throw new Error('detectUnmatchedHorizonOperations: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.horizonOpCount));
  const v2 = Math.max(0, Math.trunc(input.dbLedgerCount));
  const v3 = Math.max(0, Math.trunc(input.amountDriftStroops));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (horizonOpCount=${v1}, dbLedgerCount=${v2}, amountDriftStroops=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, amountDriftStroops=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    horizonOpCount: v1,
    dbLedgerCount: v2,
    amountDriftStroops: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    horizonOpCount: v1,
    dbLedgerCount: v2,
    amountDriftStroops: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
