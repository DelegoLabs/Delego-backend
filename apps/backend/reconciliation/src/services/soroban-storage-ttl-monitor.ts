import { createHash } from 'node:crypto';

export interface StorageTtlHealthReportInput {
  referenceId: string;
  currentLedgerSeq: number;
  liveUntilLedgerSeq: number;
  minThresholdLedgers: number;
  thresholdLimit?: number;
}

export interface StorageTtlHealthReport {
  referenceId: string;
  currentLedgerSeq: number;
  liveUntilLedgerSeq: number;
  minThresholdLedgers: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function evaluateSorobanStorageTtl(input: StorageTtlHealthReportInput): StorageTtlHealthReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('evaluateSorobanStorageTtl: referenceId is required');
  }
  if (
    !Number.isFinite(input.currentLedgerSeq) ||
    !Number.isFinite(input.liveUntilLedgerSeq) ||
    !Number.isFinite(input.minThresholdLedgers)
  ) {
    throw new Error('evaluateSorobanStorageTtl: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.currentLedgerSeq));
  const v2 = Math.max(0, Math.trunc(input.liveUntilLedgerSeq));
  const v3 = Math.max(0, Math.trunc(input.minThresholdLedgers));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (currentLedgerSeq=${v1}, liveUntilLedgerSeq=${v2}, minThresholdLedgers=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, minThresholdLedgers=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    currentLedgerSeq: v1,
    liveUntilLedgerSeq: v2,
    minThresholdLedgers: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    currentLedgerSeq: v1,
    liveUntilLedgerSeq: v2,
    minThresholdLedgers: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
