import { createHash } from 'node:crypto';

export interface RevenueStatementRowInput {
  referenceId: string;
  grossVolumeCents: number;
  platformFeeCents: number;
  refundTotalCents: number;
  thresholdLimit?: number;
}

export interface RevenueStatementRow {
  referenceId: string;
  grossVolumeCents: number;
  platformFeeCents: number;
  refundTotalCents: number;
  utilizationBps: number;
  status: 'healthy' | 'degraded' | 'halted';
  summary: string;
  checksumHex: string;
}

export function generateMerchantRevenueStatementCsv(input: RevenueStatementRowInput): RevenueStatementRow {
  const referenceId = input.referenceId.trim();
  if (!referenceId) {
    throw new Error('generateMerchantRevenueStatementCsv: referenceId is required');
  }
  if (
    !Number.isFinite(input.grossVolumeCents) ||
    !Number.isFinite(input.platformFeeCents) ||
    !Number.isFinite(input.refundTotalCents)
  ) {
    throw new Error('generateMerchantRevenueStatementCsv: numeric inputs must be finite');
  }

  const v1 = Math.max(0, Math.trunc(input.grossVolumeCents));
  const v2 = Math.max(0, Math.trunc(input.platformFeeCents));
  const v3 = Math.max(0, Math.trunc(input.refundTotalCents));
  const limit = Math.max(1, Math.trunc(input.thresholdLimit ?? 1000));

  const utilizationBps = Math.min(10000, Math.round(((v1 + v2) * 10000) / limit));
  let status: 'healthy' | 'degraded' | 'halted' = 'healthy';
  let summary = `nominal (grossVolumeCents=${v1}, platformFeeCents=${v2}, refundTotalCents=${v3})`;

  if (v3 > limit || utilizationBps >= 9000) {
    status = 'halted';
    summary = `limit exceeded: utilization=${utilizationBps}bps, refundTotalCents=${v3} > ${limit}`;
  } else if (utilizationBps >= 5000) {
    status = 'degraded';
    summary = `elevated utilization=${utilizationBps}bps for ${referenceId}`;
  }

  const canonical = JSON.stringify({
    referenceId,
    grossVolumeCents: v1,
    platformFeeCents: v2,
    refundTotalCents: v3,
    utilizationBps,
    status,
    summary,
  });
  const checksumHex = createHash('sha256').update(canonical).digest('hex');

  return {
    referenceId,
    grossVolumeCents: v1,
    platformFeeCents: v2,
    refundTotalCents: v3,
    utilizationBps,
    status,
    summary,
    checksumHex,
  };
}
