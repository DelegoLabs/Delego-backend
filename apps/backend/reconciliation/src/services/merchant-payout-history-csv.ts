import { createHash } from 'node:crypto';

export interface PayoutHistoryStreamSummaryInput {
  referenceId: string;
  exportedPayoutCount: number;
  settledStroopsTotal: number;
  chunkSizeRows: number;
  thresholdLimit?: number;
}

export interface PayoutHistoryStreamSummary {
  referenceId: string;
  exportedPayoutCount: number;
  settledStroopsTotal: number;
  chunkSizeRows: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function summarizeMerchantPayoutCsvStream(input: PayoutHistoryStreamSummaryInput): PayoutHistoryStreamSummary {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('summarizeMerchantPayoutCsvStream: referenceId is required');
  }
  if (
    !Number.isFinite(input.exportedPayoutCount) ||
    !Number.isFinite(input.settledStroopsTotal) ||
    !Number.isFinite(input.chunkSizeRows)
  ) {
    throw new Error('summarizeMerchantPayoutCsvStream: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.exportedPayoutCount));
  const v2 = Math.max(0, Math.trunc(input.settledStroopsTotal));
  const v3 = Math.max(0, Math.trunc(input.chunkSizeRows));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (exportedPayoutCount=${v1}, settledStroopsTotal=${v2}, chunkSizeRows=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, chunkSizeRows=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    exportedPayoutCount: v1,
    settledStroopsTotal: v2,
    chunkSizeRows: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    exportedPayoutCount: v1,
    settledStroopsTotal: v2,
    chunkSizeRows: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
