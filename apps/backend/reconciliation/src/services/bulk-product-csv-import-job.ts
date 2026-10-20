import { createHash } from 'node:crypto';

export interface BulkCsvImportReportInput {
  referenceId: string;
  totalRowCount: number;
  validSkuCount: number;
  malformedRowCount: number;
  thresholdLimit?: number;
}

export interface BulkCsvImportReport {
  referenceId: string;
  totalRowCount: number;
  validSkuCount: number;
  malformedRowCount: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function validateBulkProductCsvBatch(input: BulkCsvImportReportInput): BulkCsvImportReport {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('validateBulkProductCsvBatch: referenceId is required');
  }
  if (
    !Number.isFinite(input.totalRowCount) ||
    !Number.isFinite(input.validSkuCount) ||
    !Number.isFinite(input.malformedRowCount)
  ) {
    throw new Error('validateBulkProductCsvBatch: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.totalRowCount));
  const v2 = Math.max(0, Math.trunc(input.validSkuCount));
  const v3 = Math.max(0, Math.trunc(input.malformedRowCount));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (totalRowCount=${v1}, validSkuCount=${v2}, malformedRowCount=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, malformedRowCount=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    totalRowCount: v1,
    validSkuCount: v2,
    malformedRowCount: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    totalRowCount: v1,
    validSkuCount: v2,
    malformedRowCount: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
