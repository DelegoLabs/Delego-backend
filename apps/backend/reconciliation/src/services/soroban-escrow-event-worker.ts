import { createHash } from 'node:crypto';

export interface EscrowIngestionBatchReportInput {
  referenceId: string;
  scannedLedgers: number;
  stateTransitionsApplied: number;
  retryQueueDepth: number;
  thresholdLimit?: number;
}

export interface EscrowIngestionBatchReport {
  referenceId: string;
  scannedLedgers: number;
  stateTransitionsApplied: number;
  retryQueueDepth: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function ingestSorobanEscrowStateEvents(input: EscrowIngestionBatchReportInput): EscrowIngestionBatchReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('ingestSorobanEscrowStateEvents: referenceId is required');
  }
  if (
    !Number.isFinite(input.scannedLedgers) ||
    !Number.isFinite(input.stateTransitionsApplied) ||
    !Number.isFinite(input.retryQueueDepth)
  ) {
    throw new Error('ingestSorobanEscrowStateEvents: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.scannedLedgers));
  const v2 = Math.max(0, Math.trunc(input.stateTransitionsApplied));
  const v3 = Math.max(0, Math.trunc(input.retryQueueDepth));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (scannedLedgers=${v1}, stateTransitionsApplied=${v2}, retryQueueDepth=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, retryQueueDepth=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    scannedLedgers: v1,
    stateTransitionsApplied: v2,
    retryQueueDepth: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    scannedLedgers: v1,
    stateTransitionsApplied: v2,
    retryQueueDepth: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
